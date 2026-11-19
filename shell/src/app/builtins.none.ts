// The production stand-in for `./builtins`: a packaged shell loads every plugin the Rookery server
// serves, so it has none of `crow/plugins` in its bundle. `vite.config.ts` points `./builtins` here
// for a build; `bun run dev` and the tests use the real one.
import type { Connection } from "@rookery/client"

/** The connection as it is: the server's `plugins.list` is the only list. */
export function withBuiltinPlugins(conn: Connection): Connection {
  return conn
}

/** The importer as it is: `createPluginLoader`'s own dynamic `import()`. */
export function withBuiltinImporter(
  fallback?: (url: string) => Promise<{ default?: unknown }>,
): (url: string) => Promise<{ default?: unknown }> {
  return fallback ?? ((url: string) => import(/* @vite-ignore */ url))
}
