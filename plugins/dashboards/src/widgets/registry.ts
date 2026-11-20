// Reactive registry for dashboard/home widget types and components, backed by the shell's
// `rookery.widgets.types()` and `loader.widgets()` when mounted inside the shell, with local
// registration (`registerWidget`, `registerManifestWidgets`, `defineBuiltinWidget`) for standalone unit tests.
import type { WidgetContribution } from "@rookery/client"
import type { Disposable } from "@rookery/sdk/client"
import { createMemo, createSignal } from "solid-js"
import type { WidgetComponent, WidgetInstance, WidgetType } from "./types"

/** The plugin id shell-builtin widgets use. */
export const SHELL = "crow"

interface Entry {
  plugin: string
  component: WidgetComponent
}

const components = new Map<string, Entry>()
const manifestTypes = new Map<string, WidgetType[]>()
const builtinTypes = new Map<string, WidgetType>()
const [version, setVersion] = createSignal(0)
const notify = () => setVersion((v) => v + 1)

export interface ShellWidgetSource {
  types(): readonly WidgetType[]
  component?(id: string): WidgetComponent | undefined
}

let shellSource: ShellWidgetSource | null = null

export function setShellWidgetSource(source: ShellWidgetSource | null): void {
  shellSource = source
  notify()
}

export function registerWidget(plugin: string, id: string, component: WidgetComponent): Disposable {
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
}

export function registerManifestWidgets(plugin: string, widgets: readonly WidgetContribution[]): Disposable {
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
}

/** Declares a widget the shell/dashboards plugin provides itself, with its component. */
export function defineBuiltinWidget(
  type: Omit<WidgetType, "plugin">,
  component: WidgetComponent,
): Disposable {
  const full: WidgetType = { ...type, plugin: SHELL }
  builtinTypes.set(type.id, full)
  const disp = registerWidget(SHELL, type.id, component)
  return {
    dispose() {
      if (builtinTypes.get(type.id) === full) builtinTypes.delete(type.id)
      disp.dispose()
    },
  }
}

/** Clears all registered widgets and types (for isolated unit tests). */
export function clearWidgetRegistry(): void {
  components.clear()
  manifestTypes.clear()
  builtinTypes.clear()
  shellSource = null
  notify()
}

/** Every widget type there is, builtins first, then plugins by plugin id. */
export const widgetTypes = createMemo<WidgetType[]>(() => {
  version()
  const seen = new Set<string>()
  const out: WidgetType[] = []
  for (const b of builtinTypes.values()) {
    seen.add(b.id)
    out.push(b)
  }
  for (const w of shellSource?.types() ?? []) {
    if (!seen.has(w.id)) {
      seen.add(w.id)
      out.push(w)
    }
  }
  for (const [, list] of manifestTypes) {
    for (const w of list) {
      if (!seen.has(w.id)) {
        seen.add(w.id)
        out.push(w)
      }
    }
  }
  return out
})

export const widgetType = (id: string): WidgetType | undefined => widgetTypes().find((t) => t.id === id)

export const widgetComponent = (id: string): WidgetComponent | undefined => {
  version()
  return shellSource?.component?.(id) ?? components.get(id)?.component
}

export { limits, settingsWithDefaults } from "./settings"

let n = 0
export const newInstanceId = () =>
  `w${Date.now().toString(36)}${(n++).toString(36)}${Math.random().toString(36).slice(2, 5)}`

export type { WidgetInstance }
