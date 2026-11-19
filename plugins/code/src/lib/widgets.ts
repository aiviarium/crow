// Widgets are declared in plugin.json; the dashboards plugin draws them, and takes each component from a
// registry shared through the global `crow.widgets.registry` symbol. `@rookery/sdk/client` has no
// `rookery.widgets` yet (M2), so this registers into the shared store directly, the same way projects does.
import type { ClientRookery, Disposable } from "@rookery/sdk/client"
import type { JSX } from "solid-js"

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
  register(plugin: string, id: string, component: WidgetComponent): Disposable
}

function store(): SharedWidgetStore {
  const g = globalThis as Record<PropertyKey, unknown>
  const existing = g[WIDGET_REGISTRY_SYMBOL] as SharedWidgetStore | undefined
  if (existing) return existing
  const components = new Map<string, { plugin: string; component: WidgetComponent }>()
  const created: SharedWidgetStore = {
    components,
    register(plugin, id, component) {
      const entry = { plugin, component }
      components.set(id, entry)
      return {
        dispose() {
          if (components.get(id) === entry) components.delete(id)
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
  const disposables: Disposable[] = []
  if (native) disposables.push(native.register(id, component))
  disposables.push(store().register(rookery.id, id, component))
  return {
    dispose() {
      for (const d of disposables) d.dispose()
    },
  }
}
