// The Projects plugin's host half. Issue writes go through here (`server/core.ts`) so derived fields,
// notifications and automations follow every change; the client half reads with live queries.
//
// Registered here: the RPC methods the client half calls, the `projects` service (other plugins, the GitHub
// plugin's issue keys, agent tools), `entities.text` for issues and projects, the import, rollover and
// summary jobs, agent tools where the server has them, and a watcher that repairs issues written past the
// plugin.
import { type ChangeEvent, type Ctx, definePlugin, type RichText, RookeryError, z } from "@rookery/sdk"
import { type Filter, matches, parseQuery, type Resolver } from "./lib/filter"
import { formatIssueKey, keyWords } from "./lib/keys"
import { CATEGORY_ICON, defaultState, firstOf, type IssueRow, issueLabel, type StateRow } from "./lib/model"
import { between } from "./lib/rank"
import { createAgents } from "./server/agents"
import { createAi } from "./server/ai"
import { createCore, type IssuePatch, idOf, issueUri, KIND, stateFields, uid } from "./server/core"
import { createCycles } from "./server/cycles"
import { createImporter, readImport } from "./server/importer"
import {
  agentsOf,
  documentsOf,
  entitiesOf,
  extrasOf,
  fallbackTextDoc,
  grantAccess,
  jobCtx,
  requireAccess,
  spaceGrants,
  subscribeCollections,
} from "./server/sdk"
import { createSources } from "./server/sources"
import { createText } from "./server/text"

const category = z.enum(["backlog", "unstarted", "started", "completed", "cancelled"])
const patchSchema = z.object({
  title: z.string().optional(),
  state: z.string().nullable().optional(),
  stateName: z.string().optional(),
  stateCategory: category.optional(),
  priority: z.number().int().min(0).max(4).optional(),
  assignee: z.string().nullable().optional(),
  labels: z.array(z.string()).optional(),
  addLabels: z.array(z.string()).optional(),
  removeLabels: z.array(z.string()).optional(),
  estimate: z.number().nullable().optional(),
  due: z.string().nullable().optional(),
  parent: z.string().nullable().optional(),
  cycle: z.string().nullable().optional(),
})
const item = z.object({ id: z.string(), space: z.string() })

