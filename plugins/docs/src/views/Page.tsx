// A page: breadcrumbs, who is here, the cover and icon, the title, its properties, the body in the shared
// editor (`page` variant, at reading width or full width), its subpages, where it is linked from, and a side
// panel with comments, history and the outline. Everything is live: the row through a live query, the body
// through the collaborative document.
import {
  AvatarStack,
  Button,
  type EditorServices,
  EmptyState,
  Icon,
  IconButton,
  type MenuEntry,
  Popover,
  quoteOf,
  RichTextEditor,
  type RichTextEditorHandle,
  Tabs,
  useEditorServices,
  type ViewAction,
  ViewHeader,
} from "@aiviarium/nocturne"
import type { SpaceInfo } from "@rookery/sdk/client"
import {
  createEffect,
  createMemo,
  createResource,
  createSignal,
  For,
  type JSX,
  on,
  onCleanup,
  Show,
  untrack,
} from "solid-js"
import { defsOf, HUES } from "../lib/props"
import { byRank } from "../lib/rank"
import { parentId, uriOf } from "../lib/tree"
import { type ClientRookeryWithDocs, type DocumentSession, entityOfHit } from "../types"
import { type Api, ago, ICON_CHOICES, iconOf, openEntity, type Page, stored, userNames } from "./api"
import { ask } from "./ask"
import { type Anchor, type CommentRow, CommentsPanel, commentCount } from "./Comments"
import { EntityChip } from "./Entity"
import { HistoryPanel } from "./History"
import { PropsTable } from "./Props"
import { dragStart, PageIcon } from "./Tree"

export interface PageActions {
  newPage(space: SpaceInfo | { id: string }, parent: string | null): Promise<void> | void
  duplicate(page: Page, subpages: boolean): void
  moveTo(page: Page): void
  trash(page: Page): void
  exportPage(page: Page, subpages: boolean): void
  importInto(page: Page | null, space: string): void
  saveTemplate(page: Page): void
  togglePin(page: Page): void
  pinned(page: Page): boolean
}

const COVERS = ["dots", "accent", "sky", "teal", "mint", "amber", "rose", "orchid"]

type Panel = "comments" | "history" | "outline" | null
const panelPref = stored<Panel>("panel", null)

/** The page's body: the editor on the document, with comments anchored in it. */
function PageBody(props: {
  rookery: ClientRookeryWithDocs
  api: Api
  page: Page
  document: string
  wide: boolean
  comments: () => CommentRow[]
  activeComment: () => string | null
  onComment: (a: Anchor) => void
  onActiveComment: (id: string) => void
  onSession: (s: DocumentSession | null) => void
  onView: (h: RichTextEditorHandle | null) => void
  onUpdate: () => void
}): JSX.Element {
  const docs = props.rookery.documents
  if (!docs) {
    return (
      <div class="docs-body" data-part="page-body">
        <EmptyState
          icon="file"
          title="Document collaboration requires Rookery documents (M2b)"
          description="Page metadata and hierarchy are active; collaborative rich-text editing connects once M2b documents land."
        />
      </div>
    )
  }
  const session = docs.open(props.document)
  props.onSession(session)
  onCleanup(() => {
    props.onSession(null)
    props.onView(null)
    session.close()
  })
  const base = useEditorServices()
  const services: EditorServices = {
    ...base,
    links: {
      search: async (q) => {
        if (!props.rookery.entities) return []
        const raw = await props.rookery.entities.search(q, { schemes: ["doc"], limit: 8 }).catch(() => [])
        return raw
          .map(entityOfHit)
          .filter((h) => !h.deletedAt && h.id !== props.page.id)
          .map((h) => ({ uri: h.uri, title: h.title, subtitle: "Page", icon: iconOf(h.icon).name }))
      },
      create: async (title) => {
        const made = await props.api.create({ title, parent: props.page.id, space: props.page.spaceId })
        return { uri: uriOf(made.id), title: made.title }
      },
    },
  }
  const annotations = () =>
    props
      .comments()
      .filter((c) => !c.thread && !c.resolved && c.anchor?.quote)
      .map((c) => ({
        id: c.id,
        quote: c.anchor!.quote,
        prefix: c.anchor!.prefix ?? "",
        active: props.activeComment() === c.id,
      }))
  return (
    <div class="docs-body" data-part="page-body" data-status={session.status()}>
      <Show when={session.status() === "error"}>
        <p class="docs-error">{session.error()?.message}</p>
      </Show>
      <RichTextEditor
        provider={session}
        variant="page"
        services={services}
        aria-label="Page"
        placeholder="Write something. Type / for blocks, @ to mention, [[ to link a page."
        class={props.wide ? "docs-editor docs-editor--wide" : "docs-editor"}
        annotations={annotations()}
        onAnnotationClick={props.onActiveComment}
        selectionActions={[
          {
            id: "comment",
            label: "Comment",
            icon: "chat",
            run: (view) => {
              const { from, to } = view.state.selection
              if (from === to) return
              props.onComment(quoteOf(view.state.doc, from, to))
            },
          },
        ]}
        onUpdate={() => props.onUpdate()}
        ref={(h) => props.onView(h)}
        onError={(m) => props.rookery.workbench.toast({ title: m, kind: "danger" })}
      />
    </div>
  )
}

