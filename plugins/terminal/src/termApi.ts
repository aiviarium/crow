// The terminal plugin's client half API: the terminals a person may see and `attach`, one viewer of one
// terminal kept attached on a binary stream. Ported from the prototype's `sdk/src/client/terminals.ts`;
// the emulation is gone (design decision 2: `rookeryd` keeps each session's screen and the server passes
// sessions through), so this file only speaks the attach stream and leaves the bytes to xterm.js.
//
// Opening is two calls, as rookery#42 settles it: `terminals.open` returns the `TerminalInfo` (who owns
// it, its size, its offset) and `terminals.attach` returns the `TerminalAttached` and opens the stream.
// Sizes come from the wire types in `./types.ts`, copied from rookery#42's generated types until Crow
// repins; `EnvSession` and the attach's `info` are read the same way.
import type { ClientRookery, ClientStream } from "@rookery/sdk/client"
import { type Accessor, createSignal } from "solid-js"
import { envUri } from "./env"
import type {
  AttachMode,
  EnvSession,
  ScreenInfo,
  TerminalAttached,
  TerminalEvent,
  TerminalInfo,
  TerminalOpen,
  TerminalQuery,
  TermSize,
} from "./types"

const encoder = new TextEncoder()
const decoder = new TextDecoder()

export type ConnectionState = "connecting" | "live" | "resuming" | "ended" | "error"

/**
 * A frame on the attach stream: one type byte, then the body.
 *
 * - `0` output bytes, counted in the terminal's output `offset` (the resume cursor), or input going the
 *   other way.
 * - `1` a JSON `TerminalEvent` from the server, or a JSON control from the viewer (`resize`, `active`).
 * - `2` snapshot bytes: shown, but not counted (the screen the server replays before any output).
 */
export const FrameOutput = 0
export const FrameEvent = 1
export const FrameSnapshot = 2

/** A control the viewer sends to the server on the attach stream, as a type-1 JSON body. */
export type AttachControl = { type: "resize"; cols: number; rows: number } | { type: "active" }

export interface TerminalHandlers {
  /** A snapshot follows: clear the display (screen and scrollback). */
  onReset?: () => void
  /** Bytes to render: snapshot bytes, then output. */
  onData: (data: Uint8Array) => void
  /** Size, title, state and viewer events. */
  onEvent?: (e: TerminalEvent) => void
}

/** One viewer of one terminal, kept attached: `terminals.attach`, then the stream. */
export class TerminalConnection {
  readonly state: Accessor<ConnectionState>
  /** The output offset reached: what a resume asks for. */
  readonly offset: Accessor<number>
  /** The terminal's size now (the active viewer's). */
  readonly size: Accessor<TermSize | null>
  readonly info: Accessor<TerminalInfo | null>
  /** This viewer's id while attached; compare with the size event's `active`. */
  readonly viewer: Accessor<string | null>
  readonly active: Accessor<string | null>
  /** Whether the server ignored this viewer's input. */
  readonly readonly: Accessor<boolean>
  readonly exitCode: Accessor<number | null>
  /** How the terminal ended: `exited` or `lost` (its session service restarted under it). */
  readonly endState: Accessor<"exited" | "lost" | null>
  /** How the last attach started (`snapshot` or `resume`), and how many attaches there were. */
  readonly mode: Accessor<AttachMode | null>
  readonly attaches: Accessor<number>

  private readonly set: {
    state: (s: ConnectionState) => void
    offset: (n: number) => void
    size: (s: TermSize | null) => void
    info: (i: TerminalInfo | null) => void
    viewer: (v: string | null) => void
    active: (v: string | null) => void
    readonly: (v: boolean) => void
    exitCode: (c: number | null) => void
    endState: (s: "exited" | "lost" | null) => void
    mode: (m: AttachMode | null) => void
    attaches: (n: number) => void
  }

  private stream: ClientStream | null = null
  private known: number | null = null
  private ended = false
  private disposed = false
  private wanted: TermSize | null
  private retry = 0
  private timer: ReturnType<typeof setTimeout> | undefined
  private attaching = false
  private readonly requestedReadonly: boolean

