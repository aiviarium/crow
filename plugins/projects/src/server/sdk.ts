// Thin typed adapters bridging prototype host capabilities that arrive in Rookery M2 / M2b
// onto `@rookery/sdk`'s current `Rookery` and `Ctx` contracts.
import {
  type ChangeEvent,
  type Ctx,
  type Disposable,
  type JobHandle,
  type NoticeKind,
  type RichText,
  type Rookery,
  RookeryError,
} from "@rookery/sdk"

/** Normalizes any thrown error into a `RookeryError` (replaces prototype's `CrowError.from`). */
export function toRookeryError(err: unknown): RookeryError {
  if (err instanceof RookeryError) return err
  if (err && typeof err === "object") {
    const e = err as { code?: unknown; message?: unknown; details?: unknown }
    if (typeof e.code === "string" && typeof e.message === "string") {
      return new RookeryError(e.code as never, e.message, e.details)
    }
    if (typeof e.message === "string") return new RookeryError("INTERNAL", e.message)
  }
  return new RookeryError("INTERNAL", String(err))
}

export interface HostDoc {
  id: string
  title?: string
}

export interface HostDocuments {
  list(ctx: Ctx | null, parentUri: string): Promise<HostDoc[]>
  create(
    ctx: Ctx | null,
    params: { parent: string; title: string; content?: RichText; markdown?: string },
  ): Promise<HostDoc>
  edit(
    ctx: Ctx | null,
    id: string,
    ops: Array<{ op: string; markdown?: string }>,
    opts?: { author?: Record<string, unknown> },
  ): Promise<unknown>
  delete(ctx: Ctx | null, id: string): Promise<void>
  text(ctx: Ctx | null, id: string): Promise<string>
  markdown(ctx: Ctx | null, id: string): Promise<string>
  fromMarkdown(ctx: Ctx | null, markdown: string): Promise<RichText>
  toMarkdown(ctx: Ctx | null, body: RichText): Promise<string>
}

export interface HostEntity {
  id: string
  uri: string
  title: string
  subtitle?: string | null
  spaceId?: string | null
}

export interface HostEntities {
  lookup(ctx: Ctx | null, uri: string): Promise<HostEntity | null>
  lookupMany(ctx: Ctx | null, uris: string[]): Promise<HostEntity[]>
  search(ctx: Ctx | null, query: string, opts?: { schemes?: string[]; limit?: number }): Promise<HostEntity[]>
  text(
    scheme: string,
    handler: (ctx: Ctx, ref: { id: string }) => Promise<{ title: string; text: string } | null>,
  ): Disposable | undefined
}

export interface HostAgents {
  list?(ctx: Ctx, opts?: Record<string, unknown>): Promise<unknown>
  start?(ctx: Ctx, params: Record<string, unknown>): Promise<unknown>
  tool?(id: string, def: { params: unknown; run: (ctx: Ctx, params: any) => unknown }): Disposable | undefined
}

export interface SpaceGrantEntry {
  principal: string
  name?: string
  email?: string
  level: "view" | "use" | "manage"
}

export interface SpaceGrants {
  level: "view" | "use" | "manage" | null
  owner?: { principal: string; name?: string; email?: string } | null
  grants: SpaceGrantEntry[]
}

export interface HostRookeryExtras {
  documents?: HostDocuments
  entities?: HostEntities
  agents?: HostAgents
  spaces: Rookery["spaces"] & {
    create(
      ctx: Ctx,
      params: { kind: string; name: string; slug?: string },
    ): Promise<Awaited<ReturnType<Rookery["spaces"]["create"]>>>
    rename?(ctx: Ctx, space: string, name: string): Promise<unknown>
  }
  env: Rookery["env"] & {
    repositories?(ctx: Ctx, space: string): Promise<unknown[]>
    addRepository?(ctx: Ctx, params: { space: string; url: string; name?: string }): Promise<unknown>
  }
}

export function extrasOf(rookery: Rookery): HostRookeryExtras {
  return rookery as unknown as HostRookeryExtras
}

