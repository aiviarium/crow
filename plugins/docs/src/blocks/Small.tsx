// The smaller blocks Docs gives every document in Rookery: a page as a card, a table of contents, and a
// synced block (a document of its own, shown and edited wherever the block is copied: the same Yjs document
// opened in each place, so an edit in one shows in every other at once).
import { Button, Icon, RichTextEditor } from "@aiviarium/nocturne"
import { createResource, createSignal, For, type JSX, onCleanup, Show } from "solid-js"
import { openDocument } from "../lib/collab"
import { uriOf } from "../lib/tree"
import { type BlockProps, type ClientRookeryWithDocs, entityOfHit } from "../types"
import { type Api, ago, openEntity } from "../views/api"
import { EntityCard } from "../views/Entity"
import { PageIcon } from "../views/Tree"

/** A page as a card: icon, title, where it is and when it changed; live from the entity index. */
export function PageCard(props: { rookery: ClientRookeryWithDocs; p: BlockProps }): JSX.Element {
  const [q, setQ] = createSignal("")
  const uri = () => String(props.p.attrs.uri ?? "")
  const [tick, setTick] = createSignal(0)
  const timer = setInterval(() => setTick((t) => t + 1), 10_000)
  onCleanup(() => clearInterval(timer))
  const [entity] = createResource(
    () => (uri() ? [uri(), tick()] : null),
    ([u]) => props.rookery.entities?.resolve(String(u)).catch(() => null) ?? Promise.resolve(null),
  )
  const [hits] = createResource(q, async (t) => {
    if (!t.trim() || !props.rookery.entities) return []
    const raw = await props.rookery.entities.search(t, { schemes: ["doc"], limit: 6 }).catch(() => [])
    return raw.map(entityOfHit)
  })
  return (
    <Show
      when={uri()}
      fallback={
        <div class="docs-pagecard docs-pagecard--pick" data-part="page-card-pick">
          <Show when={!props.p.readOnly} fallback={<span class="nc-meta">No page chosen.</span>}>
            <input
              class="nc-input"
              placeholder="Link to a page: search"
              aria-label="Search pages"
              value={q()}
              onInput={(e) => setQ(e.currentTarget.value)}
            />
            <For each={(hits() ?? []).filter((h) => !h.deletedAt)}>
              {(h) => (
                <button
                  type="button"
                  class="docs-move__item"
                  onClick={() => props.p.setAttrs({ uri: h.uri, title: h.title })}
                >
                  <PageIcon icon={h.icon} />
                  <span>{h.title}</span>
                </button>
              )}
            </For>
          </Show>
        </div>
      }
    >
      <button
        type="button"
        class="docs-pagecard"
        onClick={() => openEntity(props.rookery, uri())}
        data-part="page-card"
        data-uri={uri()}
      >
        <PageIcon icon={entity()?.icon} size="md" />
        <span class="docs-pagecard__text">
          <span class="label docs-pagecard__title">
            {entity()?.title ?? String(props.p.attrs.title || "Page")}
          </span>
          <span class="nc-meta">
            {entity()
              ? `Page · edited ${ago(entity()!.updatedAt)}`
              : entity.loading
                ? "Page"
                : "Not available: deleted, or not shared with you"}
          </span>
        </span>
        <Icon name="arrow-up-right" size="sm" />
      </button>
    </Show>
  )
}

/**
 * Any entity that has a card, drawn by whoever owns its scheme, live: a saved view of a collection is its
 * table, list or board, read-only, with an Open control. Chosen by searching; only what the person may read
 * is found, and what they may not read at the time of viewing is not drawn.
 */
export function ItemCard(props: { rookery: ClientRookeryWithDocs; p: BlockProps }): JSX.Element {
  const [q, setQ] = createSignal("")
  const uri = () => String(props.p.attrs.uri ?? "")
  const scheme = () => uri().split("://")[0] ?? ""
  const [hits] = createResource(q, async (t) => {
    if (!t.trim() || !props.rookery.entities) return []
    const raw = await props.rookery.entities.search(t, { limit: 12 }).catch(() => [])
    return raw.map(entityOfHit)
  })
  const drawn = (h: { scheme: string; deletedAt?: string | null }) =>
    !h.deletedAt && !!props.rookery.entities.renders?.("card", h.scheme)
  return (
    <Show
      when={uri()}
      fallback={
        <div class="docs-pagecard docs-pagecard--pick" data-part="item-card-pick">
          <Show when={!props.p.readOnly} fallback={<span class="nc-meta">Nothing chosen.</span>}>
            <input
              class="nc-input"
              placeholder="Embed a saved view or any item with a card: search"
              aria-label="Search items to embed"
              value={q()}
              onInput={(e) => setQ(e.currentTarget.value)}
            />
            <For each={(hits() ?? []).filter(drawn)}>
              {(h) => (
                <button
                  type="button"
                  class="docs-move__item"
                  data-uri={h.uri}
                  onClick={() => props.p.setAttrs({ uri: h.uri, title: h.title })}
                >
                  <Icon name="layers" size="sm" />
                  <span>{h.title}</span>
                  <Show when={h.subtitle}>
                    <span class="nc-meta">{h.subtitle}</span>
                  </Show>
                </button>
              )}
            </For>
          </Show>
        </div>
      }
    >
      <div class="docs-itemcard" data-part="item-card" data-uri={uri()} data-scheme={scheme()}>
        <EntityCard
          rookery={props.rookery}
          uri={uri()}
          density="comfortable"
          fallback={
            <button type="button" class="docs-pagecard" onClick={() => openEntity(props.rookery, uri())}>
              <span class="label docs-pagecard__title">{String(props.p.attrs.title || uri())}</span>
              <Icon name="arrow-up-right" size="sm" />
            </button>
          }
        />
      </div>
    </Show>
  )
}

