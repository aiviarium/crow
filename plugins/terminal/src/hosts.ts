// The hosts the terminal plugin works on, through `env.*` (hosts as environments, `env://NAME`). Only
// what the terminal views need: the list for the picker, and the `env.changed` topic that keeps the
// picker current. `env.checkouts` is not among them: it is deferred to M5 on the server, so the
// new-terminal form takes a typed directory instead of suggesting one.
import type { EnvChanged, EnvInfo } from "@rookery/client"
import type { ClientRookery } from "@rookery/sdk/client"
import { isMethodMissing, listLegacyAgentHosts } from "../../agents/src/api"
import { envUri } from "./env"

export interface HostsApi {
  list(): Promise<EnvInfo[]>
  get(env: string): Promise<EnvInfo>
  /** `env.changed`: an environment's state or access changed, or it was removed. Returns a function that stops listening. */
  onChanged(fn: (e: EnvChanged) => void): () => void
}

export function createHostsApi(rookery: ClientRookery): HostsApi {
  return {
    list: async () => {
      try {
        const res = await rookery.rpc.call<{ environments: EnvInfo[] }>("env.list", {})
        const envs = res.environments ?? []
        if (envs.every((e) => e.supports.agents !== undefined)) return envs
        const legacy = await listLegacyAgentHosts(rookery).catch(() => [])
        const flags = new Map(legacy.map((h) => [h.name, h.agentsSupported]))
        return envs.map((e) => ({
          ...e,
          supports: { ...e.supports, agents: e.supports.agents ?? flags.get(e.name) ?? false },
        }))
      } catch (error) {
        if (!isMethodMissing(error)) throw error
      }
      return (await listLegacyAgentHosts(rookery)).map(({ name, env, state, kind, agentsSupported }) => ({
        name,
        uri: env,
        state: state === "online" ? "online" : "offline",
        kind,
        supports: {
          terminal: false,
          process: false,
          files: false,
          connect: false,
          checkouts: false,
          desktop: false,
          privileged: false,
          persistentSessions: false,
          deploy: false,
          agents: agentsSupported ?? false,
        },
      }))
    },
    get: (env) => rookery.rpc.call<EnvInfo>("env.get", { env: envUri(env) }),
    onChanged(fn) {
      const active = new Set<() => void>()
      let stopped = false
      const subscribe = (topic: string, read: (payload: unknown) => EnvChanged | undefined) => {
        void rookery.events
          .subscribe(topic, (payload) => {
            const change = read(payload)
            if (change?.env) fn(change)
          })
          .then((handle) => {
            if (stopped) handle.dispose()
            else active.add(() => handle.dispose())
          })
          .catch(() => {})
      }
      subscribe("rookery/env.changed", (payload) => payload as EnvChanged | undefined)
      subscribe("rookery/hosts.changed", (payload) => {
        const change = payload as { host?: string; removed?: boolean } | undefined
        return change?.host ? { env: envUri(change.host), removed: change.removed } : undefined
      })
      return () => {
        stopped = true
        for (const off of active) off()
        active.clear()
      }
    },
  }
}
