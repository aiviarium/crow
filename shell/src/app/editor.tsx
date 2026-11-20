// The editor services the shell gives every `RichTextEditor`: the block types plugins contribute under
// `contributes.blocks`, drawn by the components their client halves register.
//
// A plugin's client half registers through the shared `crow.blocks.registry` symbol because
// `@rookery/sdk/client` has no `rookery.blocks` yet, the same bridge the dashboards' widgets use. A block
// whose plugin is missing or turned off keeps its data and shows the editor's placeholder, because its
// type is listed with `available: false` rather than dropped.
import {
  type BlockWidth,
  type EditorBlockType,
  type EditorServices,
  EditorServicesProvider,
} from "@aiviarium/nocturne"
import type { PluginInfo } from "@rookery/client"
import type { Disposable } from "@rookery/sdk/client"
import { type Accessor, createMemo, createSignal, type JSX, onCleanup, type ParentProps } from "solid-js"
import type { ShellApp } from "./state"

export const BLOCK_REGISTRY_SYMBOL = Symbol.for("crow.blocks.registry")

/** What a block's component is handed: its attributes, live, and the way to change them. */
export interface BlockViewProps {
  attrs: Record<string, unknown>
  setAttrs(next: Record<string, unknown>): void
  get readOnly(): boolean
}

export interface BlockOptions {
  forceWidth?: (attrs: Record<string, unknown>) => BlockWidth | null | undefined
}

interface Registration {
  plugin: string
  component: (props: BlockViewProps) => JSX.Element
  options?: BlockOptions
}

export interface SharedBlockStore {
  readonly components: Map<string, Registration>
  readonly listeners: Set<() => void>
  notify(): void
  register(
    plugin: string,
    id: string,
    component: Registration["component"],
    options?: BlockOptions,
  ): Disposable
}

/**
 * The block registry all plugins share. A plugin bundle carries its own copy of this file's user (its
 * `registerBlock` helper), so the store itself lives on the global object.
 */
export function sharedBlockStore(): SharedBlockStore {
  const g = globalThis as Record<PropertyKey, unknown>
  const existing = g[BLOCK_REGISTRY_SYMBOL] as SharedBlockStore | undefined
  if (existing) return existing
  const components = new Map<string, Registration>()
  const listeners = new Set<() => void>()
  const store: SharedBlockStore = {
    components,
    listeners,
    notify() {
      for (const fn of listeners) fn()
    },
    register(plugin, id, component, options) {
      const entry: Registration = { plugin, component, ...(options ? { options } : {}) }
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
  g[BLOCK_REGISTRY_SYMBOL] = store
  return store
}

/** A new block's attributes: the defaults of the manifest's JSON Schema. */
export function defaultsOf(schema: unknown): Record<string, unknown> {
  const props =
    (schema as { properties?: Record<string, { default?: unknown }> } | undefined)?.properties ?? {}
  return Object.fromEntries(
    Object.entries(props)
      .filter(([, p]) => p && "default" in p)
      .map(([k, p]) => [k, p.default]),
  )
}

/** Every block type the active plugins declare, with the component of each that registered one. */
export function blockTypes(plugins: Readonly<Record<string, PluginInfo>>): EditorBlockType[] {
  const out: EditorBlockType[] = []
  for (const p of Object.values(plugins)) {
    for (const b of p.manifest?.contributes?.blocks ?? []) {
      const entry = sharedBlockStore().components.get(b.id)
      out.push({
        id: b.id,
        title: b.title,
        ...(b.description ? { description: b.description } : {}),
        ...(b.icon ? { icon: b.icon } : {}),
        ...(b.keywords ? { keywords: b.keywords } : {}),
        defaults: defaultsOf(b.attrs),
        plugin: p.id,
        ...(entry ? { component: entry.component as EditorBlockType["component"] } : {}),
        available: !!entry,
        ...(b.width ? { width: b.width } : {}),
        ...(entry?.options?.forceWidth ? { forceWidth: entry.options.forceWidth } : {}),
      })
    }
  }
  return out
}

/** An accessor over the block types, kept current as plugins load and register their components. */
export function blockTypeSource(app: ShellApp): Accessor<EditorBlockType[]> {
  const store = sharedBlockStore()
  const [version, setVersion] = createSignal(0)
  const listener = () => setVersion((v) => v + 1)
  store.listeners.add(listener)
  onCleanup(() => store.listeners.delete(listener))
  return createMemo(() => {
    version()
    // Reading the loader's plugins here is what makes a plugin's activation show its blocks.
    return blockTypes(app.loader.plugins)
  })
}

/** Wraps the shell's views so every editor under them can show the plugins' blocks. */
export function CrowEditorServices(props: ParentProps<{ app: ShellApp }>): JSX.Element {
  const types = blockTypeSource(props.app)
  const services: EditorServices = { blocks: types }
  return <EditorServicesProvider value={services}>{props.children}</EditorServicesProvider>
}
