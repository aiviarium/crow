// Reactive registry for dashboard/home widget types and components.
// Backed by a global bridge (`Symbol.for("crow.widgets.registry")`) so other plugins can register
// widgets in any load order until `@rookery/sdk/client` ships `rookery.widgets` directly.
import type { WidgetContribution } from "@rookery/client"
import type { Disposable } from "@rookery/sdk/client"
import { createMemo, createSignal } from "solid-js"
import type { WidgetComponent, WidgetInstance, WidgetType } from "./types"

/** The plugin id shell-builtin widgets use. */
export const SHELL = "crow"

export const WIDGET_REGISTRY_SYMBOL = Symbol.for("crow.widgets.registry")

interface Entry {
  plugin: string
  component: WidgetComponent
}

export interface SharedWidgetStore {
  readonly components: Map<string, Entry>
  readonly manifestTypes: Map<string, WidgetType[]>
  readonly builtinTypes: Map<string, WidgetType>
  readonly listeners: Set<() => void>
  notify(): void
  register(plugin: string, id: string, component: WidgetComponent): Disposable
  setPluginTypes(plugin: string, widgets: readonly WidgetContribution[]): Disposable
}

function getSharedStore(): SharedWidgetStore {
  const g = globalThis as Record<PropertyKey, unknown>
  const existing = g[WIDGET_REGISTRY_SYMBOL] as SharedWidgetStore | undefined
  if (existing) return existing
  const components = new Map<string, Entry>()
  const manifestTypes = new Map<string, WidgetType[]>()
  const builtinTypes = new Map<string, WidgetType>()
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
      const entry: Entry = { plugin, component }
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
      const list: WidgetType[] = widgets.map((w) => ({ ...w, plugin }))
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

const store = getSharedStore()
const [version, setVersion] = createSignal(0)
store.listeners.add(() => setVersion((v) => v + 1))

export function registerWidget(plugin: string, id: string, component: WidgetComponent): Disposable {
  return store.register(plugin, id, component)
}

export function registerManifestWidgets(plugin: string, widgets: readonly WidgetContribution[]): Disposable {
  return store.setPluginTypes(plugin, widgets)
}

/** Declares a widget the shell/dashboards plugin provides itself, with its component. */
export function defineBuiltinWidget(
  type: Omit<WidgetType, "plugin">,
  component: WidgetComponent,
): Disposable {
  const full: WidgetType = { ...type, plugin: SHELL }
  store.builtinTypes.set(type.id, full)
  const disp = store.register(SHELL, type.id, component)
  return {
    dispose() {
      if (store.builtinTypes.get(type.id) === full) store.builtinTypes.delete(type.id)
      disp.dispose()
    },
  }
}

/** Clears all registered widgets and types (for isolated unit tests). */
export function clearWidgetRegistry(): void {
  store.components.clear()
  store.manifestTypes.clear()
  store.builtinTypes.clear()
  store.notify()
}

/** Every widget type there is, builtins first, then plugins by plugin id. */
export const widgetTypes = createMemo<WidgetType[]>(() => {
  version()
  const out: WidgetType[] = [...store.builtinTypes.values()]
  for (const [, list] of store.manifestTypes) {
    for (const w of list) out.push(w)
  }
  return out
})

export const widgetType = (id: string): WidgetType | undefined => widgetTypes().find((t) => t.id === id)

export const widgetComponent = (id: string): WidgetComponent | undefined => {
  version()
  return store.components.get(id)?.component
}

export { limits, settingsWithDefaults } from "./settings"

let n = 0
export const newInstanceId = () =>
  `w${Date.now().toString(36)}${(n++).toString(36)}${Math.random().toString(36).slice(2, 5)}`

export type { WidgetInstance }
