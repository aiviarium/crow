// Issues that come from another tracker: a project is linked to repositories of a source
// (`projectSources`, one row per link); the source's plugin contributes to `projects.issueSources` and brings
// changes in through the `projects` service (`issues.upsertFromSource`, `comments.upsertFromSource`), and
// changes made in Crow go out through the job `projects.pushToSource`, which calls the source's `push` as the
// person who made them.
//
// Inbound writes are made as the plugin (history shows the source, not the person whose sync ran) and never
// queue a push, so nothing echoes. Each synced field remembers what both sides last agreed on (`source.base`)
// and when Crow last wrote it (`source.crowAt`): an inbound value is taken when only the source changed, and
// when both changed the later write wins and the losing value goes into `source.conflicts`, which the issue's
// activity shows.
import { type Ctx, mentions, plainText, type RichText, type Rookery, RookeryError } from "@rookery/sdk"
import { formatIssueKey, isProjectKey, keyWords } from "../lib/keys"
import {
  CATEGORY_ICON,
  type CommentRow,
  closed,
  type IssueRow,
  issueLabel,
  type LabelRow,
} from "../lib/model"
import { between } from "../lib/rank"
import {
  type CommentOrigin,
  decide,
  hueOf,
  type IssueSource,
  type IssueSourceContribution,
  labelSet,
  type RemoteState,
  remoteState,
  remoteStateOf,
  type SourceError,
  type SourceLink,
  type SourcePerson,
  SYNC_FIELDS,
  type SyncField,
  sameList,
  sameMarkdown,
  sourceKey,
  stateFor,
  withConflict,
} from "../lib/source"
import { type Core, idOf, issueUri, KIND, stateFields, userUri } from "./core"
import {
  callPluginService,
  extrasOf,
  fallbackTextDoc,
  requireAccess,
  sendNotice,
  toRookeryError,
} from "./sdk"

/** How an issue is found by its number in a repository of a source. */
const refOf = (link: SourceLink, n: number | undefined | null) => (n ? `${link.repository}#${n}` : null)

/** An issue as a source gives it to `issues.upsertFromSource`. */
export interface SourceIssueIn {
  external: string
  number?: number
  ref: string
  url: string
  title: string
  /** Markdown; mentions of people the source knows are links to their `user://` URIs. */
  body?: string | null
  state: "open" | "closed"
  stateReason?: string | null
  labels?: Array<{ name: string; color?: string | null }>
  assignees?: SourcePerson[]
  author?: SourcePerson | null
  createdAt?: string | null
  updatedAt: string
  /** The Crow issue this is: one created in Crow that the source has just created too. */
  crowId?: string | null
  /** Entities the issue linked to before it came through here (a conversion). */
  links?: string[]
  removed?: "deleted" | "transferred" | null
}

export interface SourceCommentIn {
  external: string
  body: string
  author?: SourcePerson | null
  createdAt?: string | null
  updatedAt?: string | null
  url?: string | null
  /** The Crow comment this is (one written in Crow that the source has just created too). */
  crowId?: string | null
}

export interface PushParams {
  space: string
  issue: string
  fields?: SyncField[]
  /** Create the issue on the source, through this link. */
  create?: string
  comment?: { op: "create" | "edit" | "delete"; id: string; external?: string }
}

interface ContributionEntry extends IssueSourceContribution {
  plugin: string
}

const now = () => new Date().toISOString()
const ts = (v: string | null | undefined) => (v ? Date.parse(v) : 0)

