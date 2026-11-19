// Typed adapters from the prototype's host API (`@crow/sdk`) onto `@rookery/sdk`'s `Rookery` and `Ctx`.
//
// Rookery's extension host arrived in M2 and its datastore, spaces and groups in M2b. The handles below use
// what `@rookery/sdk` types today and reach, through a cast, for the few facilities the pinned SDK does not
// declare yet (`entities`, `settings.getFor`, `access.levelOf`, `schedules.create`,
// `env.repositories`, `agents.tool`). Each is marked in `API.md`; every fallback keeps the
// plugin working (or failing cleanly) where the facility is absent.
import type { Ctx, Disposable, JobHandle, Rookery, SpaceInfo } from "@rookery/sdk"
import { ghSpace, type RepoRow } from "./rows"

/** The host handle with the facilities that arrive with M2b and M5b. */
export interface RookeryExtras {
  entities?: {
    lookup(ctx: Ctx | null, uri: string): Promise<EntityInfo | null>
    lookupMany(ctx: Ctx | null, uris: string[]): Promise<EntityInfo[]>
    search(
      ctx: Ctx | null,
      query: string,
      opts?: { schemes?: string[]; limit?: number },
    ): Promise<EntityInfo[]>
    text?(
      scheme: string,
      handler: (ctx: Ctx, ref: { id: string }) => Promise<{ title: string; text: string } | null>,
    ): Disposable
    alias?(ctx: Ctx | null, from: string, to: string): Promise<void>
  }
  settings: Rookery["settings"] & {
    /** Another person's user-scoped setting (the prototype's `settings.getFor`). */
    getFor?(key: string, user: string): Promise<unknown>
    get(key: string, opts?: { space?: string; user?: string }): Promise<unknown>
  }
  schedules: Rookery["schedules"] & {
    create?(ctx: Ctx | null, schedule: ScheduleInput): Promise<{ id: string }>
    remove?(ctx: Ctx | null, id: string): Promise<void>
  }
  env: Rookery["env"] & {
    repositories?(ctx: Ctx | null, space: string): Promise<Array<{ id: string; url: string }>>
    addRepository?(
      ctx: Ctx | null,
      params: { space: string; url: string; name?: string; connection?: string },
    ): Promise<{ id: string }>
  }
  agents?: {
    tool?(
      id: string,
      def: { params: unknown; run: (ctx: Ctx, params: any) => unknown; confirm?: boolean },
    ): Disposable
  }
}

export const extrasOf = (rookery: Rookery): RookeryExtras => rookery as unknown as RookeryExtras

// ── connections ───────────────────────────────────────────────────────────────────────────────────────

/** A connection as this plugin reads it: its plain config and the secrets of its sealed credential. */
export interface ConnectionView {
  id: string
  type: string
  name: string
  scope: "global" | "user"
  values: Record<string, unknown>
  canManage: boolean
  /** The names of the secrets the credential holds. */
  secretsSet: string[]
  updatedAt: string
}

/**
 * Reads a connection's credential. Rookery seals a connection's secrets as one string; this plugin stores the
 * GitHub App's two secrets as a JSON object in it (a token is the string itself). When M2 lets a connection
 * type declare several secret fields, the same reader keeps working as the kernel will hand over the object.
 */
export function credentialValues(credential: string | null | undefined): Record<string, unknown> {
  if (!credential) return {}
  try {
    const parsed = JSON.parse(credential)
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed))
      return parsed as Record<string, unknown>
  } catch {
    // Not JSON: the credential is the token itself.
  }
  return { token: credential }
}

export async function connectionView(rookery: Rookery, id: string): Promise<ConnectionView> {
  const resolved = await rookery.connections.resolve(id)
  return viewOf(rookery, resolved.connection, resolved.credential)
}

export function viewOf(
  rookery: Rookery,
  connection: { id: string; type: string; name: string; scope: string; config: Record<string, unknown> },
  credential: string | null,
): ConnectionView {
  void rookery
  const secrets = credentialValues(credential)
  const names = Object.keys(secrets)
  return {
    id: connection.id,
    type: connection.type,
    name: connection.name,
    scope: connection.scope === "user" ? "user" : "global",
    values: { ...connection.config, ...secrets },
    // Rookery does not say who may change a connection; the shell shows what the server lets it do.
    canManage: true,
    secretsSet: names,
    updatedAt: "",
  }
}

