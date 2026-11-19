// Pre-M2 built-in plugin seam: exposes `crow/plugins/*` as built-in client halves through
// @rookery/client's `createPluginLoader` so `ROOKERY_SHELL_DIR` serves shell and fleet together.
// Delete this module in M2 once Hatchery packages serve plugin client halves from Rookery.
import type { Connection, PluginInfo, PluginList } from "@rookery/client"
import aiManifest from "../../../plugins/ai/plugin.json"
import fleetManifest from "../../../plugins/fleet/plugin.json"

interface BuiltinPlugin {
  readonly id: string
  readonly scriptUrl: string
  readonly info: PluginInfo
  load(): Promise<{ default?: unknown }>
}

const BUILTIN_PREFIX = "data:crow-builtin/"

const BUILTIN_PLUGINS: readonly BuiltinPlugin[] = [
  {
    id: fleetManifest.id,
    scriptUrl: `${BUILTIN_PREFIX}${fleetManifest.id}`,
    info: {
      id: fleetManifest.id,
      state: "active",
      client: {
        script: `${BUILTIN_PREFIX}${fleetManifest.id}`,
        styles: null,
        hash: `builtin-${fleetManifest.version}`,
      },
      manifest: fleetManifest,
    } as unknown as PluginInfo,
    load: () => import("../../../plugins/fleet/src/client"),
  },
  {
    id: aiManifest.id,
    scriptUrl: `${BUILTIN_PREFIX}${aiManifest.id}`,
    info: {
      id: aiManifest.id,
      state: "active",
      client: {
        script: `${BUILTIN_PREFIX}${aiManifest.id}`,
        styles: null,
        hash: `builtin-${aiManifest.version}`,
      },
      manifest: aiManifest,
    } as unknown as PluginInfo,
    load: () => import("../../../plugins/ai/src/client"),
  },
]

const BY_SCRIPT = new Map(BUILTIN_PLUGINS.map((p) => [p.scriptUrl, p]))

/**
 * Wraps `conn` for `createPluginLoader` so `plugins.list` merges any built-in `crow/plugins/*`
 * not already advertised by the Rookery server. Server-provided packages always take precedence.
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
            // Pre-M2 servers may not implement `plugins.list` yet; still load built-in plugins.
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
 * Wraps `importModule` for `createPluginLoader` so built-in `crow/plugins/*` entries resolve from
 * the shell bundle while server-served plugin bundles continue to use dynamic `import()`.
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
