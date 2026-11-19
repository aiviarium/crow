// The page tree of one space: each open page lists its children with a live query of its own, so a tree of
// thousands of pages loads only what is open, and every change (anyone's) shows at once. Rows drag onto other
// rows (before, after, or inside) and onto a space's heading (to its top level).
import { Icon, IconButton, isMenuKey } from "@aiviarium/nocturne"
import type { SpaceInfo } from "@rookery/sdk/client"
import { type Accessor, createMemo, createSignal, For, type JSX, Show } from "solid-js"
import { byRank } from "../lib/rank"
import { type DropZone, uriOf, zoneAt } from "../lib/tree"
import type { ClientRookeryWithDocs } from "../types"
import { type Api, iconOf, type Page } from "./api"

export interface TreeContext {
  rookery: ClientRookeryWithDocs
  api: Api
  /** The page that is open. */
  current: Accessor<string | null>
  isOpen(id: string): boolean
  toggle(id: string, open?: boolean): void
  openPage(page: Page): void
  newPage(space: SpaceInfo, parent: string | null): void
  /** The page's menu: under `anchor` (its More button), or at `at` (a right click or a long press). */
  menu(page: Page, anchor: HTMLElement, at?: { x: number; y: number }): void
}

/** What is being dragged, page and space. */
const [dragging, setDragging] = createSignal<{ id: string; space: string } | null>(null)

export { dragging }

/** Starts a drag of a page (rows, and the page's own handle). */
export function dragStart(e: DragEvent, page: Page) {
  setDragging({ id: page.id, space: page.spaceId })
  e.dataTransfer?.setData("application/x-crow-page", JSON.stringify({ id: page.id, space: page.spaceId }))
  e.dataTransfer?.setData("text/uri-list", uriOf(page.id))
  if (e.dataTransfer) e.dataTransfer.effectAllowed = "move"
}

export function PageIcon(props: {
  icon: string | null | undefined
  size?: "sm" | "md" | "lg"
  class?: string
}): JSX.Element {
  const i = () => iconOf(props.icon)
  return (
    <span
      class={`docs-icon docs-icon--${props.size ?? "sm"} ${props.class ?? ""}`}
      data-hue={i().hue ?? undefined}
      aria-hidden="true"
    >
      <Icon name={i().name as never} size="sm" />
    </span>
  )
}

/** One level of the tree: the children of `parent` (an id, or null for the top of the space). */
export function TreeLevel(props: {
  ctx: TreeContext
  space: SpaceInfo
  parent: string | null
  depth: number
}): JSX.Element {
  const live = props.ctx.rookery.data.space(props.space.id).pages.live({
    where: { parent: props.parent ? uriOf(props.parent) : null, template: false },
    limit: 1000,
  })
  const rows = createMemo(() => ([...live()] as unknown as Page[]).sort(byRank))
  return (
    <Show
      when={!live.loading || rows().length}
      fallback={
        <span
          class="docs-tree__empty nc-meta"
          style={{ "padding-inline-start": `${22 + props.depth * 14}px` }}
        >
          Loading…
        </span>
      }
    >
      <Show
        when={rows().length}
        fallback={
          <span
            class="docs-tree__empty nc-meta"
            style={{ "padding-inline-start": `${22 + props.depth * 14}px` }}
          >
            {props.parent ? "No pages inside" : "No pages yet"}
          </span>
        }
      >
        <For each={rows()}>
          {(p) => (
            <TreeRow ctx={props.ctx} space={props.space} page={p} siblings={rows} depth={props.depth} />
          )}
        </For>
        <Show when={live.hasMore}>
          <span
            class="docs-tree__empty nc-meta"
            style={{ "padding-inline-start": `${22 + props.depth * 14}px` }}
          >
            The first 1,000 pages are shown here; search finds the rest.
          </span>
        </Show>
      </Show>
    </Show>
  )
}

