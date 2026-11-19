// The hosts the fleet views work with, through `env.*` (a host is an environment, `env://NAME`), and the
// URL a port on a host is proxied at. Ported from the prototype's `plugins/fleet/lib/{berth,access}.ts`
// and its client `crow.env`, minus the berth client: Rookery's server opens the host links.
import type { Checkout, EnvInfo, EnvPresence } from "@rookery/client"
import type { ClientRookery } from "@rookery/sdk/client"

export interface FleetEnvApi {
  list(): Promise<EnvInfo[]>
  get(env: string): Promise<EnvInfo>
  /** Who has terminals running on the host: `view` is enough, and it names nobody's terminal. */
  presence(env: string): Promise<EnvPresence>
  checkouts(env: string): Promise<Checkout[]>
  /** `env.changed`: an environment's state or access changed. Returns a function that stops listening. */
  onChanged(fn: (env: EnvInfo) => void): () => void
}

/** `env.changed` carries the environment that changed. */
export interface EnvChanged {
  environment: EnvInfo
}

/** `dev-01` or `env://dev-01` as the bare name. */
export const envName = (env: string) => env.replace(/^env:\/\//, "")

/** A host as `env://NAME`, from either form. */
export const envUri = (env: string) => `env://${envName(env)}`

/**
 * Where the server proxies HTTP and WebSocket to a port on a host's loopback:
 * `/env/<name>/port/<n>/<path>`. The browser never needs a route to the host.
 */
export function portUrl(env: string, port: number, path = ""): string {
  return `/env/${encodeURIComponent(envName(env))}/port/${port}/${path.replace(/^\//, "")}`
}

export function createFleetEnvApi(rookery: ClientRookery): FleetEnvApi {
  return {
    list: async () => {
      const res = await rookery.rpc.call<{ environments: EnvInfo[] }>("env.list", {})
      return res.environments ?? []
    },
    get: (env) => rookery.rpc.call<EnvInfo>("env.get", { env: envUri(env) }),
    presence: (env) => rookery.rpc.call<EnvPresence>("env.presence", { env: envUri(env) }),
    checkouts: async (env) => {
      const res = await rookery.rpc.call<{ checkouts: Checkout[] }>("env.checkouts", { env: envUri(env) })
      return res.checkouts ?? []
    },
    onChanged(fn) {
      let off: (() => void) | undefined
      let stopped = false
      void rookery.events
        .subscribe("rookery/env.changed", (payload) => {
          const e = payload as EnvChanged | undefined
          if (e?.environment) fn(e.environment)
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
