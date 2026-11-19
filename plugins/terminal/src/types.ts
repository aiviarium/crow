// The `terminals.*` wire types this plugin reads, copied from rookery#42 (`feat/connect`)'s
// `client/src/generated/` while Crow pins Rookery at main. The pinned generated types are the
// prototype's: `TerminalInfo` without `user` and with an optional `sessionId`, a `TerminalOpen` with
// `record` and `space`, a `TerminalAttach` with `to`, an `EnvSession` without `adopted`, and a
// `ScreenInfo` with a title and an alternate screen flag that the host's screen API has not got. Each
// copy below is replaced by an `@rookery/client` import after Crow repins past rookery#42.
//
// `EnvInfo`, `EnvSupports`, `EnvSessionQuery` and `EnvPresence` are imported from `@rookery/client` as
// they are: every field this plugin reads of them is the same on both sides of the repin.

// from rookery#42 generated/TermSize.ts; replace with @rookery/client import after repin
export type TermSize = { cols: number; rows: number }

// from rookery#42 generated/TerminalState.ts; replace with @rookery/client import after repin
export type TerminalState = "running" | "exited" | "lost"

// from rookery#42 generated/AttachMode.ts; replace with @rookery/client import after repin
/** How an attach starts: with the screen as it stands, or with the output after `after`. */
export type AttachMode = "snapshot" | "resume"

// from rookery#42 generated/EnvUser.ts; replace with @rookery/client import after repin
/** The account a terminal runs as. Anything but `agent` needs manage on the host. */
export type EnvUser = "agent" | "operator" | "root"

// from rookery#42 generated/InputInfo.ts; replace with @rookery/client import after repin
/** Who last typed into a terminal. */
export interface InputInfo {
  /** `user:<id>` or another principal. */
  principal: string
  name?: string
  /** Unix ms. */
  at: number
  /** `viewer`, from an attached viewer, or `automation`, from `terminals.write`. */
  via: string
  bytes: number
}

// from rookery#42 generated/TerminalInfo.ts; replace with @rookery/client import after repin
export interface TerminalInfo {
  id: string
  /** `terminal://<id>`. */
  uri: string
  /** `env://<name>`. */
  env: string
  title: string
  command: string[]
  cwd?: string
  /** The owner's user id. */
  owner?: string
  user: EnvUser
  state: TerminalState
  exitCode?: number
  size: TermSize
  /** Viewers attached now. */
  viewers: number
  /** Output bytes so far, as far as the server has seen. */
  offset: number
  /** RFC 3339. */
  createdAt: string
  /** The session's id on the host. */
  sessionId: string
  /** Recordings come later; always false. */
  recording: boolean
  /** The caller's level on it: `use` for one's own, `manage` for another's on a host one manages. */
  level?: "view" | "use" | "manage"
  lastInput?: InputInfo
}

// from rookery#42 generated/TerminalOpen.ts; replace with @rookery/client import after repin
/** `terminals.open`: a terminal on a host, at its default shell when there is no command. */
export interface TerminalOpen {
  env: string
  command?: string[]
  cwd?: string
  title?: string
  /** Environment variables for the command. */
  vars?: Record<string, string>
  size?: TermSize
  /** `agent` when absent; `operator` and `root` need manage on the host. */
  user?: EnvUser
}

// from rookery#42 generated/TerminalAttach.ts; replace with @rookery/client import after repin
/** `terminals.attach`. */
export interface TerminalAttach {
  id: string
  /** Go on after this output offset. Absent on a first attach, which starts with the screen. */
  after?: number
  /** The viewer's size, for the size rule. */
  size?: TermSize
  /** Watch only: the viewer's input and size are ignored. */
  readonly?: boolean
}

// from rookery#42 generated/TerminalAttached.ts; replace with @rookery/client import after repin
/** The result of `terminals.attach`: the stream and how it starts. */
export interface TerminalAttached {
  stream: number
  mode: AttachMode
  /** The output offset the first type-0 frame starts at. */
  offset: number
  /** Bytes of type-2 frames that come before it. */
  snapshot: number
  /** The terminal's size now. */
  size: TermSize
  /** This viewer's id, which a `size` event's `active` names. */
  viewer: string
  /** Whether the viewer's input is ignored. */
  readonly: boolean
  info: TerminalInfo
}

// from rookery#42 generated/TerminalEvent.ts; replace with @rookery/client import after repin
/** A type-1 frame from the server. */
export type TerminalEvent =
  | { type: "size"; cols: number; rows: number; active?: string }
  | { type: "title"; title: string }
  | { type: "state"; state: TerminalState; exitCode?: number }
  | { type: "viewers"; count: number }
  | { type: "ready" }

// from rookery#42 generated/TerminalQuery.ts; replace with @rookery/client import after repin
/** `terminals.list`: the caller's terminals, newest first. */
export interface TerminalQuery {
  /** Only those on this host. */
  env?: string
  /** Also the last 50 that ended. */
  ended?: boolean
  /** Also other people's, on the hosts the caller manages. */
  all?: boolean
}

// from rookery#42 generated/TerminalChanged.ts; replace with @rookery/client import after repin
/** The event `rookery/terminals.changed`: a terminal's title, state, size or viewers changed. */
export interface TerminalChanged {
  terminal: TerminalInfo
}

// from rookery#42 generated/EnvSession.ts; replace with @rookery/client import after repin
/** A session on a host. */
export interface EnvSession {
  id: string
  /** `terminal` or `process`. */
  kind: string
  title: string
  command: string[]
  user: string
  started: string
  ended?: string
  exitCode?: number
  lost: boolean
  /** The terminal it is, when it is one the caller may see. */
  terminal?: string
  /** Whether it is already a terminal, the caller's or not. */
  adopted: boolean
  preview?: string
}

// from rookery#42 generated/CursorInfo.ts; replace with @rookery/client import after repin
export interface CursorInfo {
  row: number
  col: number
}

// from rookery#42 generated/ScreenInfo.ts; replace with @rookery/client import after repin
/** The result of `terminals.screen`: the screen as the host keeps it. */
export interface ScreenInfo {
  size: TermSize
  /** One string per row; with `history`, the scrollback lines come first. */
  lines: string[]
  cursor: CursorInfo
  /** The output offset the server had seen when it asked. */
  offset: number
  ansi?: string
}