export function documentsOf(rookery: Rookery): HostDocuments {
  const docs = extrasOf(rookery).documents
  if (!docs) throw new RookeryError("UNAVAILABLE", "documents facility is not available on this server yet")
  return docs
}

export function entitiesOf(rookery: Rookery): HostEntities | undefined {
  return extrasOf(rookery).entities
}

export function agentsOf(rookery: Rookery): HostAgents | undefined {
  return extrasOf(rookery).agents
}

export type GrantLevel = "view" | "use" | "manage"

export function normalizeGrant(raw: unknown): GrantLevel | null {
  if (raw === "view" || raw === "use" || raw === "manage") return raw
  if (raw && typeof raw === "object" && "level" in raw) {
    return normalizeGrant((raw as { level?: unknown }).level)
  }
  return null
}

export async function requireAccess(ctx: Ctx, resource: string, level: GrantLevel): Promise<void> {
  await ctx.access.require(resource, level as never)
}

export async function grantAccess(
  ctx: Ctx,
  resource: string,
  subject: string,
  level: GrantLevel,
): Promise<void> {
  await ctx.access.grant(resource, subject, level as never)
}

export async function accessLevel(ctx: Ctx, resource: string): Promise<GrantLevel | null> {
  return normalizeGrant(await ctx.access.level(resource))
}

export async function spaceGrants(ctx: Ctx, space: string): Promise<SpaceGrants> {
  const access = ctx.access as Ctx["access"] & {
    grants?: (resource: string) => Promise<SpaceGrants>
  }
  if (typeof access.grants === "function") return access.grants(`space://${space}`)
  const level = await accessLevel(ctx, `space://${space}`)
  return { level, owner: null, grants: [] }
}

/** Sends a user notification via `@rookery/sdk`'s `rookery.notify.send`. */
export async function sendNotice(
  rookery: Rookery,
  opts: { user: string; title: string; body?: string; kind?: NoticeKind; resource?: string },
): Promise<void> {
  try {
    await rookery.notify.send(opts)
  } catch (e) {
    rookery.log.warn(`notification to ${opts.user} failed: ${String(e)}`)
  }
}

/** Calls a method on another plugin's service; the server records the caller as the plugin. */
export async function callPluginService<T = unknown>(
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

/** Extracts an optional caller `Ctx` attached to a job handle, or synthesizes a plugin-scoped context. */
export function jobCtx(rookery: Rookery, job: JobHandle): Ctx {
  const attached = (job as unknown as { ctx?: Ctx }).ctx
  if (attached) return attached
  return {
    user: null,
    principal: { kind: "plugin", id: rookery.id },
    space: null,
    signal: job.signal,
    data: rookery.data,
    access: {
      check: async () => true,
      require: async () => {},
      level: async () => "manage" as never,
      filter: async (resources) => resources,
      grant: async () => {},
      revoke: async () => {},
    },
  }
}

/** Subscribes to changes across multiple collections using `@rookery/sdk`'s per-collection `data.changes.subscribe`. */
export async function subscribeCollections(
  rookery: Rookery,
  collections: readonly string[],
  handler: (change: ChangeEvent) => unknown,
): Promise<Disposable> {
  const subs: Disposable[] = []
  for (const col of collections) {
    try {
      subs.push(await rookery.data.changes.subscribe(col, handler))
    } catch (e) {
      rookery.log.warn(`subscribing to ${col} changes failed: ${String(e)}`)
    }
  }
  return {
    dispose() {
      for (const s of subs) s.dispose()
    },
  }
}

/** Minimal Markdown -> RichText fallback when `rookery.documents.fromMarkdown` is unavailable. */
export function fallbackTextDoc(text: string): RichText {
  const paras = text
    .split(/\n{2,}/)
    .map((p) => p.trim())
    .filter(Boolean)
  return {
    type: "doc",
    content: paras.map((p) => ({ type: "paragraph", content: [{ type: "text", text: p }] })),
  }
}
