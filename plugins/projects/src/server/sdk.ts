// Thin typed adapters bridging prototype host capabilities that arrive in Rookery M2 / M2b
// onto `@rookery/sdk`'s current `Rookery` and `Ctx` contracts.
import {
  type ChangeEvent,
  type Ctx,
  type Disposable,
  type JobHandle,
  type NoticeKind,
  plainText,
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
  agents?: HostAgents
  env: Rookery["env"] & {
    repositories?(ctx: Ctx, space: string): Promise<unknown[]>
    addRepository?(ctx: Ctx, params: { space: string; url: string; name?: string }): Promise<unknown>
  }
}

export function extrasOf(rookery: Rookery): HostRookeryExtras {
  return rookery as unknown as HostRookeryExtras
}

export const documentsOf = (rookery: Rookery): Rookery["documents"] => rookery.documents

export const entitiesOf = (rookery: Rookery): Rookery["entities"] => rookery.entities

/** A document as Markdown, or empty when it has none. */
export async function documentMarkdown(docs: Rookery["documents"], ctx: Ctx, id: string): Promise<string> {
  return (await docs.read(ctx, id, "markdown")).markdown ?? ""
}

/** A document as plain text, or empty when it has none. */
export async function documentText(docs: Rookery["documents"], ctx: Ctx, id: string): Promise<string> {
  return (await docs.read(ctx, id, "text")).text ?? ""
}

/** Markdown as the editors' rich text, through the server's converter. */
export async function markdownToRichText(docs: Rookery["documents"], markdown: string): Promise<RichText> {
  return ((await docs.convert({ markdown })).content as RichText | undefined) ?? fallbackTextDoc(markdown)
}

/** Rich text as Markdown, through the server's converter. */
export async function richTextToMarkdown(docs: Rookery["documents"], body: RichText): Promise<string> {
  return (await docs.convert({ content: body })).markdown ?? plainText(body)
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
  const resource = `space://${space}`
  const access = ctx.access as Ctx["access"] & {
    grants?: (resource: string) => Promise<SpaceGrants>
  }
  const list = await access.grants(resource)
  return {
    level:
      normalizeGrant(list.grants.find((g) => ctx.user && g.principal === ctx.user.id)?.level) ??
      normalizeGrant(list.owner === ctx.user?.id ? "manage" : null),
    owner: list.owner ? { principal: list.owner } : null,
    grants: list.grants.map((g) => ({ principal: g.principal, level: normalizeGrant(g.level)! })),
  }
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
    callId: `job:${job.id}`,
    user: null,
    principal: { kind: "plugin", id: rookery.id },
    space: null,
    signal: job.signal,
    data: rookery.data,
    access: {
      check: async () => true,
      require: async () => {},
      level: async () => "manage" as never,
      levelOf: async () => null,
      grants: async (resource: string) => ({ resource, owner: null, grants: [] }),
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
