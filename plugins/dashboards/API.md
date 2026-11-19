# Rookery API Contract for `dashboards` (and Dashboard Widgets)

This document catalogs every Rookery JSON-RPC method, facility, manifest contribution type, collection feature, and client SDK surface used by `crow/plugins/dashboards` and the dashboard widgets contribution layer (`src/widgets/`).

Each item is marked:

- **exists in Rookery now** — implemented in `rookery/` today (`rookery-proto`, `rookery-facilities`, `rookery-server`, `@rookery/client`, or `@rookery/sdk`).
- **needed (M2)** — arrives with the M2 plugin/extension-host/package runtime.
- **needed (M2b)** — arrives with the M2b datastore, spaces, and entities runtime.

---

## 1. JSON-RPC Methods & Facilities

| Method / Facility                                           | Usage in `dashboards`                                                                                                                               | Status                                                                | Notes                                                                                           |
| ----------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------- |
| `plugins.list`                                              | Discovers active plugins' `contributes.widgets` metadata for the widget picker.                                                                     | **needed (M2)** (shimmed in Crow shell via `builtins.ts`)             | Returns `PluginList` (`PluginInfo[]` with `manifest.contributes.widgets`).                      |
| `data.query` / `data.live` (`rookery.data.dashboards.live`) | Lists dashboards in the current space (`orderBy: [["updatedAt", "desc"]], limit: 200`) and subscribes live to a single dashboard (`where: { id }`). | **needed (M2b)** (`@rookery/sdk/client` types/client stub exist)      | Live queries push updates from other users in real time (`rev` tracks revision echoes).         |
| `data.insert` (`rookery.data.dashboards.insert`)            | Creates a new dashboard row (`{ title, layout: [] }`) in the current space.                                                                         | **needed (M2b)** (`@rookery/sdk/client` types exist)                  | Returns inserted row with generated `id` and initial `rev`.                                     |
| `data.update` (`rookery.data.dashboards.update`)            | Saves debounced layout and title patches (`{ layout?, title? }`), returning `{ rev }`.                                                              | **needed (M2b)** (`@rookery/sdk/client` types exist)                  | Revision number is used to avoid overwriting unsaved local drag/resize state with stale echoes. |
| `spaces.*` (`rookery.spaces.current`)                       | Reads current space (`id`, `name`, `personal`) to label personal vs. team dashboards and show sharing affordances.                                  | **needed (M2b)** (`SpaceInfo` generated type & client accessor exist) | `SpaceInfo` already carries `id`, `kind`, `name`, `slug`, `personal`, `level`, `owner`.         |

---

## 2. Manifest Contribution Types (`plugin.json`)

| Contribution / Field                                                                  | Value / Usage                                                                                                                                                              | Status                                                                                                            | Notes                                                                                                                                                                                                            |
| ------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `id`, `name`, `version`, `apiVersion`, `namespace`, `description`, `client`, `styles` | Plugin metadata and client bundle entry points (`src/client.tsx`, `src/client.css`).                                                                                       | **needed (M2)** (consumed by Crow shell `builtins.ts` today)                                                      | Standard M2 plugin manifest.                                                                                                                                                                                     |
| `contributes.collections` (`dashboards`)                                              | Space-scoped collection with `fields` (`title`, `description`, `layout`), `entity`, `access`, `history`, `trash`.                                                          | **needed (M2b)** (`CollectionContribution` generated type exists)                                                 | See §3 for collection feature details.                                                                                                                                                                           |
| `contributes.entityTypes` (`dashboard`)                                               | Registers `dashboard://<id>` entity scheme pointing to view `dashboards.dashboard`.                                                                                        | **needed (M2b)** (`EntityTypeContribution` generated type exists)                                                 | Enables search, mentions, pinning, and sharing of dashboards.                                                                                                                                                    |
| `contributes.commands` (`dashboards.create`, `dashboards.open`)                       | Command palette actions to create or open dashboards.                                                                                                                      | **exists in Rookery now** (`@rookery/client` + shell) / **needed (M2)** on server                                 | Registered via `rookery.commands.register`.                                                                                                                                                                      |
| `contributes.views` (`dashboards.list`, `dashboards.dashboard`)                       | Main-slot views for the space dashboard list and a single dashboard grid.                                                                                                  | **exists in Rookery now** (`@rookery/client` + shell) / **needed (M2)** on server                                 | Registered via `rookery.views.register`.                                                                                                                                                                         |
| `contributes.nav` (`dashboards.nav`, `section: "rookery.spaces"`)                     | Sidebar entry for Dashboards.                                                                                                                                              | **exists in Rookery now** (`@rookery/client` + shell) / **needed (M2b)** for space sections                       | Shell currently lists all nav items under Plugins until space-scoped nav sections arrive in M2b.                                                                                                                 |
| `contributes.routes` (`/`, `/:dashboard` with `context: "rookery.space"`)             | Mounts dashboard URLs inside space context (`/s/<space>/dashboards/...`).                                                                                                  | **exists in Rookery now** (namespace routing) / **needed (M2b)** (`context: "rookery.space"`)                     | `@rookery/client`'s `buildRouteTable` mounts `/dashboards` and `/dashboards/:dashboard`; space context prefixing arrives in M2b.                                                                                 |
| `contributes.widgets` (`WidgetContribution`)                                          | Contribution type for widgets placed on dashboards (`id`, `title`, `description`, `icon`, `category`, `areas`, `sizes`, `settings`, `refreshSecs`, `collection`, `frame`). | **exists in Rookery now** (generated `WidgetContribution` type) / **needed (M2)** (SDK `rookery.widgets` runtime) | `dashboards` ships `src/widgets/` (`WidgetArea`, registry, picker, settings dialog) with a global bridge (`Symbol.for("crow.widgets.registry")`) until `@rookery/sdk/client` exposes `rookery.widgets` directly. |
| `contributes.extensions["home.actions"]` (`dashboards.new`)                           | Contributes "New dashboard" quick action to Crow's Home screen.                                                                                                            | **needed (M2)**                                                                                                   | Extension point contribution; parsed once shell/M2 extension registry is wired.                                                                                                                                  |

