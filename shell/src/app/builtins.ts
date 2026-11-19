// The built-in seam: exposes `crow/plugins/*` as client halves without a server that serves them, so
// `bun run dev` and the tests run against a Rookery server that has no plugins installed. A packaged
// shell does not use it: it loads each client half from the server at `/plugins/ID/HASH/PATH` (see
// `state.ts`).
import type { Connection, Manifest, PluginInfo, PluginList } from "@rookery/client"
import { BUILTIN_SOURCES } from "./builtins.gen"

interface BuiltinPlugin {
  readonly id: string
  readonly scriptUrl: string
  readonly info: PluginInfo
  load(): Promise<{ default?: unknown }>
}

const BUILTIN_PREFIX = "data:crow-builtin/"

/** The lists a client reads without looking whether they are there, as `rookery serve` completes them. */
const LISTS = [
  "commands",
  "keybindings",
  "views",
  "nav",
  "adminPages",
  "routes",
  "contexts",
  "composer",
  "settings",
  "collections",
  "entityTypes",
  "spaceKinds",
  "tools",
  "jobs",
  "rpc",
  "topics",
  "schedules",
  "webhooks",
  "connectionTypes",
  "widgets",
  "blocks",
  "hostFeatures",
  "provisioners",
] as const

/**
 * A manifest with the id and version of its package and the default of every list and map, as the
 * server gives it in `plugins.list`.
 */
function complete(source: Record<string, unknown>, id: string, version: string): Manifest {
  const manifest: Record<string, unknown> = { ...source, id, version }
  manifest.name ??= id
  manifest.apiVersion ??= "1"
  manifest.dependencies ??= {}
  manifest.optionalDependencies ??= {}
  manifest.provides ??= { services: [] }
  manifest.extensionPoints ??= []
  manifest.activate ??= "lazy"
  manifest.contributes ??= {}
  const contributes = manifest.contributes as Record<string, unknown>
  for (const list of LISTS) contributes[list] ??= []
  contributes.extensions ??= {}
  return manifest as unknown as Manifest
}

// Every plugin in crow/plugins with a client half, found by scripts/builtins.ts.
const BUILTIN_PLUGINS: readonly BuiltinPlugin[] = BUILTIN_SOURCES.map(({ id, version, manifest, load }) => {
  const scriptUrl = `${BUILTIN_PREFIX}${id}`
  return {
    id,
    scriptUrl,
    info: {
      id,
      state: "active",
      package: `crow/${id}`,
      version,
      origin: "shipped",
      client: { script: scriptUrl, styles: null, hash: `builtin-${version}` },
      manifest: complete(manifest as Record<string, unknown>, id, version),
    } as unknown as PluginInfo,
    load,
  }
})

const BY_SCRIPT = new Map(BUILTIN_PLUGINS.map((p) => [p.scriptUrl, p]))

/**
 * Wraps `conn` for `createPluginLoader` so `plugins.list` merges any built-in `crow/plugins/*` that the
 * Rookery server does not advertise. Server-provided packages always take precedence.
 */
export function withBuiltinPlugins(conn: Connection): Connection {
  return new Proxy(conn, {
    get(target, prop, receiver) {
      if (prop === "call") {
        return async <T = unknown>(method: string, params?: Record<string, unknown>): Promise<T> => {
          if (method !== "plugins.list") {
            return target.call<T>(method, params)
          }
          let serverPlugins: PluginInfo[] = []
          try {
            const res = await target.call<PluginList>(method, params)
            serverPlugins = res?.plugins ?? []
          } catch {
            // A server without the plugin system still shows the built-in plugins.
          }
          const present = new Set(serverPlugins.map((p) => p.id))
          const merged = [
            ...serverPlugins,
            ...BUILTIN_PLUGINS.filter((b) => !present.has(b.id)).map((b) => b.info),
          ]
          return { plugins: merged } as T
        }
      }
      const value = Reflect.get(target, prop, receiver)
      return typeof value === "function" ? value.bind(target) : value
    },
  })
}

/**
 * Wraps `importModule` for `createPluginLoader` so built-in `crow/plugins/*` entries resolve from the
 * shell bundle while server-served plugin bundles use dynamic `import()`.
 */
export function withBuiltinImporter(
  fallback?: (url: string) => Promise<{ default?: unknown }>,
): (url: string) => Promise<{ default?: unknown }> {
  const base = fallback ?? ((url: string) => import(/* @vite-ignore */ url))
  return (url: string) => {
    const builtin = BY_SCRIPT.get(url)
    if (builtin) return builtin.load()
    return base(url)
  }
}
