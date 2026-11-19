// The host half against a fake Rookery: what it runs on a host (the commands and the variables they get),
// the git parsers on real output, and the extension points it reads.
import { describe, expect, test } from "bun:test"
import type { Ctx, Rookery, RpcHandlerDef } from "@rookery/sdk"
import hostPlugin from "../src/host"

interface ExecCall {
  env: string
  command: string[]
  cwd?: string
  vars?: Record<string, string>
  stdin?: string
}

interface ExecResult {
  exitCode?: number
  lost?: boolean
  stdout: string
  stderr: string
}

function createFakeHost(reply: (call: ExecCall) => Partial<ExecResult> = () => ({})) {
  const calls: ExecCall[] = []
  const rpcs = new Map<string, RpcHandlerDef>()
  const commands = new Map<string, unknown>()
  const listed: string[] = []

  const env = {
    async get(_ctx: Ctx, name: string) {
      return { name, uri: `env://${name}`, kind: "workstation", state: "online", supports: {} }
    },
    async exec(_ctx: Ctx, name: string, command: string[], opts: Record<string, unknown> = {}) {
      const call: ExecCall = {
        env: name,
        command,
        cwd: opts.cwd as string | undefined,
        vars: opts.env as Record<string, string> | undefined,
        stdin: opts.stdin as string | undefined,
      }
      calls.push(call)
      return { exitCode: 0, stdout: "", stderr: "", ...reply(call) }
    },
    async listDir(_ctx: Ctx, _env: string, path: string) {
      return { path, entries: [] }
    },
  }

  const rookery = {
    id: "workbench",
    manifest: { id: "workbench" },
    log: { debug() {}, info() {}, warn() {}, error() {} },
    onDispose() {},
    rpc: {
      handle(name: string, def: RpcHandlerDef) {
        rpcs.set(name, def)
        return { dispose() {} }
      },
    },
    commands: {
      register(id: string, def: unknown) {
        commands.set(id, def)
        return { dispose() {} }
      },
      run: async () => undefined,
    },
    extensions: {
      async list(point: string) {
        listed.push(point)
        if (point === "workbench.pullRequestProviders")
          return [
            {
              plugin: "github",
              value: { id: "gh", title: "GitHub CLI", command: "workbench.gh", order: 100 },
            },
            { plugin: "workbench", value: { id: "gh", title: "GitHub CLI", command: "workbench.gh" } },
          ]
        return []
      },
    },
    env,
  } as unknown as Rookery

  const ctx: Ctx = {
    user: { id: "u1", name: "Ada", email: "ada@example.test", admin: false },
    principal: { kind: "user", id: "u1" },
    space: null,
    signal: new AbortController().signal,
    data: {} as Ctx["data"],
    access: {
      check: async () => true,
      require: async () => {},
      level: async () => "use" as never,
      filter: async (r) => r,
      grant: async () => {},
      revoke: async () => {},
    },
  }

  return {
    rookery,
    ctx,
    calls,
    rpcs,
    commands,
    listed,
    async call<T = unknown>(method: string, params: Record<string, unknown> = {}): Promise<T> {
      const def = rpcs.get(method)
      if (!def) throw new Error(`RPC ${method} is not registered`)
      const parsed = def.params ? def.params.parse(params) : params
      return (await def.run(ctx, parsed)) as T
    },
  }
}

/** The bare git command, after `git -c … -c …`. */
const gitArgs = (call: ExecCall) => {
  const at = call.command.indexOf("git")
  const rest = call.command.slice(at === -1 ? 0 : at + 1)
  const out: string[] = []
  for (let i = 0; i < rest.length; i++) {
    if (rest[i] === "-c") {
      i++
      continue
    }
    out.push(rest[i]!)
  }
  return out
}