---

## 3. Collection Features (`contributes.collections`)

Collection: `dashboards`

| Feature                      | Setting                                                                    | Status           |
| ---------------------------- | -------------------------------------------------------------------------- | ---------------- |
| Scope                        | `scope: "space"`                                                           | **needed (M2b)** |
| Field types                  | `text` (`title`, `description`), `json` (`layout`)                         | **needed (M2b)** |
| Field constraints & defaults | `required: true`, `default: "Untitled dashboard"`                          | **needed (M2b)** |
| Full-text search indexing    | `search: true` on `title` and `description`                                | **needed (M2b)** |
| Entity projection            | `entity: { scheme: "dashboard", title: "title", subtitle: "description" }` | **needed (M2b)** |
| Access policy                | `access: { read: "view", write: "use" }`                                   | **needed (M2b)** |
| Revision history             | `history: true`                                                            | **needed (M2b)** |
| Soft delete / trash          | `trash: true`                                                              | **needed (M2b)** |

---

## 4. Client SDK Surfaces (`@rookery/sdk/client`)

| Surface                                                 | Status                                                                 | Notes                                                                                                                                                                    |
| ------------------------------------------------------- | ---------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `defineClient`                                          | **exists in Rookery now**                                              | Plugin entry point wrapper.                                                                                                                                              |
| `rookery.views.register`                                | **exists in Rookery now**                                              | Registers `dashboards.list` and `dashboards.dashboard`.                                                                                                                  |
| `rookery.commands.register`                             | **exists in Rookery now**                                              | Registers `dashboards.create` and `dashboards.open`.                                                                                                                     |
| `rookery.workbench.openView`, `rookery.workbench.toast` | **exists in Rookery now**                                              | Opens views and displays error/info toasts.                                                                                                                              |
| `rookery.rpc.call`                                      | **exists in Rookery now**                                              | Calls `plugins.list` to discover plugin `contributes.widgets`.                                                                                                           |
| `rookery.data.<collection>.live/insert/update`          | **exists in `@rookery/sdk/client` types** / **needed (M2b)** on server | Live collection queries and mutations.                                                                                                                                   |
| `rookery.spaces.current`                                | **exists in `@rookery/sdk/client` types** / **needed (M2b)** on server | Current active space accessor.                                                                                                                                           |
| `rookery.widgets` (`register`, `types`, `Area`)         | **needed (M2)**                                                        | Not yet on `ClientRookery`. `dashboards` provides `src/widgets/` and uses `rookery.widgets?.Area ?? WidgetArea` so it adopts the SDK runtime automatically once shipped. |
| `rookery.workbench.share(uri)`                          | **needed (M2b)**                                                       | Opens the sharing dialog for `space://<id>`; gracefully shows an info toast when absent.                                                                                 |

---

## 5. Extension Points & Cross-Plugin Integrations

- **Widget consumers (`contributes.widgets`)**: Any plugin (such as `projects`) declares widgets in `plugin.json` under `contributes.widgets` and registers its component via `rookery.widgets.register(id, component)` (or the `Symbol.for("crow.widgets.registry")` bridge provided by `dashboards`).
- **Home actions (`home.actions`)**: Declares `dashboards.new` invoking command `dashboards.create`.
- **Optional collection/frame widget rendering**: Prototype shell supported declarative `collection` (saved views) and `frame` widgets; those shell subsystems are not in Crow yet and are left out of `WidgetArea` until M2b/M5b.
