// The GitHub host half against a fake Rookery and the mock GitHub: attaching a repository, syncing it into
// the plugin's collections and into Projects, and detaching it again.
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test"
import type { Ctx, JobHandle, Rookery } from "@rookery/sdk"
import { activate, createHost, type HostTransport } from "@rookery/sdk/runtime/host"
import api from "../rookery/interface"
import manifest from "../rookery/plugin.json"
import hostPlugin from "../src/host"
import { MockGitHub } from "./mock/github"

type Row = Record<string, any>
type Handler = (ctx: Ctx, params: any) => unknown

function matches(row: Row, where?: Record<string, any>): boolean {
  if (!where) return true
  for (const [k, cond] of Object.entries(where)) {
    if (k === "and" && Array.isArray(cond) && !cond.every((w) => matches(row, w))) return false
    if (k === "or" && Array.isArray(cond) && !cond.some((w) => matches(row, w))) return false
    if (cond === undefined) continue
    const val = row[k]
    if (cond && typeof cond === "object" && !Array.isArray(cond)) {
      const ops = cond as Record<string, unknown>
      if ("in" in ops && Array.isArray(ops.in) && !ops.in.includes(val)) return false
      if ("ne" in ops && val === ops.ne) return false
      if ("eq" in ops && val !== ops.eq) return false
      if (
        "contains" in ops &&
        String(val ?? "")
          .toLowerCase()
          .includes(String(ops.contains).toLowerCase())
      )
        continue
      if ("contains" in ops) return false
      continue
    }
    if (val !== cond) return false
  }
  return true
}

