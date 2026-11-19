# Terminal M3 API Contract

Everything `crow/plugins/terminal` calls on Rookery, and nothing else. The server half of M3 (terminals
passed through to `rookeryd` on binary channels) does not exist yet: this file is what the terminal plugin
is written against, so the server agent can implement exactly that.

Most names here are not invented. The wire types are already in `@rookery/client`'s generated types
(`client/src/generated/Terminal*.ts`, `EnvSession*.ts`, `Screen*.ts`), generated from `rookery-proto`'s
`wire!` structs; the streaming shape comes from the prototype's `crow_proto::terminals` and its client
(`sdk/src/client/terminals.ts`). Provenance per row: **[adopted]** means a name and shape that exist in
Rookery's generated types today, **[prototype]** means the prototype had it but Rookery's types do not,
**[new]** means this plugin needs it and neither had it. The payload of an event topic is where
**[prototype]** mostly lands.

Levels are from `plans/design.md` ("Levels on a host"): `view` ⊂ `use` ⊂ `manage` on `env://NAME`, or the
org role `admin`. A terminal is private to the person who opened it (see `env.presence`); a `view` holder
attaches read-only, which is the only way they see someone else's terminal, and only if the server allows
it. Hosts are addressed as `env://NAME` in every `env.*` and `terminals.*` call.

## RPC methods

| Method               | Params                                                                                             | Result                          | Level             | Notes                                                                                                                                                                                                                                                      |
| -------------------- | -------------------------------------------------------------------------------------------------- | ------------------------------- | ----------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `terminals.open`     | `TerminalOpen` (`{ env, command?, cwd?, title?, vars?, size?: TermSize, user?, record?, space? }`) | `TerminalInfo`                  | `use` on the host | Starts a session on the host. Default command: the user's login shell. **[adopted]**                                                                                                                                                                       |
| `terminals.get`      | `{ id: string }`                                                                                   | `TerminalInfo`                  | `view`            | One terminal. **[adopted]**                                                                                                                                                                                                                                |
| `terminals.list`     | `TerminalQuery` (`{ env?, ended?: boolean }`)                                                      | `{ terminals: TerminalInfo[] }` | `view`            | The caller's terminals, newest first. `ended` includes the last 50 that ended. **[adopted]**                                                                                                                                                               |
| `terminals.close`    | `{ id: string }`                                                                                   | `{}`                            | `use`             | Ends the session (SIGHUP, then a signal the host documents). **[adopted]**                                                                                                                                                                                 |
| `terminals.rename`   | `{ id, title }`                                                                                    | `{}`                            | `use`             | The title is the viewer's label; the host's title can replace it again. **[adopted]**                                                                                                                                                                      |
| `terminals.signal`   | `{ id, signal: string }`                                                                           | `{}`                            | `use`             | A signal by name (`TERM`, `INT`, `KILL`). **[adopted]**, not called by the views yet                                                                                                                                                                       |
| `terminals.write`    | `{ id, text?: string, base64?: string }`                                                           | `{}`                            | `use`             | Input for a terminal no viewer is attached to (automation). **[adopted]**, not called by the views                                                                                                                                                         |
| `terminals.input`    | `{ id, input: TermInput[] }`                                                                       | `{}`                            | `use`             | Semantic input (`key`, `text`, `paste`). **[adopted]**, not called by the views                                                                                                                                                                            |
| `terminals.resize`   | `{ id, size: TermSize }`                                                                           | `{}`                            | `use`             | Sets the size as an active viewer would, for automation. A viewer sends `resize` on its attach stream instead. **[adopted]**, not called by the views                                                                                                      |
| `terminals.screen`   | `ScreenQuery` (`{ id, history?, ansi? }`)                                                          | `ScreenInfo`                    | `view`            | The screen as the host keeps it: rows, cursor, title, alternate screen, offset, and `ansi` for rendering it. **[prototype]**, pending: decision 2 names `TerminalInfo` for the server but not the screen types, so `terminals.screen` is not yet promised. |
| `terminals.sessions` | `EnvSessionQuery` (`{ env, preview? }`)                                                            | `{ sessions: EnvSession[] }`    | `view`            | Sessions on the host that are not Rookery terminals yet, so `terminals.adopt` can take one over. `preview` is the last lines of its screen. **[adopted]**                                                                                                  |
| `terminals.adopt`    | `TerminalAdopt` (`{ env, session }`)                                                               | `TerminalInfo`                  | `use`             | Makes an existing host session a Rookery terminal. Fails `CONFLICT` when another terminal holds it. **[adopted]**                                                                                                                                          |
| `env.list`           | `{}`                                                                                               | `{ environments: EnvInfo[] }`   | `view`            | The host picker, and each host's `supports` and the caller's `level`. **[adopted]**                                                                                                                                                                        |
| `env.get`            | `{ env: string }`                                                                                  | `EnvInfo`                       | `view`            | One host's state and `supports` (the sessions view shows why a picker entry is offline). **[adopted]**                                                                                                                                                     |
| `env.checkouts`      | `{ env: string }`                                                                                  | `{ checkouts: Checkout[] }`     | `use`             | Used only to suggest a directory in the new-terminal form; a refusal leaves the form as it is. **[adopted]**                                                                                                                                               |