/** The outline: the page's headings, the one being read marked. */
function Outline(props: {
  headings: () => Array<{ level: number; text: string; pos: number }>
  active: () => number
  go: (pos: number) => void
}): JSX.Element {
  return (
    <nav class="docs-outline" aria-label="On this page" data-part="outline">
      <span class="nc-nav__label">On this page</span>
      <For each={props.headings()}>
        {(h, i) => (
          <button
            type="button"
            class="docs-outline__item"
            classList={{ "docs-outline__item--active": props.active() === i() }}
            style={{ "padding-inline-start": `${8 + (h.level - 1) * 12}px` }}
            onClick={() => props.go(h.pos)}
          >
            {h.text || "Untitled heading"}
          </button>
        )}
      </For>
    </nav>
  )
}

/** Links to the page from anywhere in Rookery, with the text around each, and unlinked mentions of its title. */
function Backlinks(props: { rookery: ClientRookeryWithDocs; api: Api; page: Page }): JSX.Element {
  const [tick, setTick] = createSignal(0)
  const timer = setInterval(() => setTick((t) => t + 1), 5000)
  onCleanup(() => clearInterval(timer))
  const [links] = createResource(
    () => [props.page.id, props.page.title, tick()] as const,
    ([id]) => props.api.backlinks(id, props.page.spaceId).catch(() => ({ linked: [], unlinked: [] })),
  )
  const [showUnlinked, setShowUnlinked] = createSignal(false)
  // Nothing links here and nothing mentions it: no section at all.
  return (
    <Show when={links()?.linked.length || links()?.unlinked.length}>
      <section class="docs-backlinks" data-part="backlinks" aria-label="Linked from">
        <div class="docs-section-head">
          <span class="nc-nav__label">Linked from</span>
          <span class="nc-meta">{links()?.linked.length || ""}</span>
        </div>
        <Show when={links()?.linked.length}>
          <ul class="docs-backlinks__list">
            <For each={links()!.linked}>
              {(l) => (
                <li class="docs-backlink" data-source={l.source}>
                  <EntityChip rookery={props.rookery} uri={l.source} label={l.title} />
                  <Show when={l.snippet}>
                    <span class="docs-backlink__snippet body">{l.snippet}</span>
                  </Show>
                </li>
              )}
            </For>
          </ul>
        </Show>
        <Show when={links()?.unlinked.length}>
          <button
            type="button"
            class="docs-backlinks__toggle nc-meta"
            onClick={() => setShowUnlinked((s) => !s)}
            data-part="unlinked-toggle"
          >
            <Icon name={showUnlinked() ? "chevron-down" : "chevron-right"} size="sm" />
            {links()!.unlinked.length} unlinked mentions
          </button>
          <Show when={showUnlinked()}>
            <ul class="docs-backlinks__list">
              <For each={links()!.unlinked}>
                {(u) => (
                  <li class="docs-backlink docs-backlink--unlinked">
                    <EntityChip rookery={props.rookery} uri={u.uri} label={u.title} />
                    <span class="docs-backlink__snippet body">{u.snippet}</span>
                  </li>
                )}
              </For>
            </ul>
          </Show>
        </Show>
      </section>
    </Show>
  )
}