function createFakeRookery(mock: MockGitHub, token: string) {
  let seq = 0
  const id = (p: string) => `${p}-${++seq}`
  const tables = new Map<string, Row[]>()
  const handlers = new Map<string, Handler>()
  const commands = new Map<string, Handler>()
  const jobs = new Map<string, Handler>()
  const services = new Map<string, Record<string, Handler>>()
  const enqueued: Array<{ name: string; params: Row }> = []
  const sent: Row[] = []
  const schedules: Row[] = []
  const secrets = new Map<string, string>()
  const warned: string[] = []

  const table = (name: string) => {
    let list = tables.get(name)
    if (!list) {
      list = []
      tables.set(name, list)
    }
    return list
  }

  const collection = (name: string) => ({
    async find(q: { where?: Row; orderBy?: Array<[string, string]>; limit?: number } = {}) {
      let rows = table(name).filter((r) => matches(r, q.where))
      for (const [field, dir] of [...(q.orderBy ?? [])].reverse())
        rows = [...rows].sort((a, b) =>
          dir === "desc"
            ? String(b[field] ?? "").localeCompare(String(a[field] ?? ""))
            : String(a[field] ?? "").localeCompare(String(b[field] ?? "")),
        )
      return { rows: q.limit ? rows.slice(0, q.limit) : rows, next: null, total: rows.length }
    },
    async get(rowId: string) {
      return table(name).find((r) => r.id === rowId) ?? null
    },
    async count(q: { where?: Row } = {}) {
      return table(name).filter((r) => matches(r, q.where)).length
    },
    async insert(values: Row) {
      const now = new Date().toISOString()
      const row: Row = { id: id(name), rev: 1, createdAt: now, updatedAt: now, ...values }
      table(name).push(row)
      return row
    },
    async update(rowId: string, patch: Row) {
      const rows = table(name)
      const at = rows.findIndex((r) => r.id === rowId)
      if (at < 0) throw new Error(`no ${name}/${rowId}`)
      rows[at] = {
        ...rows[at]!,
        ...patch,
        rev: (rows[at]!.rev ?? 1) + 1,
        updatedAt: new Date().toISOString(),
      }
      return rows[at]!
    },
    async delete(rowId: string) {
      const rows = table(name)
      const at = rows.findIndex((r) => r.id === rowId)
      if (at >= 0) rows.splice(at, 1)
      return null
    },
    async batch(ops: Array<{ op: string; id?: string; values?: Row; collection?: string }>) {
      const out: Row[] = []
      for (const op of ops) {
        const c = collection(op.collection ?? name) as any
        if (op.op === "insert") out.push(await c.insert(op.values ?? {}))
        else if (op.op === "update") out.push(await c.update(op.id!, op.values ?? {}))
        else if (op.op === "delete") out.push(await c.delete(op.id!))
      }
      return out
    },
    async search(text: string, opts: { where?: Row; limit?: number } = {}) {
      return collection(name).find({
        where: { ...opts.where, title: { contains: text } } as Row,
        limit: opts.limit,
      })
    },
  })

  type Collections = Record<string, unknown> & {
    space(id: string): Collections
    refs: unknown
    changes: { subscribe(): Promise<{ dispose(): void }> }
  }
  const data: Collections = new Proxy({} as Collections, {
    get(_t, name) {
      if (name === "space") return () => data
      if (name === "refs") return { to: async () => [], from: async () => [] }
      if (name === "changes") return { subscribe: async () => ({ dispose() {} }) }
      if (typeof name !== "string") return undefined
      return collection(name)
    },
  })

  const ro: Rookery = {
    id: "code",
    manifest: { id: "code", name: "GitHub", version: "0.1.0", contributes: {} } as never,
    log: {
      debug: () => {},
      info: () => {},
      warn: (m: string) => void warned.push(m),
      error: () => {},
    },
    commands: {
      register: (name, def) => {
        commands.set(name, def.run as Handler)
        return { dispose() {} }
      },
      run: async (ctx, name, params) => commands.get(name)!(ctx, params) as never,
    },
    rpc: {
      handle: (name, def) => {
        handlers.set(name, def.run as Handler)
        return { dispose() {} }
      },
    },
    services: {
      provide: (service: string | { name: string }, methods: Record<string, Handler>) => {
        services.set(typeof service === "string" ? service : service.name, methods)
        return { dispose() {} }
      },
      call: (async (_plugin: string, service: string, method: string, params: Record<string, unknown>) => {
        const s = services.get(service)
        if (!s?.[method]) throw new Error(`no service ${service}.${method}`)
        return s[method](ctx(), params)
      }) as never,
      stream: async function* () {},
    },
    extensions: { list: async () => [] },
    events: { publish: async () => {}, subscribe: async () => ({ dispose() {} }) },
    settings: { get: async () => 60, set: async () => {}, reset: async () => {} },
    entities: {
      lookup: async () => null,
      lookupMany: async () => [],
      search: async () => [],
      text: () => ({ dispose() {} }),
      register: async () => ({}) as never,
      remove: async () => {},
      alias: async () => {},
    } as never,
    documents: {} as never,
    users: {} as never,
    sql: {} as never,
    data: data as never,
    spaces: {
      list: async () => [space as never],
      get: async () => space as never,
      create: async () => space as never,
      rename: async () => space as never,
    },
    storage: {} as never,
    secrets: {
      get: async (k: string) => secrets.get(k) ?? null,
      set: async (k: string, v: string) => void secrets.set(k, v),
      list: async () => [...secrets.keys()],
      delete: async (k: string) => void secrets.delete(k),
      rename: async () => {},
    },
    connections: {
      list: async (opts?: { type?: string }) =>
        (opts?.type && opts.type !== "code.github-token" ? [] : [connection]) as never,
      get: async () => connection as never,
      resolve: async () => ({ connection, credential: token }) as never,
      test: () => ({ dispose() {} }),
    },
    blobs: {} as never,
    audit: { record: async () => {}, list: async () => [] },
    jobs: {
      handle: (name, def) => {
        jobs.set(name, def.run as unknown as Handler)
        return { dispose() {} }
      },
      enqueue: async (name: string, params?: Row) => {
        enqueued.push({ name, params: params ?? {} })
        return { id: "job-1" } as never
      },
      get: async () => ({}) as never,
      cancel: async () => {},
    },
    leases: {} as never,
    topics: {} as never,
    schedules: {
      list: async () => schedules,
      setEnabled: async () => {},
      fire: async () => ({ id: "job-1" }) as never,
      create: async (_ctx: Ctx, s: Row) => {
        schedules.push({ id: id("schedule"), ...s })
        return { id: "schedule-1" }
      },
      remove: async () => {},
    } as never,
    notify: {
      send: async (n: Row) => {
        sent.push(n)
        return { id: "notice-1" }
      },
    } as never,
    streams: {} as never,
    env: {
      list: async () => [],
      get: async () => ({}) as never,
      exec: async () => ({ exitCode: 1, stdout: "", stderr: "" }),
      readFile: async () => ({}) as never,
      writeFile: async () => ({}) as never,
      deleteFile: async () => {},
      listDir: async () => ({}) as never,
      repositories: async () => [],
      addRepository: async () => ({ id: "env-repo-1" }),
    } as never,
    terminals: {} as never,
    appServices: {} as never,
    onDispose: () => {},
  }

  const space = {
    id: "proj-1",
    kind: "projects.project",
    name: "Widgets",
    slug: "widgets",
    personal: false,
    level: "manage",
    owner: "u1",
  }
  const connection = {
    id: "conn-1",
    type: "code.github-token",
    name: "Ada's token",
    scope: "user",
    config: { baseUrl: mock.apiUrl },
    hasCredential: true,
    updatedAt: "2026-01-01T00:00:00Z",
  }

  let current: Ctx = userCtx()
  function userCtx(): Ctx {
    return {
      callId: "call-1",
      user: { id: "u1", name: "Ada", admin: true },
      principal: { kind: "user", id: "u1" } as never,
      space: "proj-1",
      signal: new AbortController().signal,
      data: data as never,
      access: {
        check: async () => true,
        require: async () => {},
        level: async () => "manage" as never,
        levelOf: async () => null,
        grants: async (resource: string) => ({ resource, owner: null, grants: [] }),
        filter: async (r: string[]) => r,
        grant: async () => {},
        revoke: async () => {},
      },
    }
  }
  const ctx = () => current

  return {
    ro,
    ctx,
    handlers,
    jobs,
    enqueued,
    sent,
    schedules,
    warned,
    tables,
    as: (next: Ctx) => {
      current = next
    },
    /** Runs a job with a handle that carries the caller's ctx. */
    runJob: async (name: string, params: Row) => {
      const run = jobs.get(name)
      if (!run) throw new Error(`no job ${name}`)
      const handle = {
        id: id("job"),
        attempt: 1,
        signal: new AbortController().signal,
        context: {} as never,
        ctx: current,
        progress: async () => {},
        log: async () => {},
      } as unknown as JobHandle
      return run(handle as never, params)
    },
  }
}

