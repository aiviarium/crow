// Typed client-side adapters for Rookery M2 / M2b facilities (`entities`, `documents`, `drafts`,
// `widgets`, `blocks`, `workbench.me`, `workbench.share`, `env.checkouts`, `agents`) that are not
// yet part of `@rookery/sdk/client`'s pinned `ClientRookery` surface. When the shell provides any of
// these natively on `rookery`, the adapter delegates straight through; otherwise it provides a clean
// fallback so views and tests work today.
import type { CollabProvider } from "@aiviarium/nocturne"
import type { ClientRookery, Disposable } from "@rookery/sdk/client"
import { RookeryError } from "@rookery/sdk/client"
import { createResource, type JSX } from "solid-js"

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

// ── entities ─────────────────────────────────────────────────────────────────────────────────────────

export interface ClientEntity {
  id: string
  uri: string
  scheme?: string
  title: string
  subtitle?: string | null
  parent?: string | null
  spaceId?: string | null
  deletedAt?: string | null
}

export interface EntityRendererProps {
  uri: string
  id: string
  scheme: string
  record?: Record<string, unknown>
  groupedBy?: string
  selected?: boolean
  onOpen(): void
}

export interface ClientEntities {
  resolve(uri: string): Promise<ClientEntity | null>
  resolveMany(uris: string[]): Promise<ClientEntity[]>
  search(query: string, opts?: { schemes?: string[]; limit?: number }): Promise<ClientEntity[]>
  open(uri: string): void
  card(scheme: string, renderer: (props: EntityRendererProps) => JSX.Element): Disposable
  row(scheme: string, renderer: (props: EntityRendererProps) => JSX.Element): Disposable
  Chip(props: { uri: string; label?: string }): JSX.Element
}

function openKnownUri(rookery: ClientRookery, uri: string): boolean {
  const m = uri.match(/^([a-z][a-z0-9+.-]*):\/\/(.+)$/)
  if (!m) return false
  const [, scheme, rest] = m
  if (!rest) return false
  switch (scheme) {
    case "issue":
      rookery.workbench.openView("projects.issue", { path: rest })
      return true
    case "project":
      rookery.workbench.openView("projects.overview", { path: rest })
      return true
    case "cycle":
      rookery.workbench.openView("projects.cycle", { path: rest })
      return true
    case "label":
      rookery.workbench.openView("projects.label", { path: rest })
      return true
    case "comment":
      rookery.workbench.openView("projects.comment", { path: rest })
      return true
    default:
      return false
  }
}

