// The attach stream: two-step open and attach, frames, resume from the byte offset, the size rule's
// controls, read only viewers, a refusal, and the states a viewer shows. A fake `streams.open` stands in
// for the server; nothing here touches a socket.
import { describe, expect, test } from "bun:test"
import type { ClientRookery, ClientStream } from "@rookery/sdk/client"
import { createTerminalsApi, TerminalConnection } from "../src/termApi"
import type { TerminalAttached, TerminalInfo, TermSize } from "../src/types"

const encoder = new TextEncoder()

class FakeStream implements ClientStream {
  readonly id = 7
  result: unknown
  written: Uint8Array[] = []
  closed = false
  onData: (data: Uint8Array) => void = () => {}
  onEnd: (error?: { code: string; message: string }) => void = () => {}

  constructor(result: unknown) {
    this.result = result
  }

  async write(data: Uint8Array) {
    this.written.push(new Uint8Array(data))
  }
  eof() {}
  close() {
    this.closed = true
  }

  push(kind: number, body: Uint8Array | string) {
    const bytes = typeof body === "string" ? encoder.encode(body) : body
    const frame = new Uint8Array(bytes.byteLength + 1)
    frame[0] = kind
    frame.set(bytes, 1)
    this.onData(frame)
  }

  end() {
    this.onEnd()
  }
}

const settle = () => new Promise((r) => setTimeout(r, 0))

function info(overrides: Partial<TerminalInfo> = {}): TerminalInfo {
  return {
    id: "term_1",
    uri: "terminal://term_1",
    env: "env://studio",
    title: "bash",
    command: ["bash", "-l"],
    user: "agent",
    state: "running",
    size: { cols: 80, rows: 24 },
    viewers: 1,
    offset: 0,
    createdAt: new Date().toISOString(),
    sessionId: "s-1",
    recording: false,
    ...overrides,
  }
}

function attached(overrides: Partial<TerminalAttached> = {}): TerminalAttached {
  return {
    stream: 7,
    mode: "resume",
    offset: 0,
    snapshot: 0,
    size: { cols: 80, rows: 24 },
    viewer: "v1",
    readonly: false,
    info: info(),
    ...overrides,
  }
}

function fakeRookery(
  open: (method: string, params: Record<string, unknown>) => Promise<ClientStream>,
): ClientRookery {
  return {
    streams: {
      open,
      channel: open,
    },
    rpc: {
      call: async () => ({}),
    },
    events: {
      subscribe: async () => ({ dispose() {} }),
    },
  } as unknown as ClientRookery
}