const mock = new MockGitHub()
let fake: ReturnType<typeof createFakeRookery>
let token: string

beforeAll(() => {
  mock.start()
})
afterAll(() => mock.stop())

beforeEach(async () => {
  mock.reset()
  const t = mock.createToken({ login: "ada" })
  token = t.token
  mock.createRepo({ full_name: "acme/widgets", private: true, description: "The widget factory" })
  mock.setRepo({ full_name: "acme/widgets", assignable: ["ada", "grace"] })
  fake = createFakeRookery(mock, token)
  const plugin = hostPlugin as unknown as { activate(r: Rookery): void }
  plugin.activate(fake.ro)
  // The projects service the plugin calls: a project already linked to the repository when it attaches.
  const projects = new Map<string, Handler>()
  fake.ro.services.provide("projects", {
    "sources.projects": (_ctx: Ctx, p: any) =>
      projects.has(p.repository)
        ? [
            {
              id: "link-1",
              space: "proj-1",
              repository: p.repository,
              repoSpace: p.repoSpace,
              key: "WID",
              name: "Widgets",
            },
          ]
        : [],
    "sources.link": (_ctx: Ctx, p: any) => {
      projects.set(p.repository, p)
      return { link: { id: "link-1", space: "proj-1" } }
    },
    "sources.unlink": () => ({ ok: true }),
    "sources.find": (_ctx: Ctx, p: any) => ({
      uri: `issue://i-${p.number}`,
      key: `WID-${p.number}`,
      space: "proj-1",
    }),
    "issues.upsertFromSource": (_ctx: Ctx, p: any) => ({
      linked: true,
      issues: (p.items ?? []).map((i: Row) => ({
        external: i.external,
        id: `i-${i.number}`,
        key: `WID-${i.number}`,
        changed: true,
      })),
    }),
    "comments.upsertFromSource": (_ctx: Ctx, p: any) => ({
      linked: true,
      created: (p.comments ?? []).length,
    }),
    "issues.listFromSource": () => [],
    "issues.removedAtSource": () => ({ linked: true }),
    getIssue: () => ({ key: "WID-7" }),
  } as never)
})