/** The headings of the document the block is in. */
export function Toc(props: { p: BlockProps }): JSX.Element {
  return (
    <nav class="docs-toc" aria-label="Table of contents" data-part="toc">
      <span class="nc-nav__label">Contents</span>
      <For each={props.p.outline()} fallback={<span class="nc-meta">Add headings and they show here.</span>}>
        {(h) => (
          <button
            type="button"
            class="docs-toc__item"
            style={{ "padding-inline-start": `${(h.level - 1) * 14}px` }}
            onClick={() => props.p.scrollTo(h.pos)}
          >
            {h.text || "Untitled heading"}
          </button>
        )}
      </For>
    </nav>
  )
}

/** The synced document, opened here as well. */
function SyncedBody(props: {
  rookery: ClientRookeryWithDocs
  document: string
  readOnly: boolean
}): JSX.Element {
  const session = openDocument(props.rookery, props.document)
  onCleanup(() => session.close())
  return (
    <Show
      when={session.status() !== "error"}
      fallback={
        <span class="nc-meta">The synced content is not available: deleted, or not shared with you.</span>
      }
    >
      <RichTextEditor
        provider={session}
        variant="field"
        readOnly={props.readOnly}
        aria-label="Synced content"
        placeholder="Synced content. Copy this block to show it in other places."
        blockPlaceholder={null}
      />
    </Show>
  )
}

/** A synced block: its own document, attached to the page it was made on. */
export function Synced(props: { rookery: ClientRookeryWithDocs; api: Api; p: BlockProps }): JSX.Element {
  const doc = () => String(props.p.attrs.document ?? "")
  const [busy, setBusy] = createSignal(false)
  const [origin] = createResource(
    () => String(props.p.attrs.from ?? "") || null,
    (u) => props.rookery.entities?.resolve(u).catch(() => null) ?? Promise.resolve(null),
  )
  const make = async () => {
    setBusy(true)
    try {
      // Attached to the page the block is on, so whoever can see the page can see it.
      const pageId = /\/docs\/(?:page\/)?([0-9a-f-]{36})(?:$|[/?])/i.exec(location.pathname)?.[1]
      const parent = pageId ? uriOf(pageId) : undefined
      const made = await props.rookery.documents.create({
        ...(parent ? { parent } : {}),
        title: "Synced block",
      })
      props.p.setAttrs({ document: made.id, from: parent ?? "" })
    } catch (e: any) {
      props.rookery.workbench.toast({
        title: "No synced block was made",
        body: String(e?.message ?? e),
        kind: "danger",
      })
    } finally {
      setBusy(false)
    }
  }
  return (
    <div class="docs-synced" data-part="synced" data-document={doc() || undefined}>
      <div class="docs-synced__bar nc-meta">
        <Icon name="layers" size="sm" />
        <span>Synced block</span>
        <Show when={origin()}>
          {(o) => (
            <button
              type="button"
              class="docs-link-btn nc-meta"
              onClick={() => openEntity(props.rookery, o().uri)}
            >
              from {o().title}
            </button>
          )}
        </Show>
        <span class="docs-page__spacer" />
        <Show when={doc()}>
          <span>Copy the block to show it elsewhere</span>
        </Show>
      </div>
      <Show
        when={doc()}
        keyed
        fallback={
          <Show when={!props.p.readOnly} fallback={<span class="nc-meta">Empty.</span>}>
            <Button
              size="sm"
              variant="secondary"
              icon="plus"
              loading={busy()}
              onClick={make}
              data-part="synced-create"
            >
              Start synced content
            </Button>
          </Show>
        }
      >
        {(d) => <SyncedBody rookery={props.rookery} document={d} readOnly={props.p.readOnly} />}
      </Show>
    </div>
  )
}