  constructor(
    private readonly rookery: ClientRookery,
    readonly id: string,
    private readonly handlers: TerminalHandlers,
    opts: { size?: TermSize; readonly?: boolean } = {},
  ) {
    this.wanted = opts.size ?? null
    this.requestedReadonly = !!opts.readonly
    const sig = <T>(v: T) => createSignal<T>(v)
    const [state, setState] = sig<ConnectionState>("connecting")
    const [offset, setOffset] = sig(0)
    const [size, setSize] = sig<TermSize | null>(null)
    const [info, setInfo] = sig<TerminalInfo | null>(null)
    const [viewer, setViewer] = sig<string | null>(null)
    const [active, setActive] = sig<string | null>(null)
    const [ro, setRo] = sig(this.requestedReadonly)
    const [exitCode, setExit] = sig<number | null>(null)
    const [endState, setEndState] = sig<"exited" | "lost" | null>(null)
    const [mode, setMode] = sig<AttachMode | null>(null)
    const [attaches, setAttaches] = sig(0)
    this.state = state
    this.offset = offset
    this.size = size
    this.info = info
    this.viewer = viewer
    this.active = active
    this.readonly = ro
    this.exitCode = exitCode
    this.endState = endState
    this.mode = mode
    this.attaches = attaches
    this.set = {
      state: setState,
      offset: setOffset,
      size: setSize,
      info: setInfo,
      viewer: setViewer,
      active: setActive,
      readonly: setRo,
      exitCode: setExit,
      endState: setEndState,
      mode: setMode,
      attaches: setAttaches,
    }
    this.attach()
  }

  /** One attach at a time: a drop's retry timer and a socket reconnect can both fire. */
  private async attach() {
    const current = this.stream
    if (this.disposed || this.ended || this.attaching || current) return
    this.attaching = true
    try {
      await this.attachOnce()
    } catch {
      // A handler that throws must not stop the viewer: try again like a dropped stream.
      const opened: ClientStream | null = this.stream
      opened?.close()
      this.stream = null
      this.schedule()
    } finally {
      this.attaching = false
    }
  }

  private async attachOnce() {
    clearTimeout(this.timer)
    this.set.state(this.known === null ? "connecting" : "resuming")
    let s: ClientStream
    try {
      s = await this.rookery.streams.open("terminals.attach", {
        id: this.id,
        ...(this.known !== null ? { after: this.known } : {}),
        ...(this.wanted ? { size: this.wanted } : {}),
        ...(this.requestedReadonly ? { readonly: true } : {}),
      })
    } catch (e: any) {
      // A terminal that is gone, or someone else's, is not retried: no level can appear by waiting.
      if (e?.code === "NOT_FOUND" || e?.code === "FORBIDDEN") {
        this.set.state("error")
        this.ended = true
        return
      }
      this.schedule()
      return
    }
    if (this.disposed) {
      s.close()
      return
    }
    const r = s.result as TerminalAttached | undefined
    if (!r) {
      // The result carries the attach; without it there is nothing to resume from.
      s.close()
      this.schedule()
      return
    }
    this.stream = s
    this.retry = 0
    this.set.info(r.info)
    this.set.viewer(r.viewer)
    this.set.readonly(r.readonly)
    this.set.size(r.size)
    let offset = r.offset
    this.known = offset
    this.set.offset(offset)
    this.set.mode(r.mode)
    this.set.attaches(this.attaches() + 1)
    if (r.info.state !== "running") {
      this.ended = true
      this.set.endState(r.info.state)
      this.set.exitCode(r.info.exitCode ?? null)
    }
    // A snapshot clears the display and draws the screen the server replays; a `ready` event ends the
    // replay and the viewer is live. A resume goes on from `offset` without a reset.
    if (r.mode === "snapshot") this.handlers.onReset?.()
    else this.set.state("live")
    s.onData = (frame) => {
      const kind = frame[0]
      const body = frame.subarray(1)
      if (kind === FrameOutput) {
        offset += body.byteLength
        this.known = offset
        this.set.offset(offset)
        this.handlers.onData(body)
      } else if (kind === FrameSnapshot) {
        this.handlers.onData(body)
      } else if (kind === FrameEvent) {
        let e: TerminalEvent
        try {
          e = JSON.parse(decoder.decode(body)) as TerminalEvent
        } catch {
          return
        }
        if (e.type === "ready") this.set.state("live")
        if (e.type === "size") {
          this.set.size({ cols: e.cols, rows: e.rows })
          this.set.active(e.active ?? null)
        }
        if (e.type === "state" && e.state !== "running") {
          this.ended = true
          this.set.exitCode(e.exitCode ?? null)
          this.set.endState(e.state)
        }
        this.handlers.onEvent?.(e)
      }
    }
    s.onEnd = () => {
      if (this.stream === s) this.stream = null
      if (this.disposed) return
      if (this.ended) {
        this.set.state("ended")
        return
      }
      // The stream closed under a live terminal: re-attach with `after`, which resumes the output or
      // falls back to a snapshot when the host no longer keeps it.
      this.schedule()
    }
  }

