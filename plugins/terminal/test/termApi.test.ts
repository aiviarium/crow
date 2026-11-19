// The attach stream: frames, resume from the byte offset, the size rule's controls, and the states a
// viewer shows. A fake `streams.open` stands in for the server; nothing here touches a socket.
import { describe, expect, test } from "bun:test"
import type { TerminalAttached, TerminalInfo, TermSize } from "@rookery/client"
import type { ClientRookery, ClientStream } from "@rookery/sdk/client"
import { TerminalConnection } from "../src/termApi"

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
    state: "running",
    size: { cols: 80, rows: 24 },
    viewers: 1,
    offset: 0,
    createdAt: new Date().toISOString(),
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

interface Opened {
  method: string
  params: Record<string, unknown>
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
    const opened: Opened[] = []
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
    expect(opened[0]!.params).toEqual({ id: "term_1", size, readonly: false })
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
    const opened: Opened[] = []
    const streams: FakeStream[] = []
    const rookery = fakeRookery(async (method, params) => {
      opened.push({ method, params })
      const s = new FakeStream(attached({ mode: "resume", offset: params.after === undefined ? 10 : 13 }))
      streams.push(s)
      return s
    })

    const conn = new TerminalConnection(rookery, "term_1", { onData: () => {} })
    await settle()
    expect(opened[0]!.params).toEqual({ id: "term_1", readonly: false })
    expect(conn.offset()).toBe(10)

    streams[0]!.push(0, "abc")
    expect(conn.offset()).toBe(13)
    streams[0]!.end()
    expect(conn.state()).toBe("resuming")

    await Bun.sleep(300)
    expect(opened).toHaveLength(2)
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
