import { describe, expect, test } from "bun:test"
import type { Ctx, Rookery, RpcHandlerDef } from "@rookery/sdk"
import { activate, createHost, type HostTransport } from "@rookery/sdk/runtime/host"
import api from "../rookery/interface"
import manifest from "../rookery/plugin.json"
import hostPlugin from "../src/host"

interface StoredRow {
  id: string
  spaceId?: string | null
  rev: number
  createdAt: string
  updatedAt: string
  createdBy?: string | null
  deletedAt?: string | null
  [key: string]: unknown
}

function matchesWhere(row: StoredRow, where?: Record<string, unknown>): boolean {
  if (!where) return true
  for (const [k, cond] of Object.entries(where)) {
    if (k === "or" && Array.isArray(cond)) {
      if (!cond.some((sub) => matchesWhere(row, sub as Record<string, unknown>))) return false
      continue
    }
    const val = row[k]
    if (cond && typeof cond === "object" && !Array.isArray(cond)) {
      const ops = cond as Record<string, unknown>
      if ("in" in ops && Array.isArray(ops.in) && !ops.in.includes(val)) return false
      if ("contains" in ops && (!Array.isArray(val) || !val.includes(ops.contains))) return false
      if ("ne" in ops && val === ops.ne) return false
      continue
    }
    if (val !== cond) return false
  }
  return true
}

