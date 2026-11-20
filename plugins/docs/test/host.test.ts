// Tests for the Docs host plugin (`src/host.ts`) against an in-memory fake HostRookery.
import { describe, expect, test } from "bun:test"
import type { Ctx } from "@rookery/sdk"
import { activate, createHost, type HostTransport } from "@rookery/sdk/runtime/host"
import api from "../rookery/interface"
import manifest from "../rookery/plugin.json"
import docsHostPlugin from "../src/host"
import type { HostRookery } from "../src/types"

type RpcHandler = (ctx: Ctx, params: Record<string, unknown>) => Promise<unknown> | unknown

function createFakeHost() {
  let seq = 0
  const uid = (prefix: string) => `${prefix}0000-0000-4000-8000-${String(++seq).padStart(12, "0")}`

  const pageRows = new Map<string, Record<string, unknown>>()
  const docBodies = new Map<string, string>()
  const rpcHandlers = new Map<string, RpcHandler>()
  const services = new Map<string, Record<string, (ctx: Ctx, p: any) => Promise<unknown> | unknown>>()

  const makeCollection = () => ({
    async get(id: string, opts?: { trashed?: boolean }) {
      const row = pageRows.get(id) ?? null
      if (!row) return null
      if (!opts?.trashed && row.deletedAt) return null
      return { ...row }
    },
    async find(q: { where?: Record<string, unknown>; trashed?: boolean }) {
      const out: Record<string, unknown>[] = []
      for (const row of pageRows.values()) {
        if (!q.trashed && row.deletedAt) continue
        if (q.where) {
          let ok = true
          for (const [k, v] of Object.entries(q.where)) {
            if (v && typeof v === "object" && "in" in v && Array.isArray((v as { in: unknown[] }).in)) {
              if (!(v as { in: unknown[] }).in.includes(row[k])) {
                ok = false
                break
              }
            } else if (v && typeof v === "object" && "ne" in v) {
              if (row[k] === (v as { ne: unknown }).ne) {
                ok = false
                break
              }
            } else if (k === "template") {
              if (Boolean(row[k]) !== Boolean(v)) {
                ok = false
                break
              }
            } else if (row[k] !== v) {
              ok = false
              break
            }
          }
          if (!ok) continue
        }
        out.push({ ...row })
      }
      return { rows: out, next: null }
    },
    async insert(v: Record<string, unknown>) {
      const id = String(v.id ?? uid("1111"))
      const row: Record<string, unknown> = {
        id,
        spaceId: "sp-1",
        title: "Untitled",
        parent: null,
        rank: "a0",
        private: false,
        template: false,
        wide: false,
        deletedAt: null,
        trashedWith: null,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        createdBy: "user:ann",
        ...v,
      }
      pageRows.set(id, row)
      return { ...row }
    },
    async update(id: string, patch: Record<string, unknown>) {
      const prev = pageRows.get(id)
      if (!prev) throw new Error(`missing page ${id}`)
      const next = { ...prev, ...patch, updatedAt: new Date().toISOString() }
      pageRows.set(id, next)
      return { ...next }
    },
    async delete(id: string) {
      const prev = pageRows.get(id)
      if (!prev) return null
      const next = { ...prev, deletedAt: new Date().toISOString() }
      pageRows.set(id, next)
      return { ...next }
    },
    async restore(id: string) {
      const prev = pageRows.get(id)
      if (!prev) throw new Error(`missing page ${id}`)
      const next = { ...prev, deletedAt: null }
      pageRows.set(id, next)
      return { ...next }
    },
    async purge(id: string) {
      pageRows.delete(id)
    },
    async batch(ops: Array<Record<string, unknown>>) {
      const res: Array<Record<string, unknown> | null> = []
      for (const op of ops) {
        if (op.op === "delete") {
          const prev = pageRows.get(String(op.id))
          if (prev) pageRows.set(String(op.id), { ...prev, deletedAt: new Date().toISOString() })
          res.push(prev ?? null)
        } else if (op.op === "restore") {
          const prev = pageRows.get(String(op.id))
          if (prev) {
            const next = { ...prev, deletedAt: null }
            pageRows.set(String(op.id), next)
            res.push(next)
          } else res.push(null)
        } else if (op.op === "update") {
          const prev = pageRows.get(String(op.id))
          if (prev) {
            const next = { ...prev, ...(op.patch as Record<string, unknown>) }
            pageRows.set(String(op.id), next)
            res.push(next)
          } else res.push(null)
        }
      }
      return res
    },
    async search(text: string) {
      const q = text.toLowerCase()
      const rows = [...pageRows.values()].filter(
        (r) =>
          !r.deletedAt &&
          String(r.title ?? "")
            .toLowerCase()
            .includes(q),
      )
      return { rows }
    },
  })

  const pagesColl = makeCollection()

  const fakeData = {
    pages: pagesColl,
    comments: makeCollection(),
    refs: {
      async to(uri: string) {
        const out: Array<{ source: string; title: string | null; icon: string | null; field: string }> = []
        for (const r of pageRows.values()) {
          if (r.deletedAt) continue
          const links = Array.isArray(r.links) ? (r.links as string[]) : []
          if (links.includes(uri)) {
            out.push({
              source: `doc://${r.id}`,
              title: String(r.title ?? "Untitled"),
              icon: (r.icon as string | null) ?? null,
              field: "links",
            })
          }
        }
        return out
      },
    },
    space: () => fakeData,
  }

  const ctx = {
    user: { id: "user:ann", name: "Ann", email: "ann@example.test", admin: true },
    principal: { kind: "user", id: "user:ann" },
    space: "sp-1",
    signal: new AbortController().signal,
    data: fakeData,
  } as unknown as Ctx

  const rookery = {
    log: { warn: () => {}, info: () => {}, error: () => {}, debug: () => {} },
    blobs: {
      async get() {
        throw new Error("not found")
      },
    },
    notify: { async send() {} },
    rpc: {
      handle(name: string, def: { params: any; run: RpcHandler }) {
        rpcHandlers.set(name, (c, p) => def.run(c, def.params.parse(p)))
        return { dispose() {} }
      },
    },
    commands: {
      register() {
        return { dispose() {} }
      },
    },
    services: {
      provide(
        service: string | { name: string },
        impl: Record<string, (ctx: Ctx, p: any) => Promise<unknown> | unknown>,
      ) {
        services.set(typeof service === "string" ? service : service.name, impl)
        return { dispose() {} }
      },
    },
    documents: {
      async list() {
        return []
      },
      async create(_ctx: Ctx | null, opts: { parent?: string; title?: string; markdown?: string }) {
        const id = uid("2222")
        docBodies.set(id, opts.markdown ?? "")
        return { id, parent: opts.parent ?? null, title: opts.title ?? "" }
      },
      async delete(_ctx: Ctx | null, id: string) {
        docBodies.delete(id)
      },
      async read(_ctx: Ctx | null, id: string, format?: string) {
        const body = docBodies.get(id) ?? ""
        if (format === "markdown") return { id, title: "", markdown: body, blocks: body ? 1 : 0 }
        if (format === "text") return { id, title: "", text: body, blocks: body ? 1 : 0 }
        return {
          id,
          title: "",
          content: {
            type: "doc",
            content: body ? [{ type: "paragraph", content: [{ type: "text", text: body }] }] : [],
          },
          blocks: body ? 1 : 0,
        }
      },
      async edit(
        _ctx: Ctx | null,
        params: {
          id: string
          ops: Array<{ op: string; markdown?: string; at?: number; from?: number; to?: number }>
        },
      ) {
        let body = docBodies.get(params.id) ?? ""
        for (const op of params.ops) {
          if (op.op === "setContent") body = op.markdown ?? ""
          else if (op.op === "appendMarkdown")
            body = body ? `${body}\n${op.markdown ?? ""}` : (op.markdown ?? "")
          else if (op.op === "insert" || op.op === "replaceBlocks") {
            const parts = body ? body.split("\n") : []
            if (op.op === "insert") parts.splice(op.at ?? parts.length, 0, op.markdown ?? "")
            else parts.splice(op.from ?? 0, (op.to ?? 0) - (op.from ?? 0), op.markdown ?? "")
            body = parts.join("\n")
          }
        }
        docBodies.set(params.id, body)
        return { blocks: body ? body.split("\n").length : 0 }
      },
    },
    entities: {
      async lookup(_ctx: Ctx, uri: string) {
        const id = uri.replace(/^doc:\/\//, "")
        const row = pageRows.get(id)
        return row
          ? {
              id,
              uri,
              scheme: "doc",
              title: row.title,
              icon: row.icon ?? null,
              spaceId: row.spaceId,
              updatedAt: row.updatedAt,
            }
          : null
      },
      async search(_ctx: Ctx, query: string) {
        const q = query.toLowerCase()
        return [...pageRows.values()]
          .filter((r) => !r.deletedAt && String(r.title).toLowerCase().includes(q))
          .map((r) => ({
            id: r.id,
            uri: `doc://${r.id}`,
            scheme: "doc",
            title: r.title,
            icon: r.icon ?? null,
            spaceId: r.spaceId,
            updatedAt: r.updatedAt,
          }))
      },
      text(ctxOrScheme: Ctx | string, uris: string[] | unknown) {
        if (typeof ctxOrScheme === "string") return { dispose() {} }
        const list = Array.isArray(uris) ? uris : []
        return Promise.resolve({
          texts: list.map((uri) => {
            const id = uri.replace(/^doc:\/\//, "")
            const row = pageRows.get(id)
            const text = row?.document ? (docBodies.get(String(row.document)) ?? "") : ""
            return { uri, title: (row?.title as string) ?? uri, text }
          }),
        })
      },
    },
    agents: {
      tool() {
        return { dispose() {} }
      },
    },
  } as unknown as HostRookery

  docsHostPlugin.activate(rookery)
  return {
    ctx,
    pageRows,
    docBodies,
    rpc: (name: string, params: Record<string, unknown>) => {
      const fn = rpcHandlers.get(name)
      if (!fn) throw new Error(`missing rpc ${name}`)
      return fn(ctx, params)
    },
    service: () => services.get("docs")!,
  }
}

describe("docs host plugin", () => {
  test("creates pages with backing documents, enforces tree cycles, and handles trash/restore", async () => {
    const h = createFakeHost()
    const root = (await h.rpc("create", { title: "Engineering", markdown: "# Welcome" })) as {
      id: string
      document: string
    }
    const child = (await h.rpc("create", { title: "Runbooks", parent: root.id })) as { id: string }

    expect(h.docBodies.get(root.document)).toBe("# Welcome")
    expect(h.pageRows.get(child.id)?.parent).toBe(`doc://${root.id}`)

    // Moving a parent under its own child must be refused.
    await expect(h.rpc("move", { id: root.id, parent: child.id })).rejects.toThrow()

    // Trashing the root marks the subtree and restoring brings both back.
    const trashed = (await h.rpc("trash", { id: root.id })) as { trashed: number }
    expect(trashed.trashed).toBe(2)
    expect(h.pageRows.get(child.id)?.deletedAt).not.toBeNull()

    const restored = (await h.rpc("restore", { id: root.id })) as { restored: number }
    expect(restored.restored).toBe(2)
    expect(h.pageRows.get(child.id)?.deletedAt).toBeNull()
  })

  test("resolves backlinks via refs index and sets properties via the docs service", async () => {
    const h = createFakeHost()
    const target = (await h.rpc("create", { title: "Incident Guide" })) as { id: string }
    const source = (await h.rpc("create", {
      title: "On-Call Handbook",
      markdown: `Follow the [Incident Guide](doc://${target.id}) immediately.`,
    })) as { id: string }

    await h.service().setProperties(h.ctx, {
      page: source.id,
      properties: { Related: `doc://${target.id}`, Priority: 1 },
    })

    const backlinks = (await h.rpc("backlinks", { page: target.id })) as {
      linked: Array<{ source: string; snippet: string | null }>
    }
    expect(backlinks.linked).toHaveLength(1)
    expect(backlinks.linked[0]!.source).toBe(`doc://${source.id}`)
    expect(backlinks.linked[0]!.snippet).toContain("Incident Guide")
  })
})

describe("the Docs host half on the extension host", () => {
  test("activates: the docs service matches its interface", async () => {
    const transport: HostTransport = {
      call: async () => ({}),
      registered: () => {},
      unregistered: () => {},
      log: () => {},
    }
    const { runtime, rookery } = createHost("docs", manifest as never, transport)
    runtime.interface = api
    const registered = await activate(runtime, rookery, docsHostPlugin)
    const service = registered.find((r) => r.kind === "service" && r.key === "docs")
    expect(service).toBeDefined()
    expect(Object.keys(service?.methods ?? {}).sort()).toEqual(Object.keys(api.services.docs.methods).sort())
  })
})
