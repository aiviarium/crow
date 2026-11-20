// Builds Crow's packages and packs them into a static Hatchery registry for Rookery's `rookery`
// target, so a bare `rookery serve` can install Crow onto itself:
//
//   rookery plugin registry add dir ./dist/registry
//   rookery plugin add crow/shell
//   rookery plugin add crow/fleet
//
// A package is a folder with `package.kdl`: `shell/`, whose built page goes in `rookery/web/`, and each
// plugin under `plugins/` that has one, whose client half is bundled into `rookery/client/` and whose
// host half, when it has one, into `rookery/host/`. The registry is written under
// `dist/registry/<group>/<id>/`, in the layout `plugins/` of Rookery's own source has: an egg, its
// `index.json`, its `package.kdl` and `rookery/` folder, and a catalog of every package at the root.
//
// Client halves import `solid-js`, `@aiviarium/nocturne`, `@rookery/sdk/client` and `@rookery/client`
// without bundling them: each import is a lookup in `globalThis.__rookery.modules`, which the shell
// fills before it imports any plugin, so a page has one copy of each. Host halves import
// `@rookery/sdk` the same way, from the extension host's own modules, which is why it stays external.

import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { readFile } from "node:fs/promises"
import { basename, dirname, join } from "node:path"
import { transformAsync } from "@babel/core"
// @ts-expect-error no types
import presetTs from "@babel/preset-typescript"
import Ajv2020 from "ajv/dist/2020"
// @ts-expect-error no types
import presetSolid from "babel-preset-solid"
import type { BunPlugin } from "bun"

const root = join(import.meta.dir, "..")
const out = process.argv.includes("--out")
  ? process.argv[process.argv.indexOf("--out") + 1]!
  : join(root, "dist", "registry")
const stage = join(root, "dist", "pack")

// ---------------------------------------------------------------------------
// The packages
// ---------------------------------------------------------------------------

interface About {
  name?: string
  summary?: string
  licenses: string[]
  repository?: string
  keywords: string[]
}

interface Package {
  /** The folder in the source tree, such as `shell` or `plugins/fleet`. */
  dir: string
  group: string
  id: string
  version: string
  about: About
  requires: Record<string, string>
}

/** A `package.kdl` line with its `//` comment, if any, removed; a `//` inside a quoted value stays. */
function withoutComment(line: string): string {
  let quoted = false
  for (let at = 0; at < line.length; at++) {
    const char = line[at]
    if (char === '"' && line[at - 1] !== "\\") quoted = !quoted
    else if (!quoted && char === "/" && line[at + 1] === "/" && (at === 0 || /\s/.test(line[at - 1]!)))
      return line.slice(0, at)
  }
  return line
}

/**
 * The nodes of a `package.kdl` that this repository writes: `key value…` inside `{ }`, with values
 * quoted or bare. Enough to read the package's own manifest, without a KDL parser.
 */
function parseKdl(text: string): Record<string, unknown> {
  const tree: Record<string, unknown> = {}
  const stack: Array<Record<string, unknown>> = [tree]
  const tokens = text
    .split("\n")
    .map((line) => withoutComment(line).trim())
    .filter(Boolean)
  for (const line of tokens) {
    if (line === "}") {
      stack.pop()
      continue
    }
    if (line.endsWith("{")) {
      const [key] = line.slice(0, -1).trim().split(/\s+/)
      const node: Record<string, unknown> = {}
      const top = stack[stack.length - 1]!
      const many = top[key!]
      if (Array.isArray(many)) many.push(node)
      else top[key!] = node
      stack.push(node)
      continue
    }
    const values = [...line.matchAll(/"([^"]*)"|([^\s"]+)/g)].map((m) => m[1] ?? m[2]!)
    const [key, ...rest] = values
    if (!key) continue
    const top = stack[stack.length - 1]!
    if (rest.length === 0) continue
    const existing = top[key]
    if (existing === undefined) top[key] = rest.length === 1 ? rest[0] : rest
    else if (Array.isArray(existing)) existing.push(...rest)
    else top[key] = [existing, ...rest]
  }
  return tree
}

