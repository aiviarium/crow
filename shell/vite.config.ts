import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { defineConfig } from "vite"
import solid from "vite-plugin-solid"

const port = Number(process.env.CROW_VITE_PORT ?? 4791)
const backend = process.env.ROOKERY_URL ?? "http://127.0.0.1:4790"

export default defineConfig(({ command }) => ({
  plugins: [solid()],
  resolve: {
    // A packaged shell loads the plugins the server serves, so none of `crow/plugins` is bundled: the
    // built-in seam (dev and tests) is replaced by one that adds nothing.
    alias:
      command === "build"
        ? [
            {
              find: /^\.\/builtins$/,
              replacement: join(dirname(fileURLToPath(import.meta.url)), "src", "app", "builtins.none.ts"),
            },
          ]
        : [],
    dedupe: [
      "solid-js",
      "solid-js/web",
      "solid-js/store",
      "@aiviarium/nocturne",
      "@rookery/client",
      "@rookery/sdk",
    ],
  },
  server: {
    host: "127.0.0.1",
    port,
    strictPort: true,
    proxy: {
      "/ws": { target: backend, ws: true },
      "/rpc": { target: backend },
      "/auth": { target: backend },
      "/dev": { target: backend },
      "/plugins": { target: backend },
      "/blobs": { target: backend },
      "/svc": { target: backend },
    },
  },
  build: {
    target: "es2022",
    outDir: "dist",
    emptyOutDir: true,
  },
}))