function createFakeHost() {
  let seq = 0
  const nextId = (prefix: string) => `${prefix}-${++seq}`

  // key: `${space ?? "*"}:${collection}` -> rows
  const tables = new Map<string, StoredRow[]>()
  const sequences = new Map<string, number>()
  const tableOf = (space: string | null, col: string): StoredRow[] => {
    const key = `${space ?? "*"}:${col}`
    let list = tables.get(key)
    if (!list) {
      list = []
      tables.set(key, list)
    }
    return list
  }

  const makeCollection = (space: string | null, col: string) => ({
    async get(id: string) {
      if (space) return tableOf(space, col).find((r) => r.id === id) ?? null
      for (const [k, rows] of tables) {
        if (k.endsWith(`:${col}`)) {
          const hit = rows.find((r) => r.id === id)
          if (hit) return hit
        }
      }
      return null
    },
    async find(query?: { where?: Record<string, unknown>; limit?: number; includeDeleted?: boolean }) {
      const source = space
        ? tableOf(space, col)
        : [...tables.entries()].filter(([k]) => k.endsWith(`:${col}`)).flatMap(([, rows]) => rows)
      const filtered = source.filter(
        (r) => (query?.includeDeleted || !r.deletedAt) && matchesWhere(r, query?.where),
      )
      return {
        rows: query?.limit ? filtered.slice(0, query.limit) : filtered,
        next: null,
        total: filtered.length,
      }
    },
    async count(query?: { where?: Record<string, unknown> }) {
      const source = space ? tableOf(space, col) : []
      return source.filter((r) => !r.deletedAt && matchesWhere(r, query?.where)).length
    },
    async insert(data: Record<string, unknown>) {
      const now = new Date().toISOString()
      const defaults: Record<string, unknown> = {}
      if (col === "issues" && data.number === undefined) {
        const key = `${space ?? "*"}:issue_seq`
        const next = (sequences.get(key) ?? 0) + 1
        sequences.set(key, next)
        defaults.number = next
      }
      if (col === "projects" && data.autoCloseParent === undefined) {
        defaults.autoCloseParent = true
      }
      const row: StoredRow = {
        id: nextId(col),
        spaceId: space,
        rev: 1,
        createdAt: now,
        updatedAt: now,
        createdBy: "u1",
        deletedAt: null,
        ...defaults,
        ...data,
      }
      tableOf(space, col).push(row)
      return row
    },
    async update(id: string, patch: Record<string, unknown>) {
      const rows = tableOf(space, col)
      const idx = rows.findIndex((r) => r.id === id)
      if (idx < 0) throw new Error(`missing row ${col}/${id}`)
      const next: StoredRow = {
        ...rows[idx]!,
        ...patch,
        rev: rows[idx]!.rev + 1,
        updatedAt: new Date().toISOString(),
      }
      rows[idx] = next
      return next
    },
    async delete(id: string) {
      const rows = tableOf(space, col)
      const idx = rows.findIndex((r) => r.id === id)
      if (idx >= 0) rows[idx] = { ...rows[idx]!, deletedAt: new Date().toISOString() }
    },
    async restore(id: string) {
      const rows = tableOf(space, col)
      const idx = rows.findIndex((r) => r.id === id)
      if (idx >= 0) {
        rows[idx] = { ...rows[idx]!, deletedAt: null }
        return rows[idx]
      }
      return null
    },
    async batch(
      ops: Array<{
        op: string
        id?: string
        values?: Record<string, unknown>
        record?: Record<string, unknown>
        data?: Record<string, unknown>
        patch?: Record<string, unknown>
      }>,
    ) {
      const results: unknown[] = []
      for (const op of ops) {
        if (op.op === "insert")
          results.push(await makeCollection(space, col).insert(op.values ?? op.record ?? op.data ?? {}))
        else if (op.op === "update" && op.id)
          results.push(await makeCollection(space, col).update(op.id, op.values ?? op.patch ?? {}))
        else if (op.op === "delete" && op.id) {
          await makeCollection(space, col).delete(op.id)
          results.push(null)
        }
      }
      return results
    },
    async history() {
      return { events: [], next: null }
    },
  })

  const makeData = (space: string | null): any =>
    new Proxy(
      {
        refs: {
          from: async () => [],
          to: async () => [],
        },
        changes: {
          subscribe: async (col: string) => {
            subscribedCollections.push(col)
            return { dispose() {} }
          },
        },
        space: (id: string) => makeData(id),
      },
      {
        get(target, prop) {
          if (typeof prop === "string" && !(prop in target)) {
            return makeCollection(space, prop)
          }
          return (target as Record<PropertyKey, unknown>)[prop]
        },
      },
    )

  const rpcs = new Map<string, RpcHandlerDef>()
  const commands = new Map<string, unknown>()
  const services = new Map<string, Record<string, (ctx: Ctx, params: any) => unknown>>()
  const jobs = new Map<string, unknown>()
  const subscribedCollections: string[] = []
  const notices: Array<{ user: string; title: string }> = []
  const spaces: Array<{
    id: string
    kind: string
    name: string
    slug: string
    personal: boolean
    level: null
    owner: string
  }> = []
  const docs = new Map<string, { id: string; parent: string; title: string; markdown: string }>()

  const rookery = {
    id: "projects",
    log: { debug() {}, info() {}, warn() {}, error() {} },
    onDispose() {},
    data: makeData(null),
    commands: {
      register(id: string, def: unknown) {
        commands.set(id, def)
        return { dispose() {} }
      },
      run: async () => undefined,
    },
    rpc: {
      handle(name: string, def: RpcHandlerDef) {
        rpcs.set(name, def)
        return { dispose() {} }
      },
    },
    services: {
      provide(
        service: string | { name: string },
        methods: Record<string, (ctx: Ctx, params: any) => unknown>,
      ) {
        services.set(typeof service === "string" ? service : service.name, methods)
        return { dispose() {} }
      },
      call: async () => ({}),
      stream: async function* () {},
    },
    jobs: {
      handle(name: string, handler: unknown) {
        jobs.set(name, handler)
        return { dispose() {} }
      },
      enqueue: async (job: string) => ({ id: nextId(job), state: "queued" }),
    },
    notify: {
      send: async (n: { user: string; title: string }) => {
        notices.push(n)
      },
    },
    spaces: {
      list: async () => spaces,
      create: async (_ctx: Ctx, p: { kind: string; name: string; slug?: string }) => {
        const sp = {
          id: nextId("space"),
          kind: p.kind,
          name: p.name,
          slug: p.slug ?? p.name.toLowerCase().replace(/\s+/g, "-"),
          personal: false,
          level: null,
          owner: "user://u1",
        }
        spaces.push(sp)
        return sp
      },
      rename: async (_ctx: Ctx, id: string, name: string) => {
        const sp = spaces.find((s) => s.id === id)
        if (sp) sp.name = name
        return sp
      },
    },
    extensions: {
      list: async () => [],
    },
    documents: {
      list: async (_ctx: Ctx | null, parent: string) => [...docs.values()].filter((d) => d.parent === parent),
      create: async (_ctx: Ctx | null, p: { parent: string; title: string; markdown?: string }) => {
        const d = { id: nextId("doc"), parent: p.parent, title: p.title, markdown: p.markdown ?? "" }
        docs.set(d.id, d)
        return d
      },
      edit: async () => {},
      delete: async (_ctx: Ctx | null, id: string) => {
        docs.delete(id)
      },
      text: async (_ctx: Ctx | null, id: string) => docs.get(id)?.markdown ?? "",
      markdown: async (_ctx: Ctx | null, id: string) => docs.get(id)?.markdown ?? "",
      fromMarkdown: async (_ctx: Ctx | null, md: string) => ({
        type: "doc",
        content: [{ type: "paragraph", content: [{ type: "text", text: md }] }],
      }),
      toMarkdown: async () => "",
    },
    entities: {
      lookup: async () => null,
      lookupMany: async () => [],
      search: async () => [],
      text: () => ({ dispose() {} }),
    },
    env: {
      list: async () => [],
      repositories: async () => [],
      addRepository: async () => ({}),
    },
  } as unknown as Rookery

  const ctx: Ctx = {
    user: { id: "u1", name: "Ada", email: "ada@example.com", admin: true } as unknown as Ctx["user"],
    principal: { kind: "user", id: "u1" },
    space: null,
    signal: new AbortController().signal,
    data: rookery.data,
    access: {
      check: async () => true,
      require: async () => {},
      level: async () => "manage" as never,
      filter: async (r) => r,
      grant: async () => {},
      revoke: async () => {},
    },
  }

  return {
    rookery,
    ctx,
    rpcs,
    commands,
    services,
    jobs,
    subscribedCollections,
    notices,
    async callRpc<T = unknown>(method: string, params: Record<string, unknown> = {}): Promise<T> {
      const def = rpcs.get(method)
      if (!def) throw new Error(`RPC ${method} not registered`)
      const parsed = def.params ? def.params.parse(params) : params
      return (await def.run(ctx, parsed)) as T
    },
  }
}

