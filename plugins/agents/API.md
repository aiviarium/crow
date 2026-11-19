# Agents Plugin API Contract (M5)

Every Rookery RPC method, binary stream, and event topic that `crow/plugins/agents` calls, plus the Parrot JSON-RPC surface tunneled over `agents.connect` and the list of Parrot protocol / `@aiviarium/parrot-client` gaps for a follow-up Parrot PR.

Host discovery lives in [`src/api.ts`](./src/api.ts); stream transport and Parrot handshake live in [`src/transport.ts`](./src/transport.ts); multi-host session and subscription state lives in [`src/store.ts`](./src/store.ts).

## Rookery RPC methods

| Method       | Params | Result                        | Required level                                    | Notes                                                                                                                                                                                                                              |
| ------------ | ------ | ----------------------------- | ------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `env.list`   | `{}`   | `{ environments: EnvInfo[] }` | `view` (filtered to environments caller can view) | Preferred host listing via `@rookery/client`'s `rookery.env.list()`. Each `EnvInfo` carries `{ uri, name, kind, state, level, supports, error }`. The plugin accepts `env://<name>` URIs and optional `supports.agents?: boolean`. |
| `hosts.list` | `{}`   | `{ hosts: HostInfo[] }`       | `view` (filtered to hosts caller can view)        | Compatibility fallback used only when `env.list` returns `NOT_FOUND` / `UNIMPLEMENTED` / `-32601` (pre-env servers). Maps `reachable` to `"online"` / `"offline"` and constructs `env://<name>`.                                   |

## Rookery binary streams

| Method           | Params            | Frames                                                                                                                    | Required level                                                                                                          | Notes                                                                                                                                                                                                                                                                                |
| ---------------- | ----------------- | ------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `agents.connect` | `{ env: string }` | Bidirectional UTF-8 NDJSON carrying Parrot JSON-RPC 2.0 messages (`\n`-delimited; `\r\n` tolerated, blank lines ignored). | `use` on `env` (or `view` if Rookery maps read-only callers to a `read`-scoped Parrot connection — see Open Questions). | Opens a single authorised stream from Crow to `parrot serve` on the target host (`env` is canonical `env://<host>`). Rookery authenticates the caller, checks access to `env`, ensures or dials the host's `parrot serve`, and relays bytes bidirectionally over the Rookery stream. |

### `agents.connect` framing & lifecycle

1. **Opening**: The client calls `rookery.streams.open("agents.connect", { env: "env://<host>" })`. Rookery replies with `{ stream: number }` (`StreamOpened`) or a JSON-RPC error (`NOT_FOUND` for unknown host, `PERMISSION_DENIED` for insufficient level, `UNAVAILABLE` if the host or its `parrot serve` is offline/uninstalled).
2. **Binary framing**: Standard Rookery stream wire format over `/ws` — each binary WebSocket frame is `uint32be(streamId)` followed by raw UTF-8 payload bytes, with Rookery credit flow control (`streams.credit`, `streams.eof`, `streams.close`).
3. **Message framing**: Inside the byte stream, messages are newline-delimited JSON-RPC 2.0 objects (`JSON.stringify(msg) + "\n"`), matching `parrot serve`'s native NDJSON stdio/socket transport. A single Rookery binary chunk may contain multiple lines or split a UTF-8 character/line across chunks; [`rookeryStreamTransport`](./src/transport.ts) uses streaming `TextDecoder` reassembly and serializes outgoing writes so backpressure never reorders frames.
4. **Handshake**: Immediately after `agents.connect` opens, `@aiviarium/parrot-client` sends Parrot's `initialize` request (`{ peer: { kind: "client", name: "crow-agents", version: "0.1.0" } }`) and receives `InitializeResult` (`runtime`, `protocol`, `connection`, `scopes`, `capabilities`).
5. **Multiplexing**: Crow keeps one `agents.connect` stream per active host in the plugin-scoped [`AgentsStore`](./src/store.ts). All host queries (`agent/list`, `session/list`, `subscribe` with `{ index: true }`, and per-session `{ session }` subscriptions) share that single stream while navigating between `/agents`, `/agents/:host`, and `/agents/:host/:session`.
6. **Teardown**: Closing a host runtime or unloading the plugin sends `streams.close` (and Rookery should tear down the upstream connection to `parrot serve`, which drops Parrot subscriptions). If `parrot serve` exits or the host disconnects, Rookery ends the stream with `streams.close` (and optional `ErrorBody`), which transitions the host runtime to `error` with a one-click Reconnect button.

## Rookery event topics (optional live refresh)