function readPackage(dir: string): Package {
  const tree = parseKdl(readFileSync(join(root, dir, "package.kdl"), "utf8"))
  const pkg = tree.package as { group: string; id: string; version: string }
  const about = (tree.about ?? {}) as Record<string, string | string[]>
  const one = (value: string | string[] | undefined) => (Array.isArray(value) ? value[0] : value)
  const many = (value: string | string[] | undefined) =>
    value === undefined ? [] : Array.isArray(value) ? value : [value]
  const targets = (tree.targets ?? {}) as Record<string, { requires?: Record<string, string | string[]> }>
  const requires: Record<string, string> = {}
  for (const [fact, value] of Object.entries(targets.rookery?.requires ?? {})) {
    requires[fact] = one(value) ?? ""
  }
  return {
    dir,
    group: pkg.group,
    id: pkg.id,
    version: pkg.version,
    about: {
      name: one(about.name),
      summary: one(about.summary),
      licenses: many(about.license),
      repository: one(about.repository),
      keywords: many(about.keywords),
    },
    requires,
  }
}

const packages = ["shell", ...readdirSync(join(root, "plugins")).map((name) => `plugins/${name}`)]
  .filter((dir) => existsSync(join(root, dir, "package.kdl")))
  .map(readPackage)

// ---------------------------------------------------------------------------
// The manifests
// ---------------------------------------------------------------------------

/**
 * Checks each package's `rookery/plugin.json` against Rookery's schema, and its numbered migrations.
 * A plugin the server would refuse must not reach the registry.
 */
function checkManifests(): void {
  const schemaPath = join(root, ".deps", "rookery", "schemas", "plugin.schema.json")
  if (!existsSync(schemaPath))
    throw new Error(
      `${schemaPath} is missing: run \`bun run sync-deps\` so the pin of Rookery is there to check against`,
    )
  const validate = new Ajv2020({ allErrors: true, strict: false }).compile(
    JSON.parse(readFileSync(schemaPath, "utf8")),
  )
  for (const source of packages) {
    const path = join(root, source.dir, "rookery", "plugin.json")
    if (!existsSync(path)) continue
    const manifest = JSON.parse(readFileSync(path, "utf8"))
    if (!validate(manifest)) {
      const problems = (validate.errors ?? [])
        .map((e) => `${e.instancePath || "/"} ${e.message ?? "is invalid"}`)
        .join("; ")
      throw new Error(`${source.dir}/rookery/plugin.json does not match the plugin schema: ${problems}`)
    }
    const migrations = join(root, source.dir, "rookery", "migrations")
    if (!existsSync(migrations)) continue
    for (const file of readdirSync(migrations)
      .filter((f) => f.endsWith(".json"))
      .sort()) {
      const migration = JSON.parse(readFileSync(join(migrations, file), "utf8"))
      if (!migration || !Array.isArray(migration.steps))
        throw new Error(`${source.dir}/rookery/migrations/${file} has no steps`)
      for (const step of migration.steps)
        if (typeof step?.op !== "string")
          throw new Error(`${source.dir}/rookery/migrations/${file} has a step without an op`)
    }
  }
}

checkManifests()

// ---------------------------------------------------------------------------
// Client halves
// ---------------------------------------------------------------------------

/** The modules the shell provides to plugin bundles through `globalThis.__rookery.modules`. */
const SHARED = [
  "solid-js",
  "solid-js/web",
  "solid-js/store",
  "@aiviarium/nocturne",
  "@rookery/client",
  "@rookery/sdk/client",
] as const

