// The workbench's host half: git on a host, for the client half. Everything runs as the user who asked
// (their ctx), through rookery.env.exec, as processes with machine-readable output (porcelain v2, -z,
// explicit format strings). Files go through Rookery's env file methods from the client half itself, and
// search, push, pull and fetch run with env.exec from there too: a handler has 30 seconds.
import { type Ctx, definePlugin, type Rookery, RookeryError, z } from "@rookery/sdk"
import { parseFileList, sanitizeBranch } from "./git/files"
import {
  COMMIT_FORMAT,
  LOG_FORMAT,
  parseBlame,
  parseCommit,
  parseLog,
  parseRefs,
  parseStashes,
  REF_FORMAT,
  STASH_FORMAT,
} from "./git/log"
import { parseStatus } from "./git/status"

/** What a git run adds to `env.exec`: variables for the command, and an exit code it accepts as an answer. */
interface GitOptions {
  cwd?: string
  env?: Record<string, string>
  stdin?: string
  timeoutMs?: number
}

const Where = { env: z.string(), root: z.string() }

export default definePlugin((rookery: Rookery) => {
  /** Runs git in `root`; a failure is an error with git's own message. */
  async function git(
    ctx: Ctx,
    env: string,
    root: string,
    args: string[],
    opts: GitOptions & { ok?: number[] } = {},
  ) {
    const r = await rookery.env.exec(
      ctx,
      env,
      ["git", "-c", "core.quotePath=false", "-c", "color.ui=false", ...args],
      {
        cwd: root,
        env: { GIT_TERMINAL_PROMPT: "0", GIT_OPTIONAL_LOCKS: "0", LC_ALL: "C", ...opts.env },
        ...(opts.stdin !== undefined ? { stdin: opts.stdin } : {}),
        timeoutMs: opts.timeoutMs ?? 28_000,
      },
    )
    if (r.lost) throw new RookeryError("UNAVAILABLE", `git ${args[0]} was lost on ${env}`)
    if (r.exitCode !== 0 && !(opts.ok ?? []).includes(r.exitCode ?? -1)) {
      const msg = (r.stderr || r.stdout).trim() || `exited ${r.exitCode}`
      throw new RookeryError("INVALID", msg, { git: args[0], exitCode: r.exitCode, stderr: r.stderr })
    }
    return r
  }

  const rpc = <S extends z.ZodRawShape>(
    name: string,
    shape: S,
    run: (ctx: Ctx, p: z.infer<z.ZodObject<S>>) => unknown,
  ) => rookery.rpc.handle(name, { level: "own", params: z.object(shape), run: run as never })

  // ── Workspace ────────────────────────────────────────────────────────────────────────────────────

  rpc("ws.info", { env: z.string(), path: z.string() }, async (ctx, { env, path }) => {
    const e = await rookery.env.get(ctx, env)
    const r = await rookery.env.exec(
      ctx,
      env,
      [
        "sh",
        "-c",
        'cd "$1" || exit 3; git rev-parse --show-toplevel --absolute-git-dir --abbrev-ref HEAD 2>/dev/null; echo "--"; for t in rg gh sha256sum; do command -v "$t" >/dev/null 2>&1 && echo "$t"; done; exit 0',
        "sh",
        path,
      ],
      { timeoutMs: 28_000 },
    )
    if (r.exitCode === 3) throw new RookeryError("NOT_FOUND", `${path} does not exist on ${env}`)
    const [gitOut = "", tools = ""] = r.stdout.split("--\n")
    const [root, gitDir, branch] = gitOut.split("\n").filter(Boolean)
    return {
      env: e.name,
      path,
      root: root ?? path,
      isRepo: !!root,
      gitDir: gitDir ?? null,
      branch: branch && branch !== "HEAD" ? branch : null,
      tools: Object.fromEntries(
        tools
          .split("\n")
          .filter(Boolean)
          .map((t) => [t, true]),
      ),
      kind: e.kind,
    }
  })

  // ── Git: status, files, contents ─────────────────────────────────────────────────────────────────

  rpc("git.status", { ...Where, gitDir: z.string().optional() }, async (ctx, { env, root, gitDir }) => {
    const [status, dir] = await Promise.all([
      git(ctx, env, root, [
        "status",
        "--porcelain=v2",
        "-z",
        "--branch",
        "--show-stash",
        "--ignored=traditional",
        "--untracked-files=normal",
      ]),
      gitDir ? rookery.env.listDir(ctx, env, gitDir).catch(() => null) : Promise.resolve(null),
    ])
    const names = new Set((dir?.entries ?? []).map((x) => x.name))
    const state =
      names.has("rebase-merge") || names.has("rebase-apply")
        ? "rebase"
        : names.has("MERGE_HEAD")
          ? "merge"
          : names.has("CHERRY_PICK_HEAD")
            ? "cherry-pick"
            : names.has("REVERT_HEAD")
              ? "revert"
              : null
    return { ...parseStatus(status.stdout), state }
  })

  rpc("git.lsFiles", Where, async (ctx, { env, root }) => {
    const r = await git(ctx, env, root, ["ls-files", "-z", "--cached", "--others", "--exclude-standard"])
    return { files: [...new Set(r.stdout.split("\0").filter(Boolean))] }
  })

  /** The arguments for one kind of diff. */
  function diffArgs(p: {
    kind: string
    base?: string
    head?: string
    paths?: string[]
    context?: number
  }): string[] {
    const args = ["diff", "--no-color", "--no-ext-diff", "-M", `-U${p.context ?? 3}`]
    if (p.kind === "staged") args.push("--cached")
    else if (p.kind === "range") {
      if (!p.base) throw new RookeryError("INVALID", "a range needs a base")
      args.push(p.base, p.head ?? "HEAD")
    } else if (p.kind === "worktree") args.push(p.base ?? "HEAD")
    else if (p.kind !== "unstaged") throw new RookeryError("INVALID", `no diff kind ${p.kind}`)
    args.push("--", ...(p.paths ?? []))
    return args
  }
  const DiffSpec = {
    ...Where,
    kind: z.enum(["unstaged", "staged", "range", "worktree"]),
    base: z.string().optional(),
    head: z.string().optional(),
    paths: z.array(z.string()).optional(),
    context: z.number().optional(),
  }

  rpc("git.diff", DiffSpec, async (ctx, p) => {
    const r = await git(ctx, p.env, p.root, diffArgs(p))
    return { patch: r.stdout }
  })

  /** The files a diff touches, with counts, without their patches. */
  rpc("git.diffFiles", DiffSpec, async (ctx, p) => {
    const base = diffArgs(p)
    const at = base.indexOf("--")
    const [numstat, names] = await Promise.all([
      git(ctx, p.env, p.root, [...base.slice(0, at), "--numstat", "-z", ...base.slice(at)]),
      git(ctx, p.env, p.root, [...base.slice(0, at), "--name-status", "-z", ...base.slice(at)]),
    ])
    let files = parseFileList(numstat.stdout, names.stdout)
    if (p.kind === "unstaged" && !p.paths?.length) {
      // Untracked files are part of what is not staged.
      const u = await git(ctx, p.env, p.root, ["ls-files", "-z", "--others", "--exclude-standard"])
      const extra = u.stdout.split("\0").filter(Boolean)
      files = [
        ...files,
        ...extra.map((path) => ({
          path,
          status: "untracked" as const,
          added: 0,
          removed: 0,
          binary: false,
        })),
      ]
    }
    return { files }
  })

  /** A file at a revision: `HEAD`, a sha, `:` (the index) or `:1:` to `:3:` (merge stages). */
  rpc("git.show", { ...Where, ref: z.string(), path: z.string() }, async (ctx, { env, root, ref, path }) => {
    const spec = ref.startsWith(":") ? `${ref === ":" ? ":" : ref}${path}` : `${ref}:${path}`
    const r = await rookery.env.exec(ctx, env, ["git", "-c", "core.quotePath=false", "show", spec], {
      cwd: root,
      env: { GIT_OPTIONAL_LOCKS: "0" },
      timeoutMs: 28_000,
    })
    if (r.exitCode !== 0) return { missing: true, text: null, binary: false }
    const binary = r.stdout.slice(0, 8000).includes("\0") || r.stdout.includes("�")
    return { missing: false, binary, text: binary ? null : r.stdout }
  })

  // ── Git: changing the index and the working tree ─────────────────────────────────────────────────

  rpc(
    "git.apply",
    { ...Where, patch: z.string(), cached: z.boolean().default(false), reverse: z.boolean().default(false) },
    async (ctx, p) => {
      const args = ["apply", "--whitespace=nowarn", "--recount"]
      if (p.cached) args.push("--cached")
      if (p.reverse) args.push("-R")
      args.push("-")
      await git(ctx, p.env, p.root, args, { stdin: p.patch })
      return null
    },
  )

  rpc("git.stage", { ...Where, paths: z.array(z.string()) }, async (ctx, { env, root, paths }) => {
    await git(ctx, env, root, ["add", "-A", "--", ...(paths.length ? paths : ["."])])
    return null
  })

  rpc("git.unstage", { ...Where, paths: z.array(z.string()) }, async (ctx, { env, root, paths }) => {
    const head = await git(ctx, env, root, ["rev-parse", "--verify", "-q", "HEAD"], { ok: [1] })
    const list = paths.length ? paths : ["."]
    if (head.exitCode !== 0) await git(ctx, env, root, ["rm", "--cached", "-r", "-q", "--", ...list])
    else await git(ctx, env, root, ["restore", "--staged", "--", ...list])
    return null
  })

  rpc(
    "git.discard",
    { ...Where, paths: z.array(z.string()), untracked: z.array(z.string()).default([]) },
    async (ctx, p) => {
      if (p.paths.length) await git(ctx, p.env, p.root, ["restore", "--worktree", "--", ...p.paths])
      if (p.untracked.length) await git(ctx, p.env, p.root, ["clean", "-f", "-d", "-q", "--", ...p.untracked])
      return null
    },
  )

  rpc(
    "git.commit",
    {
      ...Where,
      message: z.string(),
      amend: z.boolean().default(false),
      signoff: z.boolean().default(false),
      all: z.boolean().default(false),
      allowEmpty: z.boolean().default(false),
    },
    async (ctx, p) => {
      if (!p.message.trim() && !p.amend) throw new RookeryError("INVALID", "a commit needs a message")
      const args = ["commit", "--cleanup=strip"]
      if (p.message.trim()) args.push("-F", "-")
      else args.push("--no-edit")
      if (p.amend) args.push("--amend")
      if (p.signoff) args.push("--signoff")
      if (p.all) args.push("-a")
      if (p.allowEmpty) args.push("--allow-empty")
      // Commit as the person, unless the host's git already knows who is committing.
      const who = await git(ctx, p.env, p.root, ["config", "user.email"], { ok: [1] })
      const vars: Record<string, string> = {}
      if (!who.stdout.trim() && ctx.user?.email) {
        vars.GIT_AUTHOR_NAME = vars.GIT_COMMITTER_NAME = ctx.user.name
        vars.GIT_AUTHOR_EMAIL = vars.GIT_COMMITTER_EMAIL = ctx.user.email
      }
      await git(ctx, p.env, p.root, args, { stdin: p.message, env: vars })
      const sha = await git(ctx, p.env, p.root, ["rev-parse", "HEAD"])
      return { sha: sha.stdout.trim() }
    },
  )

  rpc("git.lastMessage", Where, async (ctx, { env, root }) => {
    const r = await git(ctx, env, root, ["log", "-1", "--format=%B"], { ok: [128] })
    return { message: r.exitCode === 0 ? r.stdout.replace(/\n+$/, "") : "" }
  })

  // ── Git: branches, tags, stashes, merges ─────────────────────────────────────────────────────────

  rpc("git.refs", Where, async (ctx, { env, root }) => {
    const [refs, remotes] = await Promise.all([
      git(ctx, env, root, [
        "for-each-ref",
        `--format=${REF_FORMAT}`,
        "--sort=-creatordate",
        "refs/heads",
        "refs/remotes",
        "refs/tags",
      ]),
      git(ctx, env, root, ["remote"]),
    ])
    return { refs: parseRefs(refs.stdout), remotes: remotes.stdout.split("\n").filter(Boolean) }
  })

  rpc(
    "git.branch",
    {
      ...Where,
      op: z.enum(["create", "switch", "delete", "rename", "setUpstream", "unsetUpstream"]),
      name: z.string(),
      newName: z.string().optional(),
      start: z.string().optional(),
      upstream: z.string().optional(),
      force: z.boolean().default(false),
      checkout: z.boolean().default(true),
    },
    async (ctx, p) => {
      const name = p.op === "switch" || p.op === "delete" ? p.name : sanitizeBranch(p.name)
      switch (p.op) {
        case "create":
          if (p.checkout) await git(ctx, p.env, p.root, ["switch", "-c", name, ...(p.start ? [p.start] : [])])
          else await git(ctx, p.env, p.root, ["branch", name, ...(p.start ? [p.start] : [])])
          break
        case "switch": {
          // A remote branch becomes a local one tracking it.
          const remote = await git(
            ctx,
            p.env,
            p.root,
            ["show-ref", "--verify", "-q", `refs/remotes/${name}`],
            { ok: [1] },
          )
          if (remote.exitCode === 0) {
            const local = name.split("/").slice(1).join("/")
            const exists = await git(
              ctx,
              p.env,
              p.root,
              ["show-ref", "--verify", "-q", `refs/heads/${local}`],
              { ok: [1] },
            )
            await git(
              ctx,
              p.env,
              p.root,
              exists.exitCode === 0 ? ["switch", local] : ["switch", "--track", name],
            )
          } else await git(ctx, p.env, p.root, ["switch", name])
          break
        }
        case "delete":
          await git(ctx, p.env, p.root, ["branch", p.force ? "-D" : "-d", name])
          break
        case "rename":
          if (!p.newName) throw new RookeryError("INVALID", "a new name is needed")
          await git(ctx, p.env, p.root, ["branch", "-m", name, sanitizeBranch(p.newName)])
          break
        case "setUpstream":
          if (!p.upstream) throw new RookeryError("INVALID", "an upstream is needed")
          await git(ctx, p.env, p.root, ["branch", `--set-upstream-to=${p.upstream}`, name])
          break
        case "unsetUpstream":
          await git(ctx, p.env, p.root, ["branch", "--unset-upstream", name])
          break
      }
      return { name }
    },
  )

  rpc(
    "git.tag",
    {
      ...Where,
      op: z.enum(["create", "delete"]),
      name: z.string(),
      ref: z.string().optional(),
      message: z.string().optional(),
    },
    async (ctx, p) => {
      if (p.op === "create") {
        const args = ["tag"]
        if (p.message) args.push("-a", "-F", "-")
        args.push(sanitizeBranch(p.name), ...(p.ref ? [p.ref] : []))
        await git(ctx, p.env, p.root, args, { stdin: p.message })
      } else await git(ctx, p.env, p.root, ["tag", "-d", p.name])
      return null
    },
  )

  rpc(
    "git.stash",
    {
      ...Where,
      op: z.enum(["list", "push", "pop", "apply", "drop"]),
      ref: z.string().optional(),
      message: z.string().optional(),
      untracked: z.boolean().default(true),
    },
    async (ctx, p) => {
      if (p.op === "list") {
        const r = await git(ctx, p.env, p.root, ["stash", "list", `--format=${STASH_FORMAT}`])
        return { stashes: parseStashes(r.stdout) }
      }
      if (p.op === "push") {
        const args = ["stash", "push"]
        if (p.untracked) args.push("--include-untracked")
        if (p.message) args.push("-m", p.message)
        await git(ctx, p.env, p.root, args)
      } else await git(ctx, p.env, p.root, ["stash", p.op, ...(p.ref ? [p.ref] : [])])
      return { stashes: null }
    },
  )

  /** Merge, rebase, cherry-pick: start, continue, abort. Conflicts are an answer, not an error. */
  rpc(
    "git.integrate",
    {
      ...Where,
      op: z.enum(["merge", "rebase", "cherry-pick", "revert"]),
      action: z.enum(["start", "continue", "abort", "skip"]),
      ref: z.string().optional(),
    },
    async (ctx, p) => {
      const args: string[] = [p.op]
      if (p.action === "start") {
        if (!p.ref) throw new RookeryError("INVALID", `${p.op} needs a ref`)
        if (p.op === "merge") args.push("--no-edit")
        args.push(p.ref)
      } else args.push(`--${p.action}`)
      const vars: Record<string, string> = { GIT_EDITOR: "true" }
      const who = await git(ctx, p.env, p.root, ["config", "user.email"], { ok: [1] })
      if (!who.stdout.trim() && ctx.user?.email) {
        vars.GIT_AUTHOR_NAME = vars.GIT_COMMITTER_NAME = ctx.user.name
        vars.GIT_AUTHOR_EMAIL = vars.GIT_COMMITTER_EMAIL = ctx.user.email
      }
      const r = await git(ctx, p.env, p.root, args, { ok: [1], env: vars })
      return { conflicts: r.exitCode !== 0, output: `${r.stdout}${r.stderr}`.trim() }
    },
  )

  rpc("git.mergeBase", { ...Where, a: z.string(), b: z.string() }, async (ctx, p) => {
    const r = await git(ctx, p.env, p.root, ["merge-base", p.a, p.b], { ok: [1] })
    return { sha: r.stdout.trim() || null }
  })

  // ── Git: history and blame ───────────────────────────────────────────────────────────────────────

  rpc(
    "git.log",
    {
      ...Where,
      ref: z.string().optional(),
      all: z.boolean().default(false),
      path: z.string().optional(),
      follow: z.boolean().default(false),
      skip: z.number().default(0),
      limit: z.number().max(2000).default(300),
      range: z.string().optional(),
    },
    async (ctx, p) => {
      const args = ["log", "--topo-order", `--format=${LOG_FORMAT}`, `--skip=${p.skip}`, `-n${p.limit}`]
      if (p.all) args.push("--all")
      if (p.range) args.push(p.range)
      else if (p.ref) args.push(p.ref)
      if (p.path) {
        if (p.follow) args.push("--follow")
        args.push("--", p.path)
      }
      const r = await git(ctx, p.env, p.root, args, { ok: [128] })
      return { commits: r.exitCode === 0 ? parseLog(r.stdout) : [] }
    },
  )

  rpc("git.commitInfo", { ...Where, sha: z.string() }, async (ctx, p) => {
    const [show, numstat, names] = await Promise.all([
      git(ctx, p.env, p.root, ["show", "-s", `--format=${COMMIT_FORMAT}`, p.sha]),
      git(ctx, p.env, p.root, ["show", "--format=", "--numstat", "-z", "-M", "--first-parent", p.sha]),
      git(ctx, p.env, p.root, ["show", "--format=", "--name-status", "-z", "-M", "--first-parent", p.sha]),
    ])
    const commit = parseCommit(show.stdout)
    if (!commit) throw new RookeryError("NOT_FOUND", `no commit ${p.sha}`)
    return { commit, files: parseFileList(numstat.stdout, names.stdout) }
  })

  rpc("git.blame", { ...Where, path: z.string(), ref: z.string().optional() }, async (ctx, p) => {
    const r = await git(ctx, p.env, p.root, ["blame", "--porcelain", ...(p.ref ? [p.ref] : []), "--", p.path])
    return parseBlame(r.stdout)
  })

  // ── Pull requests ────────────────────────────────────────────────────────────────────────────────

  rpc("pr.providers", {}, async () => {
    const list = await rookery.extensions.list("workbench.pullRequestProviders")
    return {
      providers: list
        .map((c) => ({ ...(c.value as Record<string, unknown>), plugin: c.plugin }))
        .sort(
          (a, b) =>
            Number((a as Record<string, unknown>).order ?? 0) -
            Number((b as Record<string, unknown>).order ?? 0),
        ),
    }
  })

  rpc("assistants", {}, async () => {
    const list = await rookery.extensions.list("workbench.assistant")
    return {
      assistants: list
        .map((c) => ({ ...(c.value as Record<string, unknown>), plugin: c.plugin }))
        .sort(
          (a, b) =>
            Number((a as Record<string, unknown>).order ?? 0) -
            Number((b as Record<string, unknown>).order ?? 0),
        ),
    }
  })

  const PrParams = z.object({
    env: z.string(),
    path: z.string(),
    remote: z.string().default("origin"),
    branch: z.string(),
    base: z.string().optional(),
    title: z.string().default(""),
    body: z.string().default(""),
    draft: z.boolean().default(false),
  })

  rookery.commands.register("workbench.gh.available", {
    params: z.object({ env: z.string(), path: z.string(), remote: z.string().default("origin") }),
    async run(ctx, p) {
      const r = await rookery.env.exec(ctx, p.env, ["gh", "auth", "status"], {
        cwd: p.path,
        env: { GH_PROMPT_DISABLED: "1", NO_COLOR: "1" },
        timeoutMs: 15_000,
      })
      if (r.exitCode === 127)
        return { available: false, reason: `The GitHub CLI (gh) is not installed on ${p.env}.` }
      if (r.exitCode !== 0)
        return {
          available: false,
          reason: `gh is not signed in on ${p.env}: ${(r.stderr || r.stdout).trim().split("\n")[0]}`,
        }
      return { available: true }
    },
  })

  rookery.commands.register("workbench.gh.createPullRequest", {
    params: PrParams,
    async run(ctx, p) {
      const vars = { GIT_TERMINAL_PROMPT: "0", GH_PROMPT_DISABLED: "1", NO_COLOR: "1" }
      // The branch has to be on the remote first. git's own refusal is the message if it is not allowed.
      const push = await rookery.env.exec(
        ctx,
        p.env,
        ["git", "push", "--porcelain", "-u", p.remote, `HEAD:refs/heads/${p.branch}`],
        { cwd: p.path, env: vars, timeoutMs: 28_000 },
      )
      if (push.exitCode !== 0)
        throw new RookeryError("INVALID", `git push was refused: ${(push.stderr || push.stdout).trim()}`)
      const args = [
        "gh",
        "pr",
        "create",
        "--head",
        p.branch,
        "--title",
        p.title || p.branch,
        "--body",
        p.body,
      ]
      if (p.base) args.push("--base", p.base)
      if (p.draft) args.push("--draft")
      const r = await rookery.env.exec(ctx, p.env, args, {
        cwd: p.path,
        env: vars,
        timeoutMs: 28_000,
      })
      if (r.exitCode !== 0)
        throw new RookeryError("INVALID", `gh pr create failed: ${(r.stderr || r.stdout).trim()}`)
      const url = /https?:\/\/\S+/.exec(r.stdout)?.[0] ?? null
      return { url, message: r.stdout.trim() }
    },
  })

  // ── Entities: files and commits that other parts of Crow can link to ─────────────────────────────

  rpc(
    "entity.register",
    {
      env: z.string(),
      kind: z.enum(["file", "commit"]),
      path: z.string(),
      sha: z.string().optional(),
      title: z.string().optional(),
      subtitle: z.string().optional(),
    },
    async (_ctx, p) => {
      const env = p.env.replace(/^env:\/\//, "")
      const uri = p.kind === "file" ? `code://${env}${p.path}` : `commit://${env}${p.path}@${p.sha ?? ""}`
      const name = p.path.split("/").filter(Boolean).pop() ?? p.path
      await rookery.entities.register({
        uri,
        title: p.title ?? (p.kind === "file" ? name : `${(p.sha ?? "").slice(0, 7)} ${name}`),
        subtitle: p.subtitle ?? `${env}:${p.path}`,
        icon: p.kind === "file" ? "file" : "branch",
        parent: `env://${env}`,
        searchText: `${p.path} ${p.sha ?? ""} ${p.title ?? ""}`,
        private: false,
      })
      return { uri }
    },
  )
})
