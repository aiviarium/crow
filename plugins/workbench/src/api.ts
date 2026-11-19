// The client half's view of Rookery: the workbench's host half for git (host.call), and the host's files
// through env.readFile/writeFile/deleteFile/listDir and env.exec. Commands that may take longer than a
// host handler (search, push, pull, fetch) run with env.exec from here, not through the host half.

import type { DirListing, ExecResult, FileData } from "@rookery/client"
import type { ClientRookery } from "@rookery/sdk/client"
import type { ChangedFile } from "./git/files"
import type { Blame, Commit, CommitDetail, Ref, Stash } from "./git/log"
import type { Match } from "./git/search"
import { replaceIn, type SearchQuery } from "./git/search"
import type { Status } from "./git/status"

export interface WsInfo {
  env: string
  path: string
  root: string
  isRepo: boolean
  gitDir: string | null
  branch: string | null
  tools: Record<string, boolean>
  kind: string
}

export type ReadResult =
  | { kind: "text"; text: string; sha256: string; size: number }
  | { kind: "binary"; sha256: string; size: number; mime: string; base64?: string }
  | { kind: "large"; size: number }

export interface GitStatus extends Status {
  state: "merge" | "rebase" | "cherry-pick" | "revert" | null
}

export type DiffKind = "unstaged" | "staged" | "range" | "worktree"
export interface DiffSpec {
  kind: DiffKind
  base?: string
  head?: string
  paths?: string[]
  context?: number
}

export interface PrProvider {
  id: string
  title: string
  command: string
  available?: string
  order?: number
  plugin: string
}

export interface Assistant {
  id: string
  title: string
  view: string
  icon?: string
  plugin: string
}

const strict = new TextDecoder("utf-8", { fatal: true })

const IMAGE = /\.(png|jpe?g|gif|webp|bmp|ico|svg|avif)$/i
const MIME: Record<string, string> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  bmp: "image/bmp",
  ico: "image/x-icon",
  svg: "image/svg+xml",
  avif: "image/avif",
}

/** Text if it decodes as UTF-8 and has no NUL in its first 8000 bytes. */
function asText(data: Uint8Array): string | null {
  const head = data.subarray(0, 8000)
  if (head.includes(0)) return null
  try {
    return strict.decode(data)
  } catch {
    return null
  }
}

function bytesOf(base64: string): Uint8Array {
  const bin = atob(base64)
  const out = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i)
  return out
}

export function base64Of(data: Uint8Array): string {
  let bin = ""
  for (let i = 0; i < data.length; i += 0x8000) bin += String.fromCharCode(...data.subarray(i, i + 0x8000))
  return btoa(bin)
}

function mimeOf(path: string): string {
  const ext = path.split(".").pop()?.toLowerCase() ?? ""
  return MIME[ext] ?? "application/octet-stream"
}

export interface CommandResult {
  exitCode: number | null
  stdout: string
  stderr: string
  /** The link to the host dropped while it ran. */
  lost: boolean
}

/**
 * Runs a command on the host and waits for it. `env.exec` takes the environment as `env`; its stdin and its
 * deadline are in the wire's `ExecParams` but not in the SDK's type at this pin, so they are passed through.
 */
export async function runCommand(
  rookery: ClientRookery,
  o: {
    env: string
    command: string[]
    cwd?: string
    vars?: Record<string, string>
    stdin?: string
    timeoutMs?: number
  },
): Promise<CommandResult> {
  const r = (await rookery.env.exec(o.env, o.command, {
    ...(o.cwd ? { cwd: o.cwd } : {}),
    ...(o.vars ? { env: o.vars } : {}),
    ...(o.stdin !== undefined ? { stdin: o.stdin } : {}),
    ...(o.timeoutMs ? { timeoutMs: o.timeoutMs } : {}),
  } as never)) as ExecResult
  return {
    exitCode: r.exitCode ?? null,
    stdout: r.stdout,
    stderr: r.stderr,
    lost: !!r.lost,
  }
}

