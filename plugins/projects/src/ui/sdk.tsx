// Typed client-side adapters for Rookery facilities (`entities`, `documents`, `drafts`,
// `widgets`, `blocks`, `workbench.me`, `workbench.share`, `env.checkouts`, `agents`), delegating
// to `@rookery/sdk/client`'s `ClientRookery` surface with fallbacks for lightweight unit-test mocks.

import type { EditorBlockType } from "@aiviarium/nocturne"
import type { ClientRookery, Disposable, EntityInfo } from "@rookery/sdk/client"
import { RookeryError } from "@rookery/sdk/client"
import { createResource, type JSX } from "solid-js"
import { type DocumentSession, openDocument } from "./collab"

export type { DocumentSession }

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

export interface EntityRendererProps {
  uri: string
  id: string
  scheme: string
  record?: Record<string, unknown>
  groupedBy?: string
  selected?: boolean
  onOpen(): void
}

/** The SDK's entity index, with the shell's entity components where it draws them. */
export type ClientEntities = ClientRookery["entities"] & {
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

const noop = (): Disposable => ({ dispose() {} })

export function entitiesOf(rookery: ClientRookery): ClientEntities {
  const native = rookery.entities as Partial<ClientEntities> | undefined
  const open = (uri: string): void => {
    if (typeof native?.open === "function") {
      native.open(uri)
      return
    }
    if (openKnownUri(rookery, uri)) return
    if (/^https?:\/\//.test(uri)) {
      window.open(uri, "_blank", "noopener,noreferrer")
      return
    }
    rookery.workbench.toast({ title: "Cannot open link yet", body: uri, kind: "info" })
  }

  const Chip = (props: { uri: string; label?: string }): JSX.Element => {
    if (typeof native?.Chip === "function") {
      const NativeChip = native.Chip
      return <NativeChip uri={props.uri} label={props.label} />
    }
    const [resolved] = createResource(
      () => (props.label ? null : props.uri),
      (uri) => rookery.entities.resolve(uri).catch(() => null as EntityInfo | null),
    )
    const text = () => props.label || resolved()?.title || props.uri.replace(/^[a-z]+:\/\//, "")
    return (
      <button type="button" class="nc-chip projects__entity-chip" onClick={() => open(props.uri)}>
        {text()}
      </button>
    )
  }

  return {
    ...rookery.entities,
    open,
    card: (scheme, renderer) =>
      typeof native?.card === "function" ? native.card(scheme, renderer as never) : noop(),
    row: (scheme, renderer) =>
      typeof native?.row === "function" ? native.row(scheme, renderer as never) : noop(),
    Chip,
  }
}

// ── documents ────────────────────────────────────────────────────────────────────────────────────────

export interface ClientDocuments {
  open(id: string): ReturnType<typeof openDocument>
}

export function documentsOf(rookery: ClientRookery): ClientDocuments {
  return { open: (id: string) => openDocument(rookery, id) }
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
    set: async (key: string, value: unknown) => {
      await rookery.storage.set(`draft:${key}`, value, { scope: "user" })
    },
    clear: async (key: string) => {
      await rookery.storage.delete(`draft:${key}`, { scope: "user" })
    },
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

export function registerWidget(rookery: ClientRookery, id: string, component: WidgetComponent): Disposable {
  return rookery.widgets?.register(id, component as never) ?? noop()
}

export function registerManifestWidgets(_rookery: ClientRookery): Disposable {
  return noop()
}

/** What a block's component is handed, as the shared editor defines it. */
export type BlockRendererProps = Parameters<NonNullable<EditorBlockType["component"]>>[0]

export function registerBlock(
  rookery: ClientRookery,
  id: string,
  component: (props: BlockRendererProps) => JSX.Element,
  options?: {
    forceWidth?: (attrs: Record<string, unknown>) => "reading" | "wide" | "full" | null | undefined
  },
): Disposable {
  return rookery.blocks?.register(id, component as never, options) ?? noop()
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
  if (typeof rookery.workbench.share === "function") {
    rookery.workbench.share(uri)
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
