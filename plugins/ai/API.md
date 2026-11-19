# Rookery API Contract for `ai` and `model-anthropic`

This document catalogs every Rookery RPC method, facility, manifest contribution type, client SDK surface, host SDK surface, and Rust app-service SDK (`rookery-sdk`) API needed by Crow's `ai` plugin (`plugins/ai` + `plugins/ai/router`) and its provider plugin (`plugins/model-anthropic`).

Each item is marked:

- **exists in Rookery now** — implemented in `rookery/` today (`rookery-proto`, `rookery-facilities`, `rookery-server`, or `@rookery/sdk`).
- **needed** — not yet implemented on the Rookery server or SDK runtime (primarily M2 plugin/app-service runtime, plugin-owned connection types, collections/migrations, and spaces).

## Configure an Anthropic connection

Run `bun run pack` from Crow, then add the registry and the provider it holds to an M5 server:

```bash
rookery plugin registry add dir ./dist/registry
rookery plugin add crow/model-anthropic
```

In the Models page, an administrator can add an Anthropic API key, map the Text or Fast task to a
model and run a test prompt. Rookery stores the key as a sealed connection credential and the task
mappings as global settings. The provider sends requests to Anthropic's Messages API and returns
completed text.

---

## 1. JSON-RPC Methods (`rookery-facilities` / `rookery-server`)

### Connections (`connections.*`)

- `connections.list` (`ConnectionsOf` -> `ConnectionList`): **exists in Rookery now** (returns `ConnectionInfo[]` without credentials; filtered by caller access).
  - **Gap (`needed`)**: `Scope::Space` connections and `?space=` filtering (`rookery-proto::facilities::Scope` only has `Global` and `User` today).
- `connections.resolve` (`ConnectionResolve` -> `ConnectionResolved`): **exists in Rookery now** (returns `ConnectionInfo` + sealed `credential: Option<String>`).
  - **Gap (`needed`)**: Authorizing resolve access when called by another plugin's app service acting on behalf of a user (`ai.router` calls `connections.resolve` as caller for built-in `ai.openai-compatible` connections, while `model-anthropic` calls `connections.resolve` for `model-anthropic.api` connections so API keys are revealed only to the owning plugin/service). Also note `ConnectionInfo` currently carries `config` + separate `credential: Option<String>` rather than merged `values`; `ai-router` and `model-anthropic` adapt `ConnectionResolved` (`{ ...connection.config, apiKey: credential }`) and strip `apiKey` before logging/displaying.
- `connections.types` / `connections.create` / `connections.update` / `connections.delete`: **exists in Rookery now** for hardcoded `"registry"` and `"http"` types.
  - **Gap (`needed`)**: Dynamic registration of plugin-contributed `contributes.connectionTypes` (`ai.openai-compatible`, `model-anthropic.api`), including `secret: ["apiKey"]` schema stripping and credential sealing on `create`/`update`.
