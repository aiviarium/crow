// The model-anthropic plugin's host half: serves the `anthropic` service the Models plugin calls for the
// `model-anthropic.messages` provider (its contribution to `ai.providers`), so an admin can map the text and fast
// tasks to Anthropic's Messages API, and tests a connection by listing its models.
//
// Connection credentials are fetched via `rookery.connections.resolve(id)` so API keys stay sealed in Rookery's
// credential store (`secrets` / `connections`) and never appear in settings, logs, or argv.
import { type Ctx, definePlugin } from "@rookery/sdk"
import type { ProviderCallParams } from "../interface"
import { generate, models, type ProviderCall } from "./provider"

export async function testConnection(
  values: Record<string, unknown>,
  signal?: AbortSignal,
): Promise<{ ok: boolean; message: string; details?: { models: string[] } }> {
  try {
    const list = await models(values, signal)
    const shown = list
      .slice(0, 5)
      .map((m) => m.id)
      .join(", ")
    return {
      ok: true,
      message: `${list.length} models: ${shown}`,
      details: { models: list.map((m) => m.id) },
    }
  } catch (e: unknown) {
    return { ok: false, message: e instanceof Error ? e.message : String(e) }
  }
}

export default definePlugin((rookery) => {
  const valuesOf = async (id: string): Promise<Record<string, unknown>> => {
    const resolved = await rookery.connections.resolve(id)
    // The connection's config holds no address, so the API key only ever goes to Anthropic. A
    // redirect is refused: it could carry the key to another host.
    return { apiKey: resolved.credential ?? "", rejectRedirects: true }
  }

  rookery.services.provide("anthropic", {
    async *generate(ctx: Ctx, p: ProviderCallParams) {
      const values = await valuesOf(p.connection)
      const queue: string[] = []
      let wake: (() => void) | undefined
      let finished = false
      const call: ProviderCall = {
        task: p.task,
        model: p.model,
        system: p.system,
        messages: p.messages,
        schema: p.schema,
        maxTokens: p.maxTokens,
        connection: { values },
      }
      const run = generate(
        call,
        (t) => {
          queue.push(t)
          wake?.()
        },
        ctx.signal,
      ).finally(() => {
        finished = true
        wake?.()
      })
      run.catch(() => {})
      for (;;) {
        while (queue.length) yield { type: "delta" as const, text: queue.shift()! }
        if (finished) break
        await new Promise<void>((r) => {
          wake = r
        })
        wake = undefined
      }
      const r = await run
      yield { type: "result" as const, ...r }
    },
    models: async (ctx: Ctx, p: ProviderCallParams) => ({
      models: await models(await valuesOf(p.connection), ctx.signal),
    }),
  })

  // `@rookery/sdk` host `Connections` does not expose `connections.test(type, fn)` yet (arrives in M2).
  // Register when present; testConnection stays exported for direct verification and `API.md` tracks the gap.
  const connections = rookery.connections as unknown as {
    test?: (
      type: string,
      handler: (ctx: Ctx, conn: { values: Record<string, unknown> }) => Promise<unknown>,
    ) => unknown
  }
  connections.test?.("model-anthropic.api", (ctx, conn) => testConnection(conn.values, ctx.signal))
})
