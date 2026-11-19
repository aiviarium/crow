// The home of Docs: pages opened and edited lately, templates, search results and the trash. Each has a view
// header with where it is and its actions (the tab already says "Docs"); a section with nothing in it is left out.
import { Button, ContextMenu, EmptyState, ViewHeader } from "@aiviarium/nocturne"
import type { SpaceInfo } from "@rookery/sdk/client"
import { createResource, createSignal, For, type JSX, Show } from "solid-js"
import { uriOf } from "../lib/tree"
import { type ClientRookeryWithDocs, entityOfHit } from "../types"
import { type Api, ago, openEntity, type Page, type Template } from "./api"
import { confirmAsk } from "./ask"
import { PageIcon } from "./Tree"

function Row(props: {
  icon: string | null | undefined
  title: string
  meta: string
  onClick: () => void
  data?: string
  onKeyDown?: (e: KeyboardEvent) => void
  children?: JSX.Element
}): JSX.Element {
  return (
    <div class="docs-list__row" data-page={props.data} onKeyDown={props.onKeyDown}>
      <button type="button" class="docs-list__open" onClick={props.onClick}>
        <PageIcon icon={props.icon} />
        <span class="docs-list__title body">{props.title}</span>
        <span class="nc-meta docs-list__meta">{props.meta}</span>
      </button>
      {props.children}
    </div>
  )
}

export function Recent(props: {
  rookery: ClientRookeryWithDocs
  api: Api
  space: SpaceInfo | null | undefined
}): JSX.Element {
  const [recent] = createResource(
    () => props.rookery.recents?.entities({ schemes: ["doc"], limit: 10 }).catch(() => []) ?? [],
  )
  const edited = props.space
    ? props.rookery.data
        .space(props.space.id)
        .pages.live({ where: { template: false }, orderBy: [["updatedAt", "desc"]], limit: 12 })
    : () => []
  const open = (id: string) => openEntity(props.rookery, uriOf(id))
  return (
    <>
      <ViewHeader
        crumbs={props.space ? [{ label: props.space.personal ? "My pages" : props.space.name }] : undefined}
        noPin
        actions={
          props.space
            ? [
                {
                  id: "new-page",
                  label: "New page",
                  icon: "plus",
                  onClick: async () => {
                    const made = await props.api.create({ space: props.space!.id })
                    open(made.id)
                  },
                },
              ]
            : []
        }
      />
      <div class="docs-home" data-part="docs-home">
        <Show when={recent()?.length}>
          <section class="docs-home__section">
            <span class="nc-nav__label">Opened lately</span>
            <div class="docs-cards">
              <For each={recent()}>
                {(r) => (
                  <button
                    type="button"
                    class="docs-card"
                    onClick={() => open(r.entity.id)}
                    data-page={r.entity.id}
                  >
                    <PageIcon icon={r.entity.icon} size="md" />
                    <span class="label docs-card__title">{r.entity.title}</span>
                    <span class="nc-meta">{ago(r.openedAt)}</span>
                  </button>
                )}
              </For>
            </div>
          </section>
        </Show>
        <Show when={(edited() as unknown as Page[]).length}>
          <section class="docs-home__section">
            <span class="nc-nav__label">Edited in this space</span>
            <div class="docs-list">
              <For each={edited() as unknown as Page[]}>
                {(p) => (
                  <Row
                    icon={p.icon}
                    title={p.title}
                    meta={ago(p.updatedAt)}
                    onClick={() => open(p.id)}
                    data={p.id}
                  />
                )}
              </For>
            </div>
          </section>
        </Show>
      </div>
    </>
  )
}

export function Templates(props: {
  rookery: ClientRookeryWithDocs
  api: Api
  space: SpaceInfo | null | undefined
}): JSX.Element {
  const [list] = createResource(
    () => props.space?.id,
    (sp) => props.api.templates(sp).catch(() => []),
  )
  const use = async (t: Template) => {
    if (!props.space) return
    const made = await props.api.create({ space: props.space.id, template: t.id })
    openEntity(props.rookery, uriOf(made.id))
  }
  return (
    <>
      <ViewHeader crumbs={[{ label: "Templates", icon: "layers" }]} noPin />
      <div class="docs-home" data-part="templates">
        <section class="docs-home__section">
          <span class="nc-nav__label">Built in</span>
          <div class="docs-cards">
            <For each={(list() ?? []).filter((t) => t.builtin)}>
              {(t) => (
                <button
                  type="button"
                  class="docs-card docs-card--template"
                  onClick={() => use(t)}
                  data-template={t.id}
                >
                  <PageIcon icon={t.icon} size="md" />
                  <span class="label docs-card__title">{t.title}</span>
                  <span class="nc-meta docs-card__desc">{t.description}</span>
                </button>
              )}
            </For>
          </div>
        </section>
        <Show when={(list() ?? []).some((t) => !t.builtin)}>
          <section class="docs-home__section">
            <span class="nc-nav__label">This space's</span>
            <div class="docs-list">
              <For each={(list() ?? []).filter((t) => !t.builtin)}>
                {(t) => (
                  <Row
                    icon={t.icon}
                    title={t.title}
                    meta="Template"
                    onClick={() => openEntity(props.rookery, uriOf(t.id))}
                    data={t.id}
                  >
                    <Button size="sm" variant="secondary" onClick={() => use(t)} data-use-template={t.id}>
                      Use
                    </Button>
                  </Row>
                )}
              </For>
            </div>
          </section>
        </Show>
      </div>
    </>
  )
}