- `connections.test` (`IdRef` -> `ConnectionTested`): **exists in Rookery now** for hardcoded HTTP probe types.
  - **Gap (`needed`)**: Routing `connections.test` for plugin-owned connection types (the server probes Rookery's own types only; `model-anthropic` no longer registers a host-half test handler).

### Settings, Secrets, and Storage

- `settings.get` / `settings.set` / `settings.list` / `settings.reset`: **exists in Rookery now**. Used by `ai` client (`ai.dictationLanguage`) and legacy migration fallback.
- `secrets.get` / `secrets.set` / `secrets.list` / `secrets.delete` / `secrets.rename`: **exists in Rookery now**. Model API keys are stored only as sealed credentials / secrets, never in settings, logs, or argv.
- `storage.get` / `storage.set` / `storage.list` / `storage.delete`: **exists in Rookery now** (`Scope::Global` and `Scope::User`). Used by `migrations/storageFallback.ts` (`importToStorage`) until plugin collections (`data.*` / `MigrationTx`) land.
  - **Gap (`needed`)**: `Scope::Space` on `storage.*` and `settings.*` for space-scoped configuration/overrides.

### Access Control & Audit (`access.*`, `audit.*`)

- `access.filter` (`AccessFilter` -> `Resources`): **exists in Rookery now**. Used by `ai-router` to verify `Level::Use` on `connection://<id>` before resolving a task mapping.
- `access.require` (`AccessRequire`): **exists in Rookery now**.
  - **Gap (`needed`)**: Space resources (`space://<id>`) and `connection://<id>` owner/grant wiring when connections are created/managed by users or spaces.
- `audit.list` (`AuditQuery` -> `AuditList`): **exists in Rookery now**.
- `audit.record` (host / service call): **needed** (kernel has internal `call.audit(...)`, but plugins / app services do not yet have a public RPC / `ctx.audit().record(action, resource, details)` endpoint for recording `ai.setMapping`, `ai.removeMapping`, `ai.setLimits`).

### Plugin Host, Collections, Extensions, Entities, Spaces

- `plugins.list` (`PluginList`): **needed** (currently shimmed in Crow shell by `shell/src/app/builtins.ts`).
- `plugins.rpc` (`{ plugin, method, params }` unary & streamed): **needed** (the `ai` client calls all 15 `router` methods in `methods.json` via `rookery.host.call` / `rookery.host.stream`, which serialize as `plugins.rpc`).
- `data.*` (`find`, `get`, `insert`, `update`, `upsert`, `delete`, `aggregate` for collections `mappings`, `limits`, `usage`): **needed** (used by `ai-router` for mapping storage, per-user/default daily budgets, usage recording, and usage aggregation `groupBy: [field, "ok"]` + `measures: count/sum`, as well as by `migrations/importLegacy.ts` via `MigrationTx`).
- `extensions.list` / `extensions.changed.<point>` (specifically `ai.providers`): **needed** (`ai-router` lists providers on `ai.providers` and subscribes to `extensions.changed.ai.providers` to invalidate its cache when provider plugins such as `model-anthropic` activate or deactivate).
- `services.call` / `services.stream` (`ctx.call` / `ctx.stream` between plugins): **needed** (`ai-router` streams `generate` and calls `transcribe` / `models` on the service named in a provider's `ai.providers` contribution, e.g., `model-anthropic`'s `"anthropic"` service).
- `entities.text` (`ctx.entities().text(uris)`): **needed** (used by `ai-router` when `generate`/`complete` receives `context: string[]` entity URIs to inject `<context>` blocks into the system prompt).
- `spaces.*` (`spaces.list`, `spaces.get`, caller `ctx.space()`): **needed** (used by space-scoped task mappings and space manager authorization checks).

---

## 2. Manifest Contribution Types (`plugin.json`)

| Contribution / Field                                                                                                                     | Used by                 | Status in Rookery                                                     | Notes                                                                                                                 |
| ---------------------------------------------------------------------------------------------------------------------------------------- | ----------------------- | --------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------- |
| `id`, `name`, `version`, `apiVersion`, `description`, `client`, `styles`, `host`, `dependencies`, `interface`                            | `ai`, `model-anthropic` | **needed**                                                            | M2 plugin manifest loader (`plugin.json` + `package.kdl`).                                                            |
| `namespace`, `routes`, `contributes.views`, `contributes.nav`, `contributes.commands`, `contributes.adminPages`                          | `ai`                    | **exists in `@rookery/client` shell contract** / **needed on server** | Crow's shell & `@rookery/client` consume these today via `builtins.ts`; server `plugins.list` delivery arrives in M2. |
| `contributes.settings` (`ai.dictationLanguage`)                                                                                          | `ai`                    | **needed**                                                            | Declarative plugin setting schema + UI.                                                                               |
| `contributes.connectionTypes` (`ai.openai-compatible`, `model-anthropic.api`, `secret`, `test`, `testMethod`)                            | `ai`, `model-anthropic` | **needed**                                                            | Custom connection types with masked secret fields and plugin test hooks.                                              |
| `contributes.collections` (`mappings`, `limits`, `usage`) + `migrations` (`0001.json`)                                                   | `ai`                    | **needed**                                                            | Plugin-owned collections, indexes, unique keys (`key`, `user`), and schema/TS migration runner.                       |
| `contributes.rpc` (`allow` / forwarding `methods` to `"service": "router"`)                                                              | `ai`                    | **needed**                                                            | Routes browser/CLI `plugins.rpc` calls for `ai` directly to the `router` app service's methods (`methods.json`).      |
| `extensionPoints` (`ai.providers`)                                                                                                       | `ai`                    | **needed**                                                            | Schema-validated extension point for external model provider plugins.                                                 |
| `contributes.extensions["ai.providers"]`                                                                                                 | `model-anthropic`       | **needed**                                                            | Registers `model-anthropic.messages` -> service `"anthropic"` for tasks `["text", "fast"]`.                           |
| `services` (`router`, `provides: "ai"`, `endpoints`, `dev.command`, `methods: "methods.json"`) & `provides.services` (`ai`, `anthropic`) | `ai`, `model-anthropic` | **needed**                                                            | M2 app service packaging, supervision, and service registry.                                                          |

---

## 3. Client & Host SDK Surfaces (`@rookery/sdk`)

### `@rookery/sdk/client`

- `rookery.views.register`, `rookery.commands.register`, `rookery.workbench.openView` / `toast`: **exists in Rookery now** (`@rookery/client` + `@rookery/sdk/client`).
- `rookery.host.call`, `rookery.host.stream` (`plugins.rpc` + NDJSON `ClientStream`): **exists in `@rookery/sdk/client` types/wire**; **needed** on server (`plugins.rpc`).
- `rookery.connections.list()` / `connections.types()`: **exists in Rookery now** (needs M2 support for plugin connection types).
- `rookery.settings.get()`: **exists in Rookery now**.
- `rookery.storage.*`: **exists in Rookery now** (used by `migrations/storageFallback.ts`).
- `rookery.assist.provide(handler)` & `rookery.speech.provide(source)`: **needed** (optional extension hooks on `ClientRookery`; `ai` client registers them conditionally when present, enabling inline AI assist and microphone dictation across inputs/editors).

### `@rookery/sdk` (Node/Bun Host Half, used by `model-anthropic`)

- `definePlugin`, `z`, `RookeryError`, `services.provide("anthropic", { *generate, models })`, `connections.resolve(id)`: **types exist in `@rookery/sdk`**; **host runtime needed in M2**.
- `rookery.connections.test(type, handler)`: **not in the SDK, and not coming**: a host half lists, gets and resolves connections; `model-anthropic/src/host.ts` exports `testConnection` for direct testing only.
- `MigrationTx` (`rookery/sdk/src/data.ts`): **types exist in `@rookery/sdk`**; migration execution loop on server is **needed**.

---

## 4. Rust App-Service SDK (`rookery-sdk`, for `plugins/ai/router`)

As outlined in `plans/design.md` (§ "Write a plugin's app service"), `ai-router` needs a `rookery-sdk` Rust crate alongside `rookery-proto`:

- **Already available (`exists in Rookery now`)**:
  - `rookery-proto` crate (`ErrorCode`, `RpcError`, `ErrorBody`, `Principal`, `PrincipalKind`, `User`, `methods::Grant`, `facilities::{ConnectionInfo, ConnectionResolved, Scope}`).
  - Process env contract documented in `plans/design.md`: `ROOKERY_URL`, `ROOKERY_SERVICE_ID`, `ROOKERY_SERVICE_SECRET`, `ROOKERY_REPLICA`, `ROOKERY_LOG`.
- **Missing (`needed` in `rookery-sdk` / M2)**:
  - `Rookery::connect()` / `Rookery::serve()` transport connecting back to Rookery and serving registered RPC & streaming methods (`rk.method(...)`, `rk.stream_method(...)` with `Chunks<T>` and `CancellationToken`).
  - Caller context `Ctx` propagation (`ctx.user()`, `ctx.principal()`, `ctx.space()`, `ctx.time_left()`, `ctx.cancelled()`).
  - Typed facility clients on `Rookery`/`Ctx`:
    - `svc.data::<T>()` (`find`, `upsert`, `delete`) and `svc.collection(name)` (`insert`, `aggregate`) with `Query` / `Filter` / `field()`.
    - `ctx.connections().get(id)` returning `ConnectionResolved` (with caller authorization & credential resolution).
    - `ctx.access().filter(resources, Grant::Use)` and `ctx.access().require_space(space, grant)`.
    - `svc.extensions().list::<Def>("ai.providers")` and `svc.extensions().changed("ai.providers")` stream.
    - `ctx.call::<P, R>(service, method, &params)` and `ctx.stream::<P, R>(service, method, &params)` for calling plugin-contributed provider services (`model-anthropic`'s `"anthropic"` service).
    - `ctx.entities().text(uris, max_chars)` for context URI expansion.
    - `ctx.audit().record(action, resource, details)`.

Until `rookery-sdk` lands in M2, `crow/plugins/ai/router/src/sdk.rs` provides a thin shim over `rookery-proto` and a `RookeryBackend` trait so `ai-router` builds, lints cleanly, and runs end-to-end tests against an in-memory fake backend.
