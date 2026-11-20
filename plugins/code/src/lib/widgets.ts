// Widgets are declared in plugin.json; the dashboards plugin draws them, and takes each component from a
// registry shared through the global `crow.widgets.registry` symbol. `@rookery/sdk/client` has no
// `rookery.widgets` yet (M2), so this registers into the shared store directly, the same way projects
// and docs do. The store is kept whole here too, so it works whichever plugin's client half loads first.
import type { WidgetContribution } from "@rookery/client"
import type { ClientRookery, Disposable } from "@rookery/sdk/client"
import type { JSX } from "solid-js"

export interface WidgetProps {
  widget: {
    type: string
    plugin: string
    instance: string
    area: string
    settings: Record<string, unknown>
    size: { w: number; h: number }
    editing: boolean
    refreshed(): number
    update(patch: Record<string, unknown>): void
  }
}

export type WidgetComponent = (props: WidgetProps) => JSX.Element

const WIDGET_REGISTRY_SYMBOL = Symbol.for("crow.widgets.registry")

interface SharedWidgetStore {
  readonly components: Map<string, { plugin: string; component: WidgetComponent }>
  readonly manifestTypes: Map<string, Array<WidgetContribution & { plugin: string }>>
  readonly builtinTypes: Map<string, WidgetContribution & { plugin: string }>
  readonly listeners: Set<() => void>
  notify(): void
  register(plugin: string, id: string, component: WidgetComponent): Disposable
}

function store(): SharedWidgetStore {
  const g = globalThis as Record<PropertyKey, unknown>
  const existing = g[WIDGET_REGISTRY_SYMBOL] as SharedWidgetStore | undefined
  if (existing) return existing
  const components = new Map<string, { plugin: string; component: WidgetComponent }>()
  const manifestTypes = new Map<string, Array<WidgetContribution & { plugin: string }>>()
  const builtinTypes = new Map<string, WidgetContribution & { plugin: string }>()
  const listeners = new Set<() => void>()
  const created: SharedWidgetStore = {
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
      store().notify()
      return {
        dispose() {
          if (components.get(id) === entry) {
            components.delete(id)
            store().notify()
          }
        },
      }
    },
  }
  g[WIDGET_REGISTRY_SYMBOL] = created
  return created
}

export function registerWidget(rookery: ClientRookery, id: string, component: WidgetComponent): Disposable {
  const native = (
    rookery as unknown as {
      widgets?: { register(i: string, c: WidgetComponent): Disposable }
    }
  ).widgets
  if (native) return native.register(id, component)
  return store().register(rookery.id, id, component)
}
