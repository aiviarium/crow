// The plugin system's calls for fleet's admin page: what is installed (`plugins.list`), the registries
// plugins come from, and installing, updating, removing and activating one. Every one but `plugins.list`
// and `plugins.activate` needs an admin, which the server checks as well.
import type { PluginInfo, PluginList, PluginState } from "@rookery/client"
import type { ClientRookery } from "@rookery/sdk/client"

/** One line of `hatchery.kdl`: a registry plugins are installed from. */
export interface PluginRegistry {
  /** `git`, `http` or `dir`; `builtin` for the registry in Rookery's own source, and `off` for a line
   * that turns the registry its location names off. */
  kind: string
  location: string
  name: string
  /** The groups it may serve; any when empty. The server leaves it out when it serves any. */
  only?: string[]
  key?: string | null
  min_age?: string | null
  unsigned_tags?: boolean
  builtin?: boolean
}

/** The answer of `plugins.registry.list`: the registries, in the order they are searched. */
export interface PluginRegistries {
  /** The file they are kept in. */
  file: string
  registries: PluginRegistry[]
}

/** What a change of the plugins did: a few lines, and the plugins after it. */
export interface PluginReport {
  lines: string[]
  plugins: PluginInfo[]
}

/** Whether a newer version of an installed plugin is there. */
export interface PluginNewer {
  id: string
  package: string
  version: string
  latest?: string | null
  /** Why the newer version cannot be installed here, when it cannot. */
  note: string
}

export interface PluginAddOptions {
  /** A git repository to install one folder of, instead of a package of the registries. */
  git?: string
  /** With `git`: the package's folder in the repository. */
  path?: string
  /** With `git`: a tag, branch or commit. */
  ref?: string
  /** Install a version that the registry's minimum release age still holds back. */
  allowYoung?: boolean
}

export interface PluginsApi {
  listPlugins(): Promise<PluginList>
  pluginRegistries(): Promise<PluginRegistries>
  /** Installs a package of the registries, or an `https` address of an egg. */
  addPlugin(spec: string, options?: PluginAddOptions): Promise<PluginReport>
  /** Installs an egg file the person picked. */
  uploadPlugin(file: File): Promise<PluginReport>
  updatePlugin(id?: string): Promise<PluginReport>
  removePlugin(id: string): Promise<PluginReport>
  activatePlugin(id: string): Promise<PluginInfo>
  checkPlugins(): Promise<PluginNewer[]>
}

/** A file's bytes in base64, as `plugins.upload` takes an egg. */
async function base64(file: File): Promise<string> {
  const bytes = new Uint8Array(await file.arrayBuffer())
  let text = ""
  const CHUNK = 0x8000
  for (let at = 0; at < bytes.length; at += CHUNK)
    text += String.fromCharCode(...bytes.subarray(at, at + CHUNK))
  return btoa(text)
}

/** Whether a plugin's state means its host half is not running and an admin may start it. */
export function canActivate(state: PluginState): boolean {
  return state === "inactive" || state === "failed"
}

/** What a plugin's state is called where a person reads it. */
export const PLUGIN_STATE: Record<
  PluginState,
  { label: string; tone: "neutral" | "success" | "danger" | "warning" }
> = {
  active: { label: "Running", tone: "success" },
  activating: { label: "Starting", tone: "warning" },
  inactive: { label: "Starts on first use", tone: "neutral" },
  failed: { label: "Failed", tone: "danger" },
  invalid: { label: "Not valid", tone: "danger" },
}

export function createPluginsApi(rookery: ClientRookery): PluginsApi {
  const call = <T>(method: string, params: Record<string, unknown> = {}): Promise<T> =>
    rookery.rpc.call<T>(method, params)
  return {
    listPlugins: () => call<PluginList>("plugins.list"),
    pluginRegistries: () => call<PluginRegistries>("plugins.registry.list"),
    addPlugin: (spec, options = {}) =>
      call<PluginReport>("plugins.add", {
        spec,
        ...(options.git ? { git: options.git } : {}),
        ...(options.path ? { path: options.path } : {}),
        ...(options.ref ? { ref: options.ref } : {}),
        ...(options.allowYoung ? { allowYoung: true } : {}),
      }),
    async uploadPlugin(file) {
      return call<PluginReport>("plugins.upload", { base64: await base64(file) })
    },
    updatePlugin: (id) => call<PluginReport>("plugins.update", id === undefined ? {} : { id }),
    removePlugin: (id) => call<PluginReport>("plugins.remove", { id }),
    activatePlugin: (id) => call<PluginInfo>("plugins.activate", { id }),
    async checkPlugins() {
      const answer = await call<{ plugins: PluginNewer[] }>("plugins.check")
      return answer.plugins
    },
  }
}