function TreeRow(props: {
  ctx: TreeContext
  space: SpaceInfo
  page: Page
  siblings: Accessor<Page[]>
  depth: number
}): JSX.Element {
  const [zone, setZone] = createSignal<DropZone | null>(null)
  const open = () => props.ctx.isOpen(props.page.id)
  const active = () => props.ctx.current() === props.page.id
  let rowEl!: HTMLDivElement
  let more!: HTMLButtonElement

  const canDrop = () => {
    const d = dragging()
    return !!d && d.space === props.page.spaceId && d.id !== props.page.id
  }
  const onDragOver = (e: DragEvent) => {
    if (!canDrop()) return
    e.preventDefault()
    if (e.dataTransfer) e.dataTransfer.dropEffect = "move"
    const r = rowEl.getBoundingClientRect()
    setZone(zoneAt(e.clientY - r.top, r.height))
  }
  const onDrop = async (e: DragEvent) => {
    const d = dragging()
    const z = zone()
    setZone(null)
    if (!d || !z || !canDrop()) return
    e.preventDefault()
    setDragging(null)
    try {
      if (z === "inside") {
        await props.ctx.api.move(d.id, props.page.id, undefined, props.page.spaceId)
        props.ctx.toggle(props.page.id, true)
      } else {
        const sibs = props.siblings().filter((s) => s.id !== d.id)
        const at = sibs.findIndex((s) => s.id === props.page.id)
        const index = z === "before" ? at : at + 1
        await props.ctx.api.move(
          d.id,
          props.page.parent ? props.page.parent.slice(6) : null,
          index,
          props.page.spaceId,
        )
      }
    } catch (err: any) {
      props.ctx.rookery.workbench.toast({
        title: "The page was not moved",
        body: String(err?.message ?? err),
        kind: "danger",
      })
    }
  }

  return (
    <div class="docs-tree__node" role="none">
      <div
        ref={rowEl}
        class="docs-tree__row"
        classList={{ "docs-tree__row--active": active(), [`docs-tree__row--drop-${zone()}`]: !!zone() }}
        style={{ "padding-inline-start": `${4 + props.depth * 14}px` }}
        role="treeitem"
        tabIndex={-1}
        aria-level={props.depth + 1}
        aria-expanded={open()}
        aria-selected={active()}
        data-page={props.page.id}
        data-title={props.page.title}
        draggable={true}
        onDragStart={(e) => dragStart(e, props.page)}
        onDragEnd={() => {
          setDragging(null)
          setZone(null)
        }}
        onDragOver={onDragOver}
        onDragLeave={() => setZone(null)}
        onDrop={onDrop}
        onContextMenu={(e) => {
          e.preventDefault()
          props.ctx.menu(props.page, more, { x: e.clientX, y: e.clientY })
        }}
        onKeyDown={(e) => {
          if (!isMenuKey(e)) return
          e.preventDefault()
          e.stopPropagation()
          props.ctx.menu(props.page, more)
        }}
      >
        <button
          type="button"
          class="docs-tree__chevron"
          aria-label={open() ? `Collapse ${props.page.title}` : `Expand ${props.page.title}`}
          onClick={() => props.ctx.toggle(props.page.id)}
          tabIndex={-1}
        >
          <Icon name={open() ? "chevron-down" : "chevron-right"} size="sm" />
        </button>
        <button
          type="button"
          class="docs-tree__open"
          onClick={() => props.ctx.openPage(props.page)}
          title={props.page.title}
        >
          <PageIcon icon={props.page.icon} />
          <span class="docs-tree__title">{props.page.title || "Untitled"}</span>
          <Show when={props.page.private}>
            <span class="docs-tree__lock" title="Private: only people it is shared with">
              <Icon name="lock" size="sm" />
            </span>
          </Show>
        </button>
        <span class="docs-tree__actions">
          <IconButton
            ref={more}
            icon="more"
            tooltip={false}
            label={`More for ${props.page.title}`}
            onClick={() => props.ctx.menu(props.page, more)}
          />
          <IconButton
            icon="plus"
            tooltip={false}
            label={`Add a page inside ${props.page.title}`}
            onClick={() => {
              props.ctx.toggle(props.page.id, true)
              props.ctx.newPage(props.space, props.page.id)
            }}
          />
        </span>
      </div>
      <Show when={open()}>
        <div class="docs-tree__group">
          <TreeLevel ctx={props.ctx} space={props.space} parent={props.page.id} depth={props.depth + 1} />
        </div>
      </Show>
    </div>
  )
}

/** A space as a section of the tree: its name (a drop target for its top level), then its pages. */
export function SpaceTree(props: { ctx: TreeContext; space: SpaceInfo; label?: string }): JSX.Element {
  const key = `space:${props.space.id}`
  const [over, setOver] = createSignal(false)
  const open = () => props.ctx.isOpen(key)
  return (
    <div class="docs-tree__space" data-space={props.space.slug}>
      <div
        class="docs-tree__row docs-tree__row--space"
        classList={{ "docs-tree__row--drop-inside": over() }}
        onDragOver={(e) => {
          const d = dragging()
          if (!d || d.space !== props.space.id) return
          e.preventDefault()
          setOver(true)
        }}
        onDragLeave={() => setOver(false)}
        onDrop={async (e) => {
          const d = dragging()
          setOver(false)
          if (!d || d.space !== props.space.id) return
          e.preventDefault()
          setDragging(null)
          await props.ctx.api.move(d.id, null, undefined, props.space.id).catch((err) =>
            props.ctx.rookery.workbench.toast({
              title: "The page was not moved",
              body: String(err?.message ?? err),
              kind: "danger",
            }),
          )
        }}
      >
        <button
          type="button"
          class="docs-tree__chevron"
          aria-label={open() ? `Collapse ${props.space.name}` : `Expand ${props.space.name}`}
          onClick={() => props.ctx.toggle(key)}
          tabIndex={-1}
        >
          <Icon name={open() ? "chevron-down" : "chevron-right"} size="sm" />
        </button>
        <button type="button" class="docs-tree__open" onClick={() => props.ctx.toggle(key)}>
          <span
            class="docs-icon docs-icon--sm docs-icon--space"
            data-hue={props.space.personal ? undefined : "accent"}
            aria-hidden="true"
          >
            <Icon name={props.space.personal ? "user" : "layers"} size="sm" />
          </span>
          <span class="docs-tree__title">{props.label ?? props.space.name}</span>
        </button>
        <span class="docs-tree__actions docs-tree__actions--always">
          <IconButton
            icon="plus"
            tooltip={false}
            label={`New page in ${props.space.name}`}
            onClick={() => props.ctx.newPage(props.space, null)}
          />
        </span>
      </div>
      <Show when={open()}>
        <div class="docs-tree__group">
          <TreeLevel ctx={props.ctx} space={props.space} parent={null} depth={1} />
        </div>
      </Show>
    </div>
  )
}
