import { definePlugin, RookeryError, z } from "@rookery/sdk"
import { DEFAULT_BASE_URL, generate, models } from "./provider"

// The current extension host enforces this level. Crow's older SDK pin predates the field.
const admin = { level: "admin" } as const
const connectionId = z.object({ connection: z.string().uuid() })
const generation = connectionId.extend({
  task: z.enum(["text", "fast"]),
  model: z.string().trim().min(1).max(200),
  prompt: z.string().trim().min(1).max(100_000),
  system: z.string().max(100_000).optional(),
})

export default definePlugin((rookery) => {
  const valuesOf = async (id: string) => {
    const connection = await rookery.connections.get(id)
    if (connection.type !== "model-anthropic.api" || connection.scope !== "global") {
      throw new RookeryError("NOT_FOUND", "No global Anthropic connection")
    }
    const { credential } = await rookery.connections.resolve(id)
    return { apiKey: credential, baseUrl: DEFAULT_BASE_URL, rejectRedirects: true }
  }
  const providerError = () =>
    new RookeryError(
      "UNAVAILABLE",
      "Anthropic could not complete the request. Check the connection and model.",
    )

  rookery.rpc.handle("models", {
    ...admin,
    params: connectionId,
    async run(ctx, { connection }) {
      const values = await valuesOf(connection)
      try {
        return { models: await models(values, ctx.signal) }
      } catch {
        throw providerError()
      }
    },
  })
  rookery.rpc.handle("complete", {
    ...admin,
    params: generation,
    async run(ctx, { connection, task, model, prompt, system }) {
      const values = await valuesOf(connection)
      try {
        const result = await generate(
          {
            task,
            model,
            system,
            messages: [{ role: "user", content: prompt }],
            connection: { values },
            maxTokens: 4096,
          },
          () => {},
          ctx.signal,
        )
        return { ...result, provider: "model-anthropic.messages", request: crypto.randomUUID() }
      } catch {
        throw providerError()
      }
    },
  })
})