const shared: BunPlugin = {
  name: "crow-shared",
  setup(build) {
    build.onResolve({ filter: /^(solid-js|@aiviarium\/nocturne|@rookery\/(sdk|client))(\/.*)?$/ }, (args) => {
      if ((SHARED as readonly string[]).includes(args.path))
        return { path: args.path, namespace: "crow-shared" }
      if (args.path === "@rookery/sdk")
        throw new Error(
          'client halves import "@rookery/sdk/client", not "@rookery/sdk" (the host half\'s API)',
        )
      throw new Error(`"${args.path}" is not shared with plugins; use one of ${SHARED.join(", ")}`)
    })
    build.onLoad({ filter: /.*/, namespace: "crow-shared" }, (args) => ({
      loader: "js",
      contents: `const m = globalThis.__rookery?.modules?.[${JSON.stringify(args.path)}];
if (!m) throw new Error("Crow: the shell has not provided ${args.path}");
module.exports = m;`,
    }))
  },
}

const solid: BunPlugin = {
  name: "crow-solid",
  setup(build) {
    build.onLoad({ filter: /\.[jt]sx$/ }, async (args) => {
      const source = await readFile(args.path, "utf8")
      const transformed = await transformAsync(source, {
        filename: args.path,
        babelrc: false,
        configFile: false,
        presets: [
          [presetSolid, { generate: "dom", hydratable: false }],
          [presetTs, { isTSX: true, allExtensions: true }],
        ],
      })
      return { contents: transformed?.code ?? "", loader: "js" }
    })
  },
}

/**
 * `import worker from "./x?worker"`, which Vite provides and Bun does not: the module as a module worker
 * of its own, bundled beside the client half, and a factory that starts it. The worker's URL is relative
 * to the client half's entry, which the server serves under the same `client/` folder.
 */
function workers(built: Map<string, string>): BunPlugin {
  return {
    name: "crow-workers",
    setup(build) {
      build.onResolve({ filter: /\?worker$/ }, (args) => {
        const path = Bun.resolveSync(args.path.slice(0, -"?worker".length), args.resolveDir)
        if (!built.has(path)) throw new Error(`${args.path} is not a worker of the plugin that was built`)
        return { path, namespace: "crow-worker" }
      })
      build.onLoad({ filter: /.*/, namespace: "crow-worker" }, (args) => ({
        loader: "js",
        contents: `const url = new URL(${JSON.stringify(built.get(args.path))}, import.meta.url)
export default (options) => new Worker(url, { type: "module", ...options })`,
      }))
    },
  }
}

/** The files of a folder, at any depth. */
function files(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name)
    return entry.isDirectory() ? files(path) : [path]
  })
}

/** The `?worker` modules a plugin's sources import, resolved: each is built before the client half. */
function workerEntries(dir: string): string[] {
  const src = join(root, dir, "src")
  if (!existsSync(src)) return []
  const found = new Set<string>()
  for (const file of files(src)) {
    // A declaration such as `declare module "*?worker"` names no module to build.
    if (!/\.[cm]?[jt]sx?$/.test(file) || file.endsWith(".d.ts")) continue
    for (const match of readFileSync(file, "utf8").matchAll(/["']([^"'\n]+\?worker)["']/g)) {
      try {
        found.add(Bun.resolveSync(match[1]!.slice(0, -"?worker".length), dirname(file)))
      } catch {
        // A pattern rather than a path: the build reports an import that resolves to nothing.
      }
    }
  }
  return [...found]
}

/**
 * Builds each of a plugin's workers into `<outdir>/workers/`, and answers the URL each is served at.
 * They are built before the client half: a build started inside the client build's plugin never finishes.
 */
async function buildWorkers(source: Package, outdir: string): Promise<Map<string, string>> {
  const built = new Map<string, string>()
  for (const entry of workerEntries(source.dir)) {
    const name = basename(entry).replace(/\.[cm]?[jt]sx?$/, "")
    const result = await Bun.build({
      target: "browser",
      format: "esm",
      minify: true,
      sourcemap: "none",
      entrypoints: [entry],
      outdir: join(outdir, "workers"),
      naming: { entry: `${name}-[hash].[ext]`, asset: "[name]-[hash].[ext]" },
      define: { "process.env.NODE_ENV": '"production"' },
      throw: true,
    })
    const file = result.outputs.find((output) => output.kind === "entry-point")
    if (!file) throw new Error(`the worker ${entry} of ${source.id} did not build`)
    built.set(entry, `./workers/${basename(file.path)}`)
  }
  return built
}

