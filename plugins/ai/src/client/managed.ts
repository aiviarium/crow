// The built-in Models page also works with a provider host half on servers with unary plugin RPC.
import { type ClientRookery, RookeryError } from "@rookery/sdk/client"
import type { Calls, Generated, MappingInfo, ModelInfo, ProviderInfo, Task } from "./calls"

const PROVIDER: ProviderInfo = {
  id: "model-anthropic.messages",
  title: "Anthropic Messages API",
  plugin: "model-anthropic",
  connectionType: "model-anthropic.api",
  tasks: ["text", "fast"],
  detectsLanguage: false,
}

export const ANTHROPIC_TYPE = PROVIDER.connectionType
const destination = "api.anthropic.com"
const mappingKey = (task: Task) => `mapping.${task}`
const supports = (task: unknown): task is Task => task === "text" || task === "fast"

export function managedModels(rookery: ClientRookery, router: Calls) {
  const available = async () => {
    try {
      return (await rookery.connections.types()).some(({ id }) => id === ANTHROPIC_TYPE)
    } catch {
      return false
    }
  }
  const asAdmin = async () => (await rookery.rpc.call<{ admin: boolean }>("auth.me", {})).admin
  const rpc = <T>(method: string, params: Record<string, unknown>) =>
    rookery.rpc.call<T>("plugins.rpc", { plugin: PROVIDER.plugin, method, params })

  const connections = () =>
    rookery.connections
      .list({ type: ANTHROPIC_TYPE })
      .then((list) => list.filter((c) => c.scope === "global" && c.hasCredential))

  const mappings = async (): Promise<MappingInfo[]> => {
    const byId = new Map((await connections()).map((c) => [c.id, c]))
    const entries = await rookery.settings.list()
    return PROVIDER.tasks.flatMap((task) => {
      const entry = entries.find((s) => s.key === mappingKey(task) && s.scope === "global")
      const value = entry?.value as Partial<MappingInfo> | undefined
      if (!value?.connection || typeof value.model !== "string" || !value.model) return []
      const connection = byId.get(value.connection)
      if (!connection) return []
      return [
        {
          task,
          scope: "global",
          connection: connection.id,
          connectionName: connection.name,
          connectionType: ANTHROPIC_TYPE,
          model: value.model,
          provider: PROVIDER.id,
          destination,
          local: false,
          live: false,
          updatedAt: value.updatedAt ?? connection.updatedAt,
        },
      ]
    })
  }

  const calls: Calls = {
    ...router,
    async tasks() {
      if (!(await available())) return router.tasks()
      if (!(await asAdmin())) return []
      return (await mappings()).map((m) => ({ ...m, available: true, detectsLanguage: false }))
    },
    async providers() {
      return (await available()) ? [PROVIDER] : router.providers()
    },
    async mappings() {
      return (await available()) ? mappings() : router.mappings()
    },
    async setMapping(params) {
      if (!(await available())) return router.setMapping(params)
      const { task, scope, connection, model } = params
      if (!supports(task) || scope !== "global" || typeof model !== "string" || !model.trim()) {
        throw new RookeryError("INVALID", "Choose a model for the text or fast task")
      }
      if (!(await connections()).some((c) => c.id === connection)) {
        throw new RookeryError("NOT_FOUND", "Choose a global Anthropic connection")
      }
      await rookery.rpc.call("settings.set", {
        plugin: "ai",
        key: mappingKey(task),
        scope: "global",
        value: { connection, model: model.trim(), updatedAt: new Date().toISOString() },
      })
      const mapping = (await mappings()).find((m) => m.task === task)
      if (!mapping) throw new RookeryError("UNAVAILABLE", "The task mapping could not be loaded")
      return mapping
    },
    async removeMapping(params) {
      if (!(await available())) return router.removeMapping(params)
      if (supports(params.task) && params.scope === "global") {
        await rookery.rpc.call("settings.reset", {
          plugin: "ai",
          key: mappingKey(params.task),
          scope: "global",
        })
      }
    },
    async models(connection) {
      if (!(await available())) return router.models(connection)
      return (await rpc<{ models: ModelInfo[] }>("models", { connection })).models
    },
    async *generate(params, signal) {
      if (!(await available())) {
        yield* router.generate(params, signal)
        return
      }
      signal?.throwIfAborted()
      const mapped = (await mappings()).find((m) => m.task === params.task)
      if (!mapped) throw new RookeryError("UNAVAILABLE", "Set up a model for this task")
      const generated = await rpc<Generated>("complete", {
        task: params.task,
        connection: mapped.connection,
        model: mapped.model,
        prompt: params.prompt,
        system: params.system,
      })
      signal?.throwIfAborted()
      yield { type: "delta", text: generated.text }
      yield { type: "done", generated }
    },
  }
  return { calls, available, asAdmin }
}

export type ManagedModels = ReturnType<typeof managedModels>