describe("projects host half", () => {
  test("registers RPCs, projects service, jobs, and collection watchers on activate", async () => {
    const h = createFakeHost()
    await hostPlugin.activate(h.rookery)

    for (const method of [
      "createProject",
      "updateProject",
      "createIssue",
      "update",
      "move",
      "comment",
      "react",
      "resolveKey",
      "importPreview",
      "members",
      "sourceKinds",
    ]) {
      expect(h.rpcs.has(method)).toBe(true)
    }

    expect(h.commands.has("projects.createIssue")).toBe(true)

    const svc = h.services.get("projects")
    expect(svc).toBeDefined()
    expect(typeof svc!.searchIssues).toBe("function")
    expect(typeof svc!.createIssue).toBe("function")
    expect(typeof svc!.resolveKeys).toBe("function")
    expect(typeof svc!["issues.upsertFromSource"]).toBe("function")

    expect(h.jobs.has("projects.import")).toBe(true)
    expect(h.jobs.has("projects.pushToSource")).toBe(true)
    expect(h.subscribedCollections).toContain("issues")
    expect(h.subscribedCollections).toContain("states")
  })

  test("creates a project, seeds states/labels, creates issues, and auto-closes parent", async () => {
    const h = createFakeHost()
    await hostPlugin.activate(h.rookery)

    const created = await h.callRpc<{ space: { id: string; slug: string }; project: { key: string } }>(
      "createProject",
      { name: "Crow", key: "crow", summary: "Issue tracker" },
    )
    expect(created.project.key).toBe("CROW")
    const space = created.space.id

    const states = (await h.rookery.data.space(space).states.find({ limit: 50 })).rows as unknown as Array<{
      id: string
      category: string
      name: string
    }>
    expect(states.length).toBeGreaterThanOrEqual(5)
    const done = states.find((s) => s.category === "completed")!
    expect(done).toBeDefined()

    // Create parent and child issue
    const parent = await h.callRpc<{ id: string; key: string; stateCategory: string }>("createIssue", {
      space,
      title: "Ship projects plugin",
    })
    expect(parent.key).toBe("CROW-1")
    expect(parent.stateCategory).toBe("unstarted")

    const child = await h.callRpc<{ id: string; key: string; parent: string }>("createIssue", {
      space,
      title: "Port host half",
      parent: `issue://${parent.id}`,
    })
    expect(child.key).toBe("CROW-2")
    expect(child.parent).toBe(`issue://${parent.id}`)

    // Closing the only sub-issue auto-closes the parent when autoCloseParent is enabled (default true)
    await h.callRpc("update", {
      items: [{ space, id: child.id }],
      patch: { state: done.id },
    })

    const updatedParent = (await h.rookery.data.space(space).issues.get(parent.id)) as unknown as {
      stateCategory: string
    }
    expect(updatedParent.stateCategory).toBe("completed")

    // Comments and emoji reaction toggle
    const comment = await h.callRpc<{ id: string }>("comment", {
      space,
      issue: `issue://${parent.id}`,
      body: { type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text: "Nice!" }] }] },
    })
    await h.callRpc("react", { space, id: comment.id, emoji: "👍" })
    const reacted = (await h.rookery.data.space(space).comments.get(comment.id)) as unknown as {
      reactions: Record<string, string[]>
    }
    expect(reacted.reactions["👍"]).toEqual(["u1"])

    // Resolve keys via both RPC and the plugin-to-plugin projects service
    const resolved = await h.callRpc<{ id: string; space: string; key: string } | null>("resolveKey", {
      key: "crow-1",
    })
    expect(resolved).toEqual({ id: parent.id, space, key: "CROW-1" })

    const svc = h.services.get("projects")!
    const byKeys = (await svc.resolveKeys!(h.ctx, { keys: ["CROW-1", "CROW-2"] })) as Record<string, string>
    expect(byKeys["CROW-1"]).toBe(`issue://${parent.id}`)
    expect(byKeys["CROW-2"]).toBe(`issue://${child.id}`)
  })
})

describe("the Projects host half on the extension host", () => {
  test("activates: its service matches its interface, and its jobs are declared", async () => {
    const transport: HostTransport = {
      call: async () => ({}),
      registered: () => {},
      unregistered: () => {},
      log: () => {},
    }
    const { runtime, rookery } = createHost("projects", manifest as never, transport)
    runtime.interface = api
    const registered = await activate(runtime, rookery, hostPlugin)
    const kinds = registered.map((r) => `${r.kind}:${r.key}`)
    for (const job of [
      "projects.pushToSource",
      "projects.import",
      "projects.rollover",
      "projects.cycleSummary",
    ])
      expect(kinds).toContain(`job:${job}`)
    const service = registered.find((r) => r.kind === "service" && r.key === "projects")
    expect(service).toBeDefined()
    expect(Object.keys(service?.methods ?? {}).sort()).toEqual(
      Object.keys(api.services.projects.methods).sort(),
    )
  })
})
