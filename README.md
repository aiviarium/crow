# Crow

Crow is the web shell and product plugin workspace built on Rookery (`@rookery/client`, `@rookery/sdk`) and Nocturne (`@aiviarium/nocturne`).

## Quick start

```bash
bun run bootstrap
bun run dev
```

`bun run dev` starts Vite on `http://127.0.0.1:4791` and proxies `/ws`, `/rpc`, `/auth`, `/dev`, `/plugins`, `/blobs`, and `/svc` to `ROOKERY_URL` (default `http://127.0.0.1:4790`).

To build the static shell served by `ROOKERY_SHELL_DIR`:

```bash
bun run build
```

The output lands in `shell/dist/`.

## Packaging

Crow's shell and every plugin under `plugins/` are Hatchery packages with a `rookery` target, so a bare `rookery serve` can install Crow onto itself as plugins.

```bash
bun run pack
```

That builds the shell, each plugin's client half and, where it has one, its host half, and writes a static registry to `dist/registry/`: `index.json`, then `crow/shell/`, `crow/fleet/`, `crow/agents/`, `crow/ai/`, `crow/code/`, `crow/dashboards/`, `crow/docs/`, `crow/projects/`, `crow/terminal/` and `crow/workbench/` with their `package.kdl`, `rookery/` folder, egg and `index.json`. A server installs them from it, or from one egg:

```bash
rookery plugin registry add dir ./dist/registry
rookery plugin add crow/shell
rookery plugin add crow/fleet

# or, as an egg the CLI sends to the server
rookery plugin add ./dist/registry/crow/fleet/fleet-0.1.0.egg
```

The shell is served as the page browsers load (`contributes.shell`), each plugin's client half at `/plugins/ID/HASH/PATH`, and its host half, when it has one, runs in the server's extension host. A packaged shell loads the client halves from `plugins.list`; only `bun run dev` and the tests bundle `plugins/*` into the shell itself.


## License

Dual-licensed under MIT (`LICENSE-MIT`) or Apache-2.0 (`LICENSE-APACHE`), at your option.