describe("TerminalConnection", () => {
  test("renders a snapshot, then output, and follows the events", async () => {
    const opened: Array<{ method: string; params: Record<string, unknown> }> = []
    let stream!: FakeStream
    const rookery = fakeRookery(async (method, params) => {
      opened.push({ method, params })
      stream = new FakeStream(attached({ mode: "snapshot", offset: 0, snapshot: 5 }))
      return stream
    })

    const rendered: string[] = []
    const events: string[] = []
    let resets = 0
    const size: TermSize = { cols: 100, rows: 30 }
    const conn = new TerminalConnection(
      rookery,
      "term_1",
      {
        onReset: () => resets++,
        onData: (d) => rendered.push(new TextDecoder().decode(d)),
        onEvent: (e) => events.push(e.type),
      },
      { size },
    )
    await settle()

    expect(opened).toHaveLength(1)
    expect(opened[0]!.method).toBe("terminals.attach")
    // `id`, not `terminal`; `readonly` is left out unless the viewer asks to watch only.
    expect(opened[0]!.params).toEqual({ id: "term_1", size })
    // A snapshot attach clears the display before any byte is shown.
    expect(resets).toBe(1)
    expect(conn.state()).toBe("connecting")
    expect(conn.mode()).toBe("snapshot")
    expect(conn.attaches()).toBe(1)

    stream.push(2, "hello")
    stream.push(0, " world")
    stream.push(1, JSON.stringify({ type: "ready" }))
    stream.push(1, JSON.stringify({ type: "size", cols: 120, rows: 40, active: "v2" }))
    stream.push(1, JSON.stringify({ type: "title", title: "vim" }))

    // Snapshot bytes show but do not move the offset; output does.
    expect(rendered.join("")).toBe("hello world")
    expect(conn.offset()).toBe(6)
    expect(conn.state()).toBe("live")
    expect(conn.size()).toEqual({ cols: 120, rows: 40 })
    expect(conn.active()).toBe("v2")
    expect(conn.viewer()).toBe("v1")
    expect(events).toContain("ready")

    stream.push(1, JSON.stringify({ type: "state", state: "exited", exitCode: 3 }))
    stream.end()

    expect(conn.endState()).toBe("exited")
    expect(conn.exitCode()).toBe(3)
    expect(conn.state()).toBe("ended")
    expect(resets).toBe(1)
  })

  test("resumes from the last byte after the stream drops", async () => {
    const opened: Array<{ method: string; params: Record<string, unknown> }> = []
    const streams: FakeStream[] = []
    const rookery = fakeRookery(async (method, params) => {
      opened.push({ method, params })
      const s = new FakeStream(attached({ mode: "resume", offset: params.after === undefined ? 10 : 13 }))
      streams.push(s)
      return s
    })

    const conn = new TerminalConnection(rookery, "term_1", { onData: () => {} })
    await settle()
    expect(opened[0]!.params).toEqual({ id: "term_1" })
    expect(conn.offset()).toBe(10)

    streams[0]!.push(0, "abc")
    expect(conn.offset()).toBe(13)
    streams[0]!.end()
    expect(conn.state()).toBe("resuming")

    await Bun.sleep(300)
    expect(opened).toHaveLength(2)
    // The re-attach asks for the output after the last byte it saw.
    expect(opened[1]!.params.after).toBe(13)
    expect(conn.state()).toBe("live")
    expect(conn.attaches()).toBe(2)
    conn.dispose()
  })

  test("stops retrying when the terminal is gone", async () => {
    let attempts = 0
    const rookery = fakeRookery(async () => {
      attempts++
      throw Object.assign(new Error("no such terminal"), { code: "NOT_FOUND" })
    })
    const conn = new TerminalConnection(rookery, "term_gone", { onData: () => {} })
    await settle()
    await Bun.sleep(300)
    expect(attempts).toBe(1)
    expect(conn.state()).toBe("error")
    conn.dispose()
  })

  test("a refusal is not retried: view holds no terminal to attach", async () => {
    let attempts = 0
    const rookery = fakeRookery(async () => {
      attempts++
      throw Object.assign(new Error("env://studio is view only"), { code: "FORBIDDEN" })
    })
    const conn = new TerminalConnection(rookery, "term_theirs", { onData: () => {} })
    await settle()
    await Bun.sleep(300)
    expect(attempts).toBe(1)
    expect(conn.state()).toBe("error")
    conn.dispose()
  })

  test("sends input and the size rule's controls, and nothing when read only", async () => {
    const streams: FakeStream[] = []
    const rookery = fakeRookery(async () => {
      const s = new FakeStream(attached({ mode: "resume", readonly: true }))
      s.result = attached({ mode: "resume", readonly: true })
      streams.push(s)
      return s
    })
    const conn = new TerminalConnection(rookery, "term_1", { onData: () => {} }, { readonly: true })
    await settle()
    const stream = streams[0]!
    expect(conn.readonly()).toBe(true)

    conn.write("ls\n")
    expect(stream.written).toHaveLength(0)

    // The server can answer read only even when a viewer asked to type.
    const writable = new TerminalConnection(
      fakeRookery(async () => {
        const s = new FakeStream(attached({ mode: "resume" }))
        streams.push(s)
        return s
      }),
      "term_2",
      { onData: () => {} },
    )
    await settle()
    const w = streams[1]!
    w.push(1, JSON.stringify({ type: "ready" }))
    writable.write("ls\n")
    writable.resize({ cols: 100, rows: 30 })
    writable.activate()

    const decode = (f: Uint8Array) => ({ kind: f[0], body: new TextDecoder().decode(f.subarray(1)) })
    const frames = w.written.map(decode)
    expect(frames[0]).toEqual({ kind: 0, body: "ls\n" })
    expect(frames[1]).toEqual({ kind: 1, body: JSON.stringify({ type: "resize", cols: 100, rows: 30 }) })
    expect(frames[2]).toEqual({ kind: 1, body: JSON.stringify({ type: "active" }) })

    conn.dispose()
    writable.dispose()
  })
})

describe("terminals.*", () => {
  test("open returns the terminal, and attach is a second call on its id", async () => {
    const calls: Array<{ method: string; params: Record<string, unknown> }> = []
    const rookery = {
      rpc: {
        call: async (method: string, params: Record<string, unknown>) => {
          calls.push({ method, params })
          return info({ id: "term_9" })
        },
      },
      streams: {
        open: async () => new FakeStream(attached({ info: info({ id: "term_9" }) })),
      },
      events: { subscribe: async () => ({ dispose() {} }) },
    } as unknown as ClientRookery
    const terminals = createTerminalsApi(rookery)

    const opened = await terminals.open("studio", { cwd: "/srv", size: { cols: 80, rows: 24 } })
    expect(opened.id).toBe("term_9")
    expect(calls[0]).toEqual({
      method: "terminals.open",
      params: { env: "env://studio", cwd: "/srv", size: { cols: 80, rows: 24 } },
    })

    const conn = terminals.connect(opened.id, { onData: () => {} })
    await settle()
    expect(conn.info()?.id).toBe("term_9")
    conn.dispose()
  })

  test("list, sessions and adopt name the host as env://NAME", async () => {
    const calls: Array<{ method: string; params: Record<string, unknown> }> = []
    const rookery = {
      rpc: {
        call: async (method: string, params: Record<string, unknown>) => {
          calls.push({ method, params })
          if (method === "terminals.list") return { terminals: [] }
          if (method === "terminals.sessions") return { sessions: [] }
          return info()
        },
      },
    } as unknown as ClientRookery
    const terminals = createTerminalsApi(rookery)

    await terminals.list({ env: "env://studio", ended: true })
    await terminals.sessions("studio", { preview: true })
    await terminals.adopt("studio", "s-1")

    expect(calls).toEqual([
      { method: "terminals.list", params: { env: "env://studio", ended: true } },
      { method: "terminals.sessions", params: { env: "env://studio", preview: true } },
      { method: "terminals.adopt", params: { env: "env://studio", session: "s-1" } },
    ])
  })
})
