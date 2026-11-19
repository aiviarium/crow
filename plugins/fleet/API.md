# Fleet M1 API Contract

Every Rookery JSON-RPC method, binary stream, and event topic that `crow/plugins/fleet` calls in M1. `hosts.*` is hand-written in [`src/api.ts`](./src/api.ts) until it lands in `@rookery/client`'s generated wire types; `jobs.*` is typed from those generated types in [`src/jobs.ts`](./src/jobs.ts).

## RPC methods

| Method          | Params                                                                                                         | Result                                                                   | Required level                                                                           | Notes                                                                                                                                           |
| --------------- | -------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| `hosts.list`    | `{}`                                                                                                           | `{ hosts: HostInfo[] }`                                                  | `view` (filtered to hosts caller can view)                                               | Lists hosts visible to the caller.                                                                                                              |
| `hosts.get`     | `{ host: string }`                                                                                             | `HostInfo`                                                               | `view` on host                                                                           | Current status, type, applied/behind state, and power info.                                                                                     |
| `hosts.save`    | `{ host: string, profile: HostProfile }`                                                                       | `{ host: HostInfo }`                                                     | `admin` to create, `manage` on host to update                                            | Creates or updates a host's saved profile (`rookery host add` writes `{ type?, access: { address, user?, port?, auth? }, builder? }`).          |
| `hosts.remove`  | `{ host: string }`                                                                                             | `{}`                                                                     | `manage` on host                                                                         | Removes a host record.                                                                                                                          |
| `hosts.rename`  | `{ host: string, to: string }`                                                                                 | `{ host: HostInfo }`                                                     | `manage` on host                                                                         | Renames a host record.                                                                                                                          |
| `hosts.profile` | `{ host: string }`                                                                                             | `{ profile: HostProfile }`                                               | `view` on host                                                                           | Returns the host's saved profile JSON for summary display.                                                                                      |
| `hosts.check`   | `{ host: string, capability: string }`                                                                         | `{ allowed: boolean, refusal?: { why: string, raise: string } \| null }` | `view` on host                                                                           | Checks whether the host's type permits a capability (for example `apply`).                                                                      |
| `hosts.actions` | `{ host: string }`                                                                                             | `{ actions: Action[] }`                                                  | `view` on host                                                                           | Lists host actions with availability, role, group, arguments, and confirmation text. M1 UI hides `terminal: true` actions.                      |
| `hosts.act`     | `{ host: string, action: string, arguments?: Record<string, string>, token?: string, sudo_password?: string }` | `{ job: string, state: JobState, result?: unknown }`                     | Per action (`role`: `view` -> `view`, `operate` -> `use`, `admin` -> `manage` / `admin`) | Enqueues a host action as a Rookery job (for example `apply`, `trust-key`, power, or feature actions) and returns its job ID and initial state. |
| `jobs.list`     | `JobQuery` (`{ state?: JobState, kind?, subject?, before?, limit? }`)                                          | `{ jobs: JobInfo[] }`                                                    | Caller's own jobs (`admin` for everyone's)                                               | Lists recent jobs, newest first. Fleet filters host jobs client-side by `params.host` or the job's `subject`.                                   |
| `jobs.get`      | `{ id: string }`                                                                                               | `JobDetail` (`{ job: JobInfo, attempts: JobAttemptInfo[] }`)             | Enqueuer or `admin`                                                                      | Fetches a single job and its attempt history.                                                                                                   |
| `jobs.cancel`   | `{ id: string }`                                                                                               | `{}`                                                                     | Enqueuer or `admin`                                                                      | Cancels a `queued` or `running` job.                                                                                                            |
| `jobs.retry`    | `{ id: string, attempts?: number }`                                                                            | `JobInfo`                                                                | Enqueuer or `admin`                                                                      | Retries a `failed` or `cancelled` job.                                                                                                          |

## Binary streams

