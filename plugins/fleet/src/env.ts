// The hosts the fleet views work with, through `env.*` (a host is an environment, `env://NAME`), and the
// two ways a browser reaches a port on a host. Ported from the prototype's
// `plugins/fleet/lib/{berth,access}.ts` and its client `crow.env`, minus the berth client: Rookery's
// server opens the host links.
//
// rookery#42 settles the addresses: both forms work in params, answers name `env://NAME`, a port is
// `/env/NAME/port/N/…` on Rookery's origin (which mints a ticket and redirects), or `env.portUrl`'s
// address on the ports' own origin for one use. `env.checkouts` is deferred on the server, so it is not
// here.
import type { EnvPresence } from "@rookery/client"
import type { ClientRookery } from "@rookery/sdk/client"
import type { EnvChanged, EnvInfo, FileData, FileWritten, PortUrl } from "./types"

export interface FleetEnvApi {
  list(): Promise<EnvInfo[]>
  get(env: string): Promise<EnvInfo>
  /** Who has terminals running on the host: `view` is enough, and it names nobody's terminal. */
  presence(env: string): Promise<EnvPresence>
  /** A file on the host, in base64 with the SHA-256 that is its version. Needs `use`. */
  readFile(env: string, path: string): Promise<FileData>
  /**
   * Writes a file on the host, base64 in, with its new SHA-256 out. With `ifMatch` it writes only while
   * the file is still at that SHA-256; otherwise the server answers `CONFLICT`. Needs `use`.
   */
  writeFile(
    env: string,
    path: string,
    content: string | Uint8Array,
    opts?: { ifMatch?: string; overwrite?: boolean },
  ): Promise<FileWritten>
  /** A one-use address on the ports' own origin for a port of the host. Needs `use`. */
  portUrl(env: string, port: number, path?: string): Promise<PortUrl>
  /** `env.changed`: an environment's state or access changed, or it was removed. Returns a function that stops listening. */
  onChanged(fn: (e: EnvChanged) => void): () => void
}

/** `dev-01` or `env://dev-01` as the bare name. */
export const envName = (env: string) => env.replace(/^env:\/\//, "")

/** A host as `env://NAME`, from either form. */
export const envUri = (env: string) => `env://${envName(env)}`

/**
 * Rookery's own route to a port on a host's loopback: `/env/<name>/port/<n>/<path>`. The server checks
 * `use`, mints a one-use ticket and redirects to the port's origin, so a link here is safe to keep and to
 * open again. The browser never needs a route to the host.
 */
export function portPath(env: string, port: number, path = ""): string {
  return `/env/${encodeURIComponent(envName(env))}/port/${port}/${path.replace(/^\//, "")}`
}

export function createFleetEnvApi(rookery: ClientRookery): FleetEnvApi {
  return {
    list: () => rookery.env.list(),
    get: (env) => rookery.env.get(envUri(env)),
    presence: (env) => rookery.env.presence(envUri(env)),
    readFile: (env, path) => rookery.env.readFile(envUri(env), path),
    writeFile: (env, path, content, opts = {}) => rookery.env.writeFile(envUri(env), path, content, opts),
    portUrl: (env, port, path) => rookery.env.portUrl(envUri(env), port, path),
    onChanged(fn) {
      let off: (() => void) | undefined
      let stopped = false
      void rookery.events
        .subscribe("rookery/env.changed", (payload) => {
          const e = payload as EnvChanged | undefined
          if (e?.env) fn(e)
        })
        .then((d) => {
          if (stopped) d.dispose()
          else off = () => d.dispose()
        })
        .catch(() => {})
      return () => {
        stopped = true
        off?.()
      }
    },
  }
}
