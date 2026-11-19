// The host half's model of projects and issues: every write to an issue goes through here, so the fields
// derived from others (the key, the entity title, the state's name and category, when work started and
// finished) are written with the change, notifications go to the right people, and automations run.
//
// Writes are made with the caller's ctx, so the data layer checks their level on the project's space
// (a viewer cannot edit) and history records who made them. The plugin acts as itself (`rookery.data`) only
// for its registry of project keys and for repairs of rows written past it.
import { type Ctx, mentions, plainText, type RichText, type Rookery, RookeryError } from "@rookery/sdk"
import { findIssueKeys, formatIssueKey, isProjectKey, keyWords, parseIssueKey, slugForKey } from "../lib/keys"
import {
  CATEGORY_ICON,
  type Category,
  closed,
  DEFAULT_LABELS,
  DEFAULT_STATES,
  defaultState,
  firstOf,
  type IssueRow,
  issueLabel,
  type LabelRow,
  type ProjectRow,
  type RelationKind,
  type StateRow,
} from "../lib/model"
import { between, compareRank, rankFor, sequence } from "../lib/rank"
import { accessLevel, documentsOf, entitiesOf, extrasOf, sendNotice, toRookeryError } from "./sdk"

export const KIND = "projects.project"
export const issueUri = (id: string) => `issue://${id}`
export const idOf = (uri: string) => {
  const at = uri.indexOf("://")
  return at < 0 ? uri : uri.slice(at + 3)
}
export const userUri = (id: string) => (id.startsWith("user://") ? id : `user://${id}`)

/** The id of the person a call is for; calls without one (a service account) cannot write issues. */
export function uid(ctx: Ctx): string {
  if (!ctx.user) throw new RookeryError("FORBIDDEN", "this needs a person, not a service account")
  return ctx.user.id
}

/** Fields a person may set on an issue. */
export interface IssuePatch {
  title?: string
  state?: string | null
  priority?: number
  assignee?: string | null
  labels?: string[]
  addLabels?: string[]
  removeLabels?: string[]
  estimate?: number | null
  due?: string | null
  parent?: string | null
  cycle?: string | null
  /** A state by name or category, for bulk edits across projects whose state ids differ. */
  stateName?: string
  stateCategory?: Category
}

export interface Registry {
  id: string
  space: string
  key: string
  archived: boolean
}

/** The fields that follow from a state: its name and category, the icon, when work started and ended. */
export function stateFields(state: StateRow | null, before: Partial<IssueRow> | null, now: string) {
  const category = state?.category ?? null
  const out: Record<string, unknown> = {
    state: state?.id ?? null,
    stateName: state?.name ?? null,
    stateCategory: category,
    icon: category ? CATEGORY_ICON[category] : "list",
  }
  if (category === "started" && !before?.startedAt) out.startedAt = now
  if (closed(category)) {
    if (!closed(before?.stateCategory ?? null) || !before?.completedAt) out.completedAt = now
  } else if (before?.completedAt) out.completedAt = null
  return out
}

/** What the sources (`server/sources.ts`) need to hear from every write, set once both exist. */
export interface SourceHooks {
  touched(
    issue: IssueRow,
    values: Record<string, unknown>,
  ): Array<"title" | "body" | "state" | "labels" | "assignee">
  stamp(issue: IssueRow, fields: string[]): unknown
  queue(
    ctx: Ctx | null,
    p: {
      space: string
      issue: string
      fields?: Array<"title" | "body" | "state" | "labels" | "assignee">
      create?: string
      comment?: { op: "create" | "edit" | "delete"; id: string; external?: string }
    },
  ): Promise<void>
  linkForNew(space: string, choice?: string | null): Promise<{ id: string } | null>
}