`TerminalInfo` carries the caller's `level` and `sessionId` (the host's own session id, which is how
`terminals.sessions` entries are told apart from ones already adopted) and `lastInput` (`InputInfo`, who
last typed into it). Both are in the generated types and both are shown in the sessions list.

### `terminals.open` returns the terminal, not a channel

`plans/design.md` sketches `terminals.open` answering `{ "terminal": "term_…", "channel": 4 }`, with the
bytes on the channel it names. This plugin does not use that shape: it opens with `terminals.open` and then
attaches with `terminals.attach`, which is what the adopted `TerminalOpen`/`TerminalAttached` types and the
prototype's client do. It also makes re-attach, the size rule and `readonly` attachments the same code path
as a fresh view. **[new]** as a decision: if the server keeps the one-call shape, `TerminalAttached` has to
come off the wire, because it is where `mode`, `offset`, `snapshot`, `viewer` and `readonly` live.

## Binary streams

### `terminals.attach`

Opens a binary stream channel: the result is a `StreamOpened` **with `TerminalAttached` merged in**
(`{ stream, mode, offset, snapshot, size, viewer, readonly, info }`), the way `jobs.follow` sends
`{ stream }` and then NDJSON. The stream is duplex: output comes back, input and size controls go out.
**[adopted]** shape, **[prototype]** framing.

Frame layout, both directions: one type byte, then the body. (The transport itself is
`@rookery/client`'s: a 4-byte big-endian stream id, then this frame; credit is `streams.credit`.)

| Type | Direction     | Body                                                                                                                                                          | Meaning                                                                                                                                                                                           |
| ---- | ------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `0`  | server→client | raw output bytes                                                                                                                                              | Counted in the terminal's output `offset`: the resume cursor.                                                                                                                                     |
| `0`  | client→server | raw input bytes                                                                                                                                               | Exactly what the viewer typed. The server credits these bytes (`streams.credit`), or the viewer stalls after 256 KiB.                                                                             |
| `1`  | server→client | JSON `TerminalEvent`: `{type:"size",cols,rows,active?}`, `{type:"title",title}`, `{type:"state",state,exitCode?}`, `{type:"viewers",count}`, `{type:"ready"}` | A change to show in the header or apply to xterm.js's size. **[adopted]** `TerminalEvent`.                                                                                                        |
| `1`  | client→server | JSON `{type:"resize",cols,rows}` or `{type:"active"}`                                                                                                         | The size rule: this viewer fits `cols`×`rows`; this viewer is being used, so the size follows it. **[prototype]**, **[new]** as wire types (the generated `TerminalEvent` is server→client only). |
| `2`  | server→client | snapshot bytes                                                                                                                                                | The screen the server replays. Shown, **not** counted in `offset`.                                                                                                                                |

`TerminalAttached`'s fields, as this client reads them: `mode` is `snapshot` (the viewer's `after` is
behind what the server kept, so it clears the display and draws a fresh screen first) or `resume` (output
continues from `after`); `offset` is the output offset the first type-`0` frame starts at; `snapshot` is how
many type-`2` bytes come before that; `size` is the session's size now and `viewer` this viewer's id, to
compare with a `size` event's `active`; `readonly` says the server refused input; `info` is the
`TerminalInfo` at attach time. **[new]** as an explicit reading: the generated types document each field,
but not the order of the frames, which this client takes from the prototype.

Attach parameters:

