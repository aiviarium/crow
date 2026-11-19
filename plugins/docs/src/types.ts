// M2/M2b bridge types for Rookery SDK surfaces that Docs uses (documents, entities, pins, recents, blocks,
// widgets, blobs.upload, workbench.share, and host agents.tool). Once Rookery M2 and M2b land in `@rookery/sdk`,
// these optional extensions become part of the core `Rookery` and `ClientRookery` handles.
import type { BlockWidth, CollabProvider, OutlineHeading } from "@aiviarium/nocturne"
import type { Ctx, Disposable, Rookery, z } from "@rookery/sdk"
import type {
  BlobInfo,
  ClientRookery,
  DocumentContent,
  DocumentInfo,
  DocumentVersion,
  EntityInfo,
  PinInfo,
  RecentEntity,
  SearchHit,
} from "@rookery/sdk/client"
import type { JSX } from "solid-js"

export type { BlockWidth, OutlineHeading }

/** Extracts the underlying `EntityInfo` from either a flat `EntityInfo` or an M2b `SearchHit`. */
export function entityOfHit(hit: EntityInfo | SearchHit): EntityInfo {
  return "entity" in hit ? hit.entity : hit
}

export interface BlockProps<A extends Record<string, unknown> = Record<string, unknown>> {
  readonly attrs: A
  setAttrs(patch: Partial<A>): void
  readonly readOnly: boolean
  readonly selected: boolean
  outline(): OutlineHeading[]
  scrollTo(pos: number): void
}

export interface BlockRegistration {
  forceWidth?: (attrs: Record<string, unknown>) => BlockWidth | null | undefined
}

export interface BlocksClient {
  register<A extends Record<string, unknown> = Record<string, unknown>>(
    id: string,
    component: (props: BlockProps<A>) => JSX.Element,
    options?: BlockRegistration,
  ): Disposable
}

export interface WidgetProps {
  widget: {
    id: string
    settings: Record<string, unknown>
    size: { w: number; h: number }
    editing?: boolean
  }
}

export interface WidgetsClient {
  register(id: string, component: (props: WidgetProps) => JSX.Element): Disposable
}

export interface DocumentSession extends CollabProvider {
  status(): "connecting" | "synced" | "offline" | "error" | (string & {})
  unsynced(): boolean
  error(): Error | null | undefined
  close(): void
}

export interface DocumentsClient {
  open(id: string): DocumentSession
  create(opts: {
    parent?: string
    title?: string
    content?: unknown
    markdown?: string
  }): Promise<DocumentInfo>
  history(id: string): Promise<DocumentVersion[]>
  read(id: string, opts?: { version?: string; format?: "json" | "markdown" }): Promise<DocumentContent>
  saveVersion(id: string, name?: string): Promise<DocumentVersion>
  restore(id: string, version: string): Promise<void>
}

export interface EntityChipProps {
  uri: string
  label?: string
  plain?: boolean
}

export interface EntityCardProps {
  uri: string
  density?: "compact" | "comfortable"
  record?: Record<string, unknown>
  groupedBy?: string
  fallback?: JSX.Element
}

export interface EntityRowProps {
  uri: string
  record?: Record<string, unknown>
  onOpen?: () => void
  fallback?: JSX.Element
}

export interface MentionPickerProps {
  query: string
  anchor?: HTMLElement
  open: boolean
  schemes?: string[]
  onPick: (entity: EntityInfo) => void
  onClose: () => void
}

export interface EntitiesClient {
  open(uri: string): void
  resolve(uri: string): Promise<EntityInfo | null>
  resolveMany(uris: string[]): Promise<EntityInfo[]>
  search(
    query: string,
    opts?: { schemes?: string[]; space?: string; limit?: number },
  ): Promise<Array<EntityInfo | SearchHit>>
  renders(surface: "card" | "row" | "chip", scheme: string): boolean
  Chip: (props: EntityChipProps) => JSX.Element
  Card: (props: EntityCardProps) => JSX.Element
  Row: (props: EntityRowProps) => JSX.Element
  MentionPicker: (props: MentionPickerProps) => JSX.Element
}

export interface PinsClient {
  list(): Promise<PinInfo[]>
  add(pin: {
    kind: string
    target: string
    title?: string
    icon?: string
    spaceId?: string
  }): Promise<PinInfo>
  remove(id: string): Promise<void>
  onChange(fn: () => void): Promise<Disposable>
}

export interface RecentsClient {
  entities(opts?: { schemes?: string[]; limit?: number }): Promise<RecentEntity[]>
}

export type ClientRookeryWithDocs = ClientRookery & {
  readonly entities?: EntitiesClient
  readonly documents?: DocumentsClient
  readonly pins?: PinsClient
  readonly recents?: RecentsClient
  readonly blocks?: BlocksClient
  readonly widgets?: WidgetsClient
  readonly blobs: ClientRookery["blobs"] & {
    upload?(file: Blob, opts?: { space?: string; pin?: boolean; name?: string }): Promise<BlobInfo>
  }
  readonly workbench: ClientRookery["workbench"] & {
    share?(uri: string): void
  }
}

export interface HostDocuments {
  list(ctx: Ctx | null, parentUri: string): Promise<DocumentInfo[]>
  create(
    ctx: Ctx | null,
    opts: { parent?: string; title?: string; content?: unknown; markdown?: string },
  ): Promise<DocumentInfo>
  delete(ctx: Ctx | null, id: string): Promise<void>
  json(ctx: Ctx, id: string): Promise<unknown>
  markdown(ctx: Ctx, id: string): Promise<string>
  append(ctx: Ctx, id: string, markdown: string, opts?: { author?: { name: string } }): Promise<unknown>
  edit(
    ctx: Ctx,
    id: string,
    ops: Array<{ op: string; [k: string]: unknown }>,
    opts?: { author?: { name: string } },
  ): Promise<unknown>
  replaceBlocks(
    ctx: Ctx,
    id: string,
    range: { from: number; to: number },
    body: { markdown: string },
    opts?: { author?: { name: string } },
  ): Promise<unknown>
  insert(
    ctx: Ctx,
    id: string,
    body: { markdown: string; at: number },
    opts?: { author?: { name: string } },
  ): Promise<unknown>
}

export interface HostEntities {
  lookup(ctx: Ctx, uri: string): Promise<EntityInfo | null>
  search(
    ctx: Ctx,
    query: string,
    opts?: { schemes?: string[]; space?: string; limit?: number },
  ): Promise<Array<EntityInfo | SearchHit>>
  toText(
    ctx: Ctx,
    uris: string[],
    opts?: { maxChars?: number },
  ): Promise<{ texts: Array<{ uri: string; title?: string | null; text: string }> }>
  text(
    scheme: string,
    handler: (ctx: Ctx, ref: { id: string }) => Promise<{ title: string; text: string } | null>,
  ): Disposable
}

export interface HostAgents {
  tool<S extends z.ZodTypeAny>(
    id: string,
    def: { params: S; run: (ctx: Ctx, params: z.infer<S>) => unknown },
  ): Disposable
}

export type HostRookery = Rookery & {
  readonly documents?: HostDocuments
  readonly entities?: HostEntities
  readonly agents?: HostAgents
}
