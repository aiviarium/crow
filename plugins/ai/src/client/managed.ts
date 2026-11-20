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
const mappingKey = (task: Task) => `${task}|global||`
const supports = (task: unknown): task is Task => task === "text" || task === "fast"

/** A row of the plugin's `mappings` collection: one task's model, at a scope. */
interface MappingRow {
  id: string
  key: string
  task: Task
  scope: "global" | "space" | "user"
  connection: string
  model: string
  live?: boolean
  updatedAt: string
}

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

  const mappingRows = async (): Promise<MappingRow[]> => {
    const page = await rookery.data.mappings.find({
      where: { scope: "global" },
      limit: 50,
    })
    return page.rows as unknown as MappingRow[]
  }

  const mappings = async (): Promise<MappingInfo[]> => {
    const byId = new Map((await connections()).map((c) => [c.id, c]))
    return (await mappingRows()).flatMap((row) => {
      const connection = byId.get(row.connection)
      if (!connection || !row.model) return []
      return [
        {
          task: row.task,
          scope: "global",
          connection: connection.id,
          connectionName: connection.name,
          connectionType: ANTHROPIC_TYPE,
          model: row.model,
          provider: PROVIDER.id,
          destination,
          local: false,
          live: row.live === true,
          updatedAt: row.updatedAt,
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
      await rookery.data.mappings.upsert(
        {
          key: mappingKey(task),
          task,
          scope: "global",
          connection,
          model: model.trim(),
        },
        { on: ["key"] },
      )
      const mapping = (await mappings()).find((m) => m.task === task)
      if (!mapping) throw new RookeryError("UNAVAILABLE", "The task mapping could not be loaded")
      return mapping
    },
    async removeMapping(params) {
      if (!(await available())) return router.removeMapping(params)
      if (supports(params.task) && params.scope === "global") {
        const row = (await mappingRows()).find((r) => r.task === params.task)
        if (row) await rookery.data.mappings.delete(row.id)
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
