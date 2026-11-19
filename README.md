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

## License

Dual-licensed under MIT (`LICENSE-MIT`) or Apache-2.0 (`LICENSE-APACHE`), at your option.