| Field      | Meaning                                                                                                                                                            |
| ---------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `id`       | The terminal. **[adopted]** (`TerminalAttach.id`; Rookery's SDK stub at `sdk/src/client/api.ts` says `terminal` instead — this plugin follows the generated type). |
| `after`    | Resume after this output offset. Omitted on the first attach. **[adopted]**                                                                                        |
| `size`     | The viewer's size, for the size rule. **[adopted]**                                                                                                                |
| `readonly` | Watch only: input is refused. A caller with only `view` always attaches this way. **[adopted]**                                                                    |
| `to`       | `"caller"`, for a plugin opening the stream on someone else's connection. Not used by Crow. **[adopted]**                                                          |

Behaviour the client expects:

- On drop, the client re-attaches with `after` = the last offset it received. A `NOT_FOUND` or `FORBIDDEN`
  ends it (state `error`) and is not retried; anything else is retried with backoff (250 ms doubling to
  5 s), and the retry passes through `Connection.call`'s wait for the socket, so it recovers from a socket
  drop as well.
- Input frames must arrive **in order**. The prototype's notes record unordered input frames against
  berth 0.6 (`plans/design.md`, "Things to check"); `rookeryd`'s behaviour is unverified, and getting this
  wrong reorders keystrokes.
- `state` events (`exited`, `lost`) end the viewer; `lost` means the host's session service restarted under
  the session. The client shows `lost` with its own note.

## Event topics

| Topic                       | Payload                      | Notes                                                                                                                                                                                                                                                         |
| --------------------------- | ---------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `rookery/terminals.changed` | `{ terminal: TerminalInfo }` | A terminal's title, state or viewers changed; refreshes the sessions list. **[prototype]**: the prototype had `terminals.changed` as a notification, Rookery has no `TerminalChanged` wire type yet, so this is a `events.subscribe` topic with that payload. |
| `rookery/env.changed`       | `{ environment: EnvInfo }`   | A host's state or access changed; refreshes the picker and the "offline" note. **[prototype]** for the same reason.                                                                                                                                           |

Both are best effort in the client: a server that does not publish them leaves the views on their 5-second
poll.

## Types

From `@rookery/client` (generated, do not re-declare):

- `TermSize` `{ cols, rows }`, `TerminalState` `"running" | "exited" | "lost"`, `AttachMode`
  `"snapshot" | "resume"`, `EnvUser` `"agent" | "operator" | "root"`.
- `TerminalInfo` `{ id, uri, env, title, command, cwd?, owner?, state, exitCode?, size, viewers, offset,
  createdAt, sessionId?, recording, level?, lastInput? }`.
- `TerminalAttached`, `TerminalEvent`, `TerminalOpen`, `TerminalAttach`, `TerminalList`, `TerminalQuery`,
  `TerminalRef`, `TerminalRecord`, `TerminalRename`, `TerminalResize`, `TerminalSignal`, `TerminalWrite`,
  `TerminalInput`, `TermInput`, `TerminalAdopt`.
- `EnvInfo`, `EnvList`, `EnvSession`, `EnvSessionList`, `EnvSessionQuery`, `EnvSupports`, `Checkout`,
  `CheckoutList`, `ScreenInfo`, `ScreenQuery`, `CursorInfo`, `InputInfo`, `StreamOpened`.

What the plugin declares itself, in `src/termApi.ts`: the type byte constants (`0`, `1`, `2`), the
client→server control type `AttachControl`, and `TerminalChanged`.

`TerminalInfo` is the name the server takes in M3 (decision 2: the server keeps terminal records with
levels, viewers and offsets). `ScreenInfo`, `ScreenQuery` and `CursorInfo` are not: they are prototype
types with no decision behind them yet, so `terminals.screen` is marked pending in `API.md`'s table above
and the inspector shows the method's error instead of a screen when it is missing.

## Open questions

1. **The frame type byte.** Is it the prototype's one-byte tag, or should output be raw and events a
   separate channel? This client implements the tag, because that is what the prototype's client and
   server did, and because it keeps events and bytes on one ordered stream.
2. **`snapshot` vs `offset`.** The reading above (snapshot frames uncounted, `offset` where output starts)
   is the only one that makes resume safe; the server agent should confirm it rather than pick the other
   one.
3. **Who may attach read-only.** A terminal is private to its owner, so a `view` holder attaching
   `readonly` to someone else's terminal may be a refusal instead. If it is, `attach` should answer
   `FORBIDDEN`, and the sessions list should keep hiding other people's terminals except through
   `env.presence` counts.
4. **`open`'s one-call shape** (see above): `{ terminal, channel }` from `plans/design.md`, or the
   two-step `open` then `attach` this plugin is written against.
5. **Where `sessionId` comes from.** The sessions list matches `terminals.sessions` entries to terminals by
   `TerminalInfo.sessionId`. If the server does not keep it, "other sessions" shows sessions that are
   already adopted as terminals too.
6. **`terminals.signal`'s names.** Not called by the views; if automation uses it, the accepted names need
   fixing (POSIX names, without `SIG`).