// ── entities ─────────────────────────────────────────────────────────────────────────────────────────

export interface EntityInfo {
  id: string
  uri: string
  scheme?: string
  title: string
  subtitle?: string | null
  parent?: string | null
  spaceId?: string | null
  deletedAt?: string | null
}

export const entitiesOf = (rookery: Rookery): RookeryExtras["entities"] | undefined =>
  extrasOf(rookery).entities

/**
 * The entity behind a `gh-…://` URI. Uses `entities.lookup` when the server has it; otherwise it looks the
 * row up in every space the caller can see, which is what the entity index would say.
 */
export async function lookupEntity(
  rookery: Rookery,
  ctx: Ctx | null,
  uri: string,
): Promise<EntityInfo | null> {
  const native = entitiesOf(rookery)
  if (native) return native.lookup(ctx, uri).catch(() => null)
  const m = /^(gh-pr|gh-repo):\/\/(.+)$/.exec(uri)
  if (!m) return null
  const kind = m[1] === "gh-pr" ? "prs" : "repos"
  for (const space of await visibleSpaces(rookery, ctx)) {
    const row = await (kind === "prs"
      ? ghSpace(rookery, space.id).prs.get(m[2]!)
      : ghSpace(rookery, space.id).repos.get(m[2]!)
    ).catch(() => null)
    if (!row) continue
    return {
      id: row.id,
      uri,
      scheme: m[1],
      title: String((row as RepoRow).fullName ?? (row as { title?: string }).title ?? uri),
      subtitle: null,
      spaceId: space.id,
    }
  }
  return null
}

/** The spaces the caller can see, from `spaces.list`; empty when the server has no spaces yet. */
export async function visibleSpaces(rookery: Rookery, ctx: Ctx | null): Promise<SpaceInfo[]> {
  try {
    return await rookery.spaces.list(ctx as Ctx)
  } catch {
    return []
  }
}

// ── services ─────────────────────────────────────────────────────────────────────────────────────────

/** A method of another plugin's service, called with the caller's context as the server records it. */
export async function callService<T = unknown>(
  rookery: Rookery,
  ctx: Ctx | null,
  plugin: string,
  service: string,
  method: string,
  params: Record<string, unknown>,
): Promise<T> {
  void ctx
  return rookery.services.call<T>(plugin, service, method, params)
}

/** The projects service, with its issue-source methods (Projects' `interface.ts`). */
export const projectsOf = (rookery: Rookery) => ({
  getIssue: (ctx: Ctx | null, params: { issue: string }) =>
    callService(rookery, ctx, "projects", "projects", "getIssue", params),
  searchIssues: (ctx: Ctx | null, params: Record<string, unknown>) =>
    callService(rookery, ctx, "projects", "projects", "searchIssues", params),
  comment: (ctx: Ctx | null, params: { issue: string; body: string }) =>
    callService(rookery, ctx, "projects", "projects", "comment", params),
  issueText: (ctx: Ctx | null, params: { issue: string }) =>
    callService(rookery, ctx, "projects", "projects", "issueText", params),
  "issues.upsertFromSource": (ctx: Ctx | null, params: Record<string, unknown>) =>
    callService(rookery, ctx, "projects", "projects", "issues.upsertFromSource", params),
  "comments.upsertFromSource": (ctx: Ctx | null, params: Record<string, unknown>) =>
    callService(rookery, ctx, "projects", "projects", "comments.upsertFromSource", params),
  "issues.listFromSource": (ctx: Ctx | null, params: Record<string, unknown>) =>
    callService(rookery, ctx, "projects", "projects", "issues.listFromSource", params),
  "issues.removedAtSource": (ctx: Ctx | null, params: Record<string, unknown>) =>
    callService(rookery, ctx, "projects", "projects", "issues.removedAtSource", params),
  "sources.projects": (ctx: Ctx | null, params: Record<string, unknown>) =>
    callService(rookery, ctx, "projects", "projects", "sources.projects", params),
  "sources.find": (ctx: Ctx | null, params: Record<string, unknown>) =>
    callService(rookery, ctx, "projects", "projects", "sources.find", params),
  "sources.link": (ctx: Ctx | null, params: Record<string, unknown>) =>
    callService(rookery, ctx, "projects", "projects", "sources.link", params),
  "sources.unlink": (ctx: Ctx | null, params: Record<string, unknown>) =>
    callService(rookery, ctx, "projects", "projects", "sources.unlink", params),
})

