// Types for the SDK surfaces Docs uses, and the few UI extensions Crow's shell adds on top.
// Documents, entities, pins and recents are the SDK's own handles; only entity chips, cards, rows and
// the mention picker are still a shell extension.
import type { BlockWidth, CollabProvider, OutlineHeading } from "@aiviarium/nocturne"
import type { Ctx, Disposable, Rookery, z } from "@rookery/sdk"
import type {
  BlobInfo,
  ClientRookery,
  DocumentContent,
  DocumentVersion,
  EntityInfo,
  SearchHit,
} from "@rookery/sdk/client"
import type { JSX } from "solid-js"

export type { BlockWidth, OutlineHeading }

/** Extracts the underlying `EntityInfo` from either a flat `EntityInfo` or a `SearchHit`. */
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
  status(): "connecting" | "syncing" | "synced" | "offline" | "error" | (string & {})
  unsynced(): boolean
  error(): Error | null | undefined
  readOnly(): boolean
  close(): void
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

/** The SDK's entity index, with the shell's entity components where it draws them. */
export type EntitiesClient = ClientRookery["entities"] & {
  open?(uri: string): void
  renders?(surface: "card" | "row" | "chip", scheme: string): boolean
  Chip?(props: EntityChipProps): JSX.Element
  Card?(props: EntityCardProps): JSX.Element
  Row?(props: EntityRowProps): JSX.Element
  MentionPicker?(props: MentionPickerProps): JSX.Element
}

export type ClientRookeryWithDocs = Omit<ClientRookery, "entities"> & {
  readonly entities: EntitiesClient
  readonly blocks?: BlocksClient
  readonly widgets?: WidgetsClient
  readonly blobs: ClientRookery["blobs"] & {
    upload?(file: Blob, opts?: { space?: string; pin?: boolean; name?: string }): Promise<BlobInfo>
  }
  readonly workbench: ClientRookery["workbench"] & {
    share?(uri: string): void
  }
}

/** The host handle. Documents, entities and spaces are the SDK's own; nothing is bridged here. */
export type HostRookery = Rookery

/** The `documents.read` shapes Docs uses, named for the views that pass them around. */
export type DocumentsRead = DocumentContent

/** A document's history, as the views list it. */
export type DocumentHistory = DocumentVersion[]

/** The SDK's documents, as the host half calls them. */
export type HostDocuments = Rookery["documents"]

/** The SDK's entity index. */
export type HostEntities = Rookery["entities"]

/** The SDK's context, for the helpers that take one. */
export type HostCtx = Ctx

/** Kept for the interface declarations the service modules import. */
export type { z }