/** Bundles a plugin's client half into `<stage>/rookery/client/`, the folder the server serves. */
async function buildClient(source: Package): Promise<void> {
  const entry = join(root, source.dir, "src", "client.tsx")
  if (!existsSync(entry)) return
  const outdir = join(stage, source.dir, "rookery", "client")
  rmSync(outdir, { recursive: true, force: true })
  mkdirSync(outdir, { recursive: true })
  const built = await buildWorkers(source, outdir)
  const result = await Bun.build({
    target: "browser",
    format: "esm",
    minify: true,
    splitting: true,
    sourcemap: "none",
    entrypoints: [entry],
    outdir,
    naming: { entry: "[name].[ext]", chunk: "chunk-[hash].[ext]", asset: "[name]-[hash].[ext]" },
    define: { "process.env.NODE_ENV": '"production"' },
    plugins: [shared, solid, workers(built)],
    throw: true,
  })
  // The server serves the entry as a module whose default is the client: `export default defineClient(...)`.
  const entryOut = result.outputs.find((file) => file.kind === "entry-point")
  const code = entryOut ? await entryOut.text() : ""
  if (!/export\s*\{[^}]*\bdefault\b|export\s+default/.test(code))
    throw new Error(`the client half of ${source.id} must \`export default defineClient(...)\``)
}

/**
 * Bundles a plugin's host half into `<stage>/rookery/host/`, the module the server's extension host
 * imports. `@rookery/sdk` is bundled with it: the plugin's folder has no `node_modules` of its own, and
 * what the host half needs of the SDK is structural, so the extension host activates it all the same.
 */
async function buildHost(source: Package): Promise<void> {
  const iface = join(root, source.dir, "rookery", "interface.ts")
  if (existsSync(iface)) {
    await Bun.build({
      target: "bun",
      format: "esm",
      sourcemap: "none",
      entrypoints: [iface],
      outdir: join(stage, source.dir, "rookery"),
      naming: { entry: "interface.ts" },
      throw: true,
    })
  }
  const entry = join(root, source.dir, "src", "host.ts")
  if (!existsSync(entry)) return
  const outdir = join(stage, source.dir, "rookery", "host")
  rmSync(outdir, { recursive: true, force: true })
  const result = await Bun.build({
    target: "bun",
    format: "esm",
    sourcemap: "none",
    entrypoints: [entry],
    outdir,
    naming: { entry: "[name].[ext]", chunk: "chunk-[hash].[ext]", asset: "[name]-[hash].[ext]" },
    throw: true,
  })
  // The extension host activates the module's default: `export default definePlugin(...)`.
  const entryOut = result.outputs.find((file) => file.kind === "entry-point")
  const code = entryOut ? await entryOut.text() : ""
  if (!/export\s*\{[^}]*\bdefault\b|export\s+default/.test(code))
    throw new Error(`the host half of ${source.id} must \`export default definePlugin(...)\``)
}

/**
 * The manifest names each half and its stylesheet relative to the target's folder, and the build has to
 * have written each of them: Rookery refuses a package that names a file it does not carry, or one whose
 * host half it does not name.
 */
function checkHalves(source: Package): void {
  const manifest = JSON.parse(readFileSync(join(stage, source.dir, "rookery", "plugin.json"), "utf8"))
  const hasHost = existsSync(join(root, source.dir, "src", "host.ts"))
  const namesHost = typeof manifest.host === "string"
  if (hasHost !== namesHost)
    throw new Error(
      hasHost
        ? `${source.dir} has a host half that rookery/plugin.json does not name as its host`
        : `${source.dir}/rookery/plugin.json names a host half the plugin does not have`,
    )
  for (const key of ["host", "client", "styles"]) {
    const named = manifest[key] as string | undefined
    if (named && !existsSync(join(stage, source.dir, "rookery", named)))
      throw new Error(
        `${source.dir}/rookery/plugin.json names ${named} as its ${key}, which the build did not write`,
      )
  }
}

