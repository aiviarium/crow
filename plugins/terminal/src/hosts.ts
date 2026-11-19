// The hosts the terminal plugin works on, through `env.*` (hosts as environments, `env://NAME`). Only
// what the terminal views need: the list for the picker, and the `env.changed` topic that keeps the
// picker current. `env.checkouts` is not among them: it is deferred to M5 on the server, so the
// new-terminal form takes a typed directory instead of suggesting one.
import type { EnvInfo } from "@rookery/client"
import type { ClientRookery } from "@rookery/sdk/client"
import { envUri } from "./env"

export interface HostsApi {
  list(): Promise<EnvInfo[]>
  get(env: string): Promise<EnvInfo>
  /** `env.changed`: an environment's state or access changed, or it was removed. Returns a function that stops listening. */
  onChanged(fn: (e: EnvChanged) => void): () => void
}

/** The payload of `rookery/env.changed`, as rookery#42 sends it: `env://NAME`, and the environment until
 * it is removed. */
export interface EnvChanged {
  /** `env://<name>`. */
  env: string
  environment?: EnvInfo
  removed?: boolean
}

export function createHostsApi(rookery: ClientRookery): HostsApi {
  return {
    list: async () => {
      const res = await rookery.rpc.call<{ environments: EnvInfo[] }>("env.list", {})
      return res.environments ?? []
    },
    get: (env) => rookery.rpc.call<EnvInfo>("env.get", { env: envUri(env) }),
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