describe("workbench host half", () => {
  test("registers its RPCs, commands and host commands on activate", async () => {
    const h = createFakeHost()
    await hostPlugin.activate(h.rookery)
    for (const method of ["ws.info", "git.status", "git.diff", "git.commit", "git.blame", "pr.providers"])
      expect(h.rpcs.has(method)).toBe(true)
    expect(h.commands.has("workbench.gh.available")).toBe(true)
    expect(h.commands.has("workbench.gh.createPullRequest")).toBe(true)
  })

  test("ws.info reads the repository root, branch and tools in one process", async () => {
    const h = createFakeHost((call) => {
      if (call.command[0] === "sh")
        return { stdout: "/srv/work/app\n/srv/work/app/.git\nfeature/x\n--\nrg\ngh\n" }
      return {}
    })
    await hostPlugin.activate(h.rookery)
    const info = await h.call<{
      env: string
      root: string
      isRepo: boolean
      gitDir: string
      branch: string
      kind: string
      tools: Record<string, boolean>
    }>("ws.info", { env: "studio", path: "/srv/work/app" })
    expect(info).toMatchObject({
      env: "studio",
      root: "/srv/work/app",
      isRepo: true,
      gitDir: "/srv/work/app/.git",
      branch: "feature/x",
      kind: "workstation",
      tools: { rg: true, gh: true },
    })
  })

  test("git.status parses porcelain v2 and names a merge in progress", async () => {
    const h = createFakeHost((call) => {
      const args = gitArgs(call)
      if (args[0] === "status")
        return {
          stdout:
            "# branch.oid 1111111111111111111111111111111111111111\0# branch.head main\0" +
            "# branch.ab +2 -1\0" +
            "1 .M N... 100644 100644 100644 1111 2222 src/a.ts\0" +
            "? notes.txt\0",
        }
      return {}
    })
    // A MERGE_HEAD in the git directory is read through listDir.
    const listDir = h.rookery.env.listDir
    ;(h.rookery.env as unknown as { listDir: typeof listDir }).listDir = async (_c, _e, path) => ({
      path,
      entries: [{ name: "MERGE_HEAD", kind: "file", size: 41 }],
    })
    await hostPlugin.activate(h.rookery)
    const status = await h.call<{
      branch: { head: string; ahead: number; behind: number }
      entries: Array<{ path: string; kind: string }>
      state: string
    }>("git.status", { env: "studio", root: "/srv/work/app", gitDir: "/srv/work/app/.git" })
    expect(status.branch).toMatchObject({ head: "main", ahead: 2, behind: 1 })
    expect(status.entries.map((e) => [e.path, e.kind])).toEqual([
      ["src/a.ts", "changed"],
      ["notes.txt", "untracked"],
    ])
    expect(status.state).toBe("merge")
  })

  test("git.commit commits as the person when the host's git has no identity, and reads the sha", async () => {
    const h = createFakeHost((call) => {
      const args = gitArgs(call)
      if (args[0] === "config") return { exitCode: 1 }
      if (args[0] === "commit") return {}
      if (args[0] === "rev-parse") return { stdout: "abc1234\n" }
      return {}
    })
    await hostPlugin.activate(h.rookery)
    const r = await h.call<{ sha: string }>("git.commit", {
      env: "studio",
      root: "/srv/work/app",
      message: "fix: a thing\n",
    })
    expect(r.sha).toBe("abc1234")
    const commit = h.calls.find((c) => gitArgs(c)[0] === "commit")!
    expect(gitArgs(commit)).toContain("-F")
    expect(commit.stdin).toBe("fix: a thing\n")
    expect(commit.cwd).toBe("/srv/work/app")
    expect(commit.vars).toMatchObject({
      GIT_AUTHOR_NAME: "Ada",
      GIT_AUTHOR_EMAIL: "ada@example.test",
      GIT_COMMITTER_EMAIL: "ada@example.test",
    })
  })

  test("pr.providers lists the extension point in order, with the contributing plugin", async () => {
    const h = createFakeHost()
    await hostPlugin.activate(h.rookery)
    const r = await h.call<{ providers: Array<{ id: string; plugin: string; order?: number }> }>(
      "pr.providers",
    )
    expect(h.listed).toContain("workbench.pullRequestProviders")
    expect(r.providers.map((p) => p.plugin)).toEqual(["workbench", "github"])
  })
})
