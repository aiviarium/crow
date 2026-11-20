// The Docs workspace: the page tree of every space the user is in (teamspaces, then their private pages), the
// pinned pages, templates and the trash in the view's sidebar; a page, or the home of Docs (recent pages,
// templates, search, trash) beside it. The layout is @aiviarium/nocturne's ViewLayout, which every plugin uses:
// the tree resizes, collapses to a rail (and opens over the page when the frame is narrow, as on a phone).
import {
  Dialog,
  EmptyState,
  Icon,
  Menu,
  type MenuEntry,
  Popover,
  RowMenu,
  usePhone,
  ViewLayout,
} from "@aiviarium/nocturne"
import type { PinInfo, SpaceInfo } from "@rookery/sdk/client"
import {
  type Accessor,
  batch,
  createEffect,
  createMemo,
  createResource,
  createSignal,
  For,
  type JSX,
  on,
  onCleanup,
  type Setter,
  Show,
  untrack,
} from "solid-js"
import { planImport, rewriteLinks } from "../lib/mdio"
import { uriOf } from "../lib/tree"
import { unzip, text as utf8, zip } from "../lib/zip"
import { type ClientRookeryWithDocs, entityOfHit } from "../types"
import { type Api, download, iconOf, openEntity, type Page, stored } from "./api"
import { AskHost, ask, confirmAsk } from "./ask"
import { type PageActions, type PageParts, PageView } from "./Page"
import { PageIcon, SpaceTree, type TreeContext } from "./Tree"

const expandedPref = stored<string[]>("expanded", [])

// The spaces the user is in and their pins, as last listed: a workspace that mounts again (the home, then a page)
// starts with them, so the tree is whole on its first frame.
let knownSpaces: SpaceInfo[] | undefined
let knownPins: PinInfo[] | undefined

/** The spaces of pages opened from a row that says it, so the page view need not look them up (`spaceOfPage`). */
const pageSpaces = new Map<string, string>()

/** The space of a page opened from the tree or a list, if known: the page then mounts without a lookup. */
export function spaceOfPage(page: string): SpaceInfo | undefined {
  const id = pageSpaces.get(page)
  return id ? knownSpaces?.find((s) => s.id === id) : undefined
}

/** A page mounted in the workspace: the one shown, or the next one loading behind it. */
interface PageSlot {
  id: string
  space: SpaceInfo
  parts: Accessor<PageParts | undefined>
  setParts: Setter<PageParts | undefined>
  timer?: ReturnType<typeof setTimeout>
}

/** How long the page shown stays while the next one loads; a slower page shows as it loads. */
const NEXT_PAGE_WAIT_MS = 1200

/** Reads files picked from a folder or a .zip into paths and contents. */
export async function readPicked(files: File[]): Promise<Array<{ path: string; data: Uint8Array }>> {
  const out: Array<{ path: string; data: Uint8Array }> = []
  for (const f of files) {
    const path = (f as File & { webkitRelativePath?: string }).webkitRelativePath || f.name
    const data = new Uint8Array(await f.arrayBuffer())
    if (/\.zip$/i.test(f.name)) out.push(...(await unzip(data)))
    else out.push({ path, data })
  }
  return out
}

