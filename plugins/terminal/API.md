# Terminal M3 API Contract

Everything `crow/plugins/terminal` calls on Rookery, and nothing else. The server half is rookery#42
(`feat/connect`): terminals passed through to `rookeryd` on binary channels, `env.*` over the saved
hosts, and two event topics. This file is what the plugin is written against, and the answers below are
the server's.

A terminal is private to the person who opened it: `view` on a host sees only `env.presence` counts,
never another person's terminal, screen or preview. `readonly` is not a level — it is an option of a
`use` or `manage` caller watching a terminal it may already attach to.

Hosts are `env://NAME` in every `env.*` and `terminals.*` call. The server also takes the bare name, and
always answers `env://NAME` (`EnvInfo.uri`, `TerminalInfo.env`). This plugin sends the URI form
everywhere.

## RPC methods

| Method               | Params                                                                  | Result                          | Level                  | Notes                                                                                                                                               |
| -------------------- | ----------------------------------------------------------------------- | ------------------------------- | ---------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| `terminals.open`     | `TerminalOpen` (`{ env, command?, cwd?, title?, vars?, size?, user? }`) | `TerminalInfo`                  | `use` on the host      | Starts a session on the host. Default command: the login shell. `operator` and `root` need manage.                                                  |
| `terminals.get`      | `{ id: string }`                                                        | `TerminalInfo`                  | `view` on the terminal | The caller's own, or one on a host they manage.                                                                                                     |
| `terminals.list`     | `TerminalQuery` (`{ env?, ended?, all? }`)                              | `{ terminals: TerminalInfo[] }` | self                   | The caller's terminals, running first and newest first; `ended` adds the last 50 that ended; `all` adds other people's on hosts the caller manages. |
| `terminals.close`    | `{ id: string }`                                                        | `{}`                            | `use` on the terminal  | Ends the session and forgets its record.                                                                                                            |
| `terminals.rename`   | `{ id, title }`                                                         | `{}`                            | `use` on the terminal  | The title is the viewer's label; the host's title can replace it again.                                                                             |
| `terminals.signal`   | `{ id, signal: string }`                                                | `{}`                            | `use` on the terminal  | `INT`, `TERM`, `HUP` or `KILL`, with or without `SIG`. Not called by the views.                                                                     |
| `terminals.write`    | `{ id, text?: string, base64?: string }`                                | `{}`                            | `use` on the terminal  | Input for a terminal no viewer is attached to (automation). Not called by the views.                                                                |
| `terminals.resize`   | `{ id, size: TermSize }`                                                | `{}`                            | `use` on the terminal  | Sets the size as an active viewer would, for automation. A viewer sends `resize` on its attach stream instead. Not called by the views.             |
| `terminals.screen`   | `ScreenQuery` (`{ id, history?, ansi? }`)                               | `ScreenInfo`                    | `use` on the terminal  | The screen as the host keeps it: `size`, `lines`, `cursor`, `offset`, and `ansi` for rendering it elsewhere. `history` puts scrollback lines first. |
| `terminals.sessions` | `EnvSessionQuery` (`{ env, preview? }`)                                 | `{ sessions: EnvSession[] }`    | `view` on the host     | Every session on the host, each with `adopted` and the `terminal` when the caller may see it. Previews are for a manager and a terminal's owner.    |
| `terminals.adopt`    | `TerminalAdopt` (`{ env, session }`)                                    | `TerminalInfo`                  | `manage` on the host   | Makes an existing host session a terminal of the caller's. `CONFLICT` when another terminal holds it.                                               |
| `env.list`           | `{}`                                                                    | `{ environments: EnvInfo[] }`   | self                   | The host picker, and each host's `supports` and the caller's `level`.                                                                               |
| `env.get`            | `{ env: string }`                                                       | `EnvInfo`                       | `view` on the host     | One host's state and `supports` (the picker shows why an entry is offline).                                                                         |

`terminals.open` returns the terminal and nothing else: the bytes come from `terminals.attach` below.
The design's one-call `{ terminal, channel }` sketch is dropped by the server, and this plugin never used
it.

`env.checkouts` and `env.clone` are deferred on the server (M5 and later), so the new-terminal form takes
a typed directory instead of suggesting one. `terminals.input` (`TermInput[]`) is not on the server:
`terminals.write` is what automation uses.