/** The subpages, and a line to add one. */
function Subpages(props: {
  rookery: ClientRookeryWithDocs
  api: Api
  page: Page
  readOnly: boolean
  open: (p: Page) => void
}): JSX.Element {
  const live = props.rookery.data
    .space(props.page.spaceId)
    .pages.live({ where: { parent: uriOf(props.page.id), template: false }, limit: 200 })
  const kids = createMemo(() => ([...live()] as unknown as Page[]).sort(byRank))
  const [title, setTitle] = createSignal("")
  const add = async () => {
    const t = title().trim()
    if (!t) return
    setTitle("")
    await props.api.create({ title: t, parent: props.page.id, space: props.page.spaceId })
  }
  return (
    <section class="docs-subpages" data-part="subpages" aria-label="Subpages">
      <Show when={kids().length}>
        <div class="docs-section-head">
          <span class="nc-nav__label">Subpages</span>
          <span class="nc-meta">{kids().length || ""}</span>
        </div>
      </Show>
      <For each={kids()}>
        {(k) => (
          <button
            type="button"
            class="docs-subpage"
            data-page={k.id}
            onClick={() => props.open(k)}
            draggable={true}
            onDragStart={(e) => dragStart(e, k)}
          >
            <PageIcon icon={k.icon} />
            <span class="docs-subpage__title">{k.title}</span>
            <span class="nc-meta">{ago(k.updatedAt)}</span>
          </button>
        )}
      </For>
      <Show when={!props.readOnly}>
        <form
          class="docs-subpage docs-subpage--new"
          onSubmit={(e) => {
            e.preventDefault()
            void add()
          }}
        >
          <Icon name="plus" size="sm" />
          <input
            class="docs-subpage__input body"
            placeholder="Add a subpage"
            aria-label="New subpage title"
            value={title()}
            onInput={(e) => setTitle(e.currentTarget.value)}
            data-part="new-subpage"
          />
        </form>
      </Show>
    </section>
  )
}

/**
 * What a page puts in the workspace's layout besides its main column. The workspace keeps one `ViewLayout` for
 * every page, so the tree and the columns stay put as pages change; the shown page's parts fill its slots.
 */
export interface PageParts {
  header: () => JSX.Element
  aside: () => JSX.Element
  asideLabel: () => string
  asideRequest: () => number
  asideWidth: () => number
}