export default definePlugin((rookery) => {
  const core = createCore(rookery)
  const text = createText(rookery, core)
  const ai = createAi(rookery, core, text)
  const agents = createAgents(rookery, core)
  const cycles = createCycles(rookery, core)
  const importer = createImporter(rookery, core)
  const sources = createSources(rookery, core)
  core.hooks.sources = sources as never

  const spaceOf = (ctx: Ctx, space?: string | null) => {
    const s = space ?? ctx.space
    if (!s) throw new RookeryError("INVALID", "open a project first")
    return s
  }

  /** A project space by key or id; the current space when none is named. */
  const projectSpace = async (ctx: Ctx, project?: string | null) => {
    if (!project) return spaceOf(ctx)
    if (/^[0-9a-f-]{36}$/i.test(project)) return project
    const s = await core.spaceOfKey(project)
    if (!s) throw new RookeryError("NOT_FOUND", `no project ${project}`)
    return s
  }

  const rpc = <S extends z.ZodTypeAny>(name: string, params: S, run: (ctx: Ctx, p: z.infer<S>) => unknown) =>
    rookery.rpc.handle(name, { level: "own", params, run: run as never })

  // ── projects ──────────────────────────────────────────────────────────────────────────────────────

  rpc(
    "createProject",
    z.object({
      name: z.string(),
      key: z.string(),
      summary: z.string().optional(),
      icon: z.string().optional(),
    }),
    (ctx, p) => core.createProject(ctx, p),
  )
  rpc(
    "updateProject",
    z.object({
      space: z.string(),
      patch: z.object({
        name: z.string().optional(),
        summary: z.string().nullable().optional(),
        icon: z.string().nullable().optional(),
        lead: z.string().nullable().optional(),
        archived: z.boolean().optional(),
        autoCloseParent: z.boolean().optional(),
        cycleWeeks: z.number().int().min(1).max(8).optional(),
        cycleAuto: z.boolean().optional(),
      }),
    }),
    async (ctx, { space, patch }) => {
      const proj = await core.project(ctx, space)
      const values: Record<string, unknown> = { ...patch }
      if (patch.lead) values.lead = patch.lead.startsWith("user://") ? patch.lead : `user://${patch.lead}`
      if (patch.name !== undefined) {
        const name = patch.name.trim()
        if (!name) throw new RookeryError("INVALID", "a project needs a name")
        values.name = name
        await extrasOf(rookery).spaces.rename?.(ctx, space, name)
      }
      const row = await core.data(ctx, space).projects.update(proj.id, values as never)
      if (patch.archived !== undefined) {
        const reg = (await core.registry()).find((r) => r.space === space)
        if (reg) await rookery.data.registry.update(reg.id, { archived: patch.archived } as never)
      }
      return row
    },
  )
  rpc("projectDocument", z.object({ space: z.string() }), async (ctx, { space }) => {
    const proj = await core.project(ctx, space)
    if (proj.document) return { id: proj.document }
    const docs = documentsOf(rookery)
    const uri = `project://${proj.id}`
    const existing = await docs.list(ctx, uri)
    if (existing[0]) return { id: existing[0].id }
    const doc = await docs.create(null, { parent: uri, title: proj.name })
    // The plugin records it: members may edit the document without being allowed to edit the project row.
    await rookery.data.space(space).projects.update(proj.id, { document: doc.id } as never)
    return { id: doc.id }
  })
  rpc("members", z.object({ space: z.string() }), async (ctx, { space }) => {
    const s = await spaceGrants(ctx, space)
    const people = [
      ...(s.owner ? [{ ...s.owner, level: "manage" as const, owner: true }] : []),
      ...s.grants.map((g) => ({ ...g, owner: false })),
    ]
    return {
      level: s.level,
      members: people
        .filter((p) => p.principal.startsWith("user:"))
        .map((p) => ({
          uri: `user://${p.principal.slice(5)}`,
          name: p.name,
          email: p.email,
          level: p.level,
          owner: p.owner,
        })),
      groups: people
        .filter((p) => p.principal.startsWith("group:"))
        .map((p) => ({ principal: p.principal, name: p.name, level: p.level })),
    }
  })
  rpc(
    "grant",
    z.object({ space: z.string(), user: z.string(), level: z.enum(["view", "use", "manage"]) }),
    (ctx, p) =>
      grantAccess(
        ctx,
        `space://${p.space}`,
        p.user.startsWith("group:") ? p.user : `user:${idOf(p.user)}`,
        p.level,
      ),
  )
  rpc("revoke", z.object({ space: z.string(), user: z.string() }), (ctx, p) =>
    ctx.access.revoke(`space://${p.space}`, p.user.startsWith("group:") ? p.user : `user:${idOf(p.user)}`),
  )
  rpc("repositories", z.object({ space: z.string() }), async (ctx, { space }) => ({
    repositories: (await extrasOf(rookery).env.repositories?.(ctx, space)) ?? [],
  }))
  rpc(
    "addRepository",
    z.object({ space: z.string(), url: z.string(), name: z.string().optional() }),
    async (ctx, p) => {
      const fn = extrasOf(rookery).env.addRepository
      if (!fn) throw new RookeryError("UNAVAILABLE", "environment repositories are not available yet")
      return fn(ctx, { space: p.space, url: p.url, ...(p.name ? { name: p.name } : {}) })
    },
  )
  rpc("resolveKeys", z.object({ keys: z.array(z.string()) }), (ctx, { keys }) => core.resolveKeys(ctx, keys))
  rpc("resolveKey", z.object({ key: z.string() }), async (ctx, { key }) => {
    const i = await core.findIssue(ctx, key)
    return i ? { id: i.id, space: i.spaceId, key: i.key } : null
  })

  // ── issues ────────────────────────────────────────────────────────────────────────────────────────

  rpc(
    "createIssue",
    patchSchema.extend({
      space: z.string(),
      title: z.string(),
      description: z.any().optional(),
      position: z.enum(["top", "bottom"]).optional(),
      /** Where else to create it: a source link's id, or `local`. */
      link: z.string().nullable().optional(),
      relations: z
        .array(z.object({ target: z.string(), kind: z.enum(["blocks", "relates", "duplicate"]) }))
        .optional(),
    }),
    async (ctx, p) => {
      const { space, relations, ...rest } = p
      const row = await core.createIssue(ctx, space, rest as never)
      for (const r of relations ?? []) await core.relate(ctx, space, issueUri(row.id), r.target, r.kind)
      return row
    },
  )
  rpc("update", z.object({ items: z.array(item).min(1).max(500), patch: patchSchema }), (ctx, p) =>
    core.updateMany(ctx, p.items, p.patch as IssuePatch),
  )
  rpc(
    "move",
    z.object({
      space: z.string(),
      id: z.string(),
      above: z.string().nullable().optional(),
      below: z.string().nullable().optional(),
      patch: patchSchema.optional(),
    }),
    (ctx, p) => core.move(ctx, p as never),
  )
  rpc("remove", z.object({ items: z.array(item).min(1).max(500) }), async (ctx, { items }) => {
    for (const it of items) await core.data(ctx, it.space).issues.delete(it.id)
    return { removed: items.length }
  })
  rpc("restore", z.object({ items: z.array(item).min(1).max(500) }), async (ctx, { items }) => {
    for (const it of items) await core.data(ctx, it.space).issues.restore(it.id)
    return { restored: items.length }
  })
  rpc("issueDocument", z.object({ space: z.string(), id: z.string() }), async (ctx, { space, id }) => {
    const issue = await core.getIssue(ctx, space, id)
    if (!issue) return null
    if (issue.document) return { id: issue.document }
    const docs = documentsOf(rookery)
    const uri = issueUri(id)
    const existing = await docs.list(ctx, uri)
    if (existing[0]) return { id: existing[0].id }
    const doc = await docs.create(ctx, { parent: uri, title: issue.title })
    // Two people opening an issue without a description at once: keep the first document.
    const now = await docs.list(ctx, uri)
    if (now[0] && now[0].id !== doc.id) {
      await docs.delete(ctx, doc.id).catch(() => {})
      return { id: now[0].id }
    }
    await core.data(ctx, space).issues.update(id, { document: doc.id } as never)
    return { id: doc.id }
  })
  rpc(
    "relate",
    z.object({
      space: z.string(),
      source: z.string(),
      target: z.string(),
      kind: z.enum(["blocks", "relates", "duplicate"]),
    }),
    (ctx, p) => core.relate(ctx, p.space, p.source, p.target, p.kind),
  )
  rpc("unrelate", z.object({ space: z.string(), id: z.string() }), (ctx, p) =>
    core.data(ctx, p.space).relations.delete(p.id),
  )
  rpc("relations", z.object({ space: z.string(), id: z.string() }), async (ctx, p) => {
    const issue = await core.getIssue(ctx, p.space, p.id)
    return { relations: issue ? await core.relations(ctx, issue) : [] }
  })
  rpc("follow", z.object({ space: z.string(), id: z.string(), on: z.boolean() }), async (ctx, p) => {
    const issue = await core.getIssue(ctx, p.space, p.id)
    if (!issue) throw new RookeryError("NOT_FOUND", "no such issue")
    return core.follow(ctx, issue, `user://${uid(ctx)}`, p.on)
  })

  // ── sources ───────────────────────────────────────────────────────────────────────────────────────

  /** The project's links, with what the client shows of each source (its name and icon). */
  rpc("sourceLinks", z.object({ space: z.string() }), async (ctx, { space }) => {
    await requireAccess(ctx, `space://${space}`, "view")
    const all = await sources.contributions()
    return {
      links: await sources.linksOf(space),
      sources: all.map((c) => ({ id: c.id, title: c.title, icon: c.icon ?? null })),
    }
  })
  rpc("sourceKinds", z.object({}), async () => ({
    sources: (await sources.contributions()).map((c) => ({ id: c.id, title: c.title, icon: c.icon ?? null })),
  }))
  rpc("linkable", z.object({ space: z.string() }), async (ctx, { space }) => {
    await requireAccess(ctx, `space://${space}`, "manage")
    return { repositories: await sources.linkable(ctx, space) }
  })
  rpc(
    "linkSource",
    z.object({
      space: z.string(),
      provider: z.string(),
      repository: z.string(),
      name: z.string(),
      url: z.string().optional(),
      repoSpace: z.string().optional(),
      connection: z.string().optional(),
    }),
    (ctx, p) => sources.linkFromProject(ctx, p),
  )
  rpc("unlinkSource", z.object({ id: z.string() }), (ctx, p) => sources.unlink(ctx, p.id))
  rpc("retrySync", z.object({ space: z.string(), id: z.string() }), (ctx, p) =>
    sources.retry(ctx, p.space, p.id),
  )
  rpc("descriptionEdited", z.object({ space: z.string(), id: z.string() }), (ctx, p) =>
    sources.descriptionEdited(ctx, p.space, p.id),
  )
  rookery.jobs.handle("projects.pushToSource", {
    params: z.object({
      space: z.string(),
      issue: z.string(),
      fields: z.array(z.enum(["title", "body", "state", "labels", "assignee"])).optional(),
      create: z.string().optional(),
      comment: z
        .object({ op: z.enum(["create", "edit", "delete"]), id: z.string(), external: z.string().optional() })
        .optional(),
    }),
    run: async (job, p) => {
      const r = await sources.push(jobCtx(rookery, job), p as never)
      await job.log(JSON.stringify(r))
      return r
    },
  })

  // ── comments ──────────────────────────────────────────────────────────────────────────────────────

  rpc("comment", z.object({ space: z.string(), issue: z.string(), body: z.any() }), (ctx, p) =>
    core.comment(ctx, p.space, p.issue, p.body as RichText),
  )
  rpc("editComment", z.object({ space: z.string(), id: z.string(), body: z.any() }), (ctx, p) =>
    core.editComment(ctx, p.space, p.id, p.body as RichText),
  )
  rpc("deleteComment", z.object({ space: z.string(), id: z.string() }), (ctx, p) =>
    core.deleteComment(ctx, p.space, p.id),
  )
  rpc("react", z.object({ space: z.string(), id: z.string(), emoji: z.string() }), (ctx, p) =>
    core.react(ctx, p.space, p.id, p.emoji),
  )

  // ── workflow ──────────────────────────────────────────────────────────────────────────────────────

  rpc(
    "deleteState",
    z.object({ space: z.string(), id: z.string(), moveTo: z.string() }),
    async (ctx, { space, id, moveTo }) => {
      const all = await core.states(ctx, space)
      if (all.length <= 1) throw new RookeryError("INVALID", "a project keeps at least one state")
      if (!all.some((s) => s.id === moveTo) || moveTo === id)
        throw new RookeryError("INVALID", "pick another state for its issues")
      const d = core.data(ctx, space)
      for (;;) {
        const { rows } = await d.issues.find({ where: { state: id }, limit: 200, trashed: false })
        if (!rows.length) break
        for (const r of rows as unknown as IssueRow[]) await core.updateIssue(ctx, r, { state: moveTo })
      }
      await d.states.delete(id)
      return { deleted: id }
    },
  )

  // ── cycles ────────────────────────────────────────────────────────────────────────────────────────

  rpc(
    "createCycle",
    z.object({
      space: z.string(),
      name: z.string().optional(),
      startsOn: z.string().optional(),
      endsOn: z.string().optional(),
    }),
    (ctx, p) => cycles.create(ctx, p.space, p),
  )
  rpc("cycleProgress", z.object({ space: z.string(), id: z.string() }), (ctx, p) =>
    cycles.progress(ctx, p.space, p.id),
  )
  rpc("rollover", z.object({ space: z.string(), today: z.string().optional() }), async (ctx, p) => {
    await requireAccess(ctx, `space://${p.space}`, "use")
    return cycles.rolloverProject(p.space, p.today)
  })

  // ── AI ────────────────────────────────────────────────────────────────────────────────────────────

  rpc(
    "aiSuggest",
    z.object({ space: z.string(), title: z.string(), description: z.string().optional() }),
    (ctx, p) => ai.suggest(ctx, p.space, p),
  )
  rpc("aiSummarize", z.object({ space: z.string(), id: z.string() }), (ctx, p) =>
    ai.summarize(ctx, p.space, p.id),
  )
  rpc(
    "aiDuplicates",
    z.object({
      space: z.string(),
      title: z.string(),
      description: z.string().optional(),
      exclude: z.string().optional(),
    }),
    (ctx, p) => ai.duplicates(ctx, p.space, p),
  )

  // ── agents ────────────────────────────────────────────────────────────────────────────────────────

  rpc("agentsAvailable", z.object({}), async (ctx) => ({ available: await agents.available(ctx) }))
  rpc(
    "startAgent",
    z.object({
      space: z.string(),
      id: z.string(),
      driver: z.string().optional(),
      env: z.string(),
      checkout: z.string().optional(),
      worktree: z.boolean().optional(),
      branch: z.string().optional(),
      base: z.string().optional(),
      model: z.string().optional(),
      instructions: z.string().optional(),
    }),
    (ctx, p) => agents.start(ctx, p),
  )

  // ── import ────────────────────────────────────────────────────────────────────────────────────────

  rpc(
    "importPreview",
    z.object({
      format: z.enum(["csv", "github"]),
      text: z.string(),
      mapping: z.array(z.string()).optional(),
      header: z.boolean().optional(),
    }),
    (_ctx, p) => {
      const r = readImport(p as never)
      return { count: r.issues.length, skipped: r.skipped, sample: r.issues.slice(0, 8) }
    },
  )
  rookery.jobs.handle("projects.import", {
    params: z.object({
      space: z.string(),
      format: z.enum(["csv", "github"]),
      text: z.string(),
      mapping: z.array(z.string()).optional(),
      header: z.boolean().optional(),
    }),
    run: (job, p) => importer.run(jobCtx(rookery, job), job, p as never),
  })
  rookery.jobs.handle("projects.rollover", {
    run: (job) => cycles.rolloverAll((s) => job.log(s)),
  })
  rookery.jobs.handle("projects.cycleSummary", {
    run: (job) => cycles.summarizeAll((s) => job.log(s)),
  })

  // ── the service, the command and agent tools ──────────────────────────────────────────────────────

  /** Names in a query (states, labels, people, cycles) to ids, for one project. */
  const resolver = async (ctx: Ctx, space: string | null): Promise<Resolver> => {
    const states = space ? await core.states(ctx, space) : []
    const labels = space ? await core.labelsOf(ctx, space) : []
    const people = new Map<string, string>()
    return {
      id(field, name) {
        const n = name.toLowerCase()
        if (field === "state") return states.find((s) => s.name.toLowerCase() === n)?.id ?? null
        if (field === "label") {
          const l = labels.find((x) => x.name.toLowerCase() === n)
          return l ? `label://${l.id}` : null
        }
        if (field === "assignee" || field === "creator") return people.get(n) ?? null
        return null
      },
      name: (_f, id) => id,
    }
  }

  async function search(ctx: Ctx, p: { query?: string; project?: string; limit?: number }) {
    const spaces = p.project
      ? [await projectSpace(ctx, p.project)]
      : (await rookery.spaces.list(ctx)).filter((s) => s.kind === KIND).map((s) => s.id)
    const out: IssueRow[] = []
    for (const space of spaces) {
      const { filter } = parseQuery(p.query ?? "", await resolver(ctx, space))
      const f: Filter = { ...filter, text: undefined }
      const page = filter.text
        ? await core.data(ctx, space).issues.search(filter.text, { limit: 200 })
        : await core.data(ctx, space).issues.find({ orderBy: [["updatedAt", "desc"]], limit: 500 })
      for (const r of page.rows as unknown as IssueRow[])
        if (matches(r, f, { me: `user://${uid(ctx)}` })) out.push(r)
    }
    return out.slice(0, p.limit ?? 25)
  }

  const brief = (i: IssueRow) => ({
    uri: issueUri(i.id),
    key: i.key,
    title: i.title,
    state: i.stateName,
    category: i.stateCategory,
    priority: i.priority,
    assignee: i.assignee,
    labels: i.labels,
    parent: i.parent,
    cycle: i.cycle,
    due: i.due,
    estimate: i.estimate,
  })

  const labelIds = async (ctx: Ctx, space: string, names?: string[]) => {
    if (!names?.length) return undefined
    const labels = await core.labelsOf(ctx, space)
    return names.map((n) => {
      if (n.startsWith("label://")) return n
      const l = labels.find((x) => x.name.toLowerCase() === n.toLowerCase())
      if (!l) throw new RookeryError("INVALID", `no label ${n} in this project`)
      return `label://${l.id}`
    })
  }

  const toPatch = async (ctx: Ctx, space: string, p: Record<string, any>): Promise<IssuePatch> => {
    const patch: IssuePatch = {}
    if (p.title !== undefined) patch.title = p.title
    if (p.state !== undefined) patch.stateName = p.state
    if (p.priority !== undefined) patch.priority = p.priority
    if (p.assignee !== undefined) patch.assignee = p.assignee === "me" ? `user://${uid(ctx)}` : p.assignee
    const labels = await labelIds(ctx, space, p.labels)
    if (labels) patch.labels = labels
    if (p.estimate !== undefined) patch.estimate = p.estimate
    if (p.due !== undefined) patch.due = p.due
    if (p.parent !== undefined) {
      const parent = p.parent ? await core.findIssue(ctx, p.parent, space) : null
      if (p.parent && !parent) throw new RookeryError("NOT_FOUND", `no issue ${p.parent}`)
      patch.parent = parent ? issueUri(parent.id) : null
    }
    if (p.cycle !== undefined) patch.cycle = p.cycle
    return patch
  }

  const service = {
    async createIssue(ctx: Ctx, p: Record<string, any>) {
      const space = await projectSpace(ctx, p.project)
      const patch = await toPatch(ctx, space, p)
      const docs = extrasOf(rookery).documents
      const description = p.description
        ? docs
          ? await docs.fromMarkdown(ctx, String(p.description))
          : fallbackTextDoc(String(p.description))
        : null
      const row = await core.createIssue(ctx, space, {
        ...patch,
        title: String(p.title ?? ""),
        ...(description ? { description } : {}),
        ...(p.link !== undefined ? { link: p.link } : {}),
      } as never)
      return brief(row)
    },
    async getIssue(ctx: Ctx, p: { issue: string }) {
      const i = await core.findIssue(ctx, p.issue)
      if (!i) throw new RookeryError("NOT_FOUND", `no issue ${p.issue}`)
      return { ...brief(i), text: await text.issueText(ctx, i) }
    },
    async updateIssue(ctx: Ctx, p: Record<string, any>) {
      const i = await core.findIssue(ctx, String(p.issue))
      if (!i) throw new RookeryError("NOT_FOUND", `no issue ${p.issue}`)
      return brief(await core.updateIssue(ctx, i, await toPatch(ctx, i.spaceId, p)))
    },
    async searchIssues(ctx: Ctx, p: { query?: string; project?: string; limit?: number }) {
      return { issues: (await search(ctx, p)).map(brief) }
    },
    async comment(ctx: Ctx, p: { issue: string; body: string }) {
      const i = await core.findIssue(ctx, p.issue)
      if (!i) throw new RookeryError("NOT_FOUND", `no issue ${p.issue}`)
      const c = (await core.comment(ctx, i.spaceId, issueUri(i.id), fallbackTextDoc(p.body))) as {
        id: string
      }
      return { comment: `comment://${c.id}`, issue: i.key }
    },
    async listStates(ctx: Ctx, p: { project?: string }) {
      const states = await core.states(ctx, await projectSpace(ctx, p.project))
      return { states: states.map((s: StateRow) => ({ name: s.name, category: s.category })) }
    },
    async listLabels(ctx: Ctx, p: { project?: string }) {
      const labels = await core.labelsOf(ctx, await projectSpace(ctx, p.project))
      return { labels: labels.map((l) => ({ name: l.name, workspace: !l.scope })) }
    },
    async link(ctx: Ctx, p: { issue: string; entity: string; kind?: "blocks" | "relates" | "duplicate" }) {
      const i = await core.findIssue(ctx, p.issue)
      if (!i) throw new RookeryError("NOT_FOUND", `no issue ${p.issue}`)
      if (p.entity.startsWith("issue://") || /^[A-Za-z][A-Za-z0-9]+-\d+$/.test(p.entity)) {
        await core.relate(ctx, i.spaceId, issueUri(i.id), p.entity, p.kind ?? "relates")
        return { linked: true }
      }
      const entities = entitiesOf(rookery)
      const e = entities ? await entities.lookup(ctx, p.entity) : { uri: p.entity }
      if (!e) throw new RookeryError("NOT_FOUND", `no entity ${p.entity} you can see`)
      const links = [...new Set([...(i.links ?? []), e.uri])]
      await core.data(ctx, i.spaceId).issues.update(i.id, { links } as never)
      return { linked: true }
    },
    /** For the GitHub plugin's link patterns: `{ keys, space }` -> `{ [key]: uri }`. */
    resolveKeys: (ctx: Ctx, p: { keys?: string[] }) => core.resolveKeys(ctx, p.keys ?? []),
    /** The text of an issue for an agent or a model. */
    issueText: async (ctx: Ctx, p: { issue: string }) => {
      const i = await core.findIssue(ctx, p.issue)
      return i ? { title: `${i.key} ${i.title}`, text: await text.issueText(ctx, i) } : null
    },
    startAgent: (ctx: Ctx, p: Record<string, any>) => agents.start(ctx, p as never),

    // For the plugins that contribute to projects.issueSources.
    "issues.upsertFromSource": (ctx: Ctx, p: any) => sources.upsertIssues(ctx, p),
    "comments.upsertFromSource": (ctx: Ctx, p: any) => sources.upsertComments(ctx, p),
    "issues.listFromSource": (_ctx: Ctx, p: any) => sources.listFromSource(p),
    "issues.removedAtSource": (_ctx: Ctx, p: any) => sources.removedAtSource(p),
    "sources.link": (ctx: Ctx, p: any) => sources.link(ctx, p),
    "sources.unlink": (ctx: Ctx, p: { link: string }) => sources.unlink(ctx, p.link, { tell: false }),
    "sources.projects": (_ctx: Ctx, p: any) => sources.projectsOf(p),
    "sources.find": (ctx: Ctx, p: any) => sources.findBySource(ctx, p),
  }
  rookery.services.provide("projects", service)

  rookery.commands.register("projects.createIssue", {
    params: z.object({
      title: z.string().describe("Title"),
      project: z.string().optional().describe("Project key; the current project by default"),
      priority: z
        .number()
        .int()
        .min(0)
        .max(4)
        .optional()
        .describe("0 none, 1 urgent, 2 high, 3 medium, 4 low"),
    }),
    run: (ctx, p) => service.createIssue(ctx, p),
  })

  // Agent tools reach harnesses through the kernel's MCP server where available.
  const tools: Array<[string, z.ZodTypeAny, (ctx: Ctx, p: any) => unknown]> = [
    [
      "projects.createIssue",
      z.object({
        title: z.string(),
        project: z.string().optional().describe("Project key such as CROW; the session's project by default"),
        description: z.string().optional().describe("Markdown"),
        state: z.string().optional().describe("A state name; see projects.listStates"),
        priority: z
          .number()
          .int()
          .min(0)
          .max(4)
          .optional()
          .describe("0 none, 1 urgent, 2 high, 3 medium, 4 low"),
        assignee: z.string().optional().describe("`me` or a user URI"),
        labels: z.array(z.string()).optional().describe("Label names"),
        parent: z.string().optional().describe("Parent issue key"),
        estimate: z.number().optional(),
        due: z.string().optional().describe("YYYY-MM-DD"),
      }),
      service.createIssue,
    ],
    ["projects.getIssue", z.object({ issue: z.string().describe("Key (CROW-12) or URI") }), service.getIssue],
    [
      "projects.updateIssue",
      z.object({
        issue: z.string().describe("Key (CROW-12) or URI"),
        title: z.string().optional(),
        state: z.string().optional().describe("A state name"),
        priority: z.number().int().min(0).max(4).optional(),
        assignee: z.string().nullable().optional(),
        labels: z.array(z.string()).optional().describe("Label names; replaces the labels"),
        parent: z.string().nullable().optional(),
        estimate: z.number().nullable().optional(),
        due: z.string().nullable().optional(),
      }),
      service.updateIssue,
    ],
    [
      "projects.searchIssues",
      z.object({
        query: z.string().optional().describe("Filters and words: `state:todo assignee:me label:bug login`"),
        project: z.string().optional(),
        limit: z.number().int().min(1).max(100).optional(),
      }),
      service.searchIssues,
    ],
    [
      "projects.comment",
      z.object({ issue: z.string(), body: z.string().describe("Markdown") }),
      service.comment,
    ],
    ["projects.listStates", z.object({ project: z.string().optional() }), service.listStates],
    ["projects.listLabels", z.object({ project: z.string().optional() }), service.listLabels],
    [
      "projects.link",
      z.object({
        issue: z.string(),
        entity: z.string().describe("An entity URI (doc://…, session://…) or another issue's key"),
        kind: z.enum(["blocks", "relates", "duplicate"]).optional().describe("For two issues"),
      }),
      service.link,
    ],
  ]
  const registerTool = agentsOf(rookery)?.tool
  if (typeof registerTool === "function") {
    try {
      for (const [id, params, run] of tools) registerTool(id, { params, run })
    } catch (e) {
      rookery.log.info(
        `agent tools are not registered: ${String((e as Error)?.message ?? e)}; the projects service offers them`,
      )
    }
  }

  // ── repairs ───────────────────────────────────────────────────────────────────────────────────────
  //
  // Issues written past this plugin (a client or another plugin with `rookery.data`) may lack their key,
  // entity title or state name. The watcher fixes those as the plugin.

  const keys = new Map<string, string>()
  const stateCache = new Map<string, StateRow[]>()
  const keyOf = async (space: string) => {
    let k = keys.get(space)
    if (!k) {
      k = (await core.project(null, space)).key
      keys.set(space, k)
    }
    return k
  }
  const statesIn = async (space: string) => {
    let s = stateCache.get(space)
    if (!s) {
      s = await core.states(null, space)
      stateCache.set(space, s)
    }
    return s
  }
  const pending = new Map<string, IssueRow>()
  let timer: ReturnType<typeof setTimeout> | null = null

  const fixesFor = async (r: IssueRow): Promise<Record<string, unknown> | null> => {
    const fix: Record<string, unknown> = {}
    const key = r.key || formatIssueKey(await keyOf(r.spaceId), r.number)
    if (!r.key) fix.key = key
    if (r.keyWords !== keyWords(key)) fix.keyWords = keyWords(key)
    if (r.label !== issueLabel(key, r.title)) fix.label = issueLabel(key, r.title)
    const states = await statesIn(r.spaceId)
    const st = states.find((s) => s.id === r.state)
    const moved =
      r.stateCategory && (!st || (r.stateName === st.name && r.stateCategory !== st.category))
        ? firstOf(states, r.stateCategory)
        : r.state && !st
          ? defaultState(states)
          : null
    if (moved) {
      Object.assign(
        fix,
        stateFields(moved, { ...r, stateCategory: st?.category ?? null }, new Date().toISOString()),
      )
    } else if (
      st &&
      (r.stateName !== st.name || r.stateCategory !== st.category || r.icon !== CATEGORY_ICON[st.category])
    ) {
      fix.stateName = st.name
      fix.stateCategory = st.category
      fix.icon = CATEGORY_ICON[st.category]
    }
    if (!r.rank) fix.rank = between(await core.lastRank(null, r.spaceId), null)
    return Object.keys(fix).length ? fix : null
  }

  const flush = async () => {
    timer = null
    const rows = [...pending.values()]
    pending.clear()
    for (const r of rows) {
      try {
        const fix = await fixesFor(r)
        if (fix) await rookery.data.space(r.spaceId).issues.update(r.id, fix as never)
      } catch (e) {
        rookery.log.warn(`repairing ${r.id} failed: ${String(e)}`)
      }
    }
  }

  const handleChange = async (c: ChangeEvent) => {
    if (c.collection === "states" || c.collection === "projects") {
      const spaceId = (c.row as { spaceId?: string } | null)?.spaceId
      if (spaceId) {
        stateCache.delete(spaceId)
        keys.delete(spaceId)
      }
      // A renamed state renames itself on its issues.
      const st = c.row as unknown as StateRow | null
      if (c.collection === "states" && st && c.op === "update") {
        const { rows } = await rookery.data
          .space(st.spaceId)
          .issues.find({ where: { state: st.id, stateName: { ne: st.name } }, limit: 1000 })
        if (rows.length)
          await rookery.data.space(st.spaceId).issues.batch(
            rows.map((r) => ({
              op: "update" as const,
              id: r.id,
              patch: {
                stateName: st.name,
                stateCategory: st.category,
                icon: CATEGORY_ICON[st.category],
              },
            })),
          )
      }
      return
    }
    if (c.collection !== "issues") return
    const r = c.row as unknown as IssueRow | null
    if (!r || r.deletedAt) {
      pending.delete(c.id)
      return
    }
    const st = (await statesIn(r.spaceId).catch(() => [])).find((s) => s.id === r.state)
    const ok =
      !!r.key &&
      !!r.rank &&
      r.keyWords === keyWords(r.key) &&
      r.label === issueLabel(r.key, r.title) &&
      (st ? r.stateName === st.name && r.stateCategory === st.category : !r.state && !r.stateCategory)
    if (ok) pending.delete(c.id)
    else pending.set(c.id, r)
    if (pending.size && !timer) timer = setTimeout(() => void flush(), 3000)
  }

  const subPromise = subscribeCollections(rookery, ["issues", "states", "projects"], handleChange)
  rookery.onDispose(() => {
    if (timer) clearTimeout(timer)
    void subPromise.then((s) => s.dispose())
  })
})