/** Imports Markdown files (and the images they use) under a page or at the top of a space. */
export async function importFiles(
  rookery: ClientRookeryWithDocs,
  api: Api,
  files: Array<{ path: string; data: Uint8Array }>,
  target: { parent: string | null; space: string },
  progress: (done: number, total: number) => void,
): Promise<{ pages: number; root: string | null }> {
  const dec = new TextDecoder()
  const md = files
    .filter((f) => /\.(md|markdown)$/i.test(f.path))
    .map((f) => ({ path: f.path, text: dec.decode(f.data) }))
  const plan = planImport(md)
  if (!plan.length) throw new Error("No Markdown files there.")
  // Images and other files the pages use become blobs of the space.
  const assets = new Map<string, string>()
  const others = files.filter(
    (f) => !/\.(md|markdown)$/i.test(f.path) && !f.path.split("/").some((p) => p.startsWith(".")),
  )
  const used = (p: string) => md.some((m) => m.text.includes(p.split("/").pop()!))
  const usedOthers = others.filter((f) => used(f.path))
  if (usedOthers.length && !rookery.blobs.upload) {
    throw new Error("Uploading imported images requires Rookery blobs (M2b).")
  }
  for (const f of usedOthers) {
    const name = f.path.split("/").pop()!
    const b = await rookery.blobs.upload!(new Blob([f.data as BlobPart]), { name, space: target.space })
    assets.set(f.path.replace(/\\/g, "/"), `/blobs/${b.id}`)
  }
  const asset = (p: string) => assets.get(p) ?? [...assets].find(([k]) => k.endsWith(`/${p}`) || k === p)?.[1]
  const total = plan.length
  const made = await api.importPages({
    parent: target.parent,
    space: target.space,
    pages: plan.map((p) => ({
      key: p.key,
      title: p.title,
      parent: p.parent,
      props: p.props,
      ...(p.icon ? { icon: p.icon } : {}),
    })),
  })
  progress(0, total)
  const byTitle = new Map<string, string>()
  for (const p of plan)
    if (!byTitle.has(p.title.toLowerCase())) byTitle.set(p.title.toLowerCase(), made.ids[p.key]!)
  const items = plan.map((p) => ({
    id: made.ids[p.key]!,
    markdown: rewriteLinks(
      p,
      (k) => made.ids[k],
      (t) => byTitle.get(t.toLowerCase()),
      asset,
    ),
  }))
  for (let i = 0; i < items.length; i += 10) {
    await api.importContent(items.slice(i, i + 10), made.space)
    progress(Math.min(total, i + 10), total)
  }
  return { pages: total, root: made.ids[plan[0]!.key] ?? null }
}

export interface WorkspaceProps {
  rookery: ClientRookeryWithDocs
  api: Api
  space: SpaceInfo | null | undefined
  /** The page that is open, if any. */
  page?: string
  setTitle: (t: string) => void
  /** Marks the tab while the open page has edits the kernel has not confirmed. */
  setDirty?: (dirty: boolean) => void
  /** Opens the import dialog (the "Import Markdown into Docs" command). */
  importOnOpen?: boolean
  /** The home's header (a ViewHeader), when it has something to say. */
  header?: JSX.Element
  children?: JSX.Element
}

