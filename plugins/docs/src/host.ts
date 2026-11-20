// The Docs plugin's host half. Pages are rows of `pages` (entity `doc://<id>`, one collaborative document each,
// attached to the page); the tree is `parent` and `rank`, permissions inherit along it unless a page is
// private. What needs several writes or reads of other pages lives here: creating (rank among siblings, the
// document, the creating agent session), moving (no loops), trash and restore of a subtree, purge (with the
// documents), duplicate, templates, comments (with notifications), Markdown in and out, a page as text for
// models, and the `docs` service that agent tools call. Everything acts as the caller, so their access applies;
// only the documents are created and removed as the plugin (it attaches them to its own pages).
import {
  type Ctx,
  type DocumentEdit,
  definePlugin,
  mentions,
  type Query,
  type RichText,
  RookeryError,
  z,
} from "@rookery/sdk"
import api from "../rookery/interface"
import { stringifyFrontMatter } from "./lib/frontmatter"
import { type ExportPage, exportTree, type PlannedPage } from "./lib/mdio"
import {
  defsFromFrontMatter,
  defsOf,
  inferType,
  linksOf,
  newId,
  normalize,
  type PropDef,
  propsFromFrontMatter,
  setProps,
  toFrontMatter,
} from "./lib/props"
import { byRank } from "./lib/rank"
import { BUILTIN, fill } from "./lib/templates"
import { idOf, type PageRow, parentId, rankAfter, rankAt, uriOf, wouldCycle } from "./lib/tree"
import { entityOfHit, type HostRookery } from "./types"

type Pages = {
  get(id: string, opts?: { trashed?: boolean }): Promise<PageRow | null>
  find(q: Query<PageRow>): Promise<{ rows: PageRow[]; next: string | null }>
  insert(v: Record<string, unknown>): Promise<PageRow>
  update(id: string, patch: Record<string, unknown>, opts?: { rev?: number }): Promise<PageRow>
  delete(id: string): Promise<PageRow | null>
  restore(id: string): Promise<PageRow>
  purge(id: string): Promise<void>
  batch(ops: Array<Record<string, unknown>>): Promise<Array<Record<string, unknown> | null>>
  search(
    text: string,
    opts?: { where?: Record<string, unknown>; limit?: number },
  ): Promise<{ rows: PageRow[] }>
}

const space = z.string().optional().describe("The space (an id); the caller's current one when absent")
const pageRef = z.string().describe("The page: its id, its doc:// link, or its exact title")

