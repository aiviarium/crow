// Focused client tests for the Models (`ai`) plugin: calls/NDJSON streaming, assist, recorder helpers,
// and the `ai.models` view loaded through Crow's shell builtins seam against a fake Rookery WS server.
import { afterEach, describe, expect, test } from "bun:test"
import type { ConnectionInfo, Me, StreamOpened, User } from "@rookery/client"
import { render } from "solid-js/web"
import { App } from "../../../shell/src/app/App"
import { createShellApp } from "../../../shell/src/app/state"
import { assistant } from "../src/client/assist"
import {
  calls,
  type LimitsInfo,
  type MappingInfo,
  type ProviderInfo,
  type TaskInfo,
} from "../src/client/calls"
import { encodeWav, micError, pickType } from "../src/client/recorder"

const cleanup: Array<() => void> = []
afterEach(() => {
  while (cleanup.length) cleanup.pop()!()
  document.body.innerHTML = ""
  document.title = "Crow"
})

async function waitFor(fn: () => boolean, label = "condition", timeoutMs = 10000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (fn()) return
    await Bun.sleep(10)
  }
  throw new Error(`timed out waiting for: ${label}`)
}

const enc = new TextEncoder()
function binaryFrame(streamId: number, text: string): Uint8Array {
  const payload = enc.encode(text)
  const out = new Uint8Array(4 + payload.byteLength)
  new DataView(out.buffer).setUint32(0, streamId)
  out.set(payload, 4)
  return out
}

const TEST_USER: User = {
  id: "u-ada",
  name: "Ada Lovelace",
  email: "ada@example.test",
  admin: true,
}

