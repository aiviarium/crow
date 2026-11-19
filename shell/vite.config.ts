import { defineConfig, type Plugin } from "vite"
import solid from "vite-plugin-solid"

const port = Number(process.env.CROW_VITE_PORT ?? 4791)
const backend = process.env.ROOKERY_URL ?? "http://127.0.0.1:4790"

// `@aiviarium/parrot-client` imports `node:child_process` and `node:readline` from `./stdio.ts`
// even when only `Client` + a browser `Transport` are used. Stub `stdio.ts` in browser builds
// until `@aiviarium/parrot-client` splits its Node-only entrypoint (see plugins/agents/API.md).
const parrotBrowserStub: Plugin = {
  name: "crow-parrot-browser-stub",
  enforce: "pre",
  resolveId(source, importer) {
    if ((source === "./stdio" || source === "./stdio.ts") && importer?.includes("parrot-client")) {
      return "\0parrot-stdio-stub"
    }
    return null
  },
  load(id) {
    if (id === "\0parrot-stdio-stub") {
      return `export function stdioTransport() { throw new Error("stdioTransport is not available in the browser"); }\n`
    }
    return null
  },
}

export default defineConfig({
  plugins: [parrotBrowserStub, solid()],
  resolve: {
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
})
