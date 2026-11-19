import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { GlobalRegistrator } from "@happy-dom/global-registrator"
import { type Ctx, disposable, type Rookery } from "@rookery/sdk"
import plugin, { testConnection } from "../src/host"
import { generate, models } from "../src/provider"
import { startMockMessages } from "./mock"

const mock = startMockMessages()
const hadDom = GlobalRegistrator.isRegistered
const nativeGlobals = {
  fetch: globalThis.fetch,
  Request: globalThis.Request,
  Response: globalThis.Response,
  Headers: globalThis.Headers,
  WebSocket: globalThis.WebSocket,
}
beforeAll(async () => {
  // Crow's root bunfig preloads happy-dom globally; host plugins run outside a browser and need native AbortSignal.
  if (hadDom) await GlobalRegistrator.unregister()
})
afterAll(() => {
  mock.stop()
  if (hadDom) {
    GlobalRegistrator.register({ url: "http://localhost:4791/", width: 1280, height: 800 })
    globalThis.fetch = nativeGlobals.fetch
    globalThis.Request = nativeGlobals.Request
    globalThis.Response = nativeGlobals.Response
    globalThis.Headers = nativeGlobals.Headers
    globalThis.WebSocket = nativeGlobals.WebSocket
  }
})

const call = (over: Record<string, unknown> = {}) =>
  ({
    request: "r1",
    task: "text",
    model: "claude-opus-5-5",
    connection: { values: { apiKey: "sk-ant-mock", baseUrl: mock.url } },
    system: "Be brief.",
    messages: [{ role: "user", content: "Hi" }],
    ...over,
  }) as any

describe("the Anthropic provider against a mock Messages API", () => {
  test("streams text deltas and reports usage", async () => {
    const pieces: string[] = []
    const r = await generate(call(), (t) => pieces.push(t))
    expect(pieces).toEqual(["Hello", " from", " Claude"])
    expect(r.text).toBe("Hello from Claude")
    expect(r.usage).toEqual({ inputTokens: 21, outputTokens: 7 })
    const sent = mock.requests.at(-1)!
    expect(sent.body).toMatchObject({
      model: "claude-opus-5-5",
      system: "Be brief.",
      stream: true,
      fallbacks: "default",
    })
    expect(sent.headers["anthropic-beta"]).toContain("server-side-fallback-2026-07-01")
    expect(sent.headers["anthropic-version"]).toBeTruthy()
  })

  test("structured output goes in output_config.format and fast asks for low effort", async () => {
    const schema = { type: "object", properties: { title: { type: "string" } }, required: ["title"] }
    const r = await generate(call({ task: "fast", model: "claude-haiku-5-5", schema }), () => {})
    expect(r.object).toEqual({ title: "A Claude title" })
    const sent = mock.requests.at(-1)!.body
    expect(sent.output_config).toEqual({ effort: "low", format: { type: "json_schema", schema } })
    expect(sent.fallbacks).toBeUndefined()
  })

  test("errors keep their meaning, refusals are reported", async () => {
    await expect(generate(call({ model: "missing" }), () => {})).rejects.toMatchObject({ code: "NOT_FOUND" })
    const badKey = call({ connection: { values: { apiKey: "wrong", baseUrl: mock.url } } })
    await expect(generate(badKey, () => {})).rejects.toMatchObject({ code: "UNAVAILABLE" })
    await expect(generate(call({ model: "refuses" }), () => {})).rejects.toMatchObject({
      code: "UNAVAILABLE",
    })
  })

  test("aborting the signal cancels the request at the API", async () => {
    const abort = new AbortController()
    const pieces: string[] = []
    const p = generate(
      call({ model: "slow" }),
      (t) => {
        pieces.push(t)
        if (pieces.length === 2) abort.abort(new Error("stop"))
      },
      abort.signal,
    )
    await expect(p).rejects.toThrow("stop")
    await Bun.sleep(300)
    expect(mock.aborted()).toBe(true)
  })

  test("lists models and tests connection", async () => {
    const list = await models({ apiKey: "sk-ant-mock", baseUrl: mock.url })
    expect(list.map((m) => m.id)).toEqual(["claude-opus-5-5", "claude-haiku-5-5"])
    expect(list[0]!.title).toBe("Claude Opus 5.5")

    const ok = await testConnection({ apiKey: "sk-ant-mock", baseUrl: mock.url })
    expect(ok).toMatchObject({
      ok: true,
      message: "2 models: claude-opus-5-5, claude-haiku-5-5",
      details: { models: ["claude-opus-5-5", "claude-haiku-5-5"] },
    })

    const bad = await testConnection({ apiKey: "wrong", baseUrl: mock.url })
    expect(bad.ok).toBe(false)
  })

  test("host plugin resolves connection credential via Rookery connections.resolve and streams", async () => {
    let provided: Record<string, (ctx: Ctx, params: any) => any> = {}
    const fakeRookery = {
      connections: {
        async resolve(id: string) {
          expect(id).toBe("conn-ant")
          return {
            connection: {
              id: "conn-ant",
              type: "model-anthropic.api",
              name: "Anthropic",
              scope: "global",
              config: { baseUrl: mock.url },
              hasCredential: true,
              updatedAt: "2026-11-01T00:00:00Z",
            },
            credential: "sk-ant-mock",
          }
        },
      },
      services: {
        provide(service: string, methods: Record<string, (ctx: Ctx, params: any) => any>) {
          expect(service).toBe("anthropic")
          provided = methods
          return disposable(() => {})
        },
      },
    } as unknown as Rookery

    await plugin.activate(fakeRookery)
    const ctx = { signal: new AbortController().signal } as unknown as Ctx
    const chunks: unknown[] = []
    for await (const chunk of provided.generate!(ctx, {
      request: "req-1",
      provider: "model-anthropic.messages",
      task: "text",
      connection: "conn-ant",
      messages: [{ role: "user", content: "Hi" }],
    })) {
      chunks.push(chunk)
    }
    expect(chunks.slice(0, 3)).toEqual([
      { type: "delta", text: "Hello" },
      { type: "delta", text: " from" },
      { type: "delta", text: " Claude" },
    ])
    expect(chunks.at(-1)).toMatchObject({
      type: "result",
      text: "Hello from Claude",
      model: "claude-opus-5-5",
    })
  })
})