export function entitiesOf(rookery: ClientRookery): ClientEntities {
  const native = (rookery as unknown as { entities?: ClientEntities }).entities
  if (native) return native

  const resolve = (uri: string): Promise<ClientEntity | null> =>
    rookery.rpc.call<ClientEntity | null>("entities.resolve", { uri }).catch(() => null)

  const resolveMany = (uris: string[]): Promise<ClientEntity[]> =>
    rookery.rpc.call<ClientEntity[]>("entities.resolveMany", { uris }).catch(() => [])

  const search = (query: string, opts?: { schemes?: string[]; limit?: number }): Promise<ClientEntity[]> =>
    rookery.rpc.call<ClientEntity[]>("entities.search", { query, ...opts }).catch(() => [])

  const open = (uri: string): void => {
    if (openKnownUri(rookery, uri)) return
    if (/^https?:\/\//.test(uri)) {
      window.open(uri, "_blank", "noopener,noreferrer")
      return
    }
    rookery.workbench.toast({
      title: "Cannot open link yet",
      body: uri,
      kind: "info",
    })
  }

  const noop = (): Disposable => ({ dispose() {} })

  const Chip = (props: { uri: string; label?: string }): JSX.Element => {
    const [resolved] = createResource(
      () => (props.label ? null : props.uri),
      (uri) => resolve(uri),
    )
    const text = () => props.label || resolved()?.title || props.uri.replace(/^[a-z]+:\/\//, "")
    return (
      <button type="button" class="nc-chip projects__entity-chip" onClick={() => open(props.uri)}>
        {text()}
      </button>
    )
  }

  return {
    resolve,
    resolveMany,
    search,
    open,
    card: () => noop(),
    row: () => noop(),
    Chip,
  }
}

// ── documents ────────────────────────────────────────────────────────────────────────────────────────

export interface DocumentSession extends CollabProvider {
  status(): string
  error(): Error | null
  unsynced(): boolean
  readOnly(): boolean
  close(): void
}

export interface ClientDocuments {
  open(id: string): DocumentSession
}

export function documentsOf(rookery: ClientRookery): ClientDocuments | null {
  return (rookery as unknown as { documents?: ClientDocuments }).documents ?? null
}

// ── drafts ───────────────────────────────────────────────────────────────────────────────────────────

export interface ClientDrafts {
  get<T = unknown>(key: string): Promise<T | null>
  set(key: string, value: unknown): Promise<void>
  clear(key: string): Promise<void>
}

export function draftsOf(rookery: ClientRookery): ClientDrafts {
  const native = (rookery as unknown as { drafts?: ClientDrafts }).drafts
  if (native) return native
  return {
    get: <T = unknown>(key: string) => rookery.storage.get<T>(`draft:${key}`, { scope: "user" }),
    set: (key: string, value: unknown) => rookery.storage.set(`draft:${key}`, value, { scope: "user" }),
    clear: (key: string) => rookery.storage.delete(`draft:${key}`, { scope: "user" }),
  }
}

// ── widgets & blocks ─────────────────────────────────────────────────────────────────────────────────

export interface WidgetProps {
  widget: {
    id: string
    type: string
    settings: Record<string, unknown>
    size: { w: number; h: number }
    editing: boolean
  }
}

export type WidgetComponent = (props: WidgetProps) => JSX.Element

const WIDGET_REGISTRY_SYMBOL = Symbol.for("crow.widgets.registry")

interface SharedWidgetStore {
  readonly components: Map<string, { plugin: string; component: WidgetComponent }>
  readonly manifestTypes: Map<string, unknown[]>
  readonly builtinTypes: Map<string, unknown>
  readonly listeners: Set<() => void>
  notify(): void
  register(plugin: string, id: string, component: WidgetComponent): Disposable
  setPluginTypes(plugin: string, widgets: readonly Record<string, unknown>[]): Disposable
}

function getSharedWidgetStore(): SharedWidgetStore {
  const g = globalThis as Record<PropertyKey, unknown>
  const existing = g[WIDGET_REGISTRY_SYMBOL] as SharedWidgetStore | undefined
  if (existing) return existing
  const components = new Map<string, { plugin: string; component: WidgetComponent }>()
  const manifestTypes = new Map<string, unknown[]>()
  const builtinTypes = new Map<string, unknown>()
  const listeners = new Set<() => void>()
  const notify = () => {
    for (const fn of listeners) fn()
  }
  const store: SharedWidgetStore = {
    components,
    manifestTypes,
    builtinTypes,
    listeners,
    notify,
    register(plugin, id, component) {
      const entry = { plugin, component }
      components.set(id, entry)
      notify()
      return {
        dispose() {
          if (components.get(id) === entry) {
            components.delete(id)
            notify()
          }
        },
      }
    },
    setPluginTypes(plugin, widgets) {
      const list = widgets.map((w) => ({ ...w, plugin }))
      manifestTypes.set(plugin, list)
      notify()
      return {
        dispose() {
          if (manifestTypes.get(plugin) === list) {
            manifestTypes.delete(plugin)
            notify()
          }
        },
      }
    },
  }
  g[WIDGET_REGISTRY_SYMBOL] = store
  return store
}

export function registerWidget(rookery: ClientRookery, id: string, component: WidgetComponent): Disposable {
  const disposables: Disposable[] = []
  const native = (
    rookery as unknown as { widgets?: { register(id: string, component: WidgetComponent): Disposable } }
  ).widgets
  if (native) disposables.push(native.register(id, component))
  disposables.push(getSharedWidgetStore().register(rookery.id, id, component))
  return {
    dispose() {
      for (const d of disposables) d.dispose()
    },
  }
}

export function registerManifestWidgets(rookery: ClientRookery): Disposable {
  const widgets = (rookery.manifest.contributes as unknown as { widgets?: Record<string, unknown>[] }).widgets
  if (!widgets?.length) return { dispose() {} }
  return getSharedWidgetStore().setPluginTypes(rookery.id, widgets)
}

export interface BlockRendererProps {
  attrs: Record<string, unknown>
  setAttrs(next: Record<string, unknown>): void
  readOnly: boolean
}

export function registerBlock(
  rookery: ClientRookery,
  id: string,
  component: (props: BlockRendererProps) => JSX.Element,
): Disposable {
  const native = (
    rookery as unknown as {
      blocks?: { register(id: string, component: (props: BlockRendererProps) => JSX.Element): Disposable }
    }
  ).blocks
  return native ? native.register(id, component) : { dispose() {} }
}

// ── workbench, env & agents ──────────────────────────────────────────────────────────────────────────

export interface MeInfo {
  user: { id: string; name: string; email?: string; admin?: boolean }
}

export function workbenchMe(rookery: ClientRookery): Promise<MeInfo> {
  const wb = rookery.workbench as unknown as { me?: () => Promise<MeInfo> }
  if (typeof wb.me === "function") return wb.me()
  return rookery.rpc.call<MeInfo>("auth.me", {})
}

export function workbenchShare(rookery: ClientRookery, uri: string): void {
  const wb = rookery.workbench as unknown as { share?: (uri: string) => void }
  if (typeof wb.share === "function") {
    wb.share(uri)
    return
  }
  rookery.workbench.toast({
    title: "Sharing is not available yet",
    body: uri,
    kind: "info",
  })
}

export interface EnvCheckout {
  path: string
  name: string
  branch?: string | null
  url?: string | null
  worktreeOf?: string | null
}

export function envCheckouts(rookery: ClientRookery, env: string): Promise<EnvCheckout[]> {
  const e = rookery.env as unknown as { checkouts?: (env: string) => Promise<EnvCheckout[]> }
  if (typeof e.checkouts === "function") return e.checkouts(env)
  return rookery.rpc.call<EnvCheckout[]>("env.checkouts", { env })
}

export interface ClientAgents {
  drivers?(): Promise<Array<{ id: string; title?: string }>>
  get(id: string): Promise<{ id: string; state: string; title: string }>
  onChanged(cb: (session: { id: string; state: string; title: string }) => void): Disposable | undefined
}

export function agentsOf(rookery: ClientRookery): ClientAgents | null {
  return (rookery as unknown as { agents?: ClientAgents }).agents ?? null
}

/** Extracts `"view" | "use" | "manage" | null` from a `SpaceInfo.level` regardless of Rookery type version. */
export function spaceAccessLevel(level: unknown): "view" | "use" | "manage" | null {
  if (level === "view" || level === "use" || level === "manage") return level
  if (level && typeof level === "object" && "grant" in level) {
    const g = (level as { grant?: unknown }).grant
    if (g === "view" || g === "use" || g === "manage") return g
  }
  return null
}

/** Renders an entity chip via `rookery.entities.Chip` when present, else the fallback chip. */
export function EntityChip(props: { crow: ClientRookery; uri: string; label?: string }): JSX.Element {
  const Chip = entitiesOf(props.crow).Chip
  return <Chip uri={props.uri} label={props.label} />
}