function startFakeAiServer() {
  const rpcCalls: Array<{ method: string; params: Record<string, unknown> }> = []
  let nextStreamId = 1
  const connections: ConnectionInfo[] = [
    {
      id: "conn-1",
      type: "model-anthropic.api",
      name: "Anthropic",
      scope: "global",
      config: { baseUrl: "https://api.anthropic.com" },
      hasCredential: true,
      spaceId: null,
      updatedAt: "2026-11-01T00:00:00Z",
    },
    {
      id: "conn-user",
      type: "ai.openai-compatible",
      name: "Personal",
      scope: "user",
      config: { baseUrl: "https://example.test/v1" },
      hasCredential: true,
      spaceId: null,
      updatedAt: "2026-11-01T00:00:00Z",
    },
  ]
  const providers: ProviderInfo[] = [
    {
      id: "model-anthropic.messages",
      title: "Anthropic Messages API",
      plugin: "model-anthropic",
      connectionType: "model-anthropic.api",
      tasks: ["text", "fast"],
      detectsLanguage: false,
    },
  ]
  let mappings: MappingInfo[] = [
    {
      task: "text",
      scope: "global",
      connection: "conn-1",
      connectionName: "Anthropic",
      connectionType: "model-anthropic.api",
      provider: "model-anthropic.messages",
      model: "claude-opus-5-5",
      live: false,
      destination: "api.anthropic.com",
      local: false,
      updatedAt: "2026-11-01T00:00:00Z",
    },
  ]
  let limits: LimitsInfo = {
    default: { requests: 100 },
    users: [{ userId: "u-ada", name: "Ada Lovelace", limits: { tokens: 5000 } }],
  }

  const sendReply = (ws: any, id: unknown, result: unknown) => {
    ws.send(JSON.stringify({ jsonrpc: "2.0", id, result }))
  }

  const server = Bun.serve({
    port: 0,
    fetch(req, srv) {
      const url = new URL(req.url)
      if (url.pathname === "/ws") {
        if (srv.upgrade(req, { data: undefined })) return undefined
        return new Response("upgrade failed", { status: 400 })
      }
      if (url.pathname === "/auth/session") return Response.json({ user: TEST_USER })
      return new Response("not found", { status: 404 })
    },
    websocket: {
      message(ws, data) {
        if (typeof data !== "string" && !(data instanceof Buffer)) return
        const text = typeof data === "string" ? data : data.toString("utf8")
        if (!text.startsWith("{")) return
        const msg = JSON.parse(text) as { id?: unknown; method?: string; params?: Record<string, unknown> }
        if (!msg.method || msg.id === undefined) return
        const p = msg.params ?? {}

        switch (msg.method) {
          case "auth.me": {
            const me: Me = {
              user: TEST_USER,
              principal: { kind: "user", id: TEST_USER.id },
              admin: true,
              auth: "local",
              version: "0.4.0",
              apiVersion: 1,
            }
            sendReply(ws, msg.id, me)
            return
          }
          case "plugins.list":
            sendReply(ws, msg.id, { plugins: [] })
            return
          case "commands.list":
            sendReply(ws, msg.id, { commands: [] })
            return
          case "jobs.list":
            sendReply(ws, msg.id, { jobs: [] })
            return
          case "notify.list":
            sendReply(ws, msg.id, { notifications: [], unread: 0 })
            return
          case "hosts.list":
            sendReply(ws, msg.id, { hosts: [] })
            return
          case "events.subscribe":
            sendReply(ws, msg.id, { subscription: "sub-1" })
            return
          case "events.unsubscribe":
            sendReply(ws, msg.id, {})
            return
          case "connections.list":
            sendReply(ws, msg.id, { connections })
            return
          case "settings.get":
            sendReply(ws, msg.id, { key: p.key, value: "auto", scope: "default" })
            return
          case "settings.list":
            sendReply(ws, msg.id, { settings: [] })
            return
          case "spaces.list":
            sendReply(ws, msg.id, { spaces: [] })
            return
          case "pins.list":
            sendReply(ws, msg.id, { pins: [] })
            return
          case "recents.list":
            sendReply(ws, msg.id, { entities: [], commands: [] })
            return
          case "entities.resolveMany":
            sendReply(ws, msg.id, { entities: [] })
            return
          case "entities.search":
            sendReply(ws, msg.id, { entities: [] })
            return
          case "data.find":
          case "data.scan":
            sendReply(ws, msg.id, { rows: [], next: null })
            return
          case "plugins.rpc":
          case "plugins.rpc.stream": {
            const rpcMethod = String(p.method ?? "")
            const rpcParams = (p.params ?? {}) as Record<string, unknown>
            rpcCalls.push({ method: rpcMethod, params: rpcParams })

            if (rpcMethod === "tasks") {
              const tasks: TaskInfo[] = [
                {
                  task: "text",
                  available: mappings.some((m) => m.task === "text"),
                  scope: "global",
                  provider: "model-anthropic.messages",
                  model: "claude-opus-5-5",
                  destination: "api.anthropic.com",
                  live: false,
                  detectsLanguage: false,
                },
                { task: "fast", available: false, live: false, detectsLanguage: false },
                { task: "transcription", available: false, live: false, detectsLanguage: false },
              ]
              sendReply(ws, msg.id, { tasks })
              return
            }
            if (rpcMethod === "mappings") {
              sendReply(ws, msg.id, { mappings })
              return
            }
            if (rpcMethod === "providers") {
              sendReply(ws, msg.id, { providers })
              return
            }
            if (rpcMethod === "models") {
              sendReply(ws, msg.id, { models: [{ id: "claude-opus-5-5", title: "Claude Opus 5.5" }] })
              return
            }
            if (rpcMethod === "usage") {
              sendReply(ws, msg.id, {
                rows: [
                  {
                    key: "text",
                    requests: 3,
                    errors: 0,
                    inputTokens: 120,
                    outputTokens: 45,
                    audioSeconds: 0,
                  },
                ],
                since: "2026-10-20T00:00:00Z",
              })
              return
            }
            if (rpcMethod === "limits") {
              sendReply(ws, msg.id, limits)
              return
            }
            if (rpcMethod === "setLimits") {
              limits = { ...limits, default: rpcParams.limits as LimitsInfo["default"] }
              sendReply(ws, msg.id, limits)
              return
            }
            if (rpcMethod === "removeMapping") {
              mappings = mappings.filter((m) => m.task !== rpcParams.task)
              sendReply(ws, msg.id, {})
              return
            }
            if (rpcMethod === "generate") {
              const streamId = nextStreamId++
              const opened: StreamOpened = { stream: streamId }
              sendReply(ws, msg.id, opened)
              const delta = JSON.stringify({ type: "delta", text: "Calm waves." })
              const done = JSON.stringify({
                type: "done",
                generated: {
                  request: "req-1",
                  text: "Calm waves.",
                  model: "claude-opus-5-5",
                  provider: "model-anthropic.messages",
                  usage: { inputTokens: 10, outputTokens: 3 },
                },
              })
              ws.send(binaryFrame(streamId, `${delta}\n${done}\n`))
              ws.send(
                JSON.stringify({ jsonrpc: "2.0", method: "streams.close", params: { stream: streamId } }),
              )
              return
            }
            sendReply(ws, msg.id, {})
            return
          }
          default:
            sendReply(ws, msg.id, {})
        }
      },
    },
  })

  return {
    baseUrl: `http://127.0.0.1:${server.port}`,
    wsUrl: `ws://127.0.0.1:${server.port}/ws`,
    rpcCalls,
    stop: () => server.stop(true),
  }
}