// ---------------------------------------------------------------------------
// The packages' files
// ---------------------------------------------------------------------------

/** Writes the folder an egg is packed from: `package.kdl` and the package's `rookery/` folder. */
async function prepare(source: Package): Promise<string> {
  const dir = join(stage, source.dir)
  rmSync(dir, { recursive: true, force: true })
  mkdirSync(join(dir, "rookery"), { recursive: true })
  cpSync(join(root, source.dir, "package.kdl"), join(dir, "package.kdl"))
  // What the package carries of its own, such as its manifest and guide; the built halves come after.
  for (const entry of readdirSync(join(root, source.dir, "rookery"), { withFileTypes: true })) {
    if (entry.name === "client" || entry.name === "host" || entry.name === "web") continue
    cpSync(join(root, source.dir, "rookery", entry.name), join(dir, "rookery", entry.name), {
      recursive: true,
    })
  }
  if (source.id === "shell") {
    // The shell is the page the server serves, not a client half: its build output goes in `web/`, and
    // `plugin.json` names `web/index.html` as the entry.
    const proc = Bun.spawn(["bun", "run", "build"], {
      cwd: join(root, "shell"),
      stdout: "inherit",
      stderr: "inherit",
    })
    if ((await proc.exited) !== 0) throw new Error("the shell does not build")
    cpSync(join(root, "shell", "dist"), join(dir, "rookery", "web"), { recursive: true })
  } else {
    await buildClient(source)
    await buildHost(source)
    checkHalves(source)
  }
  return dir
}

// ---------------------------------------------------------------------------
// Eggs: a gzipped POSIX ustar archive, as Hatchery writes and reads them
// ---------------------------------------------------------------------------

interface Entry {
  path: string
  data: Uint8Array
}

function walk(dir: string, prefix = ""): Entry[] {
  const out: Entry[] = []
  for (const entry of readdirSync(dir, { withFileTypes: true }).sort((a, b) =>
    a.name.localeCompare(b.name),
  )) {
    const path = join(dir, entry.name)
    if (entry.isDirectory()) out.push(...walk(path, `${prefix}${entry.name}/`))
    else out.push({ path: `${prefix}${entry.name}`, data: new Uint8Array(readFileSync(path)) })
  }
  return out
}

function octal(value: number, width: number): string {
  return `${value.toString(8).padStart(width - 1, "0")}\0`
}

function header(name: string, prefix: string, size: number): Uint8Array {
  const block = new Uint8Array(512)
  const put = (offset: number, text: string) => {
    block.set(new TextEncoder().encode(text).subarray(0, block.length - offset), offset)
  }
  put(0, name)
  put(100, octal(0o644, 8))
  put(108, octal(0, 8))
  put(116, octal(0, 8))
  put(124, octal(size, 12))
  put(136, octal(0, 12))
  block.fill(0x20, 148, 156)
  block[156] = 0x30
  put(257, "ustar\0")
  put(263, "00")
  put(345, prefix)
  let sum = 0
  for (const byte of block) sum += byte
  put(148, `${sum.toString(8).padStart(6, "0")}\0 `)
  return block
}

/** A path as the ustar name and prefix fields; a path that does not fit is refused. */
function split(path: string): { name: string; prefix: string } {
  if (path.length <= 100) return { name: path, prefix: "" }
  for (let at = path.indexOf("/"); at !== -1; at = path.indexOf("/", at + 1)) {
    const prefix = path.slice(0, at)
    const name = path.slice(at + 1)
    if (prefix.length <= 155 && name.length > 0 && name.length <= 100) return { name, prefix }
  }
  throw new Error(`${path} is too long for an egg`)
}