export function Workspace(props: WorkspaceProps): JSX.Element {
  const rookery = props.rookery
  const api = props.api
  const [spaces, setSpaces] = createSignal<SpaceInfo[] | undefined>(knownSpaces)
  rookery.spaces
    .list()
    .then((list) => {
      knownSpaces = list
      setSpaces(list)
    })
    .catch(() => setSpaces((s) => s ?? []))
  const teamspaces = createMemo(() => (spaces() ?? []).filter((s) => !s.personal))
  const personal = createMemo(() => (spaces() ?? []).find((s) => s.personal))

  // Open tree nodes, remembered; the current space and the open page's ancestors open by themselves.
  const [expanded, setExpanded] = createSignal(new Set(expandedPref.get()))
  const toggle = (id: string, open?: boolean) => {
    const now = untrack(expanded)
    const want = open ?? !now.has(id)
    if (want === now.has(id)) return
    const next = new Set(now)
    if (want) next.add(id)
    else next.delete(id)
    setExpanded(next)
    expandedPref.set([...next].slice(-400))
  }
  createEffect(() => {
    if (props.space) toggle(`space:${props.space.id}`, true)
  })
  const [ancestors] = createResource(
    () => (props.page && props.space ? [props.page, props.space.id] : null),
    ([id, sp]) =>
      api
        .ancestors(id!, sp)
        .then((r) => r.ancestors.map((a) => a.id))
        .catch(() => []),
  )
  createEffect(() => {
    for (const id of ancestors() ?? []) toggle(id, true)
  })

  // Favourites: the user's pins of pages.
  const [pins, setPins] = createSignal<PinInfo[] | undefined>(knownPins)
  const refetchPins = () =>
    rookery.pins
      .list()
      .then((list) => {
        knownPins = list
        setPins(list)
      })
      .catch(() => setPins((p) => p ?? []))
  void refetchPins()
  onCleanup(() => rookery.pins.onChange(() => void refetchPins()).dispose())
  const favourites = () =>
    (pins() ?? []).filter((p) => p.kind === "entity" && p.target.startsWith("doc://") && !p.spaceId)
  const pinned = (page: Page) => favourites().some((p) => p.target === uriOf(page.id))

  const [menu, setMenu] = createSignal<{ page: Page; el: HTMLElement; at?: { x: number; y: number } } | null>(
    null,
  )
  const phone = usePhone()
  const [moving, setMoving] = createSignal<Page | null>(null)
  const [importing, setImporting] = createSignal<{ parent: Page | null; space: string } | null>(null)

  createEffect(() => {
    if (props.importOnOpen && props.space) setImporting({ parent: null, space: props.space.id })
  })

  const open = (page: Page | { id: string }) => {
    if ("spaceId" in page && page.spaceId) pageSpaces.set(page.id, page.spaceId)
    openEntity(rookery, uriOf(page.id))
  }
  const newPage = async (space: SpaceInfo | { id: string }, parent: string | null) => {
    try {
      const made = await api.create({ parent, space: space.id })
      if (parent) toggle(parent, true)
      open(made)
    } catch (e: any) {
      rookery.workbench.toast({ title: "No page was made", body: String(e?.message ?? e), kind: "danger" })
    }
  }

  const actions: PageActions = {
    newPage,
    async duplicate(page, subpages) {
      const r = await api.duplicate(page.id, subpages, page.spaceId)
      open(r)
    },
    moveTo: (page) => setMoving(page),
    async trash(page) {
      const r = await api.trash(page.id, page.spaceId)
      rookery.workbench.toast({
        title: `${page.title} is in the trash`,
        body:
          r.trashed > 1
            ? `With ${r.trashed - 1} subpages. Restore them from the trash.`
            : "Restore it from the trash.",
      })
      if (props.page === page.id) rookery.workbench.openView("docs.home")
    },
    async exportPage(page, subpages) {
      const out = await api.exportMarkdown(page.id, subpages, page.spaceId)
      if (!subpages && out.files.length === 1 && !out.attachments.length) {
        download(out.files[0]!.path.split("/").pop()!, out.files[0]!.text, "text/markdown")
        return
      }
      const entries = out.files.map((f) => ({ path: f.path, data: utf8(f.text) }))
      for (const a of out.attachments) {
        const res = await fetch(rookery.blobs.url(a.blob))
        if (res.ok) entries.push({ path: a.path, data: new Uint8Array(await res.arrayBuffer()) })
      }
      download(`${out.files[0]!.path.replace(/\.md$/, "")}.zip`, zip(entries), "application/zip")
    },
    importInto: (page, space) => setImporting({ parent: page, space }),
    async saveTemplate(page) {
      const withSubpages = await confirmAsk(`Save ${page.title} as a template?`, {
        description: "New pages can start from it. Its subpages come along.",
        confirm: "Save template",
      })
      if (!withSubpages) return
      await api.saveTemplate(page.id, true, page.spaceId)
      rookery.workbench.toast({
        title: "Saved as a template",
        body: "Pick it when making a new page.",
        kind: "success",
      })
    },
    async togglePin(page) {
      const mine = favourites().find((p) => p.target === uriOf(page.id))
      if (mine) await rookery.pins.remove(mine.id)
      else
        await rookery.pins.add({
          kind: "entity",
          target: uriOf(page.id),
          title: page.title,
          icon: iconOf(page.icon).name,
        })
      refetchPins()
    },
    pinned,
  }

  const ctx: TreeContext = {
    rookery,
    api,
    current: () => props.page ?? null,
    isOpen: (id) => expanded().has(id),
    toggle,
    openPage: open,
    newPage: (space, parent) => void newPage(space, parent),
    menu: (page, el, at) => setMenu({ page, el, at }),
  }

  const treeMenu = (): MenuEntry[] => [
    { id: "open", label: "Open", icon: "file" },
    { id: "new", label: "Add a page inside", icon: "plus" },
    { id: "rename", label: "Rename", icon: "edit" },
    { id: "duplicate", label: "Duplicate", icon: "layers" },
    { id: "move", label: "Move to…", icon: "arrow-right" },
    {
      id: "pin",
      label: menu() && pinned(menu()!.page) ? "Remove from the sidebar" : "Add to the sidebar",
      icon: "star",
    },
    { id: "export", label: "Export as Markdown", icon: "folder" },
    { type: "separator" },
    { id: "trash", label: "Move to trash", icon: "trash", danger: true },
  ]
  const onTreeMenu = async (id: string) => {
    const m = menu()
    setMenu(null)
    if (!m) return
    const p = m.page
    if (id === "open") open(p)
    else if (id === "new") await newPage({ id: p.spaceId }, p.id)
    else if (id === "rename") {
      const t = (await ask("Rename the page", { value: p.title }))?.trim()
      if (t) await rookery.data.space(p.spaceId).pages.update(p.id, { title: t } as never)
    } else if (id === "duplicate") await actions.duplicate(p, true)
    else if (id === "move") actions.moveTo(p)
    else if (id === "pin") await actions.togglePin(p)
    else if (id === "export") await actions.exportPage(p, true)
    else if (id === "trash") await actions.trash(p)
  }

  const [search, setSearch] = createSignal("")
  const goSearch = () => rookery.workbench.openView("docs.home", { path: "search", params: { q: search() } })

  // One tree for whichever the workspace shows, a page or the home.
  const sidebar = (
    <div class="docs-side" data-part="tree">
      <form
        class="docs-side__search"
        onSubmit={(e) => {
          e.preventDefault()
          goSearch()
        }}
      >
        <Icon name="search" size="sm" />
        <input
          class="docs-side__input body"
          placeholder="Search docs"
          aria-label="Search docs"
          value={search()}
          onInput={(e) => setSearch(e.currentTarget.value)}
          data-part="docs-search"
        />
      </form>
      <nav class="docs-side__quick" aria-label="Docs">
        <button type="button" class="docs-side__link" onClick={() => rookery.workbench.openView("docs.home")}>
          <Icon name="clock" size="sm" /> Recent
        </button>
        <button
          type="button"
          class="docs-side__link"
          onClick={() => rookery.workbench.openView("docs.home", { path: "templates" })}
          data-part="templates-link"
        >
          <Icon name="layers" size="sm" /> Templates
        </button>
        <button
          type="button"
          class="docs-side__link"
          onClick={() => setImporting({ parent: null, space: props.space?.id ?? personal()?.id ?? "" })}
          data-part="import-link"
        >
          <Icon name="folder" size="sm" /> Import
        </button>
      </nav>
      <div class="docs-tree" role="tree" aria-label="Page tree">
        <Show when={favourites().length}>
          <span class="nc-nav__label docs-side__label">Pinned</span>
          <For each={favourites()}>
            {(f) => (
              <button
                type="button"
                class="docs-tree__row docs-tree__row--flat"
                classList={{ "docs-tree__row--active": f.target === uriOf(props.page ?? "") }}
                onClick={() => open({ id: f.target.slice(6) })}
                data-favorite={f.target}
              >
                <span class="docs-tree__chevron" />
                <span class="docs-tree__open">
                  <PageIcon icon={f.entity?.icon ?? f.icon} />
                  <span class="docs-tree__title">{f.entity?.title ?? f.title}</span>
                </span>
              </button>
            )}
          </For>
        </Show>
        <Show when={teamspaces().length}>
          <span class="nc-nav__label docs-side__label">Teamspaces</span>
          <For each={teamspaces()}>{(s) => <SpaceTree ctx={ctx} space={s} />}</For>
        </Show>
        <Show when={personal()}>
          {(s) => (
            <>
              <span class="nc-nav__label docs-side__label">Private</span>
              <SpaceTree ctx={ctx} space={s()} label="My pages" />
            </>
          )}
        </Show>
      </div>
      <button
        type="button"
        class="docs-side__link docs-side__trash"
        onClick={() => rookery.workbench.openView("docs.home", { path: "trash" })}
        data-part="trash-link"
      >
        <Icon name="trash" size="sm" /> Trash
      </button>
    </div>
  )

  // Pages: the one shown (front) and, while another loads, that one behind it. The shown page stays until the
  // next has its row and its body (PageView's onReady), so a click in the tree never shows an empty column.
  const [slots, setSlots] = createSignal<PageSlot[]>([])
  const [front, setFront] = createSignal<PageSlot | null>(null)
  const show = (slot: PageSlot) => {
    if (untrack(front) === slot || !untrack(slots).includes(slot)) return
    clearTimeout(slot.timer)
    batch(() => {
      setFront(slot)
      setSlots([slot])
    })
  }
  createEffect(
    on([() => props.page, () => props.space] as const, ([id, space]) => {
      const shown = untrack(front)
      if (!id) {
        for (const s of untrack(slots)) clearTimeout(s.timer)
        batch(() => {
          setSlots([])
          setFront(null)
        })
        return
      }
      // The page's space is still being found: what is shown stays.
      if (!space) return
      const same = (s: PageSlot) => s.id === id && s.space.id === space.id
      if (shown && same(shown)) {
        for (const s of untrack(slots)) if (s !== shown) clearTimeout(s.timer)
        setSlots([shown])
        return
      }
      if (untrack(slots).some((s) => s !== shown && same(s))) return
      const [parts, setParts] = createSignal<PageParts>()
      const slot: PageSlot = { id, space, parts, setParts }
      for (const s of untrack(slots)) if (s !== shown) clearTimeout(s.timer)
      if (!shown) {
        batch(() => {
          setSlots([slot])
          setFront(slot)
        })
        return
      }
      slot.timer = setTimeout(() => show(slot), NEXT_PAGE_WAIT_MS)
      setSlots([shown, slot])
    }),
  )
  onCleanup(() => {
    for (const s of untrack(slots)) clearTimeout(s.timer)
  })
  const parts = () => (props.page ? front()?.parts() : undefined)

  // One layout for the home and every page, so the tree and the columns never mount again as pages change.
  return (
    <div class="docs" data-part="docs">
      <AskHost />
      <ViewLayout
        id="docs"
        sidebar={sidebar}
        sidebarLabel="Pages"
        header={props.page ? parts()?.header() : props.header}
        aside={parts()?.aside()}
        asideLabel={parts()?.asideLabel()}
        asideRequest={parts()?.asideRequest()}
        asideWidth={parts()?.asideWidth()}
        scroll={props.page ? false : undefined}
        minMain={props.page ? 640 : undefined}
      >
        <Show when={props.page} fallback={props.children}>
          <Show
            when={slots().length > 0 || !spaces() || !!props.space}
            fallback={
              <div class="docs-empty" data-part="page-unavailable">
                <EmptyState
                  icon="file"
                  title="Page unavailable"
                  description="Opening Docs pages requires Rookery spaces (M2b)."
                />
              </div>
            }
          >
            <For each={slots()}>
              {(slot) => (
                <PageView
                  rookery={rookery}
                  api={api}
                  actions={actions}
                  id={slot.id}
                  space={slot.space}
                  setTitle={props.setTitle}
                  setDirty={props.setDirty}
                  parts={slot.setParts}
                  hidden={front() !== slot}
                  onReady={() => show(slot)}
                />
              )}
            </For>
          </Show>
        </Show>
      </ViewLayout>
      <Popover
        open={!!menu() && !menu()?.at}
        anchor={menu()?.el}
        onClose={() => setMenu(null)}
        placement="bottom-start"
      >
        <Menu
          label="Page"
          minWidth="220px"
          items={treeMenu()}
          onSelect={onTreeMenu}
          onRequestClose={() => setMenu(null)}
        />
      </Popover>
      {/* A right click opens the same menu at the pointer. */}
      <Show when={menu()?.at}>
        {(at) => (
          <RowMenu
            at={at()}
            phone={phone()}
            label="Page"
            items={treeMenu()}
            origin={menu()?.el}
            onClose={() => setMenu(null)}
            onSelect={(id) => void onTreeMenu(id)}
          />
        )}
      </Show>
      <Show when={moving()}>
        {(p) => (
          <MoveDialog
            rookery={rookery}
            api={api}
            page={p()}
            spaces={spaces() ?? []}
            onClose={() => setMoving(null)}
          />
        )}
      </Show>
      <Show when={importing()}>
        {(t) => (
          <ImportDialog
            rookery={rookery}
            api={api}
            target={t()}
            onClose={() => setImporting(null)}
            onDone={(root) => root && open({ id: root })}
          />
        )}
      </Show>
    </div>
  )
}