export function createSources(rookery: Rookery, core: Core) {
  // ── contributions ─────────────────────────────────────────────────────────────────────────────────

  let cache: { at: number; list: ContributionEntry[] } | null = null
  async function contributions(): Promise<ContributionEntry[]> {
    if (cache && Date.now() - cache.at < 30_000) return cache.list
    let list: ContributionEntry[] = []
    try {
      list = (await rookery.extensions.list("projects.issueSources")).map((c) => ({
        ...(c.value as IssueSourceContribution),
        plugin: c.plugin,
      }))
    } catch (e) {
      rookery.log.warn(`reading projects.issueSources failed: ${String(e)}`)
    }
    cache = { at: Date.now(), list }
    return list
  }
  async function contribution(provider: string): Promise<ContributionEntry> {
    const c = (await contributions()).find((x) => x.id === provider)
    if (!c) throw new RookeryError("UNAVAILABLE", `no plugin syncs issues with ${provider} now`)
    return c
  }
  /** Calls a method on the service a source names in its contribution to `projects.issueSources`. */
  const callSource = <T = unknown>(
    c: ContributionEntry,
    ctx: Ctx | null,
    method: string,
    params: Record<string, unknown>,
  ) => callPluginService<T>(rookery, ctx, c.plugin, c.service, method, params)

  // ── links ─────────────────────────────────────────────────────────────────────────────────────────

  async function linksOf(space: string): Promise<SourceLink[]> {
    const { rows } = await rookery.data.projectSources.find({ where: { space }, limit: 100 })
    return rows as unknown as SourceLink[]
  }
  async function linkById(id: string): Promise<SourceLink | null> {
    return ((await rookery.data.projectSources.get(id)) as unknown as SourceLink | null) ?? null
  }
  async function linkFor(provider: string, repository: string, repoSpace?: string | null) {
    const { rows } = await rookery.data.projectSources.find({
      where: { provider, repository, ...(repoSpace ? { repoSpace } : {}) },
      limit: 10,
    })
    return (rows[0] as unknown as SourceLink | undefined) ?? null
  }

  /** A key for a new project from a repository's name: letters of it, made unique. */
  async function keyFor(name: string): Promise<string> {
    const repo = name.split("/").pop() ?? name
    const words = repo
      .replace(/[^A-Za-z0-9]+/g, " ")
      .trim()
      .split(/\s+/)
      .filter(Boolean)
    let base = (words.length > 1 ? words.map((w) => w[0]).join("") : (words[0] ?? "REPO").slice(0, 4))
      .toUpperCase()
      .replace(/^[0-9]+/, "")
    if (base.length < 2)
      base = `${base}${(words[0] ?? "RX").toUpperCase()}`.replace(/[^A-Z0-9]/g, "").slice(0, 4)
    if (!/^[A-Z]/.test(base)) base = `R${base}`
    base = base.slice(0, 8)
    for (let n = 0; n < 100; n++) {
      const key = n === 0 ? base : `${base.slice(0, 8)}${n + 1}`
      if (isProjectKey(key) && !(await core.spaceOfKey(key))) return key
    }
    throw new RookeryError("CONFLICT", `no free key for ${name}`)
  }

  /**
   * Links a project to a repository of a source; creates the project first when none is named (as the person,
   * who owns it: named after the repository, with a key derived from it). A repository has one project per
   * space it is attached to: linking it again moves the link.
   */
  async function link(
    ctx: Ctx,
    p: {
      provider: string
      repository: string
      name: string
      url?: string | null
      repoSpace?: string | null
      connection?: string | null
      project?: string | null
      projectName?: string | null
      key?: string | null
    },
  ) {
    if (!ctx.user) throw new RookeryError("FORBIDDEN", "linking a project needs a person")
    let space = p.project ?? null
    let created = false
    if (space) {
      if (!/^[0-9a-f-]{36}$/i.test(space)) {
        const s = await core.spaceOfKey(space)
        if (!s) throw new RookeryError("NOT_FOUND", `no project ${space}`)
        space = s
      }
      await requireAccess(ctx, `space://${space}`, "manage")
    } else {
      const name = (p.projectName?.trim() || p.name.split("/").pop() || p.name).slice(0, 100)
      const key = p.key?.trim().toUpperCase() || (await keyFor(p.name))
      const made = await core.createProject(ctx, { name, key })
      space = made.space.id
      created = true
    }
    const existing = await linkFor(p.provider, p.repository, p.repoSpace ?? null)
    if (existing && existing.space !== space) {
      if (created) {
        rookery.log.warn(`${p.name} was linked to another project meanwhile`)
      }
      const other = await core.project(null, existing.space).catch(() => null)
      throw new RookeryError(
        "CONFLICT",
        `${p.name} is linked to ${other?.name ?? "another project"} already`,
        {
          reason: "projects_source_linked",
          fix: "Unlink it in that project's settings first.",
          space: existing.space,
        },
      )
    }
    const values = {
      space,
      provider: p.provider,
      repository: p.repository,
      name: p.name,
      url: p.url ?? null,
      repoSpace: p.repoSpace ?? null,
      connection: p.connection ?? null,
    }
    const row = (existing
      ? await rookery.data.projectSources.update(existing.id, values as never)
      : await rookery.data.projectSources.insert(values as never)) as unknown as SourceLink
    const proj = await core.project(null, space)
    return { link: row, space, key: proj.key, name: proj.name, created }
  }

  async function unlink(ctx: Ctx, id: string, opts: { tell?: boolean } = {}) {
    const row = await linkById(id)
    if (!row) return { removed: false }
    await requireAccess(ctx, `space://${row.space}`, "manage")
    await rookery.data.projectSources.delete(id)
    if (opts.tell !== false) {
      const c = (await contributions()).find((x) => x.id === row.provider)
      if (c?.unlinked) await callSource(c, ctx, c.unlinked, { link: row }).catch(() => {})
    }
    return { removed: true, link: row }
  }

  // ── labels ────────────────────────────────────────────────────────────────────────────────────────

  /** Label ids for names in a project, creating the missing ones with the source's colour. */
  async function labelIds(space: string, labels: Array<{ name: string; color?: string | null }>) {
    const all = await core.labelsOf(null, space)
    const out: string[] = []
    for (const l of labels) {
      const name = l.name.trim()
      if (!name) continue
      let hit = all.find((x) => x.name.toLowerCase() === name.toLowerCase())
      if (!hit) {
        hit = (await rookery.data.labels.insert({
          name,
          color: hueOf(l.color),
          scope: `space://${space}`,
        } as never)) as unknown as LabelRow
        all.push(hit)
      }
      out.push(`label://${hit.id}`)
    }
    return [...new Set(out)]
  }
  const labelNames = async (space: string, ids: string[]) => {
    const all = await core.labelsOf(null, space)
    return ids
      .map((id) => all.find((l) => `label://${l.id}` === id))
      .filter((l): l is LabelRow => !!l)
      .map((l) => ({ name: l.name, color: l.color }))
  }

  // ── people ────────────────────────────────────────────────────────────────────────────────────────

  /** The Crow assignee among the source's: the current one if still there, else the first who is a user. */
  const pickAssignee = (people: SourcePerson[], current: string | null) => {
    const users = people.map((p) => (p.user ? userUri(p.user) : null)).filter((u): u is string => !!u)
    if (current && users.includes(current)) return current
    return users[0] ?? null
  }
  const externals = (people: SourcePerson[]) =>
    people
      .filter((p) => !p.user)
      .map((p) => ({ login: p.login, avatar: p.avatar ?? null, url: p.url ?? null }))

  // ── inbound issues ────────────────────────────────────────────────────────────────────────────────

  const byKey = async (space: string, key: string) => {
    const { rows } = await rookery.data
      .space(space)
      .issues.find({ where: { sourceKey: key }, limit: 1, trashed: false })
    return (rows[0] as unknown as IssueRow | undefined) ?? null
  }

  const byRef = async (space: string, ref: string | null) => {
    if (!ref) return null
    const { rows } = await rookery.data
      .space(space)
      .issues.find({ where: { sourceRef: ref }, limit: 1, trashed: false })
    return (rows[0] as unknown as IssueRow | undefined) ?? null
  }

  /** The issues synced through a repository's link: numbers, ids, removal, and how many synced comments each has. */
  async function listFromSource(p: {
    provider: string
    repository: string
    repoSpace?: string | null
    externals?: string[]
    comments?: boolean
  }) {
    const link = await linkFor(p.provider, p.repository, p.repoSpace)
    if (!link) return []
    const d = rookery.data.space(link.space)
    const where = p.externals
      ? { sourceKey: { in: p.externals.map((e) => sourceKey(link.provider, e)) } }
      : { sourceRef: { ne: null } }
    const rows: IssueRow[] = []
    let after: string | undefined
    do {
      const page = await d.issues.find({ where: where as never, limit: 1000, ...(after ? { after } : {}) })
      rows.push(...(page.rows as unknown as IssueRow[]))
      after = page.next ?? undefined
    } while (after && !p.externals)
    const mine = rows.filter(
      (r) =>
        (r.source as IssueSource | null)?.link === link.id || r.sourceRef?.startsWith(`${link.repository}#`),
    )
    const out = []
    for (const r of mine) {
      const src = r.source as IssueSource
      out.push({
        id: r.id,
        number: src.number,
        external: src.external,
        removed: src.removed ?? null,
        ...(p.comments
          ? {
              comments: await d.comments.count({
                where: { issue: issueUri(r.id), originKey: { ne: null } } as never,
              }),
            }
          : {}),
      })
    }
    return out
  }

  /** The source says an issue is gone (deleted, or moved to another repository): the issue says so. */
  async function removedAtSource(p: {
    provider: string
    repository: string
    repoSpace?: string | null
    external: string
    removed: "deleted" | "transferred"
  }) {
    const link = await linkFor(p.provider, p.repository, p.repoSpace)
    if (!link) return { linked: false }
    const issue = await byKey(link.space, sourceKey(link.provider, p.external))
    if (!issue) return { linked: true, missing: true }
    if (issue.source?.removed === p.removed) return { linked: true }
    await rookery.data
      .space(link.space)
      .issues.update(issue.id, { source: { ...(issue.source as IssueSource), removed: p.removed } } as never)
    return { linked: true, removed: p.removed }
  }

  async function docMarkdown(issue: IssueRow): Promise<string> {
    if (!issue.document) return ""
    return (
      (await extrasOf(rookery)
        .documents?.markdown(null, issue.document)
        .catch(() => "")) ?? ""
    )
  }

  async function setDescription(
    issue: IssueRow,
    markdown: string,
  ): Promise<{ document: string | null; md: string }> {
    const docs = extrasOf(rookery).documents
    if (!docs) return { document: issue.document ?? null, md: markdown }
    let doc = issue.document
    if (!doc) {
      const made = await docs.create(null, {
        parent: issueUri(issue.id),
        title: issue.title,
        markdown,
      })
      doc = made.id
    } else {
      await docs.edit(null, doc, [{ op: "setContent", markdown }], {
        author: { name: "GitHub" },
      })
    }
    return { document: doc, md: await docs.markdown(null, doc).catch(() => markdown) }
  }

  /** Creates the Crow issue for one the source has and Crow does not, as the plugin. */
  async function createFrom(link: SourceLink, item: SourceIssueIn, quiet: boolean): Promise<IssueRow> {
    const space = link.space
    const d = rookery.data.space(space)
    const proj = await core.project(null, space)
    const states = await core.states(null, space)
    const remote = remoteState(item.state, item.stateReason)
    const st = stateFor(remote, null, states) ?? null
    const people = item.assignees ?? []
    const assignee = pickAssignee(people, null)
    const labels = await labelIds(space, item.labels ?? [])
    const author = item.author?.user ? userUri(item.author.user) : null
    const at = now()
    const source: IssueSource = {
      provider: link.provider,
      external: item.external,
      ref: item.ref,
      url: item.url,
      number: item.number,
      link: link.id,
      remoteUpdatedAt: item.updatedAt,
      syncedAt: null,
      base: {
        title: item.title,
        body: item.body ?? "",
        state: remote,
        labels: labelSet((item.labels ?? []).map((l) => l.name)),
        assignee,
      },
      crowAt: {},
      author: item.author ?? null,
      people: externals(people),
      ...(item.removed ? { removed: item.removed } : {}),
      ...(item.createdAt ? { createdAt: item.createdAt } : {}),
    } as IssueSource
    const inserted = (await d.issues.insert({
      title: item.title.trim() || "Untitled",
      label: item.title,
      ...stateFields(st, null, at),
      icon: st ? CATEGORY_ICON[st.category] : "list",
      priority: 0,
      assignee,
      labels,
      rank: between(await core.lastRank(null, space), null),
      followers: [...new Set([...(author ? [author] : []), ...(assignee ? [assignee] : [])])],
      source,
      sourceKey: sourceKey(link.provider, item.external),
      sourceRef: refOf(link, item.number),
      ...(item.links?.length ? { links: item.links } : {}),
    } as never)) as unknown as IssueRow
    const key = formatIssueKey(proj.key, inserted.number)
    let row = (await d.issues.update(inserted.id, {
      key,
      keyWords: keyWords(key),
      label: issueLabel(key, inserted.title),
    } as never)) as unknown as IssueRow
    if ((item.body ?? "").trim()) {
      const desc = await setDescription(row, item.body ?? "")
      row = (await d.issues.update(row.id, {
        ...(desc.document ? { document: desc.document } : {}),
        source: { ...source, base: { ...source.base, bodyCrow: desc.md } },
      } as never)) as unknown as IssueRow
    } else {
      row = (await d.issues.update(row.id, {
        source: { ...source, base: { ...source.base, bodyCrow: "" } },
      } as never)) as unknown as IssueRow
    }
    if (!quiet && assignee) await notify(assignee, row, `Assigned to you on ${providerTitle(link)}`)
    return row
  }

  const providerTitle = (link: SourceLink) => (link.provider === "github" ? "GitHub" : link.provider)

  async function notify(user: string, issue: IssueRow, what: string) {
    await sendNotice(rookery, {
      user: idOf(user),
      kind: "action",
      title: `${what}: ${issue.key}`.slice(0, 200),
      body: issue.title,
      resource: issueUri(issue.id),
    })
  }

  /** Links a Crow issue to the source's copy of it, which the source just created: both now agree. */
  async function adopt(link: SourceLink, issue: IssueRow, item: SourceIssueIn): Promise<IssueRow> {
    const md = await docMarkdown(issue)
    const source: IssueSource = {
      ...(issue.source ?? ({} as IssueSource)),
      provider: link.provider,
      external: item.external,
      ref: item.ref,
      url: item.url,
      number: item.number,
      link: link.id,
      remoteUpdatedAt: item.updatedAt,
      syncedAt: now(),
      base: {
        title: item.title,
        body: item.body ?? "",
        bodyCrow: md,
        state: remoteState(item.state, item.stateReason),
        labels: labelSet((item.labels ?? []).map((l) => l.name)),
        assignee: pickAssignee(item.assignees ?? [], issue.assignee),
      },
      crowAt: issue.source?.crowAt ?? {},
      author: item.author ?? null,
      people: externals(item.assignees ?? []),
      error: null,
    }
    return (await rookery.data.space(issue.spaceId).issues.update(issue.id, {
      source,
      sourceKey: sourceKey(link.provider, item.external),
      sourceRef: refOf(link, item.number),
    } as never)) as unknown as IssueRow
  }

  /** Applies what the source says about an issue Crow has, field by field. */
  async function apply(link: SourceLink, issue: IssueRow, item: SourceIssueIn, quiet: boolean) {
    const src: IssueSource = { ...(issue.source as IssueSource) }
    const base = { ...(src.base ?? {}) }
    const crowAt = src.crowAt ?? {}
    const values: Record<string, unknown> = {}
    let conflicts = src.conflicts
    const at = item.updatedAt
    const conflict = (field: SyncField, won: "crow" | "source", lost: unknown, kept: unknown) => {
      conflicts = withConflict(conflicts, { field, at: now(), won, lost, kept })
    }
    // Seen already: only what a source says besides its fields (people, removal) may differ.
    const fresh = ts(at) > ts(src.remoteUpdatedAt) || !src.base

    if (fresh) {
      // Title.
      {
        const d = decide({
          remoteChanged: item.title !== base.title,
          crowChanged: base.title !== undefined && issue.title !== base.title,
          same: item.title === issue.title,
          remoteAt: at,
          crowAt: crowAt.title,
        })
        if (d.kind === "apply" || (d.kind === "conflict" && d.won === "source")) {
          if (d.kind === "conflict") conflict("title", "source", issue.title, item.title)
          values.title = item.title.trim() || issue.title
          values.label = issueLabel(issue.key, values.title as string)
          base.title = item.title
        } else if (d.kind === "conflict") conflict("title", "crow", item.title, issue.title)
        else if (item.title === issue.title) base.title = item.title
      }
      // Description.
      const body = item.body ?? ""
      if (!sameMarkdown(body, base.body)) {
        const md = await docMarkdown(issue)
        const d = decide({
          remoteChanged: true,
          crowChanged: base.bodyCrow !== undefined && !sameMarkdown(md, base.bodyCrow),
          same: sameMarkdown(md, body),
          remoteAt: at,
          crowAt: crowAt.body,
        })
        if (d.kind === "apply" || (d.kind === "conflict" && d.won === "source")) {
          if (d.kind === "conflict") conflict("body", "source", md, body)
          const desc = await setDescription(issue, body)
          if (desc.document && desc.document !== issue.document) values.document = desc.document
          base.body = body
          base.bodyCrow = desc.md
        } else if (d.kind === "conflict") conflict("body", "crow", body, md)
        else if (sameMarkdown(md, body)) {
          base.body = body
          base.bodyCrow = md
        }
      }
      // State.
      {
        const remote: RemoteState = remoteState(item.state, item.stateReason)
        const mine = remoteStateOf(issue.stateCategory)
        const d = decide({
          remoteChanged: remote !== base.state,
          crowChanged: base.state !== undefined && mine !== base.state,
          same: remote === mine,
          remoteAt: at,
          crowAt: crowAt.state,
        })
        if (d.kind === "apply" || (d.kind === "conflict" && d.won === "source")) {
          if (d.kind === "conflict") conflict("state", "source", issue.stateName, remote)
          const states = await core.states(null, issue.spaceId)
          const st = stateFor(remote, issue.stateCategory, states)
          if (st !== undefined) Object.assign(values, stateFields(st, issue, now()))
          base.state = remote
        } else if (d.kind === "conflict") conflict("state", "crow", remote, issue.stateName)
        else if (remote === mine) base.state = remote
      }
      // Labels.
      {
        const remote = labelSet((item.labels ?? []).map((l) => l.name))
        const mine = labelSet((await labelNames(issue.spaceId, issue.labels ?? [])).map((l) => l.name))
        const d = decide({
          remoteChanged: !sameList(remote, base.labels),
          crowChanged: base.labels !== undefined && !sameList(mine, base.labels),
          same: sameList(remote, mine),
          remoteAt: at,
          crowAt: crowAt.labels,
        })
        if (d.kind === "apply" || (d.kind === "conflict" && d.won === "source")) {
          if (d.kind === "conflict") conflict("labels", "source", mine, remote)
          values.labels = await labelIds(issue.spaceId, item.labels ?? [])
          base.labels = remote
        } else if (d.kind === "conflict") conflict("labels", "crow", remote, mine)
        else if (sameList(remote, mine)) base.labels = remote
      }
      // Assignee.
      {
        const remote = pickAssignee(item.assignees ?? [], issue.assignee)
        const d = decide({
          remoteChanged: remote !== (base.assignee ?? null),
          crowChanged: base.assignee !== undefined && issue.assignee !== (base.assignee ?? null),
          same: remote === issue.assignee,
          remoteAt: at,
          crowAt: crowAt.assignee,
        })
        if (d.kind === "apply" || (d.kind === "conflict" && d.won === "source")) {
          if (d.kind === "conflict") conflict("assignee", "source", issue.assignee, remote)
          values.assignee = remote
          if (remote && !issue.followers?.includes(remote))
            values.followers = [...(issue.followers ?? []), remote]
          base.assignee = remote
        } else if (d.kind === "conflict") conflict("assignee", "crow", remote, issue.assignee)
        else if (remote === issue.assignee) base.assignee = remote
      }
    }

    const next: IssueSource = {
      ...src,
      provider: link.provider,
      external: item.external,
      ref: item.ref,
      url: item.url,
      number: item.number ?? src.number,
      link: link.id,
      remoteUpdatedAt: ts(at) > ts(src.remoteUpdatedAt) ? at : src.remoteUpdatedAt,
      base,
      author: item.author ?? src.author ?? null,
      people: item.assignees ? externals(item.assignees) : (src.people ?? []),
      removed: item.removed ?? null,
      conflicts,
    }
    if (JSON.stringify(next) !== JSON.stringify(issue.source)) values.source = next
    const ref = refOf(link, next.number)
    if (ref && ref !== issue.sourceRef) values.sourceRef = ref
    if (!Object.keys(values).length) return { row: issue, changed: false }
    const row = (await rookery.data
      .space(issue.spaceId)
      .issues.update(issue.id, values as never)) as unknown as IssueRow
    if (!quiet && values.assignee && values.assignee !== issue.assignee)
      await notify(values.assignee as string, row, `Assigned to you on ${providerTitle(link)}`)
    return { row, changed: true }
  }

  async function upsertIssues(
    ctx: Ctx | null,
    p: {
      provider: string
      repository: string
      repoSpace?: string | null
      items: SourceIssueIn[]
      quiet?: boolean
    },
  ) {
    void ctx
    const link = await linkFor(p.provider, p.repository, p.repoSpace)
    if (!link) return { linked: false, issues: [] }
    const out: Array<{ external: string; id: string; key: string; created: boolean; changed: boolean }> = []
    for (const item of p.items) {
      const key = sourceKey(link.provider, item.external)
      let issue = await byKey(link.space, key)
      let created = false
      let changed = true
      if (!issue && item.crowId) {
        const mine = await core.getIssue(null, link.space, item.crowId)
        if (mine) issue = await adopt(link, mine, item)
      } else if (!issue) {
        issue = await createFrom(link, item, !!p.quiet)
        created = true
      } else {
        const r = await apply(link, issue, item, !!p.quiet)
        issue = r.row
        changed = r.changed
      }
      if (issue) out.push({ external: item.external, id: issue.id, key: issue.key, created, changed })
    }
    return { linked: true, space: link.space, issues: out }
  }

  // ── inbound comments ──────────────────────────────────────────────────────────────────────────────

  const excerpt = (doc: RichText) => core.excerpt(doc)

  const mdToRichText = async (md: string): Promise<RichText> => {
    const docs = extrasOf(rookery).documents
    if (docs) return docs.fromMarkdown(null, md)
    return fallbackTextDoc(md)
  }

  const richTextToMd = async (body: RichText): Promise<string> => {
    const docs = extrasOf(rookery).documents
    if (docs) return docs.toMarkdown(null, body)
    return plainText(body)
  }

  async function upsertComments(
    ctx: Ctx | null,
    p: {
      provider: string
      repository: string
      repoSpace?: string | null
      /** The issue: the source's id of it, or its number in the repository. */
      issue?: string
      number?: number
      comments: SourceCommentIn[]
      /** The list is every comment the source has on the issue: synced ones it does not list are deleted. */
      complete?: boolean
      quiet?: boolean
    },
  ) {
    void ctx
    const link = await linkFor(p.provider, p.repository, p.repoSpace)
    if (!link) return { linked: false }
    const issue = p.issue
      ? await byKey(link.space, sourceKey(link.provider, p.issue))
      : await byRef(link.space, refOf(link, p.number))
    if (!issue) return { linked: true, missing: true }
    const d = rookery.data.space(link.space)
    const uri = issueUri(issue.id)
    const { rows } = await d.comments.find({ where: { issue: uri }, limit: 1000 })
    const existing = rows as unknown as Array<
      CommentRow & { origin?: CommentOrigin & { body?: string }; originKey?: string | null }
    >
    const byOrigin = new Map(existing.filter((c) => c.originKey).map((c) => [c.originKey!, c]))
    let created = 0
    let updated = 0
    let fresh = issue
    for (const c of p.comments) {
      const key = sourceKey(link.provider, c.external)
      const origin = {
        provider: link.provider,
        external: c.external,
        url: c.url ?? null,
        author: c.author ?? null,
        remoteUpdatedAt: c.updatedAt ?? c.createdAt ?? null,
        createdAt: c.createdAt ?? null,
        body: c.body,
      }
      const known = byOrigin.get(key)
      if (known) {
        const before = known.origin ?? ({} as CommentOrigin & { body?: string })
        if (c.body === before.body || ts(origin.remoteUpdatedAt) <= ts(before.remoteUpdatedAt)) continue
        // Edited on both sides: the later edit wins.
        if (known.editedAt && ts(known.editedAt) > ts(origin.remoteUpdatedAt)) continue
        const body = await mdToRichText(c.body)
        await d.comments.update(known.id, {
          body,
          excerpt: excerpt(body),
          origin,
          editedAt: origin.remoteUpdatedAt,
        } as never)
        updated++
        continue
      }
      if (c.crowId) {
        const mine = existing.find((x) => x.id === c.crowId)
        if (mine) {
          await d.comments.update(mine.id, { origin, originKey: key } as never)
          byOrigin.set(key, mine)
          continue
        }
      }
      const body = await mdToRichText(c.body)
      const author = c.author?.user ? userUri(c.author.user) : null
      const row = (await d.comments.insert({
        issue: uri,
        body,
        excerpt: excerpt(body),
        author,
        origin,
        originKey: key,
      } as never)) as unknown as CommentRow
      byOrigin.set(key, row as never)
      created++
      if (author && !fresh.followers?.includes(author)) fresh = await core.follow(null, fresh, author)
      if (!p.quiet) {
        const mentioned = mentions(body).filter((m) => m.startsWith("user://"))
        const who = c.author?.login ?? "Someone"
        for (const f of fresh.followers ?? []) {
          if (f === author || mentioned.includes(f)) continue
          await sendNotice(rookery, {
            user: idOf(f),
            kind: "info",
            title: `${who} commented on ${fresh.key} ${fresh.title}`.slice(0, 200),
            body: excerpt(body),
            resource: uri,
          })
        }
      }
    }
    let removed = 0
    if (p.complete) {
      const listed = new Set(p.comments.map((c) => sourceKey(link.provider, c.external)))
      for (const c of existing)
        if (c.originKey?.startsWith(`${link.provider}:`) && !listed.has(c.originKey)) {
          await d.comments.delete(c.id)
          removed++
        }
    }
    return { linked: true, created, updated, removed }
  }

  // ── outbound ──────────────────────────────────────────────────────────────────────────────────────

  /** What Crow has for each synced field now, as the source compares it. */
  async function current(issue: IssueRow) {
    const labels = await labelNames(issue.spaceId, issue.labels ?? [])
    return {
      title: issue.title,
      body: await docMarkdown(issue),
      state: remoteStateOf(issue.stateCategory),
      labels,
      assignee: issue.assignee,
    }
  }

  /**
   * The synced fields a write changes as the source would see them (moving between two started states is no
   * change for GitHub). For core.updateIssue: their `crowAt` goes into the same write, then a push is queued.
   */
  function touched(issue: IssueRow, values: Record<string, unknown>): SyncField[] {
    if (!issue.source?.link) return []
    const base = issue.source.base ?? {}
    const out: SyncField[] = []
    if (values.title !== undefined && values.title !== base.title) out.push("title")
    if (
      values.stateCategory !== undefined &&
      remoteStateOf(values.stateCategory as never) !== remoteStateOf(issue.stateCategory)
    )
      out.push("state")
    if (values.labels !== undefined) out.push("labels")
    if (values.assignee !== undefined && values.assignee !== issue.assignee) out.push("assignee")
    return out
  }

  function stamp(issue: IssueRow, fields: SyncField[]): IssueSource {
    const at = now()
    const crowAt = { ...(issue.source?.crowAt ?? {}) }
    for (const f of fields) crowAt[f] = at
    return { ...(issue.source as IssueSource), crowAt }
  }

  async function queue(_ctx: Ctx | null, p: PushParams) {
    try {
      await rookery.jobs.enqueue("projects/pushToSource", p as unknown as Record<string, unknown>, {
        ...(p.create ? { dedupeKey: `create:${p.issue}` } : {}),
      })
    } catch (e) {
      rookery.log.warn(`queueing a push of ${p.issue} failed: ${String(e)}`)
    }
  }

  async function recordError(issue: IssueRow, err: SourceError | null) {
    const fresh = ((await core.getIssue(null, issue.spaceId, issue.id)) ?? issue) as IssueRow
    const src = (fresh.source ?? {}) as IssueSource
    if (!err && !src.error) return
    await rookery.data
      .space(issue.spaceId)
      .issues.update(issue.id, { source: { ...src, error: err } } as never)
      .catch((e) => rookery.log.warn(`recording the sync state of ${issue.id} failed: ${String(e)}`))
  }

  /** The job: writes the changed fields (or a comment) to the source, as the person who made the change. */
  async function push(ctx: Ctx, p: PushParams) {
    const issue = await core.getIssue(null, p.space, p.issue)
    if (!issue) return { skipped: "gone" }
    const src = issue.source as IssueSource | null
    const linkId = p.create ?? src?.link
    if (!linkId) return { skipped: "local" }
    if (p.create && src?.external) return { skipped: "created" }
    const link = await linkById(linkId)
    if (!link) return { skipped: "unlinked" }
    if (src?.removed) return { skipped: "removed" }
    const c = await contribution(link.provider)
    const now_ = await current(issue)
    const base = src?.base ?? {}
    const differs: Record<SyncField, boolean> = {
      title: now_.title !== base.title,
      body: !sameMarkdown(now_.body, base.bodyCrow),
      state: now_.state !== base.state,
      labels: !sameList(
        now_.labels.map((l) => l.name),
        base.labels,
      ),
      assignee: (now_.assignee ?? null) !== (base.assignee ?? null),
    }
    const fields = p.create ? [...SYNC_FIELDS] : (p.fields ?? [...SYNC_FIELDS]).filter((f) => differs[f])
    let comment: Record<string, unknown> | undefined
    if (p.comment) {
      const row = (await rookery.data
        .space(p.space)
        .comments.get(p.comment.id)
        .catch(() => null)) as (CommentRow & { origin?: CommentOrigin }) | null
      if (p.comment.op === "delete") {
        const external = p.comment.external ?? row?.origin?.external
        if (external) comment = { op: "delete", id: p.comment.id, external }
      } else if (row) {
        const external = row.origin?.external
        if (p.comment.op === "create" && external) comment = undefined
        else
          comment = {
            op: external ? "edit" : "create",
            id: row.id,
            external: external ?? null,
            body: await richTextToMd(row.body as RichText),
          }
      }
    }
    if (!fields.length && !comment) return { skipped: "unchanged" }
    try {
      const r = await callSource<{
        external: string
        number?: number
        ref: string
        url: string
        remoteUpdatedAt?: string | null
        body?: string | null
        comment?: { external: string; url?: string | null; remoteUpdatedAt?: string | null; body?: string }
      }>(c, ctx, c.push, {
        link,
        create: !!p.create,
        external: src?.external ?? null,
        number: src?.number ?? null,
        fields,
        issue: {
          id: issue.id,
          key: issue.key,
          title: now_.title,
          body: now_.body,
          state: now_.state,
          labels: now_.labels,
          assignee: now_.assignee,
          people: src?.people ?? [],
        },
        ...(comment ? { comment } : {}),
      })
      const fresh = ((await core.getIssue(null, p.space, p.issue)) ?? issue) as IssueRow
      const fsrc = (fresh.source ?? {}) as IssueSource
      const nextBase = { ...(fsrc.base ?? {}) }
      for (const f of fields) {
        if (f === "title") nextBase.title = now_.title
        if (f === "body") {
          nextBase.body = r.body ?? now_.body
          nextBase.bodyCrow = now_.body
        }
        if (f === "state") nextBase.state = now_.state
        if (f === "labels") nextBase.labels = labelSet(now_.labels.map((l) => l.name))
        if (f === "assignee") nextBase.assignee = now_.assignee
      }
      const next: IssueSource = {
        ...fsrc,
        provider: link.provider,
        external: r.external,
        ref: r.ref,
        url: r.url,
        number: r.number ?? fsrc.number,
        link: link.id,
        remoteUpdatedAt:
          ts(r.remoteUpdatedAt) > ts(fsrc.remoteUpdatedAt) ? r.remoteUpdatedAt : fsrc.remoteUpdatedAt,
        syncedAt: now(),
        base: nextBase,
        error: null,
      }
      await rookery.data.space(p.space).issues.update(p.issue, {
        source: next,
        sourceKey: sourceKey(link.provider, r.external),
        sourceRef: refOf(link, next.number),
      } as never)
      if (comment && r.comment && comment.op !== "delete") {
        const key = sourceKey(link.provider, r.comment.external)
        await rookery.data
          .space(p.space)
          .comments.update(String(comment.id), {
            origin: {
              provider: link.provider,
              external: r.comment.external,
              url: r.comment.url ?? null,
              remoteUpdatedAt: r.comment.remoteUpdatedAt ?? null,
              body: r.comment.body ?? comment.body,
            },
            originKey: key,
          } as never)
          .catch(() => {})
      }
      return { pushed: fields, comment: comment?.op ?? null }
    } catch (e) {
      const err = toRookeryError(e)
      const details = (err.details ?? {}) as { reason?: string; fix?: string; retryAt?: string }
      const reason = details.reason ?? err.code.toLowerCase()
      const record: SourceError = {
        reason,
        message: err.message,
        ...(details.fix ? { fix: details.fix } : {}),
        at: now(),
        ...(details.retryAt ? { retryAt: details.retryAt } : {}),
        fields: fields.length ? fields : undefined,
        ...(comment ? { comment: { op: comment.op, id: comment.id } } : {}),
      } as SourceError
      await recordError(issue, record)
      if (err.code === "UNAVAILABLE" || err.code === "TIMEOUT") {
        const wait = details.retryAt ? ts(details.retryAt) - Date.now() : 0
        if (wait > 60_000) {
          await queue(ctx, p).catch(() => {})
          return { failed: reason, retryAt: details.retryAt }
        }
        throw err
      }
      return { failed: reason }
    }
  }

  /** Everything that differs from what the source has, and the comment that did not get through. */
  async function retry(ctx: Ctx, space: string, id: string) {
    const issue = await core.getIssue(ctx, space, id)
    if (!issue) throw new RookeryError("NOT_FOUND", "no such issue")
    await requireAccess(ctx, issueUri(id), "use")
    const src = issue.source as IssueSource | null
    if (!src?.link && !src?.external) throw new RookeryError("INVALID", "this issue does not sync")
    const failed = (src?.error as (SourceError & { comment?: PushParams["comment"] }) | null)?.comment
    await recordError(issue, null)
    if (!src.external && src.link) await queue(ctx, { space, issue: id, create: src.link })
    else
      await queue(ctx, { space, issue: id, fields: [...SYNC_FIELDS], ...(failed ? { comment: failed } : {}) })
    return { queued: true }
  }

  /** After someone edited the description in Crow: note when, and push it when it differs. */
  async function descriptionEdited(ctx: Ctx, space: string, id: string) {
    const issue = await core.getIssue(ctx, space, id)
    if (!issue?.source?.link || !issue.document) return { queued: false }
    await requireAccess(ctx, issueUri(id), "use")
    const md = await docMarkdown(issue)
    if (sameMarkdown(md, issue.source.base?.bodyCrow)) return { queued: false }
    await rookery.data.space(space).issues.update(id, { source: stamp(issue, ["body"]) } as never)
    await queue(ctx, { space, issue: id, fields: ["body"] })
    return { queued: true }
  }

  /** Where a new issue goes: the link chosen, the only one, or nowhere ("local", or several and none chosen). */
  async function linkForNew(space: string, choice?: string | null): Promise<SourceLink | null> {
    if (choice === "local") return null
    const links = await linksOf(space)
    if (choice) return links.find((l) => l.id === choice) ?? null
    return links.length === 1 ? links[0]! : null
  }

  /** The repositories a person may link the project to, from every source. */
  async function linkable(ctx: Ctx, space: string) {
    const out: Array<Record<string, unknown>> = []
    for (const c of await contributions()) {
      if (!c.repositories) continue
      try {
        const r = await callSource<{ repositories?: Array<Record<string, unknown>> }>(
          c,
          ctx,
          c.repositories,
          { space },
        )
        for (const x of r.repositories ?? []) out.push({ provider: c.id, providerTitle: c.title, ...x })
      } catch (e) {
        rookery.log.warn(`${c.id}: listing repositories failed: ${String(e)}`)
      }
    }
    return out
  }

  async function linkFromProject(
    ctx: Ctx,
    p: {
      space: string
      provider: string
      repository: string
      name: string
      url?: string
      repoSpace?: string
      connection?: string
    },
  ) {
    const r = await link(ctx, { ...p, project: p.space })
    const c = await contribution(p.provider)
    if (c.linked)
      await callSource(c, ctx, c.linked, { link: r.link }).catch((e) => {
        rookery.log.warn(`${c.id}: telling it about a link failed: ${String(e)}`)
      })
    return r
  }

  /** Projects whose issues come from a repository (for the source's own views: "Issues" opens them). */
  async function projectsOf(p: { provider: string; repository?: string; repoSpace?: string }) {
    const { rows } = await rookery.data.projectSources.find({
      where: {
        provider: p.provider,
        ...(p.repository ? { repository: p.repository } : {}),
        ...(p.repoSpace ? { repoSpace: p.repoSpace } : {}),
      },
      limit: 200,
    })
    const out = []
    for (const r of rows as unknown as SourceLink[]) {
      const reg = (await core.registry()).find((x) => x.space === r.space)
      out.push({ ...r, key: reg?.key ?? null })
    }
    return out
  }

  /** Finds the Crow issue for a source's ref (`owner/repo#212`) or id, as the caller may see it. */
  async function findBySource(
    ctx: Ctx | null,
    p: { provider: string; repository: string; repoSpace?: string; number?: number; external?: string },
  ) {
    const link = await linkFor(p.provider, p.repository, p.repoSpace)
    if (!link) return null
    const d = ctx ? ctx.data.space(link.space) : rookery.data.space(link.space)
    if (p.external) {
      const { rows } = await d.issues.find({
        where: { sourceKey: sourceKey(p.provider, p.external) },
        limit: 1,
      })
      const r = rows[0] as unknown as IssueRow | undefined
      return r ? { uri: issueUri(r.id), key: r.key, space: link.space } : null
    }
    const { rows } = await d.issues.find({ where: { sourceRef: refOf(link, p.number) ?? "" }, limit: 1 })
    const r = rows[0] as unknown as IssueRow | undefined
    return r ? { uri: issueUri(r.id), key: r.key, space: link.space } : null
  }

  void closed
  void KIND

  return {
    contributions,
    linksOf,
    linkById,
    linkFor,
    link,
    unlink,
    upsertIssues,
    upsertComments,
    listFromSource,
    removedAtSource,
    touched,
    stamp,
    queue,
    push,
    retry,
    descriptionEdited,
    linkForNew,
    linkable,
    linkFromProject,
    projectsOf,
    findBySource,
  }
}

export type Sources = ReturnType<typeof createSources>