const call = async <T = unknown>(name: string, params: Row): Promise<T> => {
  const run = fake.handlers.get(name)
  if (!run) throw new Error(`no rpc ${name}`)
  return (await run(fake.ctx(), params)) as T
}

describe("old issue addresses", () => {
  test("an address from before issues were Projects issues opens the issue it became", async () => {
    const entities = fake.ro.entities as unknown as {
      lookup(ctx: unknown, uri: string): Promise<unknown>
    }
    const lookup = entities.lookup
    entities.lookup = async (_ctx, uri: string) =>
      uri === "gh-issue://i-7" ? { uri, scheme: "issue", spaceId: "proj-1" } : null
    try {
      expect(await call("issueFor", { id: "i-7" })).toEqual({ space: "widgets", key: "WID-7" })
      expect(await call("issueFor", { id: "i-9" })).toBeNull()
    } finally {
      entities.lookup = lookup
    }
  })
})

describe("attaching and syncing a repository", () => {
  test("attach stores the repository, its route, its project link and a poll schedule", async () => {
    const repo = await call<Row>("attach", { repo: "acme/widgets" })
    expect(repo.fullName).toBe("acme/widgets")
    expect(repo.status).toBe("pending")
    expect(repo.syncedBy).toBe("u1")
    expect(fake.tables.get("routes")?.[0]).toMatchObject({
      repoKey: `127.0.0.1:${new URL(mock.apiUrl).port}/acme/widgets`,
      inSpace: "proj-1",
      repoId: repo.id,
    })
    expect(fake.schedules[0]).toMatchObject({ name: `code:sync:${repo.id}`, job: "code.sync", everySecs: 60 })
    expect(fake.enqueued[0]).toMatchObject({ name: "code/sync", params: { repo: repo.id, space: "proj-1" } })
  })

  test("a sync writes pull requests and comments, and issues go to Projects", async () => {
    const { number } = mock.createPull({
      repo: "acme/widgets",
      title: "Rework the gearbox",
      head: "feat/gearbox",
      body: "Fixes nothing in particular",
    })
    mock.comment({ repo: "acme/widgets", number, body: "Looks good to me" })
    mock.createIssue({ repo: "acme/widgets", title: "Bolt too tight", body: "It squeaks" })
    const repo = await call<Row>("attach", { repo: "acme/widgets" })
    const result = await fake.runJob("code.sync", { repo: repo.id, space: "proj-1", force: true })
    expect(result).toMatchObject({ ok: true })

    const prs = fake.tables.get("prs") ?? []
    const pr = prs.find((r) => r.number === number)
    expect(pr).toMatchObject({
      title: "Rework the gearbox",
      state: "open",
      head: "feat/gearbox",
      repo: `gh-repo://${repo.id}`,
    })

    const comments = fake.tables.get("comments") ?? []
    expect(comments.some((c) => c.kind === "comment" && c.body === "Looks good to me")).toBe(true)

    const stored = (fake.tables.get("repos") ?? [])[0]!
    expect(stored.status).toBe("ok")
    expect(stored.lastSyncAt).toBeTruthy()
    expect(stored.nextSyncAt).toBeTruthy()
    expect(stored.openPulls).toBe(1)
    expect(stored.lastSyncStats).toMatchObject({ pulls: 1, issues: 1 })
  })

  test("a sync is skipped while the repository is not due", async () => {
    const repo = await call<Row>("attach", { repo: "acme/widgets" })
    await fake.runJob("code.sync", { repo: repo.id, space: "proj-1", force: true })
    const again = await fake.runJob("code.sync", { repo: repo.id, space: "proj-1" })
    expect(again).toMatchObject({ ok: true, skipped: "not due" })
  })

  test("a detached repository takes its rows and routes with it", async () => {
    mock.createPull({ repo: "acme/widgets", title: "Gearbox", head: "feat/gearbox" })
    const repo = await call<Row>("attach", { repo: "acme/widgets" })
    await fake.runJob("code.sync", { repo: repo.id, space: "proj-1", force: true })
    expect((fake.tables.get("prs") ?? []).length).toBeGreaterThan(0)
    await call("detach", { repo: repo.id })
    expect(fake.tables.get("repos") ?? []).toHaveLength(0)
    expect(fake.tables.get("prs") ?? []).toHaveLength(0)
    expect(fake.tables.get("routes") ?? []).toHaveLength(0)
  })

  test("a GitHub failure is recorded on the repository, and the job succeeds", async () => {
    const repo = await call<Row>("attach", { repo: "acme/widgets" })
    mock.down({ count: 100 })
    const result = await fake.runJob("code.sync", { repo: repo.id, space: "proj-1", force: true })
    expect(result).toMatchObject({ ok: false })
    const stored = (fake.tables.get("repos") ?? [])[0]!
    expect(stored.status).toBe("error")
    expect(stored.errorCode).toBe("github_unavailable")
  })
})