export function Search(props: {
  rookery: ClientRookeryWithDocs
  space: SpaceInfo | null | undefined
  query: string
}): JSX.Element {
  const [q, setQ] = createSignal(props.query)
  const [hits] = createResource(q, async (text) => {
    if (!text.trim() || !props.rookery.entities) return []
    const raw = await props.rookery.entities.search(text, { schemes: ["doc"], limit: 50 }).catch(() => [])
    return raw.map(entityOfHit)
  })
  return (
    <>
      <ViewHeader crumbs={[{ label: "Search", icon: "search" }]} noPin />
      <div class="docs-home" data-part="docs-search-results">
        <input
          class="nc-input docs-home__search"
          placeholder="Search titles and text"
          aria-label="Search pages"
          value={q()}
          onInput={(e) => setQ(e.currentTarget.value)}
        />
        <div class="docs-list">
          <For
            each={(hits() ?? []).filter((h) => !h.deletedAt)}
            fallback={
              <span class="nc-meta">
                {q().trim() ? "No pages match." : "Type to search every page you can see."}
              </span>
            }
          >
            {(h) => (
              <Row
                icon={h.icon}
                title={h.title}
                meta={ago(h.updatedAt)}
                onClick={() => openEntity(props.rookery, h.uri)}
                data={h.id}
              />
            )}
          </For>
        </div>
      </div>
    </>
  )
}

export function Trash(props: {
  rookery: ClientRookeryWithDocs
  api: Api
  space: SpaceInfo | null | undefined
}): JSX.Element {
  const live = props.space
    ? props.rookery.data
        .space(props.space.id)
        .pages.live({ trashed: true, orderBy: [["updatedAt", "desc"]], limit: 500 })
    : () => []
  // A subtree went to the trash together: show its top page, with how many came along.
  const roots = () => {
    const all = live() as unknown as Page[]
    return all
      .filter((p) => !p.trashedWith || p.trashedWith === p.id)
      .map((p) => ({ page: p, more: all.filter((x) => x.trashedWith === p.id && x.id !== p.id).length }))
  }
  return (
    <>
      <ViewHeader
        crumbs={[
          { label: "Trash", icon: "trash" },
          ...(props.space ? [{ label: props.space.personal ? "My pages" : props.space.name }] : []),
        ]}
        noPin
        actions={
          roots().length
            ? [
                {
                  id: "empty-trash",
                  label: "Empty trash",
                  danger: true,
                  overflow: true,
                  onClick: async () => {
                    if (
                      !(await confirmAsk("Empty the trash?", {
                        description: "Every page in it is deleted for good, with its history and comments.",
                        confirm: "Empty trash",
                        danger: true,
                      }))
                    )
                      return
                    await props.api.emptyTrash(props.space?.id)
                  },
                },
              ]
            : []
        }
      />
      <div class="docs-home" data-part="trash">
        <Show
          when={roots().length}
          fallback={
            <EmptyState
              icon="trash"
              title="The trash is empty"
              description="Pages moved to the trash wait here until you restore them or delete them for good."
            />
          }
        >
          <div class="docs-list">
            <For each={roots()}>
              {(r) => {
                const purge = async () => {
                  if (
                    !(await confirmAsk(`Delete ${r.page.title} for good?`, {
                      description: "It cannot be restored afterwards.",
                      confirm: "Delete for good",
                      danger: true,
                    }))
                  )
                    return
                  await props.api.purge(r.page.id, props.space?.id)
                }
                const restore = () => props.api.restore(r.page.id, props.space?.id)
                return (
                  <ContextMenu
                    label="Page in the trash"
                    items={() => [
                      { id: "restore", label: "Restore", icon: "arrow-up-right" },
                      { id: "purge", label: "Delete for good", icon: "trash", danger: true },
                    ]}
                    onSelect={(id) => (id === "restore" ? restore() : purge())}
                  >
                    <Row
                      icon={r.page.icon}
                      title={r.page.title}
                      meta={`${r.more ? `with ${r.more} subpages · ` : ""}deleted ${ago(r.page.deletedAt ?? r.page.updatedAt)}`}
                      onClick={() => {}}
                      data={r.page.id}
                      onKeyDown={(e) => {
                        if (e.key === "Delete" || e.key === "Backspace") {
                          e.preventDefault()
                          purge()
                        }
                      }}
                    >
                      <Button
                        size="sm"
                        variant="secondary"
                        icon="arrow-up-right"
                        onClick={restore}
                        data-restore={r.page.id}
                      >
                        Restore
                      </Button>
                    </Row>
                  </ContextMenu>
                )
              }}
            </For>
          </div>
        </Show>
      </div>
    </>
  )
}
