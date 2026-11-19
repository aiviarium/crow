// The hosts the terminal plugin works on, through `env.*` (hosts as environments, `env://NAME`). Only
// what the terminal views need: the list for the picker, the checkouts under the new-terminal form, and
// the `env.changed` topic that keeps the picker current.
import type { Checkout, EnvInfo } from "@rookery/client"
import type { ClientRookery } from "@rookery/sdk/client"

export interface HostsApi {
  list(): Promise<EnvInfo[]>
  get(env: string): Promise<EnvInfo>
  /** Git checkouts on the host, to suggest as a terminal's directory. */
  checkouts(env: string): Promise<Checkout[]>
  /** `env.changed`: an environment's state or access changed. Returns a function that stops listening. */
  onChanged(fn: (env: EnvInfo) => void): () => void
}

/** `env.changed` carries the environment that changed. */
export interface EnvChanged {
  environment: EnvInfo
}

export function envName(env: string): string {
  return env.replace(/^env:\/\//, "")
}

export function createHostsApi(rookery: ClientRookery): HostsApi {
  return {
    list: async () => {
      const res = await rookery.rpc.call<{ environments: EnvInfo[] }>("env.list", {})
      return res.environments ?? []
    },
    get: (env) => rookery.rpc.call<EnvInfo>("env.get", { env }),
    checkouts: async (env) => {
      const res = await rookery.rpc.call<{ checkouts: Checkout[] }>("env.checkouts", { env })
      return res.checkouts ?? []
    },
    onChanged(fn) {
      let off: (() => void) | undefined
      let stopped = false
      void rookery.events
        .subscribe("env.changed", (payload) => {
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