  private schedule() {
    if (this.disposed || this.ended) return
    this.set.state("resuming")
    const delay = Math.min(5000, 250 * 2 ** this.retry++)
    this.timer = setTimeout(() => this.attach(), delay)
  }

  private frame(kind: number, body: Uint8Array) {
    const s = this.stream
    if (!s) return
    const f = new Uint8Array(body.byteLength + 1)
    f[0] = kind
    f.set(body, 1)
    s.write(f).catch(() => {})
  }

  /** Input as the viewer produces it (xterm.js's `onData`). */
  write(data: string | Uint8Array) {
    if (this.readonly()) return
    this.frame(FrameOutput, typeof data === "string" ? encoder.encode(data) : data)
  }

  /** The viewer's area fits this size. The size rule decides whose it is. */
  resize(size: TermSize) {
    this.wanted = size
    this.control({ type: "resize", ...size })
  }

  /** The viewer is being used: its size wins. */
  activate() {
    this.control({ type: "active" })
  }

  private control(c: AttachControl) {
    this.frame(FrameEvent, encoder.encode(JSON.stringify(c)))
  }

  dispose() {
    this.disposed = true
    clearTimeout(this.timer)
    this.stream?.close()
    this.stream = null
  }
}

export interface TerminalsApi {
  /** `terminals.open`: a terminal on the host, returned before anything is attached to it. */
  open(env: string, opts?: Omit<TerminalOpen, "env">): Promise<TerminalInfo>
  get(id: string): Promise<TerminalInfo>
  /** The caller's terminals, newest first; `ended` includes the last 50 that ended. */
  list(opts?: TerminalQuery): Promise<TerminalInfo[]>
  /** Sessions on the host, each saying whether it is already a terminal. */
  sessions(env: string, opts?: { preview?: boolean }): Promise<EnvSession[]>
  /** Makes an existing session of the host a Rookery terminal. Needs manage. */
  adopt(env: string, session: string): Promise<TerminalInfo>
  rename(id: string, title: string): Promise<void>
  close(id: string): Promise<void>
  /** The terminal's screen as the host keeps it, as rows or as escape sequences. Needs use. */
  screen(id: string, opts?: { history?: number; ansi?: boolean }): Promise<ScreenInfo>
  /** `terminals.changed`: returns a function that stops listening. */
  onChanged(fn: (t: TerminalInfo) => void): () => void
  /** `terminals.attach`, kept attached: this viewer's stream of the terminal. */
  connect(
    id: string,
    handlers: TerminalHandlers,
    opts?: { size?: TermSize; readonly?: boolean },
  ): TerminalConnection
}

export function createTerminalsApi(rookery: ClientRookery): TerminalsApi {
  const call = <T = unknown>(method: string, params: Record<string, unknown> = {}) =>
    rookery.rpc.call<T>(method, params)
  return {
    open: (env, opts = {}) => call<TerminalInfo>("terminals.open", { env: envUri(env), ...opts }),
    get: (id) => call<TerminalInfo>("terminals.get", { id }),
    list: async (opts = {}) =>
      (
        await call<{ terminals: TerminalInfo[] }>("terminals.list", {
          ...opts,
          ...(opts.env ? { env: envUri(opts.env) } : {}),
        })
      ).terminals,
    sessions: async (env, opts = {}) =>
      (await call<{ sessions: EnvSession[] }>("terminals.sessions", { env: envUri(env), ...opts })).sessions,
    adopt: (env, session) => call<TerminalInfo>("terminals.adopt", { env: envUri(env), session }),
    rename: async (id, title) => {
      await call("terminals.rename", { id, title })
    },
    close: async (id) => {
      await call("terminals.close", { id })
    },
    screen: (id, opts = {}) => call<ScreenInfo>("terminals.screen", { id, ...opts }),
    connect: (id, handlers, opts) => new TerminalConnection(rookery, id, handlers, opts),
    onChanged(fn) {
      let off: (() => void) | undefined
      let stopped = false
      void rookery.events
        .subscribe("rookery/terminals.changed", (payload) => {
          const e = payload as import("@rookery/client").TerminalChanged | undefined
          if (e?.terminal) fn(e.terminal)
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