// ── access ───────────────────────────────────────────────────────────────────────────────────────────

export type Level = "view" | "use" | "manage"

export async function requireLevel(ctx: Ctx, resource: string, level: Level): Promise<void> {
  await ctx.access.require(resource, level as never)
}

export async function levelOf(ctx: Ctx, resource: string, user: string): Promise<Level | null> {
  const access = ctx.access as Ctx["access"] & {
    levelOf?(resource: string, user: string): Promise<Level | null>
  }
  if (typeof access.levelOf === "function") return access.levelOf(resource, user)
  // Without `access.levelOf` (M2b), a notification cannot check what its recipient may see: it is not sent.
  return null
}

// ── settings ────────────────────────────────────────────────────────────────────────────────────────

export async function getSetting<T = unknown>(
  rookery: Rookery,
  key: string,
  opts: { space?: string; user?: string } = {},
): Promise<T> {
  const settings = extrasOf(rookery).settings
  if (opts.user && typeof settings.getFor === "function") return (await settings.getFor(key, opts.user)) as T
  return (await settings.get(key, opts)) as T
}

// ── schedules ───────────────────────────────────────────────────────────────────────────────────────

export interface ScheduleInput {
  name: string
  job: string
  everySecs?: number
  cron?: string
  title?: string
  params?: Record<string, unknown>
  missed?: string
}

export const scheduleName = (repoId: string) => `code:sync:${repoId}`

/** Creates or replaces the per-repository poll schedule, where the server lets a plugin make one (M2). */
export async function putSchedule(
  rookery: Rookery,
  ctx: Ctx | null,
  schedule: ScheduleInput,
): Promise<boolean> {
  const create = extrasOf(rookery).schedules.create
  if (!create) return false
  await create(ctx, schedule)
  return true
}

export async function removeScheduleFor(rookery: Rookery, ctx: Ctx | null, repoId: string) {
  const schedules = extrasOf(rookery).schedules
  if (!schedules.remove) return
  const found = await rookery.schedules.list().catch(() => [])
  for (const s of found) if (s.name === scheduleName(repoId)) await schedules.remove(ctx, s.id)
}

// ── notifications ───────────────────────────────────────────────────────────────────────────────────

export async function sendNotice(
  rookery: Rookery,
  opts: {
    user: string
    title: string
    body?: string
    kind?: "info" | "warning" | "action"
    resource?: string
  },
): Promise<void> {
  try {
    await rookery.notify.send({
      user: opts.user.replace(/^user:\/\//, ""),
      title: opts.title.slice(0, 200),
      ...(opts.body ? { body: opts.body.slice(0, 500) } : {}),
      ...(opts.kind ? { kind: opts.kind } : {}),
      ...(opts.resource ? { resource: opts.resource } : {}),
    })
  } catch (e) {
    rookery.log.warn(`notification to ${opts.user} failed: ${String(e)}`)
  }
}

// ── jobs and contexts ───────────────────────────────────────────────────────────────────────────────

export async function enqueue(
  rookery: Rookery,
  ctx: Ctx | null,
  name: string,
  params: Record<string, unknown>,
  key?: string,
): Promise<void> {
  await rookery.jobs.enqueue(name, params, key ? { dedupeKey: key } : undefined)
  void ctx
}

/** A context for work a job runs, when the job does not carry the person's (the prototype's `jobCtx`). */
export function jobCtx(rookery: Rookery, job: JobHandle): Ctx {
  const attached = (job as unknown as { ctx?: Ctx }).ctx
  if (attached) return attached
  return {
    user: null,
    principal: { kind: "plugin", id: rookery.id } as never,
    space: null,
    signal: job.signal,
    data: rookery.data,
    access: {
      check: async () => true,
      require: async () => {},
      level: async () => "manage" as never,
      filter: async (resources: string[]) => resources,
      grant: async () => {},
      revoke: async () => {},
    },
  }
}