export function createCore(rookery: Rookery) {
  const data = (ctx: Ctx | null, space: string) => (ctx ? ctx.data.space(space) : rookery.data.space(space))
  const hooks: { sources?: SourceHooks } = {}

  // ── projects ──────────────────────────────────────────────────────────────────────────────────────

  /** Every project, from the plugin's registry (key -> space). Readable by everyone; issues are not. */
  const registry = async (): Promise<Registry[]> => {
    const out: Registry[] = []
    let after: string | undefined
    do {
      const page = await rookery.data.registry.find({ limit: 1000, ...(after ? { after } : {}) })
      out.push(...(page.rows as unknown as Registry[]))
      after = page.next ?? undefined
    } while (after)
    return out
  }

  // Key -> space, read whole and kept briefly: other plugins ask for keys found in any text (the GitHub
  // plugin, for every pull request it syncs), and most such "keys" (UTF-8, fix-2) name no project.
  let keyCache: { at: number; map: Map<string, string> } | null = null
  const keyMap = async (fresh = false) => {
    if (!fresh && keyCache && Date.now() - keyCache.at < 10_000) return keyCache.map
    const map = new Map((await registry()).map((r) => [r.key.toUpperCase(), r.space]))
    keyCache = { at: Date.now(), map }
    return map
  }
  const spaceOfKey = async (key: string): Promise<string | null> => {
    const k = key.toUpperCase()
    return (await keyMap()).get(k) ?? (await keyMap(true)).get(k) ?? null
  }
  /** The same without reading again on a miss: for keys found in text, which mostly name nothing. */
  const knownKey = async (key: string) => (await keyMap()).get(key.toUpperCase()) ?? null

  const project = async (ctx: Ctx | null, space: string): Promise<ProjectRow> => {
    const { rows } = await data(ctx, space).projects.find({ limit: 1 })
    const p = rows[0] as unknown as ProjectRow | undefined
    if (!p) throw new RookeryError("NOT_FOUND", "this space is not a project, or you cannot see it")
    return p
  }

  const states = async (ctx: Ctx | null, space: string): Promise<StateRow[]> => {
    const { rows } = await data(ctx, space).states.find({ limit: 200 })
    return (rows as unknown as StateRow[]).sort((a, b) => (a.rank < b.rank ? -1 : 1))
  }

  const labelsOf = async (ctx: Ctx | null, space: string): Promise<LabelRow[]> => {
    const { rows } = await (ctx ? ctx.data : rookery.data).labels.find({
      where: { or: [{ scope: `space://${space}` }, { scope: null }] },
      limit: 1000,
    })
    return rows as unknown as LabelRow[]
  }

  async function createProject(
    ctx: Ctx,
    p: { name: string; key: string; summary?: string; icon?: string; labels?: boolean },
  ) {
    const key = p.key.trim().toUpperCase()
    if (!isProjectKey(key))
      throw new RookeryError("INVALID", "a key is 2 to 10 capital letters and digits, starting with a letter")
    const name = p.name.trim()
    if (!name) throw new RookeryError("INVALID", "a project needs a name")
    if (await spaceOfKey(key)) throw new RookeryError("CONFLICT", `the key ${key} is taken`, { key })
    const space = await extrasOf(rookery)
      .spaces.create(ctx, { kind: KIND, name, slug: slugForKey(key) })
      .catch((e) => {
        if (toRookeryError(e).code === "CONFLICT" || /slug/i.test(String(e?.message)))
          throw new RookeryError("CONFLICT", `a space with the address ${slugForKey(key)} exists`, { key })
        throw e
      })
    try {
      await rookery.data.registry.insert({ space: space.id, key } as never)
      keyCache = null
    } catch (e) {
      throw new RookeryError("CONFLICT", `the key ${key} is taken`, { key, cause: String(e) })
    }
    const d = data(ctx, space.id)
    const row = (await d.projects.insert({
      key,
      name,
      summary: p.summary?.trim() || null,
      icon: p.icon ?? null,
      lead: userUri(uid(ctx)),
    } as never)) as unknown as ProjectRow
    const ranks = sequence(DEFAULT_STATES.length)
    await d.states.batch(
      DEFAULT_STATES.map((s, i) => ({ op: "insert" as const, values: { ...s, rank: ranks[i] } })),
    )
    if (p.labels !== false)
      await ctx.data.labels.batch(
        DEFAULT_LABELS.map((l) => ({
          op: "insert" as const,
          values: { ...l, scope: `space://${space.id}` },
        })),
      )
    return { space, project: row }
  }

  // ── derived fields ────────────────────────────────────────────────────────────────────────────────

  /** Resolves a patch's state for one project: an id of that project, or a name or category. */
  function pickState(all: StateRow[], patch: IssuePatch): StateRow | null | undefined {
    if (patch.state !== undefined) {
      if (patch.state === null) return null
      const byId = all.find((s) => s.id === patch.state)
      if (byId) return byId
    }
    if (patch.stateName) {
      const n = patch.stateName.toLowerCase()
      const byName = all.find((s) => s.name.toLowerCase() === n)
      if (byName) return byName
    }
    if (patch.stateCategory) return firstOf(all, patch.stateCategory)
    if (patch.state !== undefined)
      throw new RookeryError("INVALID", `no state ${patch.state} in this project`)
    return undefined
  }

  const asUris = (list: string[] | undefined, scheme: string) =>
    (list ?? []).map((x) => (x.includes("://") ? x : `${scheme}://${x}`))

  /** The values to write for a patch to one issue (or a new one when `before` is null). */
  function patchValues(
    patch: IssuePatch,
    before: IssueRow | null,
    all: StateRow[],
    now: string,
  ): Record<string, unknown> {
    const v: Record<string, unknown> = {}
    if (patch.title !== undefined) {
      const t = patch.title.trim()
      if (!t) throw new RookeryError("INVALID", "an issue needs a title")
      v.title = t
    }
    const st = pickState(all, patch)
    if (st !== undefined) Object.assign(v, stateFields(st, before, now))
    if (patch.priority !== undefined) {
      if (![0, 1, 2, 3, 4].includes(patch.priority)) throw new RookeryError("INVALID", "priority is 0 to 4")
      v.priority = patch.priority
    }
    if (patch.assignee !== undefined) v.assignee = patch.assignee ? userUri(patch.assignee) : null
    if (patch.labels !== undefined || patch.addLabels || patch.removeLabels) {
      const base = patch.labels !== undefined ? asUris(patch.labels, "label") : [...(before?.labels ?? [])]
      const add = asUris(patch.addLabels, "label")
      const remove = new Set(asUris(patch.removeLabels, "label"))
      v.labels = [...new Set([...base, ...add])].filter((l) => !remove.has(l))
    }
    if (patch.estimate !== undefined) v.estimate = patch.estimate
    if (patch.due !== undefined) v.due = patch.due || null
    if (patch.parent !== undefined) {
      const parent = patch.parent ? asUris([patch.parent], "issue")[0]! : null
      if (before && parent === issueUri(before.id))
        throw new RookeryError("INVALID", "an issue cannot be its own parent")
      v.parent = parent
    }
    if (patch.cycle !== undefined) v.cycle = patch.cycle ? asUris([patch.cycle], "cycle")[0]! : null
    if (v.title !== undefined && before) v.label = issueLabel(before.key, v.title as string)
    // Followers: whoever is assigned follows.
    if (v.assignee && before && !before.followers?.includes(v.assignee as string))
      v.followers = [...(before.followers ?? []), v.assignee]
    return v
  }

  // ── issues ────────────────────────────────────────────────────────────────────────────────────────

  const getIssue = async (ctx: Ctx | null, space: string, id: string) =>
    (await data(ctx, space).issues.get(idOf(id))) as unknown as IssueRow | null

  /** An issue by key (`CROW-12`), URI or id. With an id or URI the space may be left out. */
  async function findIssue(ctx: Ctx | null, ref: string, space?: string | null): Promise<IssueRow | null> {
    const key = parseIssueKey(ref)
    if (key) {
      const s = await spaceOfKey(key.project)
      if (!s) return null
      const { rows } = await data(ctx, s).issues.find({ where: { number: key.number }, limit: 1 })
      return (rows[0] as unknown as IssueRow) ?? null
    }
    const id = idOf(ref)
    if (space) return getIssue(ctx, space, id)
    const e = await entitiesOf(rookery)?.lookup(ctx, issueUri(id))
    if (!e?.spaceId) return null
    return getIssue(ctx, e.spaceId, id)
  }

  /** The key after the last one, for rows inserted without going through createIssue. */
  const lastRank = async (ctx: Ctx | null, space: string): Promise<string | null> => {
    const { rows } = await data(ctx, space).issues.find({ orderBy: [["rank", "desc"]], limit: 1 })
    return ((rows[0] as unknown as IssueRow | undefined)?.rank as string | undefined) ?? null
  }
  const firstRank = async (ctx: Ctx | null, space: string): Promise<string | null> => {
    const { rows } = await data(ctx, space).issues.find({
      where: { rank: { ne: null } },
      orderBy: ["rank"],
      limit: 1,
    })
    return ((rows[0] as unknown as IssueRow | undefined)?.rank as string | undefined) ?? null
  }

  async function createIssue(
    ctx: Ctx,
    space: string,
    p: IssuePatch & {
      title: string
      description?: RichText | null
      position?: "top" | "bottom"
      followers?: string[]
      /** The source link to create it on too, `local` for none; the project's only link by default. */
      link?: string | null
    },
  ): Promise<IssueRow> {
    const proj = await project(ctx, space)
    const all = await states(ctx, space)
    const now = new Date().toISOString()
    const values = patchValues(p, null, all, now)
    if (values.state === undefined) Object.assign(values, stateFields(defaultState(all), null, now))
    const rank =
      p.position === "top"
        ? between(null, await firstRank(ctx, space))
        : between(await lastRank(ctx, space), null)
    const me = userUri(uid(ctx))
    const followers = [
      ...new Set([me, ...(values.assignee ? [values.assignee as string] : []), ...(p.followers ?? [])]),
    ]
    const inserted = (await data(ctx, space).issues.insert({
      ...values,
      rank,
      followers,
      label: values.title,
    } as never)) as unknown as IssueRow
    // The number comes from the store's sequence; the key and the entity title follow from it.
    const key = formatIssueKey(proj.key, inserted.number)
    let row = (await data(ctx, space).issues.update(inserted.id, {
      key,
      keyWords: keyWords(key),
      label: issueLabel(key, inserted.title),
    } as never)) as unknown as IssueRow
    if (p.description && plainText(p.description).trim()) {
      const docs = extrasOf(rookery).documents
      if (docs) {
        const doc = await docs.create(ctx, {
          parent: issueUri(row.id),
          title: row.title,
          content: p.description,
        })
        row = (await data(ctx, space).issues.update(row.id, {
          document: doc.id,
        } as never)) as unknown as IssueRow
      }
      for (const m of mentions(p.description))
        if (m.startsWith("user://") && m !== me) await follow(ctx, row, m)
    }
    if (row.assignee && row.assignee !== me) await notifyAssigned(ctx, row)
    const target = await hooks.sources?.linkForNew(space, p.link).catch(() => null)
    if (target) await hooks.sources!.queue(ctx, { space, issue: row.id, create: target.id })
    return row
  }

  const follow = async (ctx: Ctx | null, issue: IssueRow, user: string, on = true) => {
    const has = issue.followers?.includes(user)
    if (on === !!has) return issue
    const followers = on
      ? [...(issue.followers ?? []), user]
      : (issue.followers ?? []).filter((f) => f !== user)
    return (await data(ctx, issue.spaceId).issues.update(issue.id, {
      followers,
    } as never)) as unknown as IssueRow
  }

  // ── notifications ─────────────────────────────────────────────────────────────────────────────────

  const who = (ctx: Ctx) => ctx.user?.name || "Someone"

  async function notifyAssigned(ctx: Ctx, issue: IssueRow) {
    if (!issue.assignee) return
    await sendNotice(rookery, {
      user: idOf(issue.assignee),
      kind: "action",
      title: `${who(ctx)} assigned you ${issue.key}`,
      body: issue.title,
      resource: issueUri(issue.id),
    })
  }

  async function notifyState(ctx: Ctx, issue: IssueRow, from: string | null) {
    const me = userUri(uid(ctx))
    const to = new Set<string>()
    if (issue.createdBy) to.add(userUri(issue.createdBy))
    if (issue.assignee) to.add(issue.assignee)
    to.delete(me)
    for (const u of to)
      await sendNotice(rookery, {
        user: idOf(u),
        kind: "info",
        title: `${who(ctx)} moved ${issue.key} ${from ? `from ${from} ` : ""}to ${issue.stateName}`,
        body: issue.title,
        resource: issueUri(issue.id),
      })
  }

  // ── updates ───────────────────────────────────────────────────────────────────────────────────────

  /** Applies a patch to one issue, then what follows from it. Returns the issue as written. */
  async function updateIssue(
    ctx: Ctx,
    issue: IssueRow,
    patch: IssuePatch,
    extra: Record<string, unknown> = {},
  ) {
    const all = await states(ctx, issue.spaceId)
    const now = new Date().toISOString()
    const values = { ...patchValues(patch, issue, all, now), ...extra }
    // Only what changes is written, so history shows real changes.
    for (const k of Object.keys(values))
      if (JSON.stringify((issue as any)[k] ?? null) === JSON.stringify(values[k] ?? null)) delete values[k]
    if (!Object.keys(values).length) return issue
    // Fields the issue's source has: when Crow wrote them goes into the same write, and a push follows.
    const synced = hooks.sources?.touched(issue, values) ?? []
    if (synced.length) values.source = hooks.sources!.stamp(issue, synced)
    if (values.parent) {
      const parent = await findIssue(ctx, values.parent as string, issue.spaceId)
      if (!parent) throw new RookeryError("NOT_FOUND", "no such parent issue")
      // No cycles: the new parent must not be below this issue.
      let at: IssueRow | null = parent
      for (let depth = 0; at?.parent && depth < 50; depth++) {
        if (at.parent === issueUri(issue.id))
          throw new RookeryError("INVALID", "that would make the issue its own ancestor")
        at = await findIssue(ctx, at.parent, at.spaceId)
      }
    }
    const row = (await data(ctx, issue.spaceId).issues.update(
      issue.id,
      values as never,
    )) as unknown as IssueRow
    const me = userUri(uid(ctx))
    if (synced.length)
      await hooks.sources!.queue(ctx, { space: issue.spaceId, issue: issue.id, fields: synced })
    if (values.assignee && values.assignee !== me) await notifyAssigned(ctx, row)
    if (values.state !== undefined && values.state !== issue.state) {
      await notifyState(ctx, row, issue.stateName)
      if (closed(row.stateCategory) && row.parent) await autoCloseParent(ctx, row)
    }
    return row
  }

  /** With the project setting on: when the last open sub-issue closes, the parent completes. */
  async function autoCloseParent(ctx: Ctx, child: IssueRow) {
    const parent = await findIssue(ctx, child.parent!, child.spaceId)
    if (!parent || closed(parent.stateCategory)) return
    const proj = await project(ctx, parent.spaceId)
    if (!proj.autoCloseParent) return
    const { rows } = await data(ctx, parent.spaceId).issues.find({
      where: { parent: issueUri(parent.id) },
      limit: 1000,
    })
    const kids = rows as unknown as IssueRow[]
    if (!kids.length || !kids.every((k) => closed(k.stateCategory))) return
    // All cancelled: the parent is cancelled too; otherwise it is done.
    const allCancelled = kids.every((k) => k.stateCategory === "cancelled")
    await updateIssue(ctx, parent, { stateCategory: allCancelled ? "cancelled" : "completed" })
  }

  async function updateMany(ctx: Ctx, items: Array<{ id: string; space: string }>, patch: IssuePatch) {
    const out: IssueRow[] = []
    for (const it of items) {
      const issue = await getIssue(ctx, it.space, it.id)
      if (!issue) throw new RookeryError("NOT_FOUND", `no issue ${it.id}`)
      out.push(await updateIssue(ctx, issue, patch))
    }
    return out
  }

  /**
   * Moves an issue between two others in the manual order, and into a group (a board column: its state,
   * assignee, …) in the same write. The neighbours' keys are read now, not taken from the person's screen,
   * so concurrent moves see each other.
   */
  async function move(
    ctx: Ctx,
    p: { space: string; id: string; above?: string | null; below?: string | null; patch?: IssuePatch },
  ) {
    const issue = await getIssue(ctx, p.space, p.id)
    if (!issue) throw new RookeryError("NOT_FOUND", "no such issue")
    const d = data(ctx, p.space)
    const read = async (id: string | null | undefined) =>
      id && id !== p.id ? ((await d.issues.get(id)) as unknown as IssueRow | null) : null
    const above = await read(p.above)
    const below = await read(p.below)
    let ceiling: IssueRow | null = null
    if (above?.rank && below?.rank && above.rank >= below.rank) {
      const { rows } = await d.issues.find({
        where: { rank: { gt: above.rank }, id: { ne: p.id } },
        orderBy: ["rank"],
        limit: 5,
      })
      ceiling =
        (rows as unknown as IssueRow[]).filter((r) => r.rank! > above.rank!).sort(compareRank)[0] ?? null
    }
    const r = rankFor(above, below, ceiling)
    if (r.below && below) await d.issues.update(below.id, { rank: r.below } as never)
    return updateIssue(ctx, issue, p.patch ?? {}, { rank: r.rank })
  }

  // ── relations ─────────────────────────────────────────────────────────────────────────────────────

  async function relate(ctx: Ctx, space: string, source: string, target: string, kind: RelationKind) {
    const a = await findIssue(ctx, source, space)
    const b = await findIssue(ctx, target, space)
    if (!a || !b) throw new RookeryError("NOT_FOUND", "no such issue")
    if (a.id === b.id) throw new RookeryError("INVALID", "an issue cannot relate to itself")
    const d = data(ctx, a.spaceId)
    const existing = (
      await d.relations.find({ where: { source: issueUri(a.id), target: issueUri(b.id) }, limit: 10 })
    ).rows as unknown as Array<{ id: string; kind: RelationKind }>
    if (existing.some((r) => r.kind === kind)) return existing.find((r) => r.kind === kind)
    return d.relations.insert({ source: issueUri(a.id), target: issueUri(b.id), kind } as never)
  }

  /** Relations of an issue, both directions, as far as the caller can see. */
  async function relations(ctx: Ctx, issue: IssueRow) {
    const uri = issueUri(issue.id)
    const spaces = (await rookery.spaces.list(ctx)).filter((s) => s.kind === KIND).map((s) => s.id)
    if (!spaces.includes(issue.spaceId)) spaces.push(issue.spaceId)
    const { rows } = await ctx.data.relations.find({
      where: { or: [{ source: uri }, { target: uri }] },
      spaces,
      limit: 500,
    })
    return rows as unknown as Array<{
      id: string
      spaceId: string
      source: string
      target: string
      kind: RelationKind
    }>
  }

  // ── comments ──────────────────────────────────────────────────────────────────────────────────────

  const excerpt = (doc: RichText | null | undefined) => {
    const t = plainText(doc).replace(/\s+/g, " ").trim()
    return t.length > 80 ? `${t.slice(0, 79)}…` : t || "Comment"
  }

  async function comment(ctx: Ctx, space: string, issueRef: string, body: RichText) {
    const issue = await findIssue(ctx, issueRef, space)
    if (!issue) throw new RookeryError("NOT_FOUND", "no such issue")
    if (!plainText(body).trim() && !mentions(body).length)
      throw new RookeryError("INVALID", "the comment is empty")
    const row = await data(ctx, issue.spaceId).comments.insert({
      issue: issueUri(issue.id),
      body,
      excerpt: excerpt(body),
    } as never)
    const me = userUri(uid(ctx))
    let fresh = await follow(ctx, issue, me)
    const mentioned = mentions(body).filter((m) => m.startsWith("user://"))
    // The kernel tells mentioned people; everyone else who follows gets a comment notification.
    for (const f of fresh.followers ?? []) {
      if (f === me || mentioned.includes(f)) continue
      await sendNotice(rookery, {
        user: idOf(f),
        kind: "info",
        title: `${who(ctx)} commented on ${issue.key} ${issue.title}`,
        body: excerpt(body),
        resource: issueUri(issue.id),
      })
    }
    for (const m of mentioned) if (m !== me) fresh = await follow(ctx, fresh, m)
    if (issue.source?.link)
      await hooks.sources?.queue(ctx, {
        space: issue.spaceId,
        issue: issue.id,
        comment: { op: "create", id: (row as { id: string }).id },
      })
    return row
  }

  type Stored = {
    createdBy: string | null
    issue: string
    originKey?: string | null
    origin?: { external?: string }
  }

  async function editComment(ctx: Ctx, space: string, id: string, body: RichText) {
    const c = (await data(ctx, space).comments.get(id)) as unknown as Stored | null
    if (!c) throw new RookeryError("NOT_FOUND", "no such comment")
    if (c.createdBy !== uid(ctx)) throw new RookeryError("FORBIDDEN", "only its author edits a comment")
    const row = await data(ctx, space).comments.update(id, {
      body,
      excerpt: excerpt(body),
      editedAt: new Date().toISOString(),
    } as never)
    if (c.originKey)
      await hooks.sources?.queue(ctx, { space, issue: idOf(c.issue), comment: { op: "edit", id } })
    return row
  }

  async function deleteComment(ctx: Ctx, space: string, id: string) {
    const c = (await data(ctx, space).comments.get(id)) as unknown as Stored | null
    if (!c) throw new RookeryError("NOT_FOUND", "no such comment")
    if (c.createdBy !== uid(ctx) && !ctx.user?.admin) {
      const level = await accessLevel(ctx, `space://${space}`)
      if (level !== "manage")
        throw new RookeryError("FORBIDDEN", "only its author or the project's managers delete a comment")
    }
    const out = await data(ctx, space).comments.delete(id)
    if (c.origin?.external)
      await hooks.sources?.queue(ctx, {
        space,
        issue: idOf(c.issue),
        comment: { op: "delete", id, external: c.origin.external },
      })
    return out
  }

  /** Adds or removes the caller's reaction. Retries when someone else reacted at the same moment. */
  async function react(ctx: Ctx, space: string, id: string, emoji: string) {
    if (!emoji || [...emoji].length > 8) throw new RookeryError("INVALID", "a reaction is one emoji")
    const me = uid(ctx)
    for (let attempt = 0; attempt < 5; attempt++) {
      const c = (await data(ctx, space).comments.get(id)) as unknown as {
        rev: number
        reactions: Record<string, string[]>
      } | null
      if (!c) throw new RookeryError("NOT_FOUND", "no such comment")
      const r = { ...(c.reactions ?? {}) }
      const list = new Set(r[emoji] ?? [])
      if (list.has(me)) list.delete(me)
      else list.add(me)
      if (list.size) r[emoji] = [...list]
      else delete r[emoji]
      try {
        return await data(ctx, space).comments.update(id, { reactions: r } as never, { rev: c.rev })
      } catch (e) {
        if (toRookeryError(e).code !== "CONFLICT") throw e
      }
    }
    throw new RookeryError("CONFLICT", "too many reactions at once; try again")
  }

  // ── keys for other plugins ────────────────────────────────────────────────────────────────────────

  /** Issue keys to URIs, for the keys the caller may see (the GitHub plugin's link patterns). */
  async function resolveKeys(ctx: Ctx | null, keys: string[]) {
    const out: Record<string, string> = {}
    const byProject = new Map<string, number[]>()
    for (const k of keys.flatMap((k) => findIssueKeys(k))) {
      const p = parseIssueKey(k)!
      const list = byProject.get(p.project) ?? []
      list.push(p.number)
      byProject.set(p.project, list)
    }
    for (const [proj, numbers] of byProject) {
      const space = await knownKey(proj)
      if (!space) continue
      try {
        const { rows } = await data(ctx, space).issues.find({
          where: { number: { in: numbers } },
          limit: 1000,
        })
        for (const r of rows as unknown as IssueRow[]) out[formatIssueKey(proj, r.number)] = issueUri(r.id)
      } catch {
        // Not a member: nothing to resolve there.
      }
    }
    return out
  }

  void documentsOf

  return {
    hooks,
    data,
    registry,
    spaceOfKey,
    project,
    states,
    labelsOf,
    createProject,
    stateFields,
    getIssue,
    findIssue,
    createIssue,
    updateIssue,
    updateMany,
    move,
    follow,
    relate,
    relations,
    comment,
    editComment,
    deleteComment,
    react,
    resolveKeys,
    excerpt,
    lastRank,
    notifyAssigned,
  }
}

export type Core = ReturnType<typeof createCore>