`TerminalInfo` carries the caller's `level` (`use` for one's own, `manage` for another's on a host one
manages), `user` (the account it runs as), `size`, `viewers`, `offset`, and `sessionId` (always set: the
host's session id, which is how a `terminals.sessions` entry is matched to its terminal) with `lastInput`
(`InputInfo`, who last typed into it). Both are in the generated types and both are shown in the sessions
list.

## Binary streams

### `terminals.attach`

Opens a binary stream channel: the result is a `TerminalAttached` (`{ stream, mode, offset, snapshot,
size, viewer, readonly, info }`). The stream is duplex: output comes back, input and size controls go out.
(The transport itself is `@rookery/client`'s: a 4-byte big-endian stream id, then this frame; credit is
`streams.credit`.)

Frame layout, both directions: one type byte, then the body.

| Type | Direction     | Body                                                                                                                                                          | Meaning                                                                                                               |
| ---- | ------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------- |
| `0`  | server→client | raw output bytes                                                                                                                                              | Counted in the terminal's output `offset`: the resume cursor.                                                         |
| `0`  | client→server | raw input bytes                                                                                                                                               | Exactly what the viewer typed. The server credits these bytes (`streams.credit`), or the viewer stalls after 256 KiB. |
| `1`  | server→client | JSON `TerminalEvent`: `{type:"size",cols,rows,active?}`, `{type:"title",title}`, `{type:"state",state,exitCode?}`, `{type:"viewers",count}`, `{type:"ready"}` | A change to show in the header or apply to xterm.js's size.                                                           |
| `1`  | client→server | JSON `AttachControl`: `{type:"resize",cols,rows}` or `{type:"active"}`                                                                                        | The size rule: this viewer fits `cols`×`rows`; this viewer is being used, so the size follows it.                     |
| `2`  | server→client | snapshot bytes                                                                                                                                                | The screen the server replays. Shown, **not** counted in `offset`.                                                    |

`TerminalAttached`'s fields, as this client reads them: `mode` is `snapshot` (the viewer's `after` is
behind what the server kept, so it clears the display and draws a fresh screen first) or `resume` (output
continues from `after`); `offset` is the output offset the first type-`0` frame starts at; `snapshot` is
how many type-`2` bytes come before that; `size` is the session's size now and `viewer` this viewer's id,
to compare with a `size` event's `active`; `readonly` says the server ignored this viewer's input; `info`
is the `TerminalInfo` at attach time. A `ready` event ends the replay.

Attach parameters:

| Field      | Meaning                                                                                                                   |
| ---------- | ------------------------------------------------------------------------------------------------------------------------- |
| `id`       | The terminal.                                                                                                             |
| `after`    | Resume after this output offset. Omitted on the first attach.                                                             |
| `size`     | The viewer's size, for the size rule.                                                                                     |
| `readonly` | Watch only: input and size controls are ignored. An option of a caller that may attach at all; there is no `view` attach. |

Behaviour the client expects:

- On drop, the client re-attaches with `after` = the last offset it received. A `NOT_FOUND` or `FORBIDDEN`
  ends it (state `error`) and is not retried; anything else is retried with backoff (250 ms doubling to
  5 s), and the retry passes through `Connection.call`'s wait for the socket, so it recovers from a socket
  drop as well.
- The server resumes when the host still keeps that output and it is at most 1 MiB behind; otherwise it
  answers `mode: "snapshot"` and the viewer clears its display.
- Input frames must arrive **in order**. The server forwards them on one host WebSocket per viewer.
- `state` events (`exited`, `lost`) end the viewer; `lost` means the host's session service restarted under
  the session. The client shows `lost` with its own note.
- Every `terminals.*` method that takes an `id` declares a level on `terminal://ID`, which the server
  computes: `manage` for whoever manages the host, `use` for its owner while they still hold `use` on the
  host, and nothing for anyone else. A `view` holder on the host therefore gets `FORBIDDEN`, not a
  read-only attachment.

## Event topics

| Topic                       | Payload                                          | Notes                                                                                                                                                             |
| --------------------------- | ------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `rookery/terminals.changed` | `TerminalChanged` (`{ terminal }`)               | A terminal's title, state, size or viewers changed. Built per subscriber, with that subscriber's `level`. Refreshes the sessions list.                            |
| `rookery/env.changed`       | `EnvChanged` (`{ env, environment?, removed? }`) | A host's state, type or access changed, or it was removed. `environment` is as `env.get` gives it to the subscriber. Refreshes the picker and the "offline" note. |

Both are best effort in the client: a server that does not publish them leaves the views on their 5-second
poll. `env.changed` is sent with `hosts.changed` (save, rename, remove), not on reachability, so the picker
keeps its poll for online/offline.

## Types

From `@rookery/client` (generated, do not re-declare):

- `EnvInfo`, `EnvSupports`, `EnvSessionQuery`, `EnvPresence`, `StreamOpened`, `Grant`.

Copied into [`src/types.ts`](./src/types.ts), each marked with where it came from, because Crow pins
Rookery at main, which still has the prototype's shapes:

- `TermSize`, `TerminalState`, `AttachMode`, `EnvUser`, `InputInfo`, `TerminalInfo`, `TerminalOpen`,
  `TerminalAttach`, `TerminalAttached`, `TerminalEvent`, `TerminalQuery`, `TerminalChanged`, `EnvSession`,
  `ScreenInfo`, `CursorInfo`.

What the plugin declares itself, in `src/termApi.ts`: the type byte constants (`0`, `1`, `2`) and
`AttachControl`. Each copied type is replaced by an `@rookery/client` import after the repin.