| Method        | Params                           | Frames                                                                                                                                                     | Required level      | Notes                                                                                                                                           |
| ------------- | -------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| `jobs.follow` | `{ id: string, after?: number }` | NDJSON UTF-8 chunks: one `LogItem` (`{ seq, at, attempt, level, text, data }`) per line, then one `JobEnd` (`{ state, result, error: ErrorBody \| null }`) | Enqueuer or `admin` | Streams log lines after cursor `after` (exclusive). Reconnecting clients pass the last received `seq`. An `ErrorBody` stands for its `message`. |

## Event topics (optional live refresh)

| Topic           | Payload                                                        | Notes                                             |
| --------------- | -------------------------------------------------------------- | ------------------------------------------------- |
| `hosts.changed` | `{ host: string, info?: HostInfo \| null, removed?: boolean }` | Refreshes fleet views in place when hosts change. |
| `jobs.changed`  | `{ job: JobInfo }`                                             | Updates job state in place while viewing a job.   |

## Core types

- **`HostInfo`** (from `rookery/src/local/serve/api.rs`):
  `{ id?, name, address, reachable, version?, api?, error?, applied?, behind?: { changes: [{ id, from, to }] }, type: "ssh" \| "managed" \| "node" \| "workstation" \| "local", seen?, rotating?, power: { start, stop, state: "running" \| "stopped" \| "unknown", start_by?, stop_by? }, machine?: { resource, provisioner, external_id, state } }`
- **`Action`** (from `rookery-api/src/types.rs`):
  `{ name, label, help, group, arguments: Argument[], confirm?, runs: "rookery" \| "host", terminal, changes, role: "view" \| "operate" \| "admin", available, why?, steps?, collection? }`
- **`Argument`** (from `rookery-api/src/types.rs`):
  `{ name, label, required, default, choices?, kind?, help?, values?, secret?, fixed?, confirm? }`
