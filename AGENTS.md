# Working on Crow

Crow is the web shell and first-party plugin workspace built on Rookery (`@rookery/client`, `@rookery/sdk`) and Nocturne (`@aiviarium/nocturne`). Bun runs everything.

## Layout

| Path | What it is |
| --- | --- |
| `shell/` | `@crow/shell`: the SolidJS web shell built with Nocturne components over `@rookery/client`. `src/auth/` has sign-in and the account menu. `src/app/` has chrome, routing, navigation, status bar, connection status, home and plugin view hosting. `test/` has Bun tests against an in-process fake Rookery server |
| `plugins/` | Workspace folder for Crow's plugins (empty until plugins land) |
| `deps.json` | Commit pins for cross-repo TypeScript dependencies (`rookery` and `nocturne`) |
| `scripts/sync-deps.ts` | Populates `.deps/` from local sibling checkouts inside `aiviarium/mono` or from pinned commits in `deps.json` standalone and in CI |

## Cross-repo dependencies

Crow depends on TypeScript source packages from two sibling repositories: `@rookery/client` and `@rookery/sdk` from `aiviarium/rookery`, and `@aiviarium/nocturne` from `aiviarium/nocturne`.

`shell/package.json` references those packages under `.deps/` (`file:../.deps/rookery/client`, `file:../.deps/rookery/sdk`, `file:../.deps/nocturne`). Run `bun run sync-deps` (or `bun run bootstrap`) before `bun install`:

- Inside `aiviarium/mono`, when `../rookery` and `../nocturne` exist, `scripts/sync-deps.ts` symlinks `.deps/rookery` and `.deps/nocturne` to the sibling checkouts so local edits apply immediately.
- Outside `mono`, in CI (`CI=true`), or when `CROW_USE_PINS=1` is set, `scripts/sync-deps.ts` shallow-fetches the exact commit SHA recorded in `deps.json` into `.deps/<name>`.

When updating a pinned upstream commit, update the `commit` and `ref` fields in `deps.json`, run `CROW_USE_PINS=1 bun run bootstrap && bun run check`, and commit `deps.json` and `bun.lock`.

## Build and check

```bash
bun run bootstrap     # sync .deps/ and install packages
bun run lint          # Biome check on shell/ and scripts/
bun run typecheck     # tsc --noEmit on shell/
bun run test          # Bun tests (happy-dom + SolidJS transform)
bun run build         # static Vite bundle into shell/dist/ for ROOKERY_SHELL_DIR
bun run check         # lint + typecheck + test + build
```

For interactive development against `rookery serve`:

```bash
ROOKERY_URL=http://127.0.0.1:4790 bun run dev
```

Vite listens on `http://127.0.0.1:4791` (override with `CROW_VITE_PORT`) and proxies `/ws`, `/rpc`, `/auth`, `/dev`, `/plugins`, `/blobs`, and `/svc` to `ROOKERY_URL`.

## Conventions

- Build UI from `@aiviarium/nocturne` components and Nocturne CSS tokens (`var(--bg-0)`, `var(--space-*)`, `nc-*`). Do not duplicate design tokens or fork UI primitives into `shell/`.
- Keep protocol, auth helper, plugin loading, and SolidJS data/stream logic in `@rookery/client`; keep `shell/` focused on UI, navigation, and chrome.
- Commits follow Conventional Commits (`feat(shell): ...`, `fix(auth): ...`, `ci: ...`) with short subjects. Add an `Assisted-by: <tool>:<model>` trailer when an AI coding tool assisted, and no `Co-Authored-By` trailers.
- Tests use made-up users, hosts, keys, and addresses (`example.test`, `127.0.0.1`). Secrets never go into argv, logs, or the repository.