/** Picks a new parent for a page: another page of its space, or the top of the space. */
function MoveDialog(props: {
  rookery: ClientRookeryWithDocs
  api: Api
  page: Page
  spaces: SpaceInfo[]
  onClose: () => void
}): JSX.Element {
  const [q, setQ] = createSignal("")
  const [hits] = createResource(q, async (text) => {
    if (!props.rookery.entities) return []
    const raw = await props.rookery.entities
      .search(text, { schemes: ["doc"], space: props.page.spaceId, limit: 20 })
      .catch(() => [])
    return raw.map(entityOfHit)
  })
  const space = () => props.spaces.find((s) => s.id === props.page.spaceId)
  const move = async (parent: string | null) => {
    try {
      await props.api.move(props.page.id, parent, undefined, props.page.spaceId)
      props.rookery.workbench.toast({ title: "Moved", kind: "success" })
      props.onClose()
    } catch (e: any) {
      props.rookery.workbench.toast({ title: "Not moved", body: String(e?.message ?? e), kind: "danger" })
    }
  }
  return (
    <Dialog
      open={true}
      onClose={props.onClose}
      title={`Move ${props.page.title}`}
      description="Choose where it goes. Its subpages come along."
      data-part="move-dialog"
    >
      <input
        class="nc-input docs-move__search"
        placeholder="Search pages"
        aria-label="Search pages"
        value={q()}
        onInput={(e) => setQ(e.currentTarget.value)}
        ref={(el) => queueMicrotask(() => el.focus())}
      />
      <div class="docs-move__list">
        <button type="button" class="docs-move__item" onClick={() => move(null)} data-target="top">
          <Icon name="layers" size="sm" />
          <span>Top of {space()?.personal ? "my pages" : (space()?.name ?? "the space")}</span>
        </button>
        <For each={(hits() ?? []).filter((h) => h.id !== props.page.id && !h.deletedAt)}>
          {(h) => (
            <button type="button" class="docs-move__item" onClick={() => move(h.id)} data-target={h.id}>
              <PageIcon icon={h.icon} />
              <span>{h.title}</span>
            </button>
          )}
        </For>
      </div>
    </Dialog>
  )
}

