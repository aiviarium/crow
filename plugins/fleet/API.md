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

| Topic                   | Payload                                                        | Notes                                             |
| ----------------------- | -------------------------------------------------------------- | ------------------------------------------------- |
| `rookery/hosts.changed` | `{ host: string, info?: HostInfo \| null, removed?: boolean }` | Refreshes fleet views in place when hosts change. |
| `rookery/jobs.changed`  | `{ job: JobInfo }`                                             | Updates job state in place while viewing a job.   |

A topic with a `/` is the server's, taken as it is; a bare name would be `fleet/…`, this plugin's own.

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
| `access.grant`  | `{ resource: string, principal: string, level: "view" \| "use" \| "manage" }` | `GrantInfo`                                                | `manage` on the host | Adds a grant or changes its level. The grant is the server's `AccessGrant` (`{ resource, principal, level }`); the generated `GrantSet` (`{ uri, principal, level }`) is a stale prototype type and is not used. **[adopted]**                   |
| `access.revoke` | `{ resource: string, principal: string }`                                     | `{}`                                                       | `manage` on the host | Removes a grant. `NOT_FOUND` when there was none. **[adopted]**                                                                                                                                                                                  |
| `access.level`  | `{ resource: string }`                                                        | `{ level: "view" \| "use" \| "manage" \| null }`           | the caller's own     | Kept for the desktop and port views' gates; the host's `level` in `EnvInfo` is what the UI reads. **[adopted]**                                                                                                                                  |
| `admin.users`   | `{}`                                                                          | `UserList` (`{ users: UserInfo[] }`)                       | `admin`              | Names the people in the share dialog's picker and its "who has access" list. One call, not a combined users-and-groups answer. **[adopted]**                                                                                                     |
| `admin.groups`  | `{}`                                                                          | `GroupList` (`{ groups: GroupInfo[] }`)                    | `admin`              | Names `group:<id>` grants and offers groups in the picker, beside `admin.users`. **[adopted]**                                                                                                                                                   |
| `users.search`  | `{ query: string }` → `{ users: UserInfo[] }`                                 | —                                                          | `manage` on the host | **Pending (M2b)**: what a manager who is not an admin needs to find a person. Until it lands the dialog takes a typed `user:<id>` or `everyone`; see question 2.                                                                                 |
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

| Topic                 | Payload                    | Notes                                                                                                                                                                                                       |
| --------------------- | -------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `rookery/env.changed` | `{ environment: EnvInfo }` | Refreshes the host page's state, `supports` and level. **[prototype]**: the prototype had `env.changed`; Rookery has no `EnvChanged` wire type yet, so it is an `events.subscribe` topic with this payload. |

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
   wants. **Pending (M2b)**: `users.search` at `manage`, and the dialog's picker switches to it for a
   non-admin manager.
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

# Fleet M4 API Contract

What `crow/plugins/fleet` calls for M4: making a machine from the installation's catalogue, the
provisioners' page, the machine a host has, and the admin page (server settings, installation secrets and
registries). The server side is rookery#33 (`feat/cli-client`, not yet merged). Crow pins Rookery at
`5708f84`, which has none of these methods, so the wire types are copied into
[`src/types.ts`](./src/types.ts), each marked with where it came from and with the `@rookery/client` import
that replaces it after the repin. Every method here is `admin` level on the server.

## The new-machine flow

1. `setup.catalogue` once: the profile a new host starts from (`template`) and the features the installed
   plugins can install, with the types of host each fits.
2. `provisioners.list`: the provisioners registered under names of their own. One with a `problem`, or
   with `missing_secrets`, is shown with what to fix and cannot make a machine.
3. `hosts.save` with the template, the host's name as `hostname`, and the chosen features in
   `ansible_vars.rookery_plugin_features`: the machine is made for a saved host, and `resources.create`
   refuses one without a profile.
4. `resources.create` with `provisioner`, `kind: "machine"`, the host's name, and the provisioner's
   arguments (its `own` ones, such as the server, start from its settings, the rest from their defaults).
   The result is the resource and the job that makes it.
5. `jobs.follow` on that job, as the existing job view does: the log, then how it ended. The dialog lands
   on the new host's page when the job succeeds, and offers the job when it fails.

The host page then has the host's `apply` (`hosts.act`) and its machine (`host.info.machine`), whose
`resources.actions` offers the provisioner's verbs, and `resources.remove` deletes the machine.

## RPC methods