export function createApi(rookery: ClientRookery) {
  const call = <R>(m: string, p: Record<string, unknown> = {}) => rookery.host.call<R>(m, p)

  /** `env.writeFile` as the wire takes it: the bytes in base64, and the version to write over. */
  const writeFile = async (
    env: string,
    path: string,
    data: Uint8Array,
    opts: { ifMatch?: string; overwrite?: boolean } = {},
  ) => {
    const body: Record<string, unknown> = { env, path, base64: base64Of(data) }
    if (opts.ifMatch) body.ifMatch = opts.ifMatch
    else if (opts.overwrite) body.overwrite = true
    return rookery.rpc.call<{ sha256: string; size: number }>("env.writeFile", body)
  }

  const readFile = async (env: string, path: string): Promise<FileData> =>
    (await rookery.rpc.call("env.readFile", { env, path })) as FileData

  const fs = {
    list: (env: string, path: string) => rookery.env.listDir(env, path) as Promise<DirListing>,

    read: async (
      env: string,
      path: string,
      opts: { size?: number; limit?: number; force?: boolean } = {},
    ): Promise<ReadResult> => {
      const limit = opts.limit ?? 5 * 1024 * 1024
      if (opts.size !== undefined && opts.size > limit && !opts.force && !IMAGE.test(path))
        return { kind: "large", size: opts.size }
      const file = await readFile(env, path)
      if (file.size > limit && !opts.force && !IMAGE.test(path)) return { kind: "large", size: file.size }
      const data = bytesOf(file.base64)
      const text = IMAGE.test(path) && !path.endsWith(".svg") ? null : asText(data)
      if (text !== null) return { kind: "text", text, sha256: file.sha256, size: data.byteLength }
      return {
        kind: "binary",
        sha256: file.sha256,
        size: data.byteLength,
        mime: mimeOf(path),
        // Images are shown; other binary files only if asked (for a download).
        ...(IMAGE.test(path) || opts.force ? { base64: file.base64 } : {}),
      }
    },

    write: (
      env: string,
      path: string,
      data: { text?: string; base64?: string },
      opts: { ifMatch?: string; overwrite?: boolean } = {},
    ) =>
      writeFile(
        env,
        path,
        data.text !== undefined ? new TextEncoder().encode(data.text) : bytesOf(data.base64 ?? ""),
        opts,
      ),

    mkdir: async (env: string, path: string) => {
      const r = await runCommand(rookery, { env, command: ["mkdir", "-p", "--", path], timeoutMs: 28_000 })
      if (r.exitCode !== 0) throw new Error(r.stderr.trim() || "mkdir failed")
      return null
    },

    rename: async (env: string, from: string, to: string) => {
      const r = await runCommand(rookery, {
        env,
        command: [
          "sh",
          "-c",
          'if [ -e "$2" ]; then echo "$2 exists" >&2; exit 17; fi; mkdir -p -- "$(dirname -- "$2")" && mv -- "$1" "$2"',
          "sh",
          from,
          to,
        ],
        timeoutMs: 28_000,
      })
      if (r.exitCode === 17) throw Object.assign(new Error(`${to} exists`), { code: "CONFLICT" })
      if (r.exitCode !== 0) throw new Error(r.stderr.trim() || "mv failed")
      return null
    },

    delete: async (env: string, path: string, recursive = false) => {
      // `env.deleteFile` deletes one file; a folder is removed by the host's own `rm`, inside its roots.
      if (!recursive) return rookery.env.deleteFile(env, path)
      const r = await runCommand(rookery, {
        env,
        command: ["rm", "-rf", "--", path],
        timeoutMs: 28_000,
      })
      if (r.exitCode !== 0) throw new Error(r.stderr.trim() || "rm failed")
    },

    versions: async (env: string, paths: string[]): Promise<Record<string, string | null>> => {
      if (!paths.length) return {}
      const r = await runCommand(rookery, { env, command: ["sha256sum", "--", ...paths], timeoutMs: 28_000 })
      const out: Record<string, string | null> = Object.fromEntries(paths.map((p) => [p, null]))
      for (const line of r.stdout.split("\n")) {
        const m = /^\\?([0-9a-f]{64}) [ *](.*)$/.exec(line)
        if (m && m[2]! in out) out[m[2]!] = m[1]!
      }
      return out
    },
  }

  const git = {
    status: (env: string, root: string, gitDir?: string | null) =>
      call<GitStatus>("git.status", { env, root, ...(gitDir ? { gitDir } : {}) }),
    lsFiles: async (env: string, root: string) =>
      (await call<{ files: string[] }>("git.lsFiles", { env, root })).files,
    diff: async (env: string, root: string, spec: DiffSpec) =>
      (await call<{ patch: string }>("git.diff", { env, root, ...spec })).patch,
    diffFiles: async (env: string, root: string, spec: DiffSpec) =>
      (await call<{ files: ChangedFile[] }>("git.diffFiles", { env, root, ...spec })).files,
    show: (env: string, root: string, ref: string, path: string) =>
      call<{ missing: boolean; binary: boolean; text: string | null }>("git.show", {
        env,
        root,
        ref,
        path,
      }),
    apply: (env: string, root: string, patch: string, opts: { cached?: boolean; reverse?: boolean }) =>
      call("git.apply", { env, root, patch, ...opts }),
    stage: (env: string, root: string, paths: string[]) => call("git.stage", { env, root, paths }),
    unstage: (env: string, root: string, paths: string[]) => call("git.unstage", { env, root, paths }),
    discard: (env: string, root: string, paths: string[], untracked: string[] = []) =>
      call("git.discard", { env, root, paths, untracked }),
    commit: (
      env: string,
      root: string,
      o: { message: string; amend?: boolean; signoff?: boolean; all?: boolean },
    ) => call<{ sha: string }>("git.commit", { env, root, ...o }),
    lastMessage: async (env: string, root: string) =>
      (await call<{ message: string }>("git.lastMessage", { env, root })).message,
    refs: (env: string, root: string) => call<{ refs: Ref[]; remotes: string[] }>("git.refs", { env, root }),
    branch: (
      env: string,
      root: string,
      o: {
        op: string
        name: string
        newName?: string
        start?: string
        upstream?: string
        force?: boolean
        checkout?: boolean
      },
    ) => call<{ name: string }>("git.branch", { env, root, ...o }),
    tag: (
      env: string,
      root: string,
      o: { op: "create" | "delete"; name: string; ref?: string; message?: string },
    ) => call("git.tag", { env, root, ...o }),
    stash: (
      env: string,
      root: string,
      o: {
        op: "list" | "push" | "pop" | "apply" | "drop"
        ref?: string
        message?: string
        untracked?: boolean
      },
    ) => call<{ stashes: Stash[] | null }>("git.stash", { env, root, ...o }),
    integrate: (
      env: string,
      root: string,
      o: {
        op: "merge" | "rebase" | "cherry-pick" | "revert"
        action: "start" | "continue" | "abort" | "skip"
        ref?: string
      },
    ) => call<{ conflicts: boolean; output: string }>("git.integrate", { env, root, ...o }),
    mergeBase: async (env: string, root: string, a: string, b: string) =>
      (await call<{ sha: string | null }>("git.mergeBase", { env, root, a, b })).sha,
    resolve: async (env: string, root: string, path: string, text: string) => {
      await fs.write(env, `${root.replace(/\/$/, "")}/${path}`, { text }, { overwrite: true })
      await git.stage(env, root, [path])
    },
    log: async (
      env: string,
      root: string,
      o: {
        ref?: string
        all?: boolean
        path?: string
        follow?: boolean
        skip?: number
        limit?: number
        range?: string
      } = {},
    ) => (await call<{ commits: Commit[] }>("git.log", { env, root, ...o })).commits,
    commitInfo: (env: string, root: string, sha: string) =>
      call<{ commit: CommitDetail; files: ChangedFile[] }>("git.commitInfo", { env, root, sha }),
    blame: (env: string, root: string, path: string, ref?: string) =>
      call<Blame>("git.blame", { env, root, path, ...(ref ? { ref } : {}) }),
  }

  const search = {
    /**
     * Runs ripgrep (`rg --json`), or `git grep -z` on a host without it, and returns its raw output for the
     * parsers in `git/search.ts`. `env.process` would stream it; `env.exec` returns it at the end.
     */
    run: async (
      env: string,
      root: string,
      command: string[],
    ): Promise<{ exitCode: number | null; stdout: string; stderr: string }> => {
      const r = await runCommand(rookery, { env, command, cwd: root, timeoutMs: 120_000 })
      return { exitCode: r.exitCode, stdout: r.stdout, stderr: r.stderr }
    },
  }

  const replace = async (
    env: string,
    root: string,
    query: SearchQuery,
    replacement: string,
    files: Array<{ path: string; matches?: Match[] }>,
    preview: boolean,
  ) => {
    const results: Array<{
      path: string
      count: number
      before?: string
      after?: string
      error?: string
      conflict?: boolean
    }> = []
    for (const f of files) {
      const abs = `${root.replace(/\/$/, "")}/${f.path}`
      try {
        const file = await readFile(env, abs)
        const text = asText(bytesOf(file.base64))
        if (text === null) {
          results.push({ path: f.path, count: 0, error: "binary" })
          continue
        }
        const r = replaceIn(text, query, replacement, f.matches)
        if (preview) results.push({ path: f.path, count: r.count, before: text, after: r.text })
        else {
          if (r.count) await fs.write(env, abs, { text: r.text }, { ifMatch: file.sha256 })
          results.push({ path: f.path, count: r.count })
        }
      } catch (err) {
        results.push({
          path: f.path,
          count: 0,
          error: (err as Error).message,
          conflict: (err as { code?: string } | null)?.code === "CONFLICT",
        })
      }
    }
    return { results }
  }

  return {
    info: (env: string, path: string) => call<WsInfo>("ws.info", { env, path }),
    fs,
    replace,
    git,
    search,
    prProviders: async () => (await call<{ providers: PrProvider[] }>("pr.providers")).providers,
    assistants: async () => (await call<{ assistants: Assistant[] }>("assistants")).assistants,
    /** The workbench's URL for a file: the route the `workbench.file` view is mounted at. */
    link: (env: string, path: string) => {
      const id = `${env.replace(/^env:\/\//, "")}${path.startsWith("/") ? path : `/${path}`}`
      return {
        uri: `code://${id}`,
        href: `/workbench/file/${id.split("/").map(encodeURIComponent).join("/")}`,
      }
    },
    /** The workbench's URL for a commit: the route the `workbench.commit` view is mounted at. */
    commitLink: (env: string, path: string, sha: string) => {
      const id = `${env.replace(/^env:\/\//, "")}${path.startsWith("/") ? path : `/${path}`}@${sha}`
      return {
        uri: `commit://${id}`,
        href: `/workbench/commit/${id.split("/").map(encodeURIComponent).join("/")}`,
      }
    },
  }
}

export type Api = ReturnType<typeof createApi>