/** The gzipped ustar archive of these entries: sorted by path, no owner, no time, fixed bytes. */
function archive(entries: Entry[]): Uint8Array {
  const parts: Uint8Array[] = []
  for (const entry of [...entries].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))) {
    const { name, prefix } = split(entry.path)
    parts.push(header(name, prefix, entry.data.length), entry.data)
    const rem = entry.data.length % 512
    if (rem) parts.push(new Uint8Array(512 - rem))
  }
  parts.push(new Uint8Array(1024))
  const tar = new Uint8Array(parts.reduce((total, part) => total + part.length, 0))
  let at = 0
  for (const part of parts) {
    tar.set(part, at)
    at += part.length
  }
  return new Uint8Array(Bun.gzipSync(tar))
}

/** The egg's files: `package.kdl` and the target's folder as `<target>/<path>`. */
function eggEntries(dir: string): Entry[] {
  const entries: Entry[] = [
    { path: "package.kdl", data: new Uint8Array(readFileSync(join(dir, "package.kdl"))) },
  ]
  for (const entry of walk(join(dir, "rookery")))
    entries.push({ path: `rookery/${entry.path}`, data: entry.data })
  return entries
}

function sha256(data: Uint8Array): string {
  return new Bun.CryptoHasher("sha256").update(data).digest("hex")
}

/** When the packages were published: the commit's time, so packing the same tree gives the same index. */
function published(): string {
  const epoch = process.env.SOURCE_DATE_EPOCH
  if (epoch) return new Date(Number(epoch) * 1000).toISOString().replace(/\.\d{3}Z$/, "Z")
  const proc = Bun.spawnSync(["git", "log", "-1", "--format=%ct"], { cwd: root })
  const seconds = Number(proc.stdout.toString().trim())
  return new Date((Number.isFinite(seconds) && seconds > 0 ? seconds : Date.now() / 1000) * 1000)
    .toISOString()
    .replace(/\.\d{3}Z$/, "Z")
}

// ---------------------------------------------------------------------------
// The registry
// ---------------------------------------------------------------------------

const when = published()
const catalog: string[] = []

for (const source of packages) {
  const dir = await prepare(source)
  const egg = archive(eggEntries(dir))
  const file = `${source.id}-${source.version}.egg`
  writeFileSync(join(dir, file), egg)
  const index = {
    group: source.group,
    id: source.id,
    about: {
      ...(source.about.name ? { name: source.about.name } : {}),
      ...(source.about.summary ? { summary: source.about.summary } : {}),
      ...(source.about.licenses.length ? { licenses: source.about.licenses } : {}),
      ...(source.about.repository ? { repository: source.about.repository } : {}),
      ...(source.about.keywords.length ? { keywords: source.about.keywords } : {}),
    },
    versions: {
      [source.version]: {
        sha256: sha256(egg),
        published: when,
        targets: { rookery: { requires: source.requires } },
      },
    },
  }
  writeFileSync(join(dir, "index.json"), `${JSON.stringify(index, null, 2)}\n`)

  // The registry's copy: its package folder is the one an egg is installed from.
  const to = join(out, source.group, source.id)
  rmSync(to, { recursive: true, force: true })
  mkdirSync(dirname(to), { recursive: true })
  cpSync(dir, to, { recursive: true })
  catalog.push(`${source.group}/${source.id}`)
  console.log(`[pack] ${source.group}/${source.id}@${source.version} ${bytes(egg.length)}`)
}

catalog.sort()
writeFileSync(join(out, "index.json"), `${JSON.stringify({ packages: catalog }, null, 2)}\n`)
console.log(`[pack] ${out}`)

function bytes(count: number): string {
  return count > 1 << 20 ? `${(count / (1 << 20)).toFixed(1)} MiB` : `${Math.round(count / 1024)} KiB`
}