- **`JobInfo` / `JobDetail` / `LogItem` / `JobEnd`** (from `rookery-proto`, through `@rookery/client`'s generated types):
  `JobInfo` is `{ id, kind, state, params, subject, attempts, maxAttempts, cancelRequested, progress, result, error, enqueuedBy, createdAt, startedAt, finishedAt }`; `error` is an `ErrorBody` (`{ code, message, details? }`), and `progress` is plugin-defined. A job has no `name` or `plugin`: show its `kind` and `subject`.

# Fleet M3 API Contract

What the M3 parts of `crow/plugins/fleet` need from the server: a host's desktop (VNC in the browser), port
links (`/env/<name>/port/<n>/`), and sharing a host (grants on `env://NAME`). The M1 contract above is
unchanged. Provenance per row: **[adopted]** means the method or name exists in Rookery today (checked in
`rookery/crates`), **[prototype]** means the prototype had it in that shape, **[new]** means this plugin
needs it and neither had it.

Where the M1 methods address a host by bare name (`hosts.get { host: "studio" }`), the M3 methods use the
environment form the design settles on: `env.*` take `env: "env://studio"` (or `"studio"`, whichever the
server prefers; this client sends `env://NAME`) and `access.*` take `resource: "env://studio"`. That
mismatch is real and is question 1 below.

## RPC methods

| Method          | Params                                                                        | Result                                                     | Required level       | Notes                                                                                                                                                                                                                                            |
| --------------- | ----------------------------------------------------------------------------- | ---------------------------------------------------------- | -------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `env.list`      | `{}`                                                                          | `{ environments: EnvInfo[] }`                              | `view`               | The hosts as environments, with each one's `supports` and the caller's `level`. The host page uses it to decide whether to show the desktop and ports. **[adopted]**                                                                             |
| `env.get`       | `{ env: string }`                                                             | `EnvInfo`                                                  | `view` on the host   | The desktop and port views load this: `state` (online, offline, …), `supports.desktop`, `supports.connect` and `level`. **[adopted]**                                                                                                            |
| `env.presence`  | `{ env: string }`                                                             | `{ users: PresenceUser[] }`                                | `view`               | "On it now" on the host page. Terminal counts per person, never their terminals. **[adopted]**                                                                                                                                                   |
| `env.checkouts` | `{ env: string }`                                                             | `{ checkouts: Checkout[] }`                                | `use`                | Not needed by M3 but already in the M1 page's data (`Checkout`); read only if the host page grows a worktree list. **[adopted]**                                                                                                                 |
| `access.grants` | `{ resource: string }`                                                        | `{ resource, owner: string \| null, grants: GrantInfo[] }` | `manage` on the host | Who holds what. `owner` is the owner's **user id** (not a principal); `GrantInfo` is `{ principal, level, createdBy, createdAt }` and `principal` is `user:<id>`, `group:<id>` or `everyone`. **[adopted]** (`rookery-facilities/src/access.rs`) |
| `access.grant`  | `{ resource: string, principal: string, level: "view" \| "use" \| "manage" }` | `GrantInfo`                                                | `manage` on the host | Adds a grant or changes its level. Note the generated `GrantSet` type says `{ uri, principal, level: Level }`; the server's `AccessGrant` is `{ resource, principal, level: Grant }` and that is what this client sends. **[adopted]**           |
| `access.revoke` | `{ resource: string, principal: string }`                                     | `{}`                                                       | `manage` on the host | Removes a grant. `NOT_FOUND` when there was none. **[adopted]**                                                                                                                                                                                  |
| `access.level`  | `{ resource: string }`                                                        | `{ level: "view" \| "use" \| "manage" \| null }`           | the caller's own     | Kept for the desktop and port views' gates; the host's `level` in `EnvInfo` is what the UI reads. **[adopted]**                                                                                                                                  |
| `admin.users`   | `{}`                                                                          | `{ users: AdminUser[], groups: AdminGroup[] }`             | `admin`              | Only to name people in the share dialog and to offer a picker. A non-admin manager types a principal instead (see question 2). **[adopted]**                                                                                                     |
| `hosts.check`   | `{ host: string, capability: string }`                                        | `{ allowed, refusal }`                                     | `view` on the host   | M1 already calls it for `apply`; M3 expects the capabilities `terminal`, `desktop` and `ports` to answer. `env.get.supports` is the field the UI actually reads. **[adopted]** for the method, **[new]** for the three capability names          |
| `auth.me`       | `{}`                                                                          | `Me`                                                       | self                 | The person's id (for "you" in the grants list) and `admin`, which holds manage on every host. **[adopted]**                                                                                                                                      |

### Levels these parts expect

| Level    | What the fleet views let it do                                                                                                 |
| -------- | ------------------------------------------------------------------------------------------------------------------------------ |
| `view`   | See the host, its state, its desktop **thumbnail** and who is on it. The live desktop, ports and sharing are refused with 403. |
| `use`    | Watch the live desktop read-only is **not** this level: `use` is the live desktop with input, and reaching ports.              |
| `manage` | Share the host: read the grants, add, change and remove them.                                                                  |
| `admin`  | The org role: manage on every host, and `admin.users` for picking people.                                                      |

## HTTP routes

| Route                             | For                                                                                                                            | Auth              | Notes                                                                                                                                                                                         |
| --------------------------------- | ------------------------------------------------------------------------------------------------------------------------------ | ----------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `/env/<name>/desktop` (WebSocket) | A host's desktop: the RFB bytes from its VNC server on the host's loopback, with the server answering the VNC password itself. | `use` on the host | The prototype's route, kept as is: noVNC connects with sub-protocol `binary`. `view` gets a 403 on the upgrade (or, if the server prefers, a screenshot route instead). **[prototype]**       |
| `/env/<name>/port/<n>/<path>`     | HTTP and WebSocket to a port on the host's loopback.                                                                           | `use` on the host | From `plans/design.md` ("Endpoints"). The plugin builds it with `portUrl(env, port, path)`; the iframe and the links point at it directly. **[adopted]** for the route, **[new]** for nothing |

The plugin never needs a route to a host: both proxies are on the server's own origin, so the iframe and
noVNC use relative or same-host URLs.

## Event topics

| Topic         | Payload                    | Notes                                                                                                                                                                                                       |
| ------------- | -------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `env.changed` | `{ environment: EnvInfo }` | Refreshes the host page's state, `supports` and level. **[prototype]**: the prototype had `env.changed`; Rookery has no `EnvChanged` wire type yet, so it is an `events.subscribe` topic with this payload. |

## Core types

From `@rookery/client`'s generated types (already there, do not re-declare):

- `EnvInfo` `{ name, uri, kind, provider?, kindTitle?, kindIcon?, state: "online" | "offline" | "starting" | "degraded", owner?, level?, os?, version?, supports: EnvSupports, error?, metadata?, connector? }`.
- `EnvSupports` `{ terminal, process, files, connect, checkouts, desktop, privileged, persistentSessions, deploy }`. M3 reads `desktop` and `connect`.
- `EnvPresence` `{ users: PresenceUser[] }`, `PresenceUser` `{ id, name, terminals, since }`.
- `Grant` `"view" | "use" | "manage"`, `GrantInfo` `{ principal, level, createdBy, createdAt }`, `GrantList` `{ resource, owner, grants }`, `LevelHeld` `{ level }`, `ResourceRef` `{ resource }`.
- `AdminUser` `{ id, name, email?, avatar?, admin, adminFromConfig, disabled, createdAt, lastSeenAt?, groups }`, `AdminUsers` `{ users, groups }`.
- `Me` `{ user: User | null, principal, admin, auth, version, apiVersion }`.
- `Checkout` `{ env, path, name, branch?, head?, url?, repository?, worktreeOf?, recorded }`.

Declared by the plugin: `PortLink` (`{ port, label? }`), and the local storage keys `crow.fleet.ports.v1`
(per-host port links) and `crow.terminal.env` (the last host, shared with the terminal plugin).

## Open questions

1. **`env://` or a bare name in params.** M1's `hosts.*` takes `host: "studio"`; `env.*` documents
   `env: string` without saying which, and this client sends `env://studio`. The generated `EnvRef` says
   `{ env }` and `EnvInfo.uri` is `env://<name>`, so the URI form looks intended. Confirm, and if the server
   wants bare names, that is a one-line change in `plugins/fleet/src/env.ts`.
2. **Finding a person to share with.** `access.grant` needs a `user:<id>`, and only `admin.users` (admin
   only) lists people; `entities.search` (the prototype's way to find a user) is out of scope for the first
   version (`plans/design.md`, decision 22). So a manager who is not an admin types a user id. A
   `users.search` for anyone with manage on a resource would close this; until then the dialog says what it
   wants.
3. **`access.grants` needs manage.** The prototype's share dialog showed the grants to anyone who could
   see the resource; Rookery's `access.grants` requires manage. This client follows the server: a `view`
   holder gets 403 and a sentence. If a `view` holder should see _who_ (not what they do), that is a server
   change.
4. **The desktop route.** `/env/<name>/desktop` is the prototype's. `plans/design.md` names "the VNC
   proxy" without a route, and the port proxy is `/env/<name>/port/<n>/`. An alternative is to proxy the
   host's VNC port (`/env/<name>/port/5900/`) and let noVNC connect there, which reuses one proxy but puts
   the VNC password in the browser's hands. The plugin is written for the prototype's route; the noVNC
   component takes the URL from `desktopUrl()` in `plugins/fleet/src/DesktopView.tsx` if it changes.
5. **`view` and the desktop.** A `view` holder is promised a "desktop thumbnail" in the design's level table,
   but no method returns one (`hosts.desktop.screenshot` is proposed, not implemented). The desktop view
   refuses with 403 and shows no picture; when the screenshot method lands, that is where it goes.
6. **WebSocket in the port proxy.** Dev servers that use HMR open a WebSocket under the same path. The
   UI cannot tell whether the proxy upgrades; it assumes it does, as the design's "HTTP and WebSocket" line
   says.