describe("the service", () => {
  test("the github service is provided and links sessions to branches", async () => {
    const repo = await call<Row>("attach", { repo: "acme/widgets" })
    const { number } = mock.createPull({ repo: "acme/widgets", title: "Gearbox", head: "feat/gearbox" })
    await fake.runJob("code.sync", { repo: repo.id, space: "proj-1", force: true })
    const service = (fake.ro.services as unknown as { provide: unknown }).provide
    void service
    const linked = (await fake.ro.services.call("code", "github", "linkSession", {
      session: "session://s-1",
      branch: "feat/gearbox",
      space: "proj-1",
    })) as { pulls: Array<{ number: number }> }
    expect(linked.pulls.map((p) => p.number)).toContain(number)
    const prs = (await fake.ro.services.call("code", "github", "pullRequestsFor", {
      branch: "feat/gearbox",
      space: "proj-1",
    })) as Array<{ number: number }>
    expect(prs.map((p) => p.number)).toEqual([number])
  })

  test("the agent tools read a pull request as text", async () => {
    const repo = await call<Row>("attach", { repo: "acme/widgets" })
    const { number } = mock.createPull({ repo: "acme/widgets", title: "Gearbox", head: "feat/gearbox" })
    await fake.runJob("code.sync", { repo: repo.id, space: "proj-1", force: true })
    const read = (await call("tool", {
      id: "code.read",
      params: { repo: "acme/widgets", number },
    })) as { title: string; text: string }
    expect(read.title).toContain("Gearbox")
    expect(read.text).toContain("acme/widgets#")
  })
})

describe("the GitHub host half on the extension host", () => {
  test("activates: its service matches its interface, and its jobs are declared", async () => {
    const transport: HostTransport = {
      call: async () => ({}),
      registered: () => {},
      unregistered: () => {},
      log: () => {},
    }
    const { runtime, rookery } = createHost("code", manifest as never, transport)
    runtime.interface = api
    const registered = await activate(runtime, rookery, hostPlugin)
    const kinds = registered.map((r) => `${r.kind}:${r.key}`)
    expect(kinds).toContain("service:github")
    expect(kinds).toContain("job:code.sync")
    expect(kinds).toContain("job:code.delivery")
    // The interface's methods are exactly what the service provides.
    const service = registered.find((r) => r.kind === "service" && r.key === "github")
    expect(Object.keys(service?.methods ?? {}).sort()).toEqual(
      Object.keys(api.services.github.methods).sort(),
    )
  })
})