describe("ai plugin client helpers and Models view", () => {
  test("recorder helpers pick supported mime type, encode PCM WAV, and map mic errors", () => {
    expect(pickType((t) => t === "audio/mp4")).toBe("audio/mp4")
    expect(pickType(() => false)).toBeNull()

    const wav = encodeWav([new Float32Array(1600)], 16_000, 16_000)
    expect(String.fromCharCode(...wav.slice(0, 4))).toBe("RIFF")
    expect(String.fromCharCode(...wav.slice(8, 12))).toBe("WAVE")
    expect(wav.byteLength).toBe(44 + 1600 * 2)

    const blocked = micError({ name: "NotAllowedError" }) as Error & { blocked?: boolean }
    expect(blocked.blocked).toBe(true)
    expect(micError({ name: "NotFoundError" }).message).toContain("no microphone")
  })

  test("assistant builds prompt and streams deltas from calls.generate", async () => {
    const received: Array<{ method: string; params: Record<string, unknown> }> = []
    const api = calls({
      async call() {
        return {}
      },
      async stream(method: string, params: Record<string, unknown> = {}) {
        received.push({ method, params })
        const s: any = {
          id: 1,
          result: undefined,
          onData: () => {},
          onEnd: () => {},
          close() {},
        }
        setTimeout(() => {
          s.onData(enc.encode(`${JSON.stringify({ type: "delta", text: "Hello" })}\n`))
          s.onData(enc.encode(`${JSON.stringify({ type: "delta", text: " world" })}\n`))
          s.onEnd()
        }, 0)
        return s
      },
    } as any)

    const assist = assistant(api)
    const out: string[] = []
    for await (const piece of assist({
      action: "fix",
      instruction: "Fix typo",
      selection: "Helo world",
      before: "",
      after: "",
      signal: new AbortController().signal,
    })) {
      out.push(piece)
    }
    expect(out).toEqual(["Hello", " world"])
    expect(received[0]).toMatchObject({ method: "generate", params: { task: "text", plugin: "crow" } })
  })

  test("ModelsPage loads through shell builtins seam, filters global connections, and streams Try it", async () => {
    const server = startFakeAiServer()
    cleanup.push(() => server.stop())

    const app = createShellApp({
      wsUrl: server.wsUrl,
      baseUrl: server.baseUrl,
      initialUrl: "/ai",
      reconnect: false,
    })
    cleanup.push(() => app.dispose())

    const root = document.createElement("div")
    document.body.appendChild(root)
    cleanup.push(render(() => <App app={app} />, root))

    await app.boot()
    await app.loader.clientsSettled(4000)

    await waitFor(
      () => document.querySelector('[data-part="admin-models"]') !== null,
      "Models page mounts via builtins seam",
    )
    await waitFor(
      () => document.querySelector('[data-task="text"]')?.textContent?.includes("Set up") ?? false,
      "text task shows configured state",
    )

    // Privacy table should show the global mapping destination without leaking secrets or user-scoped connection.
    const privacy = document.querySelector('[data-part="models-privacy"]')
    expect(privacy?.textContent).toContain("api.anthropic.com")
    expect(privacy?.textContent).toContain("Leaves the network")

    // Run "Try it" generation and check streamed output.
    const runBtn = Array.from(document.querySelectorAll('[data-try="text"] button')).find(
      (b) => b.textContent?.trim() === "Run",
    ) as HTMLButtonElement | undefined
    expect(runBtn).toBeDefined()
    runBtn!.click()
    await waitFor(
      () =>
        document.querySelector('[data-part="models-try-output"]')?.textContent?.includes("Calm waves.") ??
        false,
      "Try it streams generated text",
    )
    expect(document.querySelector('[data-part="models-try-meta"]')?.textContent).toContain("claude-opus-5-5")

    // Usage totals rendered.
    const usage = document.querySelector('[data-part="models-usage"]')
    expect(usage?.textContent).toContain("165")
  })
})