/** Imports a folder of Markdown files or a .zip. */
function ImportDialog(props: {
  rookery: ClientRookeryWithDocs
  api: Api
  target: { parent: Page | null; space: string }
  onClose: () => void
  onDone: (root: string | null) => void
}): JSX.Element {
  const [state, setState] = createSignal<{ done: number; total: number } | null>(null)
  const [error, setError] = createSignal<string | null>(null)
  const run = async (files: File[]) => {
    setError(null)
    try {
      const picked = await readPicked(files)
      setState({ done: 0, total: picked.length })
      const r = await importFiles(
        props.rookery,
        props.api,
        picked,
        { parent: props.target.parent?.id ?? null, space: props.target.space },
        (done, total) => setState({ done, total }),
      )
      props.rookery.workbench.toast({ title: `Imported ${r.pages} pages`, kind: "success" })
      props.onClose()
      props.onDone(r.root)
    } catch (e: any) {
      setError(String(e?.message ?? e))
      setState(null)
    }
  }
  return (
    <Dialog
      open={true}
      onClose={props.onClose}
      title="Import Markdown"
      description={`Into ${props.target.parent ? props.target.parent.title : "the top of the space"}. Folders become pages with subpages, front matter becomes properties, links between the files stay links. An Obsidian vault or a docs folder works as it is.`}
      data-part="import-dialog"
    >
      <div class="docs-import">
        <label class="docs-import__drop">
          <Icon name="folder" size="sm" />
          <span class="label">Choose a folder</span>
          <input
            type="file"
            class="docs-import__input"
            multiple
            {...({ webkitdirectory: "" } as object)}
            onChange={(e) => run([...(e.currentTarget.files ?? [])])}
            data-part="import-folder"
          />
        </label>
        <label class="docs-import__drop">
          <Icon name="file" size="sm" />
          <span class="label">Choose Markdown files or a .zip</span>
          <input
            type="file"
            class="docs-import__input"
            multiple
            accept=".md,.markdown,.zip,image/*"
            onChange={(e) => run([...(e.currentTarget.files ?? [])])}
            data-part="import-files"
          />
        </label>
        <Show when={state()}>
          {(s) => (
            <p class="nc-meta">
              Importing… {s().done} of {s().total}
            </p>
          )}
        </Show>
        <Show when={error()}>
          <p class="docs-error">{error()}</p>
        </Show>
      </div>
    </Dialog>
  )
}