export default definePlugin((baseRookery) => {
  const rookery = baseRookery as HostRookery

  const requireDocuments = () => rookery.documents
  const requireEntities = () => rookery.entities

  /** A document's ProseMirror JSON, as an empty document when it has none. */
  const docJson = async (ctx: Ctx, id: string): Promise<RichText> =>
    ((await rookery.documents.read(ctx, id, "json")).content as RichText | undefined) ?? {
      type: "doc",
      content: [],
    }

  /** A document as Markdown. */
  const docMarkdown = async (ctx: Ctx, id: string): Promise<string> =>
    (await rookery.documents.read(ctx, id, "markdown")).markdown ?? ""

  /** Applies blocks to a document as the caller (or the agent that acts for them). */
  const docEdit = (ctx: Ctx, id: string, ops: DocumentEdit["ops"]) =>
    rookery.documents.edit(ctx, { id, ops, ...(author(ctx) ? { author: author(ctx) } : {}) })

  /** The pages collection as the caller, in a space (theirs by default). */
  const pages = (ctx: Ctx, sp?: string | null): Pages =>
    ((sp ? ctx.data.space(sp) : ctx.data) as unknown as { pages: Pages }).pages
  const comments = (ctx: Ctx, sp?: string | null) =>
    ((sp ? ctx.data.space(sp) : ctx.data) as unknown as { comments: Pages }).comments

  /** Every row of a query, page by page. */
  const all = async (col: Pages, query: Record<string, unknown>): Promise<PageRow[]> => {
    const out: PageRow[] = []
    let after: string | null = null
    do {
      const r: { rows: PageRow[]; next: string | null } = await col.find({
        ...query,
        limit: 1000,
        ...(after ? { after } : {}),
      } as Query<PageRow>)
      out.push(...r.rows)
      after = r.next
    } while (after && out.length < 50_000)
    return out
  }

  /** A page by id, `doc://` link or exact title; NOT_FOUND when the caller cannot see it. */
  const resolve = async (ctx: Ctx, ref: string, sp?: string | null): Promise<PageRow> => {
    const id = idOf(ref)
    if (id && /^[0-9a-f-]{36}$/i.test(id)) {
      const found = await requireEntities()
        .lookup(ctx, uriOf(id))
        .catch(() => null)
      const row = await pages(ctx, sp ?? found?.spaceId ?? null).get(id)
      if (row) return row
    }
    const hits = await requireEntities()
      .search(ctx, ref, {
        schemes: ["doc"],
        ...(sp ? { space: sp } : {}),
        limit: 10,
      })
      .catch(() => null)
    const exact = hits
      ?.map(entityOfHit)
      .find((h) => h.title.trim().toLowerCase() === ref.trim().toLowerCase())
    if (exact) {
      const row = await pages(ctx, exact.spaceId ?? sp).get(exact.id)
      if (row) return row
    } else if (id) {
      // A server whose entity index is not there still resolves a page by its id.
      const row = await pages(ctx, sp ?? null)
        .get(id)
        .catch(() => null)
      if (row) return row
    }
    throw new RookeryError("NOT_FOUND", `no page ${ref} that you can see`)
  }

  /** The page's document id, making one for a page that has none. */
  const documentOf = async (ctx: Ctx, page: PageRow): Promise<string> => {
    if (page.document) return page.document
    const existing = await requireDocuments().list(ctx, uriOf(page.id))
    if (existing[0]) return existing[0].id
    const doc = await requireDocuments().create(ctx, { parent: uriOf(page.id), title: page.title })
    await pages(ctx, page.spaceId)
      .update(page.id, { document: doc.id })
      .catch(() => {})
    return doc.id
  }

  /** The children of a parent (an id or null), in order. */
  const siblings = async (
    ctx: Ctx,
    sp: string | null | undefined,
    parent: string | null,
    opts?: { template?: boolean },
  ) =>
    (
      await all(pages(ctx, sp), {
        where: { parent: parent ? uriOf(parent) : null, template: opts?.template ?? false },
      })
    ).sort(byRank)

  /** Whether the caller is an agent session principal (M2 extends `PrincipalKind` with `"agent"`). */
  const isAgent = (ctx: Ctx) => (ctx.principal?.kind as string) === "agent"

  /** Who an edit by this caller shows as in the document. */
  const author = (ctx: Ctx) => (isAgent(ctx) ? { name: `${ctx.user?.name ?? "Someone"}'s agent` } : undefined)

  /** The property definitions a page has: its parent's shared ones, then its own. */
  const defsFor = async (
    ctx: Ctx,
    page: PageRow,
  ): Promise<{ shared: PropDef[]; local: PropDef[]; parent: PageRow | null }> => {
    const pid = parentId(page)
    const parent = pid ? await pages(ctx, page.spaceId).get(pid) : null
    return { shared: defsOf(parent?.schema), local: defsOf(page.localSchema), parent }
  }

  interface CreateOpts {
    title?: string
    parent?: string | null
    space?: string | null
    /** Position among the siblings; the end by default. */
    index?: number
    icon?: string | null
    markdown?: string
    content?: unknown
    props?: Record<string, unknown>
    localSchema?: PropDef[]
    schema?: PropDef[]
    private?: boolean
    template?: boolean
    cover?: string | null
  }

  const create = async (ctx: Ctx, o: CreateOpts): Promise<PageRow> => {
    let sp = o.space ?? ctx.space
    const parentPage = o.parent ? await resolve(ctx, o.parent, sp) : null
    if (parentPage) sp = parentPage.spaceId ?? sp
    if (!sp) throw new RookeryError("INVALID", "open a space first, or name one")
    const sibs = o.template ? [] : await siblings(ctx, sp, parentPage?.id ?? null)
    const rank = o.index === undefined ? rankAfter(sibs) : rankAt(sibs, o.index)
    const values: Record<string, unknown> = {
      title: o.title?.trim() || "Untitled",
      parent: parentPage ? uriOf(parentPage.id) : null,
      rank,
      private: !!o.private,
      template: !!o.template,
    }
    if (o.icon) values.icon = o.icon
    if (o.cover) values.cover = o.cover
    if (o.schema?.length) values.schema = o.schema
    if (o.localSchema?.length) values.localSchema = o.localSchema
    const defs = [...defsOf(parentPage?.schema), ...(o.localSchema ?? [])]
    if (o.props && Object.keys(o.props).length) {
      values.props = setProps(defs, {}, o.props)
      values.links = linksOf(defs, values.props as Record<string, unknown>)
    }
    // The session that made it, in the reference index, so the agents plugin's library lists it.
    if (isAgent(ctx)) values.session = `session://${ctx.principal.id}`
    const row = await pages(ctx, sp).insert(values)
    const doc = await requireDocuments().create(ctx, {
      parent: uriOf(row.id),
      title: row.title,
      ...(o.content ? { content: o.content } : o.markdown ? { markdown: o.markdown } : {}),
    })
    return pages(ctx, sp).update(row.id, { document: doc.id })
  }

  /** Moves a page under another (or to the top) at a position among its new siblings. */
  const move = async (
    ctx: Ctx,
    id: string,
    parent: string | null,
    index: number | undefined,
    sp?: string | null,
  ) => {
    const page = await resolve(ctx, id, sp)
    const col = pages(ctx, page.spaceId)
    const target = parent ? await resolve(ctx, parent, page.spaceId) : null
    if (target && target.spaceId !== page.spaceId)
      throw new RookeryError("INVALID", "pages move within their space")
    if (target?.template) throw new RookeryError("INVALID", "a page cannot go under a template")
    if (target) {
      // Walk up from the new parent: the page must not be among its ancestors.
      const known = new Map<string, string | null>([[target.id, parentId(target)]])
      let at = parentId(target)
      while (at && !known.has(at)) {
        const row = await col.get(at)
        known.set(at, row ? parentId(row) : null)
        at = row ? parentId(row) : null
      }
      if (wouldCycle(page.id, target.id, (x) => known.get(x) ?? null))
        throw new RookeryError("INVALID", "a page cannot go inside itself")
    }
    const sibs = (await siblings(ctx, page.spaceId, target?.id ?? null)).filter((s) => s.id !== page.id)
    const rank = rankAt(sibs, index ?? sibs.length)
    return col.update(page.id, { parent: target ? uriOf(target.id) : null, rank })
  }

  /** A page and everything below it, parents first. */
  const subtree = async (ctx: Ctx, root: PageRow, opts?: { trashed?: boolean }): Promise<PageRow[]> => {
    const col = pages(ctx, root.spaceId)
    const out = [root]
    let frontier = [root.id]
    while (frontier.length) {
      const next: PageRow[] = []
      for (let i = 0; i < frontier.length; i += 500) {
        const chunk = frontier.slice(i, i + 500).map(uriOf)
        next.push(
          ...(await all(col, {
            where: { parent: { in: chunk }, ...(opts?.trashed ? { trashedWith: root.id } : {}) },
            ...(opts?.trashed ? { trashed: true } : {}),
          })),
        )
      }
      next.sort(byRank)
      out.push(...next)
      frontier = next.map((p) => p.id)
      if (out.length > 20_000) break
    }
    return out
  }

  const chunks = <T>(list: T[], n: number) =>
    Array.from({ length: Math.ceil(list.length / n) }, (_, i) => list.slice(i * n, i * n + n))

  /** Moves a page and its subpages to the trash, remembering they went together. */
  const trash = async (ctx: Ctx, id: string, sp?: string | null) => {
    const root = await resolve(ctx, id, sp)
    const tree = await subtree(ctx, root)
    const col = pages(ctx, root.spaceId)
    for (const part of chunks(tree, 400))
      await col.batch(
        part.flatMap((p) => [
          { op: "update", id: p.id, patch: { trashedWith: root.id } },
          { op: "delete", id: p.id },
        ]),
      )
    return { trashed: tree.length }
  }

  /** Brings a trashed page back with what went with it; to the top when its parent is gone. */
  const restore = async (ctx: Ctx, id: string, sp?: string | null) => {
    const col = pages(ctx, sp)
    const root = await col.get(id, { trashed: true })
    if (!root) throw new RookeryError("NOT_FOUND", "no such page in the trash")
    const group = await all(col, { where: { trashedWith: root.id }, trashed: true })
    for (const part of chunks(group, 1000)) await col.batch(part.map((p) => ({ op: "restore", id: p.id })))
    const pid = parentId(root)
    const parentOk = pid ? await col.get(pid) : null
    await col.update(root.id, { trashedWith: null, ...(pid && !parentOk ? { parent: null } : {}) })
    for (const part of chunks(
      group.filter((p) => p.id !== root.id),
      500,
    ))
      await col.batch(part.map((p) => ({ op: "update", id: p.id, patch: { trashedWith: null } })))
    return { restored: group.length || 1 }
  }

  /** Deletes a trashed page and what went with it for good, with their documents and comments. */
  const purge = async (ctx: Ctx, id: string, sp?: string | null) => {
    const col = pages(ctx, sp)
    const root = await col.get(id, { trashed: true })
    if (!root) throw new RookeryError("NOT_FOUND", "no such page in the trash")
    const group = await all(col, { where: { trashedWith: root.id }, trashed: true })
    const list = group.some((p) => p.id === root.id) ? group : [root, ...group]
    // Children first, so no row is left pointing at a purged parent.
    for (const p of list.reverse()) {
      await col.purge(p.id)
      const docs = p.document
        ? [{ id: p.document }]
        : await rookery.documents.list(ctx, uriOf(p.id)).catch(() => [])
      for (const d of docs) await rookery.documents.delete(ctx, d.id).catch(() => {})
      const notes = await all(comments(ctx, p.spaceId), { where: { page: uriOf(p.id) } }).catch(() => [])
      for (const part of chunks(notes, 1000))
        await comments(ctx, p.spaceId)
          .batch(part.map((c) => ({ op: "delete", collection: "comments", id: c.id })))
          .catch(() => {})
    }
    return { purged: list.length }
  }

  /** Copies a page (and its subpages) with their content, under `parent` (the original's by default). */
  const copyTree = async (
    ctx: Ctx,
    root: PageRow,
    opts: {
      subpages: boolean
      template?: boolean
      parent?: string | null
      title?: string
      space?: string | null
      index?: number
    },
  ) => {
    const tree = opts.subpages ? await subtree(ctx, root) : [root]
    const map = new Map<string, string>()
    let first: PageRow | null = null
    for (const p of tree) {
      const isRoot = p.id === root.id
      const docId = p.document ?? (await documentOf(ctx, p))
      const content = await docJson(ctx, docId)
      const parent = isRoot ? (opts.parent === undefined ? parentId(p) : opts.parent) : map.get(parentId(p)!)!
      const made = await create(ctx, {
        title: isRoot ? (opts.title ?? p.title) : p.title,
        parent: parent ?? null,
        space: opts.space ?? p.spaceId,
        ...(isRoot && opts.index !== undefined ? { index: opts.index } : {}),
        icon: p.icon ?? null,
        cover: p.cover ?? null,
        content,
        props: (p.props as Record<string, unknown>) ?? {},
        schema: defsOf(p.schema),
        localSchema: defsOf(p.localSchema),
        private: isRoot ? !!p.private : false,
        template: isRoot ? !!opts.template : false,
      })
      map.set(p.id, made.id)
      first ??= made
    }
    return { id: first!.id, pages: tree.length }
  }

  const duplicate = async (ctx: Ctx, id: string, subpages: boolean, sp?: string | null) => {
    const root = await resolve(ctx, id, sp)
    const sibs = await siblings(ctx, root.spaceId, parentId(root), { template: !!root.template })
    const at = sibs.findIndex((s) => s.id === root.id)
    return copyTree(ctx, root, {
      subpages,
      title: `${root.title} (copy)`,
      template: !!root.template,
      index: at + 1,
    })
  }

  // ── Templates ───────────────────────────────────────────────────────────────────────────────────

  const templates = async (ctx: Ctx, sp?: string | null) => {
    const own = sp || ctx.space ? await all(pages(ctx, sp), { where: { template: true } }) : []
    return [
      ...BUILTIN.map((t) => ({
        id: t.id,
        title: t.title,
        description: t.description,
        icon: t.icon,
        builtin: true,
      })),
      ...own
        .sort((a, b) => a.title.localeCompare(b.title))
        .map((p) => ({ id: p.id, title: p.title, description: "", icon: p.icon ?? "file", builtin: false })),
    ]
  }

  const fromTemplate = async (
    ctx: Ctx,
    template: string,
    o: { parent?: string | null; space?: string | null; index?: number; title?: string },
  ) => {
    const builtin = BUILTIN.find((t) => t.id === template)
    if (builtin) {
      const now = new Date()
      const props = Object.fromEntries(
        Object.entries(builtin.props ?? {}).map(([k, v]) => [k, typeof v === "string" ? fill(v, now) : v]),
      )
      // Under a database the template's properties join the parent's shared ones; elsewhere they are the page's own.
      const parentPage = o.parent ? await resolve(ctx, o.parent, o.space) : null
      let localSchema = builtin.schema
      if (parentPage && builtin.schema?.length) {
        const shared = defsOf(parentPage.schema)
        if (shared.length) {
          const merged = [
            ...shared,
            ...builtin.schema.filter((d) => !shared.some((s) => s.id === d.id || s.name === d.name)),
          ]
          await pages(ctx, parentPage.spaceId).update(parentPage.id, { schema: merged })
          localSchema = undefined
        }
      }
      return create(ctx, {
        title: o.title ?? fill(builtin.pageTitle, now),
        parent: o.parent ?? null,
        space: o.space ?? null,
        ...(o.index !== undefined ? { index: o.index } : {}),
        icon: builtin.icon,
        markdown: fill(builtin.markdown, now),
        ...(localSchema ? { localSchema } : {}),
        props,
      })
    }
    const t = await resolve(ctx, template, o.space)
    if (!t.template) throw new RookeryError("INVALID", `${t.title} is not a template`)
    const parentPage = o.parent ? await resolve(ctx, o.parent, o.space ?? t.spaceId) : null
    const r = await copyTree(ctx, t, {
      subpages: true,
      parent: parentPage?.id ?? null,
      space: parentPage?.spaceId ?? o.space ?? t.spaceId,
      title: o.title ?? t.title,
      template: false,
      ...(o.index !== undefined ? { index: o.index } : {}),
    })
    return (await pages(ctx, parentPage?.spaceId ?? o.space ?? t.spaceId).get(r.id))!
  }

  // ── Markdown ────────────────────────────────────────────────────────────────────────────────────

  /** Front matter values of a page: title, icon, then its properties by name. */
  const metaOf = async (ctx: Ctx, page: PageRow) => {
    const { shared, local } = await defsFor(ctx, page)
    return {
      title: page.title,
      ...(page.icon ? { icon: page.icon } : {}),
      ...toFrontMatter([...shared, ...local], page.props),
    }
  }

  /** A page as Markdown with its properties as front matter. */
  const pageMarkdown = async (ctx: Ctx, page: PageRow, withMeta = true) => {
    const body = await docMarkdown(ctx, await documentOf(ctx, page))
    return (withMeta ? stringifyFrontMatter(await metaOf(ctx, page)) : "") + body
  }

  const exportPages = async (ctx: Ctx, id: string, subpages: boolean, sp?: string | null) => {
    const root = await resolve(ctx, id, sp)
    const tree = subpages ? await subtree(ctx, root) : [root]
    const list: ExportPage[] = []
    for (const p of tree)
      list.push({
        id: p.id,
        title: p.title,
        parent: p.id === root.id ? null : parentId(p),
        markdown: await docMarkdown(ctx, await documentOf(ctx, p)),
        meta: await metaOf(ctx, p),
      })
    const names = new Map<string, string>()
    for (const p of list)
      for (const m of p.markdown.matchAll(/\]\(\/blobs\/([0-9a-zA-Z-]+)\)/g)) {
        const blob = m[1]!
        if (names.has(blob)) continue
        const info = await rookery.blobs.get(ctx, blob).catch(() => null)
        names.set(blob, info?.name ? `${blob.slice(0, 8)}-${info.name}` : blob)
      }
    return exportTree(list, (b) => names.get(b) ?? b)
  }

  /** Makes the pages of an import plan (empty), under `parent`; returns each key's page id. */
  const importPages = async (
    ctx: Ctx,
    planned: Array<Pick<PlannedPage, "key" | "title" | "parent" | "props" | "icon">>,
    o: { parent?: string | null; space?: string | null },
  ) => {
    const target = o.parent ? await resolve(ctx, o.parent, o.space) : null
    const sp = target?.spaceId ?? o.space ?? ctx.space
    if (!sp) throw new RookeryError("INVALID", "open a space first, or name one")
    const ids = new Map<string, string>()
    // Each parent's children share a schema made from their front matter.
    const byParent = new Map<string | null, typeof planned>()
    for (const p of planned) {
      const k = p.parent ?? null
      byParent.set(k, [...(byParent.get(k) ?? []), p])
    }
    const schemaFor = new Map<string | null, PropDef[]>()
    for (const [k, kids] of byParent) {
      const withProps = kids.filter((c) => Object.keys(c.props ?? {}).length)
      if (!withProps.length) continue
      const existing = k === null ? defsOf(target?.schema) : []
      schemaFor.set(
        k,
        defsFromFrontMatter(
          existing,
          withProps.map((c) => c.props),
        ),
      )
    }
    if (target && schemaFor.has(null)) await pages(ctx, sp).update(target.id, { schema: schemaFor.get(null) })
    const startSibs = await siblings(ctx, sp, target?.id ?? null)
    let topRank = rankAfter(startSibs)
    const lastRank = new Map<string, string>()
    for (const p of planned) {
      const parentKey = p.parent ?? null
      const parentPage = parentKey ? ids.get(parentKey) : target?.id
      const defs = schemaFor.get(parentKey) ?? []
      const props = defs.length ? propsFromFrontMatter(defs, p.props ?? {}) : {}
      let rank: string
      if (parentKey === null) {
        rank = topRank
        topRank = rankAfter([{ rank }])
      } else {
        rank = rankAfter(lastRank.has(parentKey) ? [{ rank: lastRank.get(parentKey)! }] : [])
        lastRank.set(parentKey, rank)
      }
      const values: Record<string, unknown> = {
        title: p.title || "Untitled",
        parent: parentPage ? uriOf(parentPage) : null,
        rank,
        ...(p.icon ? { icon: p.icon } : {}),
        ...(schemaFor.has(p.key) ? { schema: schemaFor.get(p.key) } : {}),
        ...(Object.keys(props).length ? { props, links: linksOf(defs, props) } : {}),
        ...(parentKey === null && !target && defs.length ? { localSchema: defs } : {}),
        ...(isAgent(ctx) ? { session: `session://${ctx.principal.id}` } : {}),
      }
      const row = await pages(ctx, sp).insert(values)
      const doc = await requireDocuments().create(ctx, { parent: uriOf(row.id), title: row.title })
      await pages(ctx, sp).update(row.id, { document: doc.id })
      ids.set(p.key, row.id)
    }
    return { space: sp, ids: Object.fromEntries(ids) }
  }

  /** Sets the body of imported pages from Markdown whose links already point at the new pages. */
  const importContent = async (
    ctx: Ctx,
    items: Array<{ id: string; markdown: string }>,
    sp?: string | null,
  ) => {
    for (const it of items) {
      const page = await resolve(ctx, it.id, sp)
      const doc = await documentOf(ctx, page)
      if (it.markdown.trim()) await docEdit(ctx, doc, [{ op: "setContent", markdown: it.markdown }])
    }
    return { done: items.length }
  }

  // ── Comments ────────────────────────────────────────────────────────────────────────────────────

  const comment = async (
    ctx: Ctx,
    o: {
      page: string
      body: RichText
      text: string
      anchor?: unknown
      thread?: string | null
      space?: string | null
    },
  ) => {
    const page = await resolve(ctx, o.page, o.space)
    const col = comments(ctx, page.spaceId)
    const text = o.text.trim().slice(0, 2000)
    if (!text) throw new RookeryError("INVALID", "a comment needs some text")
    const row = await col.insert({
      page: uriOf(page.id),
      thread: o.thread ?? null,
      body: o.body,
      text,
      ...(o.anchor ? { anchor: o.anchor } : {}),
    })
    const me = ctx.user?.id
    const who = ctx.user?.name ?? "Someone"
    const told = new Set<string>(me ? [me] : [])
    const send = async (user: string, line: string) => {
      if (told.has(user)) return
      told.add(user)
      await rookery.notify
        .send({ user, kind: "info", title: line, resource: `doc-comment://${row.id}` })
        .catch((e) => rookery.log.warn(`notify ${user}: ${e}`))
    }
    for (const uri of mentions(o.body)) {
      if (uri.startsWith("user://"))
        await send(uri.slice(7), `${who} mentioned you in a comment on ${page.title}`)
    }
    if (o.thread) {
      const thread = await all(col, { where: { or: [{ thread: o.thread }] } })
      const root = await col.get(o.thread)
      for (const c of [root, ...thread])
        if (c?.createdBy) await send(c.createdBy, `${who} replied on ${page.title}`)
    } else if (page.createdBy) await send(page.createdBy, `${who} commented on ${page.title}`)
    return row
  }

  // ── Agent-facing operations ─────────────────────────────────────────────────────────────────────

  const read = async (ctx: Ctx, ref: string, sp?: string | null) => {
    const page = await resolve(ctx, ref, sp)
    return {
      id: page.id,
      uri: uriOf(page.id),
      title: page.title,
      space: page.spaceId,
      markdown: await pageMarkdown(ctx, page),
    }
  }

  const search = async (ctx: Ctx, text: string, o: { space?: string | null; limit?: number }) => {
    const entities = requireEntities()
    const hits = await entities.search(ctx, text, {
      schemes: ["doc"],
      ...(o.space ? { space: o.space } : {}),
      limit: o.limit ?? 20,
    })
    return hits
      .map(entityOfHit)
      .filter((h) => !h.deletedAt)
      .map((h) => ({ id: h.id, uri: h.uri, title: h.title, space: h.spaceId, parent: h.parent }))
  }

  const list = async (ctx: Ctx, o: { page?: string | null; space?: string | null; depth?: number }) => {
    const root = o.page ? await resolve(ctx, o.page, o.space) : null
    const sp = root?.spaceId ?? o.space ?? ctx.space
    if (!sp) throw new RookeryError("INVALID", "open a space first, or name one")
    const depth = Math.max(1, Math.min(o.depth ?? 3, 10))
    const out: Array<{ id: string; uri: string; title: string; depth: number; parent: string | null }> = []
    let frontier: Array<string | null> = [root?.id ?? null]
    for (let d = 0; d < depth && frontier.length; d++) {
      const next: string[] = []
      for (const f of frontier) {
        for (const p of await siblings(ctx, sp, f)) {
          out.push({ id: p.id, uri: uriOf(p.id), title: p.title, depth: d, parent: f })
          next.push(p.id)
        }
      }
      frontier = next
      if (out.length > 2000) break
    }
    return { space: sp, pages: out }
  }

  const append = async (ctx: Ctx, ref: string, markdown: string, sp?: string | null) => {
    const page = await resolve(ctx, ref, sp)
    const blocks = (await docEdit(ctx, await documentOf(ctx, page), [{ op: "appendMarkdown", markdown }]))
      .blocks
    return { id: page.id, blocks }
  }

  /** Replaces the blocks under a heading (until the next heading of the same or a higher level). */
  const replaceSection = async (
    ctx: Ctx,
    ref: string,
    heading: string,
    markdown: string,
    sp?: string | null,
  ) => {
    const page = await resolve(ctx, ref, sp)
    const doc = await documentOf(ctx, page)
    const json = await docJson(ctx, doc)
    const blocks = json.content ?? []
    const want = heading
      .replace(/^#+\s*/, "")
      .trim()
      .toLowerCase()
    const text = (n: (typeof blocks)[number]): string =>
      (n.content ?? []).map((c) => (c.type === "text" ? (c.text ?? "") : text(c))).join("")
    const at = blocks.findIndex((b) => b.type === "heading" && text(b).trim().toLowerCase() === want)
    if (at < 0) {
      // No such section: add it at the end.
      const level = 2
      await docEdit(ctx, doc, [
        {
          op: "appendMarkdown",
          markdown: `${"#".repeat(level)} ${heading.replace(/^#+\s*/, "")}\n\n${markdown}`,
        },
      ])
      return { id: page.id, added: true }
    }
    const level = Number(blocks[at]!.attrs?.level ?? 1)
    let end = at + 1
    while (
      end < blocks.length &&
      !(blocks[end]!.type === "heading" && Number(blocks[end]!.attrs?.level ?? 1) <= level)
    )
      end++
    if (end > at + 1) await docEdit(ctx, doc, [{ op: "replaceBlocks", from: at + 1, to: end, markdown }])
    else await docEdit(ctx, doc, [{ op: "insert", at: at + 1, markdown }])
    return { id: page.id, added: false }
  }

  /** Sets properties by name; names the page does not have yet become properties of its own. */
  const setProperties = async (
    ctx: Ctx,
    ref: string,
    values: Record<string, unknown>,
    sp?: string | null,
  ) => {
    const page = await resolve(ctx, ref, sp)
    const found = await defsFor(ctx, page)
    // Copies, so new options can be added and the definitions saved where they live when they changed.
    const clone = (list: PropDef[]) =>
      list.map((d) => ({ ...d, ...(d.options ? { options: d.options.map((o) => ({ ...o })) } : {}) }))
    const shared = clone(found.shared)
    const localDefs = clone(found.local)
    const patch: Record<string, unknown> = {}
    for (const [name, raw] of Object.entries(values)) {
      let def = [...shared, ...localDefs].find((d) => d.name.toLowerCase() === name.toLowerCase())
      if (!def) {
        def = { id: newId(), name, type: inferType([raw]) }
        if (def.type === "select" || def.type === "multi") def.options = []
        localDefs.push(def)
      }
      let v = raw
      if (def.type === "select" || def.type === "multi") {
        const names = (Array.isArray(raw) ? raw : [raw])
          .filter((x) => x !== null && x !== undefined)
          .map(String)
        def.options ??= []
        const options = def.options
        for (const n of names)
          if (!options.some((o) => o.name === n)) options.push({ id: newId("o"), name: n })
        const ids = names.map((n) => options.find((o) => o.name === n)!.id)
        v = def.type === "select" ? ids[0] : ids
      }
      patch[def.id] = raw === null ? null : (normalize(def, v) ?? null)
    }
    const defs = [...shared, ...localDefs]
    const props = setProps(defs, page.props, patch)
    if (found.parent && JSON.stringify(shared) !== JSON.stringify(found.shared))
      await pages(ctx, page.spaceId).update(found.parent.id, { schema: shared })
    const row = await pages(ctx, page.spaceId).update(page.id, {
      props,
      links: linksOf(defs, props),
      ...(JSON.stringify(localDefs) !== JSON.stringify(found.local) ? { localSchema: localDefs } : {}),
    })
    return { id: row.id, properties: toFrontMatter(defs, props) }
  }

  // ── Registration ────────────────────────────────────────────────────────────────────────────────

  const ok = <T extends z.ZodRawShape>(shape: T) => z.object(shape)
  const rpc = <T extends z.ZodRawShape>(
    name: string,
    shape: T,
    run: (ctx: Ctx, p: z.infer<z.ZodObject<T>>) => unknown,
  ) => rookery.rpc.handle(name, { level: "own", params: ok(shape), run: (ctx, p) => run(ctx, p as never) })

  rpc(
    "create",
    {
      title: z.string().optional(),
      parent: z.string().nullable().optional(),
      space,
      index: z.number().int().optional(),
      template: z.string().optional(),
      markdown: z.string().optional(),
      private: z.boolean().optional(),
    },
    async (ctx, p) => {
      const row = p.template
        ? await fromTemplate(ctx, p.template, {
            parent: p.parent ?? null,
            space: p.space ?? null,
            ...(p.index !== undefined ? { index: p.index } : {}),
            ...(p.title ? { title: p.title } : {}),
          })
        : await create(ctx, {
            title: p.title,
            parent: p.parent ?? null,
            space: p.space ?? null,
            ...(p.index !== undefined ? { index: p.index } : {}),
            ...(p.markdown ? { markdown: p.markdown } : {}),
            private: p.private,
          })
      return { id: row.id, spaceId: row.spaceId, document: row.document, title: row.title }
    },
  )
  rpc("document", { id: z.string(), space }, async (ctx, p) => ({
    id: await documentOf(ctx, await resolve(ctx, p.id, p.space)),
  }))
  rpc(
    "move",
    { id: z.string(), parent: z.string().nullable(), index: z.number().int().optional(), space },
    async (ctx, p) => {
      const row = await move(ctx, p.id, p.parent, p.index, p.space)
      return { id: row.id, parent: row.parent, rank: row.rank }
    },
  )
  rpc("trash", { id: z.string(), space }, (ctx, p) => trash(ctx, p.id, p.space))
  rpc("restore", { id: z.string(), space }, (ctx, p) => restore(ctx, p.id, p.space))
  rpc("purge", { id: z.string(), space }, (ctx, p) => purge(ctx, p.id, p.space))
  rpc("emptyTrash", { space }, async (ctx, p) => {
    const roots = (
      await all(pages(ctx, p.space), { trashed: true, where: { trashedWith: { ne: null } } })
    ).filter((r) => r.trashedWith === r.id)
    let n = 0
    for (const r of roots) n += (await purge(ctx, r.id, p.space)).purged
    return { purged: n }
  })
  rpc("duplicate", { id: z.string(), subpages: z.boolean().default(false), space }, (ctx, p) =>
    duplicate(ctx, p.id, p.subpages, p.space),
  )
  rpc("templates", { space }, (ctx, p) => templates(ctx, p.space))
  rpc("saveTemplate", { id: z.string(), subpages: z.boolean().default(true), space }, async (ctx, p) => {
    const root = await resolve(ctx, p.id, p.space)
    return copyTree(ctx, root, { subpages: p.subpages, template: true, parent: null })
  })
  rpc("exportMarkdown", { id: z.string(), subpages: z.boolean().default(true), space }, (ctx, p) =>
    exportPages(ctx, p.id, p.subpages, p.space),
  )
  rpc(
    "importPages",
    {
      parent: z.string().nullable().optional(),
      space,
      pages: z.array(
        z.object({
          key: z.string(),
          title: z.string(),
          parent: z.string().nullable(),
          props: z.record(z.string(), z.unknown()).default({}),
          icon: z.string().optional(),
        }),
      ),
    },
    (ctx, p) => importPages(ctx, p.pages, { parent: p.parent ?? null, space: p.space ?? null }),
  )
  rpc(
    "importContent",
    { items: z.array(z.object({ id: z.string(), markdown: z.string() })), space },
    (ctx, p) => importContent(ctx, p.items, p.space),
  )
  rpc(
    "comment",
    {
      page: z.string(),
      body: z.any(),
      text: z.string(),
      anchor: z.any().optional(),
      thread: z.string().nullable().optional(),
      space,
    },
    async (ctx, p) => {
      const row = await comment(ctx, {
        page: p.page,
        body: p.body as RichText,
        text: p.text,
        anchor: p.anchor,
        thread: p.thread ?? null,
        space: p.space ?? null,
      })
      return { id: row.id }
    },
  )
  rpc("markdown", { id: z.string(), space }, async (ctx, p) => ({
    markdown: await pageMarkdown(ctx, await resolve(ctx, p.id, p.space)),
  }))
  // Where a page is linked from (any plugin, through the reference index) with the text around the link, and
  // places that name its title without linking to it.
  rpc("backlinks", { page: z.string(), space }, async (ctx, p) => {
    const page = await resolve(ctx, p.page, p.space)
    const uri = uriOf(page.id)
    const refs = await ctx.data.refs.to(uri)
    const seen = new Set<string>()
    const linked = refs
      // The page's own comments point at it as their parent; they are not links to it.
      .filter(
        (r) =>
          r.source !== uri &&
          !r.source.startsWith("doc-comment://") &&
          !seen.has(r.source) &&
          !!seen.add(r.source),
      )
      .slice(0, 50)
    const texts = await requireEntities()
      .text(
        ctx,
        linked.slice(0, 20).map((r) => r.source),
        { maxChars: 20_000 },
      )
      .catch(() => null)
    const textOf = new Map((texts?.texts ?? []).map((t) => [t.uri, t.text]))
    const around = (text: string | undefined, needles: string[]) => {
      if (!text) return null
      for (const n of needles) {
        const i = n ? text.toLowerCase().indexOf(n.toLowerCase()) : -1
        if (i < 0) continue
        const start = Math.max(0, text.lastIndexOf("\n", i) + 1, i - 90)
        const endNl = text.indexOf("\n", i + n.length)
        const end = Math.min(text.length, endNl < 0 ? text.length : endNl, i + n.length + 90)
        return (
          (start > 0 ? "…" : "") +
          text
            .slice(start, end)
            .replace(/\[([^\]]*)\]\(doc:\/\/[^)]+\)/g, "$1")
            .replace(/\s+/g, " ")
            .trim() +
          (end < text.length ? "…" : "")
        )
      }
      return null
    }
    let unlinked: Array<{ uri: string; title: string; snippet: string | null }> = []
    if (page.title.trim().length >= 3 && page.title !== "Untitled") {
      const hits = await requireEntities()
        .search(ctx, page.title, { limit: 12 })
        .catch(() => [])
      const candidates = hits
        .map(entityOfHit)
        .filter(
          (h) =>
            h.uri !== uri &&
            !seen.has(h.uri) &&
            h.scheme !== "document" &&
            h.scheme !== "doc-comment" &&
            !h.deletedAt &&
            h.title.trim().toLowerCase() !== page.title.trim().toLowerCase(),
        )
      const more = await requireEntities()
        .text(
          ctx,
          candidates.slice(0, 8).map((h) => h.uri),
          { maxChars: 20_000 },
        )
        .catch(() => null)
      unlinked = (more?.texts ?? [])
        .map((t) => ({
          uri: t.uri,
          title: t.title ?? candidates.find((c) => c.uri === t.uri)?.title ?? t.uri,
          snippet: around(t.text, [page.title]),
        }))
        .filter((u) => u.snippet)
    }
    return {
      linked: linked.map((r) => ({
        source: r.source,
        title: r.title ?? r.source,
        icon: r.icon,
        field: r.field,
        snippet: around(textOf.get(r.source), [uri, `@${page.title}`, page.title]),
      })),
      unlinked,
    }
  })

  // The pages above one, top first, as far as the caller can see them.
  rpc("ancestors", { id: z.string(), space }, async (ctx, p) => {
    const page = await resolve(ctx, p.id, p.space)
    const col = pages(ctx, page.spaceId)
    const out: PageRow[] = []
    const seen = new Set([page.id])
    let at = parentId(page)
    while (at && !seen.has(at) && out.length < 64) {
      seen.add(at)
      const row = await col.get(at)
      if (!row) break
      out.unshift(row)
      at = parentId(row)
    }
    return { ancestors: out.map((r) => ({ id: r.id, title: r.title, icon: r.icon ?? null })) }
  })

  // Commands: the palette, and agents through `commands.run` (and as tools once the agents plugin serves them).
  // The operations agents use are commands (the palette, `commands.run`) and tools (the MCP server agents
  // reach), with the same params and the same code.
  const both = <S extends z.ZodTypeAny>(
    id: string,
    def: { params: S; run: (ctx: Ctx, p: z.infer<S>) => unknown },
  ) => {
    rookery.commands.register(id as never, def as never)
    const agents = (rookery as typeof rookery & { agents?: { tool?: (id: string, def: unknown) => unknown } })
      .agents
    agents?.tool?.(id, { params: def.params, run: def.run })
  }
  both("docs.create", {
    params: z.object({
      title: z.string().optional().describe("The page's title"),
      parent: z.string().optional().describe("A page to put it under"),
      space,
      markdown: z.string().optional().describe("The page's body"),
      properties: z.record(z.string(), z.unknown()).optional().describe("Properties by name"),
      template: z
        .string()
        .optional()
        .describe(
          "A template id (builtin:meeting, builtin:decision, builtin:runbook, builtin:weekly) or a template page",
        ),
    }),
    async run(ctx, p) {
      const row = p.template
        ? await fromTemplate(ctx, p.template, {
            parent: p.parent ?? null,
            space: p.space ?? null,
            ...(p.title ? { title: p.title } : {}),
          })
        : await create(ctx, {
            title: p.title,
            parent: p.parent ?? null,
            space: p.space ?? null,
            ...(p.markdown ? { markdown: p.markdown } : {}),
          })
      if (p.properties && Object.keys(p.properties).length)
        await setProperties(ctx, row.id, p.properties, row.spaceId)
      if (p.template && p.markdown) await append(ctx, row.id, p.markdown, row.spaceId)
      return { id: row.id, uri: uriOf(row.id), title: row.title, space: row.spaceId }
    },
  })
  both("docs.read", {
    params: z.object({ page: pageRef, space }),
    run: (ctx, p) => read(ctx, p.page, p.space),
  })
  both("docs.search", {
    params: z.object({
      text: z.string().describe("Words to look for"),
      space,
      limit: z.number().int().optional(),
    }),
    run: async (ctx, p) => ({
      pages: await search(ctx, p.text, { space: p.space ?? null, ...(p.limit ? { limit: p.limit } : {}) }),
    }),
  })
  both("docs.list", {
    params: z.object({
      page: pageRef.optional(),
      space,
      depth: z.number().int().optional().describe("Levels below, 3 by default"),
    }),
    run: (ctx, p) =>
      list(ctx, { page: p.page ?? null, space: p.space ?? null, ...(p.depth ? { depth: p.depth } : {}) }),
  })
  both("docs.append", {
    params: z.object({ page: pageRef, markdown: z.string().describe("Markdown to add at the end"), space }),
    run: (ctx, p) => append(ctx, p.page, p.markdown, p.space),
  })
  both("docs.replaceSection", {
    params: z.object({
      page: pageRef,
      heading: z.string().describe("The heading's text; the section is added when there is none"),
      markdown: z.string().describe("The section's new content, without the heading"),
      space,
    }),
    run: (ctx, p) => replaceSection(ctx, p.page, p.heading, p.markdown, p.space),
  })
  both("docs.setProperties", {
    params: z.object({
      page: pageRef,
      properties: z.record(z.string(), z.unknown()).describe("Values by property name"),
      space,
    }),
    run: (ctx, p) => setProperties(ctx, p.page, p.properties, p.space),
  })

  // The service other plugins (and the agents plugin's tools) call with their ctx.
  rookery.services.provide(api.services.docs, {
    read: (ctx, p) => read(ctx, p.page, p.space),
    search: (ctx, p) => search(ctx, p.text, p),
    list: (ctx, p) => list(ctx, p),
    create: async (ctx, p) => {
      const row = await create(ctx, p as CreateOpts)
      if (p.properties) await setProperties(ctx, row.id, p.properties, row.spaceId)
      return { id: row.id, uri: uriOf(row.id), title: row.title, space: row.spaceId }
    },
    append: (ctx, p) => append(ctx, p.page, p.markdown, p.space),
    replaceSection: (ctx, p) => replaceSection(ctx, p.page, p.heading, p.markdown, p.space),
    setProperties: (ctx, p) => setProperties(ctx, p.page, p.properties, p.space),
    exportMarkdown: (ctx, p) => exportPages(ctx, p.page, p.subpages ?? true, p.space),
  })
})