export function PageView(props: {
  rookery: ClientRookeryWithDocs
  api: Api
  actions: PageActions
  id: string
  space: SpaceInfo
  setTitle: (t: string) => void
  setDirty?: (dirty: boolean) => void
  /** Hands the workspace the header and the panel for its layout. */
  parts: (parts: PageParts) => void
  /**
   * The page is loading behind the one shown: it renders out of sight and leaves the tab's title and mark
   * alone until it is shown.
   */
  hidden?: boolean
  /** The page has what it shows on its first frame: the row, and the body synced and measured (or failed). */
  onReady?: () => void
}): JSX.Element {
  const rookery = props.rookery
  const pages = () => rookery.data.space(props.space.id).pages
  const live = pages().live({ where: { id: props.id } })
  const page = () => live()[0] as unknown as Page | undefined
  const [trashed] = createResource(
    () => (!live.loading && !page() ? props.id : null),
    (id) => (pages().get(id, { trashed: true }) as unknown as Promise<Page | null>).catch(() => null),
  )
  const name = userNames(rookery)

  // The parent row, live, for shared properties and the breadcrumbs.
  const parentLive = createMemo(() => {
    const pid = page() ? parentId(page()!) : null
    return pid ? pages().live({ where: { id: pid } }) : null
  })
  const parent = () => (parentLive()?.()[0] as unknown as Page | undefined) ?? null
  const [ancestors] = createResource(
    () => [page()?.id, page()?.parent, parent()?.title] as const,
    ([id]) =>
      id
        ? props.api
            .ancestors(id, props.space.id)
            .then((r) => r.ancestors)
            .catch(() => [])
        : [],
  )

  createEffect(() => {
    const p = page()
    if (p && !props.hidden) props.setTitle(p.title)
  })

  // Title: edits save after a pause; someone else's title shows unless this window has unsaved edits.
  const [title, setTitle] = createSignal("")
  const [dirty, setDirty] = createSignal(false)
  createEffect(
    on(
      () => page()?.title,
      (t) => {
        if (t !== undefined && !dirty()) setTitle(t)
      },
    ),
  )
  let titleTimer: ReturnType<typeof setTimeout> | undefined
  const saveTitle = async () => {
    titleTimer = undefined
    if (!dirty() || !page()) return
    const t = title().trim() || "Untitled"
    try {
      await pages().update(page()!.id, { title: t } as never)
    } catch (e: any) {
      rookery.workbench.toast({
        title: "The title was not saved",
        body: String(e?.message ?? e),
        kind: "danger",
      })
    }
    setDirty(false)
  }
  onCleanup(() => {
    if (titleTimer) {
      clearTimeout(titleTimer)
      void saveTitle()
    }
  })

  // The document (made on first open for a page that has none).
  const [doc] = createResource(
    () => (rookery.documents && page() && !page()!.document ? page()!.id : null),
    (id) => props.api.document(id, props.space.id),
  )
  const documentId = () => page()?.document ?? doc()?.id

  // The editor and the people in the document.
  const [session, setSession] = createSignal<DocumentSession | null>(null)
  const [handle, setHandle] = createSignal<RichTextEditorHandle | null>(null)
  const [people, setPeople] = createSignal<Array<{ name: string; agent: boolean }>>([])
  createEffect(() => {
    const s = session()
    if (!s) return setPeople([])
    const update = () => {
      const out: Array<{ name: string; agent: boolean }> = []
      s.awareness.getStates().forEach((st, client) => {
        if (client !== s.doc.clientID && st?.user?.name)
          out.push({ name: String(st.user.name), agent: /agent/i.test(String(st.user.name)) })
      })
      setPeople(out)
    }
    update()
    s.awareness.on("change", update)
    onCleanup(() => s.awareness.off("change", update))
  })
  const readOnly = () => !!session()?.readOnly?.()
  // Edits the kernel has not confirmed mark the tab (plugins.md, view.setDirty). When the page goes they are
  // kept for its next session, which sends them, so the mark goes with the page.
  createEffect(() => !props.hidden && props.setDirty?.(!!session()?.unsynced()))

  // Outline and word count, from the editor's document.
  const [headings, setHeadings] = createSignal<Array<{ level: number; text: string; pos: number }>>([])
  const [words, setWords] = createSignal(0)
  let updateTimer: ReturnType<typeof setTimeout> | undefined
  const recount = () => {
    updateTimer = undefined
    const h = handle()
    if (!h) return
    const out: Array<{ level: number; text: string; pos: number }> = []
    h.view.state.doc.forEach((n, pos) => {
      if (n.type.name === "heading") out.push({ level: Number(n.attrs.level ?? 1), text: n.textContent, pos })
    })
    setHeadings(out)
    const text = h.view.state.doc.textBetween(0, h.view.state.doc.content.size, " ", " ")
    setWords(text.split(/\s+/).filter(Boolean).length)
  }
  const onUpdate = () => {
    updateTimer ??= setTimeout(recount, 250)
  }
  createEffect(on(handle, () => setTimeout(recount, 50)))
  onCleanup(() => updateTimer && clearTimeout(updateTimer))
  // Once the body has synced, its outline and word count are measured at once rather than after the update's
  // pause, so the page is ready (and shown) with its panel and meta line as they stay.
  const [measured, setMeasured] = createSignal(false)
  createEffect(() => {
    const synced = session()?.status() === "synced"
    if (!synced || !handle() || untrack(measured)) return
    const t = setTimeout(() => {
      recount()
      setMeasured(true)
    })
    onCleanup(() => clearTimeout(t))
  })
  const ready = createMemo(() => {
    if (live.loading) return false
    if (!page()) return trashed.state === "ready" || trashed.state === "errored"
    // The breadcrumbs: the parent row (its title is part of what they are fetched with), then the ancestors.
    if (parentLive()?.loading || ancestors.loading) return false
    if (!rookery.documents) return true
    const st = session()?.status()
    return st === "error" || st === "offline" || (st === "synced" && measured())
  })
  createEffect(() => ready() && props.onReady?.())
  const [activeHeading, setActiveHeading] = createSignal(0)
  let scroller!: HTMLDivElement
  const onScroll = () => {
    const h = handle()
    if (!h) return
    const top = scroller.getBoundingClientRect().top + 80
    let best = 0
    headings().forEach((x, i) => {
      const dom = h.view.nodeDOM(x.pos) as HTMLElement | null
      if (dom && dom.getBoundingClientRect().top <= top) best = i
    })
    setActiveHeading(best)
  }
  const goTo = (pos: number) => {
    const h = handle()
    const dom = h?.view.nodeDOM(pos) as HTMLElement | null
    dom?.scrollIntoView({ block: "start", behavior: "smooth" })
  }

  // Comments.
  const commentsLive = createMemo(() =>
    page()
      ? rookery.data.space(props.space.id).comments.live({ where: { page: uriOf(props.id) }, limit: 500 })
      : null,
  )
  const comments = () => (commentsLive()?.() ?? []) as unknown as CommentRow[]
  const [pending, setPending] = createSignal<Anchor | null>(null)
  const [activeComment, setActiveComment] = createSignal<string | null>(null)
  const [panel, setPanelRaw] = createSignal<Panel>(panelPref.get())
  // Choosing a panel opens the layout's right-hand panel, also after the person collapsed it.
  const [asideRequest, setAsideRequest] = createSignal(0)
  const setPanel = (p: Panel) => {
    setPanelRaw(p)
    panelPref.set(p)
    if (p) setAsideRequest((n) => n + 1)
  }
  const openComment = (id: string) => {
    setActiveComment(id)
    setPanel("comments")
    queueMicrotask(() =>
      document.querySelector(`[data-thread="${id}"]`)?.scrollIntoView({ block: "nearest" }),
    )
  }
  // A link to a comment (`?comment=`) opens it.
  createEffect(() => {
    const c = new URLSearchParams(location.search).get("comment")
    if (c && comments().some((x) => x.id === c)) openComment(c)
  })
  createEffect(
    on(activeComment, (id) => {
      if (!id) return
      queueMicrotask(() =>
        document
          .querySelector(`[data-part="page-body"] [data-annotation="${id}"]`)
          ?.scrollIntoView({ block: "center", behavior: "smooth" }),
      )
    }),
  )

  // Icon and cover.
  const [iconOpen, setIconOpen] = createSignal(false)
  const [coverOpen, setCoverOpen] = createSignal(false)
  const [_menuOpen, setMenuOpen] = createSignal(false)
  let iconBtn!: HTMLButtonElement
  let coverBtn!: HTMLButtonElement
  let _moreBtn!: HTMLButtonElement
  const update = (patch: Record<string, unknown>) =>
    pages()
      .update(props.id, patch as never)
      .catch((e: any) =>
        rookery.workbench.toast({ title: "Not saved", body: String(e?.message ?? e), kind: "danger" }),
      )
  const uploadCover = () => {
    if (!rookery.blobs.upload) {
      rookery.workbench.toast({ title: "Image upload requires Rookery blobs (M2b)", kind: "warning" })
      return
    }
    const upload = rookery.blobs.upload
    const input = document.createElement("input")
    input.type = "file"
    input.accept = "image/*"
    input.onchange = async () => {
      const f = input.files?.[0]
      if (!f) return
      const b = await upload(f, { space: props.space.id, pin: true, name: f.name })
      await update({ cover: `/blobs/${b.id}` })
      setCoverOpen(false)
    }
    input.click()
  }

  const menuItems = (): MenuEntry[] => {
    const p = page()!
    return [
      { id: "duplicate", label: "Duplicate", icon: "layers" },
      { id: "duplicateAll", label: "Duplicate with subpages", icon: "layers" },
      { id: "move", label: "Move to…", icon: "arrow-right" },
      { id: "wide", label: p.wide ? "Reading width" : "Full width", icon: "grid", checked: !!p.wide },
      { type: "separator" },
      { id: "template", label: "Save as a template", icon: "star" },
      { id: "export", label: "Export as Markdown", icon: "file" },
      { id: "exportAll", label: "Export with subpages (.zip)", icon: "folder" },
      { id: "import", label: "Import Markdown here…", icon: "folder" },
      { id: "link", label: "Copy link", icon: "link" },
      { type: "separator" },
      {
        id: "private",
        label: p.private ? "Share like its parent again" : "Make private",
        description: p.private
          ? "Everyone who can see the parent sees it"
          : "Only you and people you share it with",
        icon: "lock",
      },
      { id: "trash", label: "Move to trash", icon: "trash", danger: true },
    ]
  }
  const onMenu = async (id: string) => {
    setMenuOpen(false)
    const p = page()!
    const a = props.actions
    if (id === "duplicate") a.duplicate(p, false)
    else if (id === "duplicateAll") a.duplicate(p, true)
    else if (id === "move") a.moveTo(p)
    else if (id === "wide") await update({ wide: !p.wide })
    else if (id === "template") a.saveTemplate(p)
    else if (id === "export") a.exportPage(p, false)
    else if (id === "exportAll") a.exportPage(p, true)
    else if (id === "import") a.importInto(p, p.spaceId)
    else if (id === "link") {
      await navigator.clipboard?.writeText(`${location.origin}/e/doc/${p.id}`).catch(() => {})
      rookery.workbench.toast({ title: "Link copied", kind: "success" })
    } else if (id === "private") await update({ private: !p.private })
    else if (id === "trash") a.trash(p)
  }

  const defsShared = () => defsOf(parent()?.schema)
  const defsLocal = () => defsOf(page()?.localSchema)
  const minutes = () => Math.max(1, Math.round(words() / 220))

  const overflow = (): ViewAction[] =>
    menuItems()
      .filter((m) => "id" in m && "label" in m)
      .map((m) => {
        const item = m as { id: string; label: string; icon?: never; danger?: boolean }
        return {
          id: item.id,
          label: item.label,
          icon: item.icon,
          danger: item.danger,
          overflow: true,
          onClick: () => void onMenu(item.id),
        }
      })
  const actions = (p: Page): ViewAction[] => [
    ...(rookery.workbench.share
      ? [{ id: "share", label: "Share", onClick: () => rookery.workbench.share?.(uriOf(p.id)) }]
      : []),
    {
      id: "comments",
      label: "Comments",
      icon: "chat",
      count: commentCount(comments()),
      pressed: panel() === "comments",
      onClick: () => setPanel(panel() === "comments" ? null : "comments"),
    },
    {
      id: "history",
      label: "History",
      icon: "clock",
      pressed: panel() === "history",
      onClick: () => setPanel(panel() === "history" ? null : "history"),
    },
    ...overflow(),
  ]
  // Where the page is (its space and the pages above it: the tab already has its title), and what is out of the
  // ordinary about it: private, being edited, other people in it.
  // Built once: what it shows follows the row by itself, so an open menu in it stays open while others edit.
  // Made inside the layout (a getter in its props), so it finds the layout's panel toggle.
  const header = () => (
    <Show when={page()}>
      {(row) => (
        <ViewHeader
          crumbs={[
            { label: props.space.personal ? "Private" : props.space.name },
            ...(ancestors() ?? []).map((a) => ({
              label: a.title,
              onClick: () => openEntity(rookery, uriOf(a.id)),
            })),
          ]}
          context={
            <>
              <Show when={row().private}>
                <span class="docs-crumbs__lock nc-meta" title="Only you and people you share it with">
                  <Icon name="lock" size="sm" /> Private
                </span>
              </Show>
              <Show when={dirty()}>
                <span class="nc-meta" data-testid="edited">
                  Editing…
                </span>
              </Show>
              <Show when={people().length}>
                <span
                  data-part="presence"
                  title={people()
                    .map((x) => x.name)
                    .join(", ")}
                >
                  <AvatarStack
                    people={people().map((x) => ({
                      name: x.name,
                      ...(x.agent ? { kind: "agent" as const } : {}),
                    }))}
                    size="sm"
                  />
                </span>
              </Show>
            </>
          }
          actions={actions(row())}
        />
      )}
    </Show>
  )
  // The right-hand panel: comments or history when chosen, otherwise the outline of a page with headings.
  const asideMode = createMemo(() =>
    !page() ? null : panel() ? panel() : headings().length > 1 ? ("outline" as const) : null,
  )
  // Made again only when what it shows changes, not on every edit of the row.
  const aside = () => {
    const mode = asideMode()
    if (!mode) return undefined
    return untrack(() =>
      mode === "outline" && !panel() ? (
        <div class="docs-aside">
          <Outline headings={headings} active={activeHeading} go={goTo} />
        </div>
      ) : (
        panelView()
      ),
    )
  }
  const panelView = () => {
    const p = page()!
    return (
      <div class="docs-panel" data-part="side-panel">
        <div class="docs-panel__tabs">
          <Tabs
            variant="underline"
            label="Panel"
            items={[
              { id: "comments", label: "Comments", count: commentCount(comments()) || undefined },
              { id: "history", label: "History" },
              { id: "outline", label: "Outline" },
            ]}
            value={panel()!}
            onChange={(v) => setPanel(v as Panel)}
          />
          <IconButton icon="close" label="Close the panel" onClick={() => setPanel(null)} />
        </div>
        <div class="docs-panel__body">
          <Show when={panel() === "comments"}>
            <CommentsPanel
              rookery={rookery}
              api={props.api}
              page={p}
              comments={comments}
              pending={pending}
              clearPending={() => setPending(null)}
              active={activeComment}
              setActive={setActiveComment}
              name={name}
            />
          </Show>
          <Show when={panel() === "history" && (documentId() || !rookery.documents)}>
            <HistoryPanel
              rookery={rookery}
              document={documentId() ?? p.id}
              readOnly={readOnly()}
              who={(pr) => (pr?.startsWith("user:") ? name(pr.slice(5)) : name(pr))}
            />
          </Show>
          <Show when={panel() === "outline"}>
            <Outline headings={headings} active={activeHeading} go={goTo} />
          </Show>
        </div>
      </div>
    )
  }

  props.parts({
    header,
    aside,
    asideLabel: () => (panel() === "comments" ? "Comments" : panel() === "history" ? "History" : "Outline"),
    asideRequest,
    asideWidth: () => (panel() ? 280 : 220),
  })

  return (
    <div
      class="docs-page"
      classList={{ "docs-page--hidden": !!props.hidden }}
      data-part={props.hidden ? "page-next" : "page"}
      data-page={props.id}
      aria-hidden={props.hidden ? "true" : undefined}
    >
      <Show when={!live.loading && !page()}>
        <Show
          when={trashed()}
          fallback={
            <EmptyState
              icon="file"
              title="This page is not available"
              description="It was deleted for good, or it is not shared with you."
            />
          }
        >
          <EmptyState
            icon="trash"
            title="This page is in the trash"
            description="Restore it to read and edit it again."
          >
            <Button
              variant="primary"
              onClick={async () => {
                await props.api.restore(trashed()!.trashedWith ?? props.id, props.space.id)
              }}
            >
              Restore
            </Button>
          </EmptyState>
        </Show>
      </Show>
      <Show when={page()}>
        {(p) => (
          <div class="docs-page__scroll" ref={scroller} onScroll={onScroll}>
            <Show when={p().cover}>
              {(c) => (
                <div
                  class="docs-cover"
                  data-cover={c().startsWith("/blobs/") ? "image" : c()}
                  style={c().startsWith("/blobs/") ? { "background-image": `url(${c()})` } : undefined}
                  data-part="cover"
                />
              )}
            </Show>
            <article
              class="docs-article"
              classList={{ "docs-article--wide": !!p().wide, "docs-article--cover": !!p().cover }}
            >
              <div class="docs-article__top">
                <button
                  ref={iconBtn}
                  type="button"
                  class="docs-article__icon"
                  aria-label="Change icon"
                  disabled={readOnly()}
                  onClick={() => setIconOpen(true)}
                  data-part="page-icon"
                >
                  <PageIcon icon={p().icon} size="lg" />
                </button>
                <Show when={!readOnly()}>
                  <div class="docs-article__tools">
                    <button type="button" class="docs-link-btn nc-meta" onClick={() => setIconOpen(true)}>
                      Change icon
                    </button>
                    <button
                      ref={coverBtn}
                      type="button"
                      class="docs-link-btn nc-meta"
                      onClick={() => setCoverOpen(true)}
                      data-part="cover-button"
                    >
                      {p().cover ? "Change cover" : "Add cover"}
                    </button>
                    <button type="button" class="docs-link-btn nc-meta" onClick={() => setPanel("comments")}>
                      Add comment
                    </button>
                  </div>
                </Show>
              </div>
              <Popover
                open={iconOpen()}
                anchor={iconBtn}
                onClose={() => setIconOpen(false)}
                placement="bottom-start"
              >
                <div class="docs-picker" data-part="icon-picker">
                  <div class="docs-picker__grid">
                    <For each={ICON_CHOICES}>
                      {(n) => (
                        <button
                          type="button"
                          class="docs-picker__cell"
                          aria-label={n}
                          onClick={() =>
                            update({
                              icon: `${n}${iconOf(p().icon).hue ? `:${iconOf(p().icon).hue}` : ""}`,
                            })
                          }
                        >
                          <Icon name={n as never} size="sm" />
                        </button>
                      )}
                    </For>
                  </div>
                  <div class="docs-picker__hues">
                    <For each={HUES}>
                      {(h) => (
                        <button
                          type="button"
                          class="docs-picker__hue"
                          data-hue={h === "neutral" ? undefined : h}
                          aria-label={`Colour ${h}`}
                          onClick={() =>
                            update({ icon: `${iconOf(p().icon).name}${h === "neutral" ? "" : `:${h}`}` })
                          }
                        />
                      )}
                    </For>
                  </div>
                </div>
              </Popover>
              <Popover
                open={coverOpen()}
                anchor={coverBtn}
                onClose={() => setCoverOpen(false)}
                placement="bottom-start"
              >
                <div class="docs-picker" data-part="cover-picker">
                  <div class="docs-picker__covers">
                    <For each={COVERS}>
                      {(c) => (
                        <button
                          type="button"
                          class="docs-cover docs-cover--swatch"
                          data-cover={c}
                          aria-label={`Cover ${c}`}
                          onClick={() => {
                            void update({ cover: c })
                            setCoverOpen(false)
                          }}
                        />
                      )}
                    </For>
                  </div>
                  <div class="docs-picker__row">
                    <Button size="sm" variant="secondary" icon="plus" onClick={uploadCover}>
                      Upload an image
                    </Button>
                    <Show when={p().cover}>
                      <Button
                        size="sm"
                        variant="ghost"
                        onClick={() => {
                          void update({ cover: null })
                          setCoverOpen(false)
                        }}
                      >
                        Remove
                      </Button>
                    </Show>
                  </div>
                </div>
              </Popover>
              <input
                class="docs-article__title figure-xl"
                aria-label="Title"
                placeholder="Untitled"
                value={title()}
                readOnly={readOnly()}
                onInput={(e) => {
                  setTitle(e.currentTarget.value)
                  setDirty(true)
                  if (titleTimer) clearTimeout(titleTimer)
                  titleTimer = setTimeout(saveTitle, 400)
                }}
                onKeyDown={(e) => {
                  if (e.key === "Enter") {
                    e.preventDefault()
                    void saveTitle()
                    handle()?.focus()
                  }
                }}
                data-testid="page-title"
              />
              <div class="docs-article__meta nc-meta">
                <span>{name(p().createdBy)}</span>
                <span>·</span>
                <span>Created {ago(p().createdAt)}</span>
                <span>·</span>
                <span data-testid="word-count">
                  {words().toLocaleString("en-US")} words · {minutes()} min read
                </span>
              </div>
              <PropsTable
                rookery={rookery}
                model={{
                  page: () => page()!,
                  parent,
                  shared: defsShared,
                  local: defsLocal,
                  readOnly,
                }}
              />
              <Show
                when={documentId() || !rookery.documents}
                keyed
                fallback={<span class="nc-meta">Opening…</span>}
              >
                {(d) => (
                  <PageBody
                    rookery={rookery}
                    api={props.api}
                    page={p()}
                    document={typeof d === "string" ? d : p().id}
                    wide={!!p().wide}
                    comments={comments}
                    activeComment={activeComment}
                    onComment={(a) => {
                      setPending(a)
                      setPanel("comments")
                    }}
                    onActiveComment={openComment}
                    onSession={setSession}
                    onView={setHandle}
                    onUpdate={onUpdate}
                  />
                )}
              </Show>
              <Subpages
                rookery={rookery}
                api={props.api}
                page={p()}
                readOnly={readOnly()}
                open={(k) => openEntity(rookery, uriOf(k.id))}
              />
              <Backlinks rookery={rookery} api={props.api} page={p()} />
            </article>
          </div>
        )}
      </Show>
    </div>
  )
}

export const askTitle = (initial = "") => ask("Name the page", { value: initial, confirm: "Create page" })
