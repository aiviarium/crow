// The editor blocks and dashboard widgets this plugin contributes, registered where the shell can find
// them. `@rookery/sdk/client` has no `rookery.blocks` or `rookery.widgets` yet, so each falls back to the
// registries the shell and the dashboards plugin share through global symbols, the same way the other
// plugins do. When the SDK grows them, the native handle takes over and the bridge stays empty.

import type { EditorBlockType } from "@aiviarium/nocturne"
import type { WidgetContribution } from "@rookery/client"
import type { ClientRookery, Disposable } from "@rookery/sdk/client"
import type { JSX } from "solid-js"

export const BLOCK_REGISTRY_SYMBOL = Symbol.for("crow.blocks.registry")
const WIDGET_REGISTRY_SYMBOL = Symbol.for("crow.widgets.registry")

/** What a block's component is handed, as the shared editor defines it. */
export type BlockViewProps = Parameters<NonNullable<EditorBlockType["component"]>>[0]

export interface BlockOptions {
  forceWidth?: (attrs: Record<string, unknown>) => "reading" | "wide" | "full" | null | undefined
}

interface BlockEntry {
  plugin: string
  component: (props: BlockViewProps) => JSX.Element
  options?: BlockOptions
}

interface SharedBlockStore {
  readonly components: Map<string, BlockEntry>
  register(plugin: string, id: string, component: BlockEntry["component"], options?: BlockOptions): Disposable
}

function blockStore(): SharedBlockStore {
  const g = globalThis as Record<PropertyKey, unknown>
  const existing = g[BLOCK_REGISTRY_SYMBOL] as SharedBlockStore | undefined
  if (existing) return existing
  const components = new Map<string, BlockEntry>()
  const created: SharedBlockStore = {
    components,
    register(plugin, id, component, options) {
      const entry: BlockEntry = { plugin, component, ...(options ? { options } : {}) }
      components.set(id, entry)
      return {
        dispose() {
          if (components.get(id) === entry) components.delete(id)
        },
      }
    },
  }
  g[BLOCK_REGISTRY_SYMBOL] = created
  return created
}

/** Registers the component of a block `contributes.blocks` declares, with the shell or on the bridge. */
export function registerBlock(
  rookery: ClientRookery,
  id: string,
  component: BlockEntry["component"],
  options?: BlockOptions,
): Disposable {
  const native = (
    rookery as unknown as {
      blocks?: {
        register(id: string, component: BlockEntry["component"], options?: BlockOptions): Disposable
      }
    }
  ).blocks
  if (native) return native.register(id, component, options)
  return blockStore().register(rookery.id, id, component, options)
}

// ── widgets ──────────────────────────────────────────────────────────────────────────────────────────

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

/** The registry dashboards draws from. Kept whole here too, so it works whichever plugin loads first. */
interface SharedWidgetStore {
  readonly components: Map<string, { plugin: string; component: WidgetComponent }>
  readonly manifestTypes: Map<string, Array<WidgetContribution & { plugin: string }>>
  readonly builtinTypes: Map<string, WidgetContribution & { plugin: string }>
  readonly listeners: Set<() => void>
  notify(): void
  register(plugin: string, id: string, component: WidgetComponent): Disposable
}

function widgetStore(): SharedWidgetStore {
  const g = globalThis as Record<PropertyKey, unknown>
  const existing = g[WIDGET_REGISTRY_SYMBOL] as SharedWidgetStore | undefined
  if (existing) return existing
  const components = new Map<string, { plugin: string; component: WidgetComponent }>()
  const manifestTypes = new Map<string, Array<WidgetContribution & { plugin: string }>>()
  const builtinTypes = new Map<string, WidgetContribution & { plugin: string }>()
  const listeners = new Set<() => void>()
  const store: SharedWidgetStore = {
    components,
    manifestTypes,
    builtinTypes,
    listeners,
    notify() {
      for (const fn of listeners) fn()
    },
    register(plugin, id, component) {
      const entry = { plugin, component }
      components.set(id, entry)
      store.notify()
      return {
        dispose() {
          if (components.get(id) === entry) {
            components.delete(id)
            store.notify()
          }
        },
      }
    },
  }
  g[WIDGET_REGISTRY_SYMBOL] = store
  return store
}

/** Registers the component of a widget `contributes.widgets` declares. */
export function registerWidget(rookery: ClientRookery, id: string, component: WidgetComponent): Disposable {
  const native = (
    rookery as unknown as { widgets?: { register(id: string, component: WidgetComponent): Disposable } }
  ).widgets
  if (native) return native.register(id, component)
  return widgetStore().register(rookery.id, id, component)
}