| Method                        | Params                                                      | Result                                              | Notes                                                                                                                      |
| ----------------------------- | ----------------------------------------------------------- | --------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| `provisioners.list`           | `{}`                                                        | `ProvisionerInfo[]`                                 | The ones registered under names of their own. **[#33]**                                                                    |
| `provisioners.types`          | `{}`                                                        | `ProvisionerInfo[]`                                 | Every type the installed plugins bring; its `arguments` are the fields a registration fills. **[#33]**                     |
| `provisioners.get`            | `{ name, given?: Record<string, string> }`                  | `ProvisionerState`                                  | Its page: what it says of itself (`state`, `message`, `details`) and what it holds (`resources`, `collections`). **[#33]** |
| `provisioners.save`           | `{ name, type, settings?: Record<string, string> \| null }` | `ProvisionerInfo`                                   | Registers one, or changes its settings; its type stays. Empty settings are not kept. **[#33]**                             |
| `provisioners.remove`         | `{ name }`                                                  | `{}`                                                | Only one that made nothing kept; a refusal is a sentence to show. **[#33]**                                                |
| `provisioners.actions`        | `{ name }`                                                  | `{ actions: Action[] }`                             | Its plugin's own actions, such as listing images or pruning. **[#33]**                                                     |
| `provisioners.act`            | `{ name, action, arguments?, token? }`                      | `Acted`                                             | A changing action is a job; a reading one answers at once in `result`. **[#33]**                                           |
| `resources.create`            | `NewResource`                                               | `{ resource, job: JobInfo }`                        | Needs the host's profile saved first. **[#33]**                                                                            |
| `resources.list`              | `{ provisioner?, kind?, host? }`                            | `Resource[]`                                        | **[#33]**                                                                                                                  |
| `resources.get`               | `{ id }`                                                    | `Resource`                                          | Asks the provisioner for its state. **[#33]**                                                                              |
| `resources.actions`           | `{ id }`                                                    | `{ actions: Action[] }`                             | Includes `start`, `stop`, `change`, `logs`, `exec` and `remove` as the kind declares them. **[#33]**                       |
| `resources.act`               | `{ id, action, arguments?, token? }`                        | `Acted`                                             | **[#33]**                                                                                                                  |
| `resources.remove`            | `{ id, token? }`                                            | `Acted`                                             | Deletes the machine with its provisioner; the host's profile stays. **[#33]**                                              |
| `setup.catalogue`             | `{}`                                                        | `{ template: object, features: FeatureInfo[] }`     | **[#33]**                                                                                                                  |
| `installation.settings.list`  | `{}`                                                        | `Array<{ key, value, meaning, open }>`              | A string value; `open: false` is the server's own and cannot be set from a browser session. **[#33]**                      |
| `installation.settings.set`   | `{ name, value }`                                           | `{}`                                                | An empty value goes back to the default. **[#33]**                                                                         |
| `installation.secrets.list`   | `{}`                                                        | `{ names: string[], secrets: Array<{ id, name }> }` | Names only; values never leave the server. **[#33]**                                                                       |
| `installation.secrets.set`    | `{ name, value }`                                           | `{}`                                                | Write-only. **[#33]**                                                                                                      |
| `installation.secrets.rename` | `{ name, value: newName }`                                  | `{}`                                                | A secret of a name of its own. **[#33]**                                                                                   |
| `installation.secrets.remove` | `{ name }`                                                  | `{}`                                                | **[#33]**                                                                                                                  |
| `installation.actions`        | `{}`                                                        | `{ actions: Action[] }`                             | The installation's own: upgrade, rekey, and the checks it offers. **[#33]**                                                |
| `installation.act`            | `{ action, arguments?, token? }`                            | `Acted`                                             | **[#33]**                                                                                                                  |
| `registries.list`             | `{}`                                                        | `{ registries: Record<string, Registry> }`          | By name: `id`, `type` (`raw`, `npm`, `docker`, `nexus`), `url`, `username`, and a Nexus server's `repositories`. **[#33]** |
| `registries.save`             | `{ name, value: Registry }`                                 | `{}`                                                | Its login is the secret `registry/NAME`, set with `installation.secrets.set`. **[#33]**                                    |
| `registries.check`            | `{ name }`                                                  | `{ lines: string[] }`                               | One line per thing checked, starting with ✓, ! or ✗. **[#33]**                                                             |
| `registries.rename`           | `{ name, value: newName }`                                  | `{}`                                                | Its login moves with it. **[#33]**                                                                                         |
| `registries.remove`           | `{ name }`                                                  | `{}`                                                | With its login. **[#33]**                                                                                                  |

`Acted` is `{ job: string | null, state: JobState | null, info: JobInfo | null, session, result }`; the UI
follows `job` when it is one and shows `result` (`{ lines }` or text) when it is not.

## Levels

All of M4's methods are `admin` on the server. The Provisioners page and the new-machine dialog show what
the server refuses as a sentence; the Admin page is for admins alone, and the sidebar row for it appears
only while the signed-in person is one (`auth.me`'s `admin`).

## Needed

Where the UI wants what the server does not have yet, each with the milestone it belongs to.

1. **A catalogue of machines, not only of profiles.** `setup.catalogue` gives the profile template and the
   features, so "New machine" takes its fields from the chosen provisioner's arguments. A catalogue of
   sizes and images (the entries the CLI's prompts imply) would let the same flow offer "2 vCPU, 4 GiB,
   Debian 13" without reading a provisioner's argument names, and would keep working when a provisioner
   changes its arguments. **M4.**
2. **One call for a host and its machine.** `resources.create` refuses a host with no saved profile, so the
   dialog saves one and then asks for the machine: between the two, a host exists with nothing behind it.
   A `NewResource` that carries the profile (or a `hosts.create` that takes both) would make it one call.
   **M4.**
3. **A provisioner's state in its listing.** `provisioners.list` does not say `ready`, `unreachable` or
   `unusable`, so the page calls `provisioners.get` once per registered provisioner. A `state` and
   `message` on `ProvisionerInfo`, or a `provisioners.states` over many names, would be one call. **M4.**
4. **What blocks a removal.** `provisioners.remove` refuses one that made something kept, and says what in
   the error; the page can only show that sentence. The resources that block it are what
   `provisioners.get` lists, when its provisioner can be asked at all. **M4.**
5. **Registries as connections.** `plans/design.md` says host registries become connections of a declared
   type, while #33 keeps `registries.*` as methods of their own. Crow calls `registries.*`; when they are
   folded into `connections.*`, the Admin page's section follows. **M4.**
6. **A registry's login state.** The login is the secret `registry/NAME`, and `registries.check` is the
   only thing that says whether it fits; `installation.secrets.list` says the name exists, not whether it
   is the right password. A line in `registries.list` that says the login is kept and last checked would
   let the page show it without a check. **M4.**
7. **Settings that are the server's own.** `installation.settings.list` answers `open: false` for the ones
   only the server's own user sets, and the page shows them read-only. That is the intended split; a
   sentence per key on what to run (`rookery config set KEY`) rather than only `meaning` would save a
   reader a lookup. **M4.**