| Topic                   | Payload                                                        | Notes                                                                                                                                                                                                                                             |
| ----------------------- | -------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `rookery/hosts.changed` | `{ host: string, info?: HostInfo \| null, removed?: boolean }` | Subscribed opportunistically (`rookery.events.subscribe("rookery/hosts.changed", ...)`; a name with a `/` is the server's, taken as it is). Triggers `refreshHosts()` so newly added or online hosts appear in the host picker without reloading. |

## Parrot JSON-RPC surface used over `agents.connect`

For reference, the plugin calls these Parrot methods over the `agents.connect` stream:

- **Handshake & discovery**: `initialize`, `agent/list`, `env/list`, `workspace/list`, `session/list`
- **Subscriptions**: `subscribe` (with `{ index: true }` for host-wide session/agent/env/workspace index updates, and `{ session }` for live transcript/request/option/action/usage updates), `unsubscribe`
- **Session lifecycle**: `session/new`, `session/prompt`, `session/cancel`, `session/stop`, `session/rename`, `session/archive`, `session/rebind`, `binding/start`
- **Interactive requests & controls**: `request/answer`, `option/set`, `action/invoke`
- **TUI fallback**: `session/screen`, `session/keys`

## Open questions for the Rookery server contract

1. **Agent host capability flag**: `EnvInfo.supports` in `@rookery/client` currently has `{ exec, files, terminal, connect, desktop, workspaces, process, checkouts, privileged, persistentSessions, deploy }` — no `agents` boolean. Should Rookery add `supports.agents: boolean` to `EnvInfo` (reflecting whether the host has the `agents` egg / `parrot serve`), or should the plugin discover capability lazily when `agents.connect` returns `UNAVAILABLE`? (The plugin already reads `supports.agents` if present and still lets users attempt connection otherwise.)
2. **Authorisation level → Parrot scope mapping**: `plans/design.md` specifies `use` on `env` for `agents.connect`. Should a caller with only `view` on `env` be refused at `agents.connect`, or allowed to connect with Rookery clamping the Parrot connection's `scopes` to `["read"]` so they can inspect transcripts without prompting or answering approvals?
3. **Principal propagation**: When Rookery dials `parrot serve` on behalf of a Crow user, how does it pass the authenticated Rookery principal so Parrot's `session.origin.principal` and `subscribers` reflect the human user rather than a generic service identity?
4. **On-demand `parrot serve` startup**: If `parrot serve` is installed on a host (via the agent egg) but not yet running, does `agents.connect` start it lazily (e.g. via systemd socket activation or host agent spawn) and keep the stream open until it responds, or return `UNAVAILABLE`?
5. **Environment change events**: `crow/plugins/agents` subscribes to `rookery/hosts.changed` for live refresh. Once `env.list` is the primary API, will Rookery emit `rookery/env.changed` (or keep `hosts.changed` as the topic for host environments)?

## Parrot protocol / `@aiviarium/parrot-client` gaps

### Delivered by parrot#49 (`1eca23d`)

The workarounds Crow carried for these are gone: `ParrotItem` is `ItemBody` plus the streaming flags,
the stdio transport is imported (only) from `@aiviarium/parrot-client/stdio` so the root entry is
browser-safe, key forwarding, rebinding control and the first prompt call the typed methods, and the
session list reads `SessionSummary.cwd`.

1. **`ItemBody` had no wire `kind` discriminant.** The generated union carries `kind`
   (`"user"`, `"assistant"`, …), so [`src/parrot.ts`](./src/parrot.ts) aliases it rather than
   redeclaring each variant.
2. **The root entry imported `./stdio`**, and with it `node:child_process` and `node:readline`, so a
   browser build needed a Vite stub (which is removed from `crow/shell/vite.config.ts`).
   `stdioClient`/`stdioTransport` now live in `@aiviarium/parrot-client/stdio`.
3. **`session/keys` was typed as `SessionRef`.** `SessionKeysParams` has `text` and `press`, so TUI
   key forwarding uses `client.call`.
4. **`SessionRebindParams` lacked `control`.** Switching between `"native"` and `"tui"` is typed.
5. **`session/new` did not accept an initial prompt.** `SessionNewParams` has `prompt`, `context` and
   `attachments`; the new-session composer sends the first prompt with the creation, not after it.
6. **`SessionSummary` had no `cwd` or workspace.** Both are on the summary, and the session list filters
   on `cwd`.
7. **Multi-question `Request`s were untyped.** `Request.questions` is `Question[]` and the answer is
   `Answer.answers` by question id; `extractQuestions` reads them instead of guessing at `input`.

### Still open

8. **No session-level diff or per-turn checkpoint revert RPC**: The prototype offered a turn-level
   "Files changed" diff modal and per-turn revert (`revert`). Parrot models individual `file_change` items
   and has `session/rewind` (`{ session, turn, files }`), but lacks a `session/diff` (or turn-aggregated
   diff) RPC for viewing net workspace changes across a turn or session.
9. **Approval subject & edit diff metadata**: `Request` (`kind: "approval"`) carries `title`, `summary`,
   `item`, and untyped `input?: unknown`, without a standardized typed command/diff field or a structured
   "remember / allow always" scope indicator beyond free-form `choices`. Standardizing `command` / `diff`
   / `kind` metadata on approval requests would let UIs render rich approval cards consistently across
   Claude Code, Codex, and other drivers.
