// The Docs plugin's client half: the workspace (page tree and pages), the home of Docs (recent, templates,
// search, trash), blocks for every document in Rookery (inline databases, page cards, a table of contents,
// synced blocks), widgets (recent pages, one page on a dashboard), and the commands behind "New document".
import { EmptyState, RichTextEditor, Widget } from "@aiviarium/nocturne"
import { defineClient } from "@rookery/sdk/client"
import { createResource, For, onCleanup, Show } from "solid-js"
import { DatabaseBlock } from "./blocks/Database"
import { ItemCard, PageCard, Synced, Toc } from "./blocks/Small"
import { openDocument } from "./lib/collab"
import { databaseIsWide } from "./lib/dbview"
import { registerBlock, registerWidget } from "./lib/registry"
import { idOf, uriOf } from "./lib/tree"
import type { ClientRookeryWithDocs } from "./types"
import { ago, api, openEntity, type Page } from "./views/api"
import { Recent, Search, Templates, Trash } from "./views/Home"
import { PageIcon } from "./views/Tree"
import { spaceOfPage, Workspace } from "./views/Workspace"
import "./client.css"

export default defineClient((baseRookery) => {
  const rookery = baseRookery as ClientRookeryWithDocs
  const docs = api(rookery)

  const createAndOpen = async (params: Record<string, unknown> = {}) => {
    const space = rookery.spaces.current()
    if (!space) {
      rookery.workbench.toast({ title: "Open a space first", kind: "warning" })
      return
    }
    const made = await docs.create({
      space: space.id,
      ...(typeof params.title === "string" ? { title: params.title } : {}),
      ...(typeof params.template === "string" ? { template: params.template } : {}),
      ...(typeof params.parent === "string" ? { parent: params.parent } : {}),
    })
    openEntity(rookery, uriOf(made.id))
    return made
  }

  rookery.commands.register("docs.create", { title: "New document", run: (p) => createAndOpen(p) })
  rookery.commands.register("docs.open", { run: () => rookery.workbench.openView("docs.home") })
  rookery.commands.register("docs.import", {
    run: () => rookery.workbench.openView("docs.home", { path: "import" }),
  })

  // Both views follow their path (the shell keeps them mounted), so moving between pages, or between the home's
  // sections, keeps the tree, the layout and the page shown until the next one is ready.
  rookery.views.register(
    "docs.home",
    (props) => {
      props.view.setTitle("Docs")
      const section = () => props.view.path.split("/")[0] ?? ""
      // The home of Docs is a space's (its routes are under the space context): what changed in it, its templates
      // and trash. Pages are not bound to a space in their URL; the tree spans every space.
      const space = () => props.view.space ?? rookery.spaces.current()
      return (
        <div class="docs-root" data-plugin="docs" data-part="docs-root">
          <Workspace
            rookery={rookery}
            api={docs}
            space={space()}
            setTitle={props.view.setTitle}
            setDirty={props.view.setDirty}
            importOnOpen={section() === "import"}
          >
            <Show when={section() === "trash"}>
              <Trash rookery={rookery} api={docs} space={space()} />
            </Show>
            <Show when={section() === "templates"}>
              <Templates rookery={rookery} api={docs} space={space()} />
            </Show>
            <Show when={section() === "search"}>
              <Search rookery={rookery} space={space()} query={props.view.params.q ?? ""} />
            </Show>
            <Show when={!["trash", "templates", "search"].includes(section())}>
              <Recent rookery={rookery} api={docs} space={space()} />
            </Show>
          </Workspace>
        </div>
      )
    },
    { followsPath: true },
  )

  rookery.views.register(
    "docs.page",
    (props) => {
      props.view.setTitle("Page")
      const id = () => props.view.path.split("/")[0] || undefined
      // The page's own space, which the entity link or the tree it was opened from does not have to say. Until
      // it is known for this page the workspace keeps showing the page before.
      const [pageSpace] = createResource(id, async (page) => {
        const e = await rookery.entities?.resolve(uriOf(page)).catch(() => null)
        const space = e?.spaceId
          ? ((await rookery.spaces.list().catch(() => [])).find((s) => s.id === e.spaceId) ?? null)
          : null
        return { page, space: space ?? rookery.spaces.current() }
      })
      const space = () => {
        const page = id()
        const known = page ? spaceOfPage(page) : undefined
        if (known) return known
        const found = pageSpace.latest
        return found && found.page === page ? found.space : rookery.spaces.current()
      }
      return (
        <div class="docs-root" data-plugin="docs" data-part="docs-root">
          <Workspace
            rookery={rookery}
            api={docs}
            space={space()}
            page={id()}
            setTitle={props.view.setTitle}
            setDirty={props.view.setDirty}
          />
        </div>
      )
    },
    { followsPath: true },
  )

  // A link to a comment opens its page with the comment showing.
  rookery.views.register("docs.comment", (props) => {
    props.view.setTitle("Comment")
    const id = props.view.path.split("/")[0]!
    const [found] = createResource(async () => {
      if (!rookery.entities) return null
      const c = await rookery.entities.resolve(`doc-comment://${id}`).catch(() => null)
      const page = idOf(c?.parent ?? null)
      if (page) rookery.workbench.openView("docs.page", { path: page, params: { comment: id } })
      return c
    })
    return (
      <Show when={!rookery.entities || (found.state === "ready" && !found())}>
        <EmptyState
          icon="chat"
          title="This comment is not available"
          description={
            rookery.entities
              ? "It was deleted, or its page is not shared with you."
              : "Comment links require Rookery entities (M2b)."
          }
        />
      </Show>
    )
  })

  // A table or a board needs the room: they are always wide; a list follows the person's choice.
  registerBlock(
    rookery,
    "docs.database",
    (p) => (
      <DatabaseBlock
        rookery={rookery}
        api={docs}
        attrs={p.attrs}
        setAttrs={p.setAttrs}
        readOnly={p.readOnly}
      />
    ),
    { forceWidth: (attrs) => (databaseIsWide(attrs) ? "wide" : null) },
  )
  registerBlock(rookery, "docs.page", (p) => <PageCard rookery={rookery} p={p} />)
  registerBlock(rookery, "docs.item", (p) => <ItemCard rookery={rookery} p={p} />, {
    forceWidth: (attrs) => (String(attrs.uri ?? "") ? "wide" : null),
  })
  registerBlock(rookery, "docs.toc", (p) => <Toc p={p} />)
  registerBlock(rookery, "docs.synced", (p) => <Synced rookery={rookery} api={docs} p={p} />)

  // The space's pages that changed last.
  registerWidget(rookery, "docs.recent", (props) => {
    const pages = rookery.data.pages.live({
      where: { template: false },
      orderBy: [["updatedAt", "desc"]],
      limit: 30,
    })
    const rows = () =>
      Math.min(Number(props.widget.settings.limit ?? 8), Math.max(1, props.widget.size.h * 2 - 2))
    // No pages renders nothing, so the page leaves the widget out. No count: it would only say how many of
    // the newest thirty were fetched.
    return (
      <Show when={pages().length}>
        <Widget fill title={String(props.widget.settings.heading ?? "Recent pages")} data-widget-body="docs">
          <ul class="docs-widget" aria-label="Recent pages">
            <For each={(pages() as unknown as Page[]).slice(0, rows())}>
              {(p) => (
                <li>
                  <button
                    type="button"
                    class="docs-widget__row"
                    data-page={p.id}
                    onClick={() => openEntity(rookery, uriOf(p.id))}
                  >
                    <PageIcon icon={p.icon} />
                    <span class="label docs-widget__title">{p.title}</span>
                    <span class="nc-meta">{ago(p.updatedAt)}</span>
                  </button>
                </li>
              )}
            </For>
          </ul>
        </Widget>
      </Show>
    )
  })

  // One page, live, on a dashboard: read only unless the widget says otherwise.
  registerWidget(rookery, "docs.embed", (props) => {
    const ref = () => idOf(String(props.widget.settings.page ?? "").trim())
    const [page] = createResource(ref, async (id) => {
      if (!rookery.entities) return null
      const e = await rookery.entities.resolve(uriOf(id)).catch(() => null)
      if (!e?.spaceId) return null
      const row = (await rookery.data.space(e.spaceId).pages.get(id)) as unknown as Page | null
      if (!row) return null
      const doc = row.document ?? (await docs.document(id, e.spaceId)).id
      return { row, doc }
    })
    // No page chosen, or one the viewer cannot open, is the arranger's to fix: it shows while editing, and the
    // page leaves the widget out otherwise. While it opens it renders nothing.
    return (
      <Show
        when={page()}
        keyed
        fallback={
          <Show when={props.widget.editing && !page.loading}>
            <Widget fill title="Page" data-widget-body="docs-embed">
              <span class="nc-meta">
                {ref() ? "This page is not available." : "Choose a page in the widget's settings."}
              </span>
            </Widget>
          </Show>
        }
      >
        {(p) => {
          const session = openDocument(rookery, p.doc)
          onCleanup(() => session.close())
          return (
            <Widget
              fill
              title={p.row.title}
              data-widget-body="docs-embed"
              caption={
                <button
                  type="button"
                  class="docs-link-btn docs-widget__link nc-meta"
                  onClick={() => openEntity(rookery, uriOf(p.row.id))}
                >
                  Open the page
                </button>
              }
            >
              <div class="docs-embed">
                <RichTextEditor
                  provider={session}
                  variant="field"
                  readOnly={!props.widget.settings.editable || props.widget.editing}
                  aria-label={p.row.title}
                />
              </div>
            </Widget>
          )
        }}
      </Show>
    )
  })
})
