// Solid JSX transform for .tsx, browser build of solid-js, and no-op CSS imports under Bun test.

import { readFileSync } from "node:fs"
import { dirname, resolve } from "node:path"
import { transformAsync } from "@babel/core"
import typescript from "@babel/preset-typescript"
import solid from "babel-preset-solid"
import { plugin } from "bun"

const ROOT_NODE_MODULES = resolve(dirname(import.meta.path), "../../node_modules")

const SOLID_BROWSER_ENTRIES: Record<string, string> = {
  "solid-js": resolve(ROOT_NODE_MODULES, "solid-js/dist/solid.js"),
  "solid-js/web": resolve(ROOT_NODE_MODULES, "solid-js/web/dist/web.js"),
  "solid-js/store": resolve(ROOT_NODE_MODULES, "solid-js/store/dist/store.js"),
}

const SERVER_TO_BROWSER: Array<[RegExp, string, string]> = [
  [/solid-js[\\/]dist[\\/](server|solid)\.js$/, "solid.js", SOLID_BROWSER_ENTRIES["solid-js"]!],
  [/solid-js[\\/]web[\\/]dist[\\/](server|web)\.js$/, "web.js", SOLID_BROWSER_ENTRIES["solid-js/web"]!],
  [
    /solid-js[\\/]store[\\/]dist[\\/](server|store)\.js$/,
    "store.js",
    SOLID_BROWSER_ENTRIES["solid-js/store"]!,
  ],
]

const SHELL_NOCTURNE = resolve(dirname(import.meta.path), "../node_modules/@aiviarium/nocturne/src/index.ts")

plugin({
  name: "solid-crow",
  setup(build) {
    build.onLoad({ filter: /\.css$/ }, () => ({ contents: "", loader: "js" }))
    build.onLoad({ filter: /@aiviarium[\\/]nocturne[\\/]src[\\/]index\.ts$/ }, (args) => {
      if (resolve(args.path) !== SHELL_NOCTURNE) {
        return { contents: `export * from ${JSON.stringify(SHELL_NOCTURNE)};`, loader: "ts" }
      }
      return { contents: readFileSync(SHELL_NOCTURNE, "utf8"), loader: "ts" }
    })
    build.onLoad(
      { filter: /solid-js[\\/](web[\\/]|store[\\/])?dist[\\/](server|solid|web|store)\.js$/ },
      (args) => {
        const hit = SERVER_TO_BROWSER.find(([re]) => re.test(args.path))
        if (!hit) return undefined
        const canonical = hit[2]
        if (resolve(args.path) !== canonical) {
          return { contents: `export * from ${JSON.stringify(canonical)};`, loader: "js" }
        }
        return { contents: readFileSync(canonical, "utf8"), loader: "js" }
      },
    )
    build.onLoad({ filter: /\.tsx$/ }, async (args) => {
      const code = readFileSync(args.path, "utf8")
      const result = await transformAsync(code, {
        filename: args.path,
        presets: [[solid, { generate: "dom", hydratable: false }], typescript],
        babelrc: false,
        configFile: false,
      })
      return { contents: result?.code ?? "", loader: "js" }
    })
  },
})
