// The inline database block: rows of a source as a table, a board or a list, with filters, sorts, grouping and
// visible fields saved in the block. Sources are the pages under a parent page (their columns are the
// parent's shared properties) or any plugin's collection that marks itself showable (`display` in its
// manifest). Reads and writes are the data layer's ordinary calls as the signed-in user, so each source's
// scope and access rules apply wherever the block is, in a docs page or any other document.
import {
  Board,
  BoardCard,
  BoardCardMeta,
  BoardCardTitle,
  BoardCardTop,
  BoardLane,
  Button,
  DropdownMenu,
  EmptyState,
  Icon,
  IconButton,
  Menu,
  Popover,
  Select,
  Tabs,
} from "@aiviarium/nocturne"
import type { Showable } from "@rookery/sdk/client"
import { createMemo, createResource, createSignal, For, type JSX, Show } from "solid-js"
import {
  applyView,
  attrsOf,
  type Column,
  collectionColumns,
  type DatabaseAttrs,
  type Filter,
  type FilterOp,
  type Group,
  groupable,
  groupRows,
  type Layout,
  OP_LABEL,
  opsFor,
  pageColumns,
  type Row,
  type Source,
  toWhere,
  type ViewConfig,
  valueForGroup,
  visibleColumns,
} from "../lib/dbview"
import { defsOf, linksOf, type PropDef, setProps } from "../lib/props"
import { byRank } from "../lib/rank"
import { uriOf } from "../lib/tree"
import { type ClientRookeryWithDocs, entityOfHit } from "../types"
import { type Api, ago, openEntity, type Page } from "../views/api"
import { AskHost, ask } from "../views/ask"
import { EntityCard, EntityRow } from "../views/Entity"
import { PropEditor, PropValue } from "../views/Props"
import { PageIcon } from "../views/Tree"

interface Bound {
  cols: () => Column[]
  rows: () => Row[]
  loading: () => boolean
  error: () => string | null
  /** Opens a row in its own view. */
  open: (row: Row) => void
  /** Saves a column's value for a row. */
  set: (row: Row, col: Column, value: unknown) => Promise<void>
  /** Adds a row (with values for some columns); null when the source does not allow it. */
  add: ((values: Record<string, unknown>) => Promise<void>) | null
  /** Changes a column's options (a page property's), when the source keeps its own definitions. */
  setDef?: (def: PropDef) => Promise<void>
  icon: (row: Row) => string | null | undefined
  /** The row's entity URI, when rows are entities: their plugin draws their cards and rows. */
  uri: (row: Row) => string | null
  label: () => string
  where: () => string
}

/** The page the block is on, when it sits in a docs page (from the URL). */
function hostPage(): string | null {
  return /\/docs\/(?:page\/)?([0-9a-f-]{36})(?:$|[/?])/i.exec(location.pathname)?.[1] ?? null
}

function bindPages(
  rookery: ClientRookeryWithDocs,
  api: Api,
  src: Extract<Source, { kind: "pages" }>,
  view: () => ViewConfig,
): Bound {
  const sp = src.space
  const data = sp ? rookery.data.space(sp) : rookery.data
  const container = data.pages.live({ where: { id: src.parent } })
  const kids = data.pages.live({ where: { parent: uriOf(src.parent), template: false }, limit: 1000 })
  const parent = () => container()[0] as unknown as Page | undefined
  const defs = () => defsOf(parent()?.schema)
  const cols = createMemo(() => pageColumns(defs()))
  return {
    cols,
    rows: () => applyView(kids() as unknown as Row[], cols(), view(), byRank as never),
    loading: () => kids.loading,
    error: () => kids.error?.message ?? container.error?.message ?? null,
    open: (r) => openEntity(rookery, uriOf(r.id)),
    set: async (r, col, v) => {
      if (col.type === "title") {
        await data.pages.update(r.id, { title: String(v || "Untitled") } as never)
        return
      }
      const page = r as unknown as Page
      const props = setProps(defs(), page.props as Record<string, unknown>, { [col.id]: v })
      await data.pages.update(r.id, { props, links: linksOf(defs(), props) } as never)
    },
    add: async (values) => {
      const made = await api.create({
        parent: src.parent,
        space: parent()?.spaceId ?? sp,
        title: String(values.title ?? "Untitled"),
      })
      const rest = Object.fromEntries(Object.entries(values).filter(([k]) => k !== "title"))
      if (Object.keys(rest).length) {
        const props = setProps(defs(), {}, rest)
        await data.pages.update(made.id, { props, links: linksOf(defs(), props) } as never)
      }
    },
    setDef: async (def) => {
      const p = parent()
      if (!p) return
      await data.pages.update(p.id, { schema: defs().map((d) => (d.id === def.id ? def : d)) } as never)
    },
    icon: (r) => (r as unknown as Page).icon,
    uri: (r) => uriOf(r.id),
    label: () => parent()?.title ?? "Pages",
    where: () => `Pages in ${parent()?.title ?? "…"}`,
  }
}

function bindCollection(
  rookery: ClientRookeryWithDocs,
  s: Showable,
  src: Extract<Source, { kind: "collection" }>,
  view: () => ViewConfig,
): Bound {
  const data = src.space ? rookery.data.space(src.space) : rookery.data
  const coll = data.collection(s.plugin, s.collection)
  const cols = createMemo(() => collectionColumns(s.def, s.display))
  const query = createMemo(() => {
    const { where, rest } = toWhere(view().filters, cols())
    const all = [where, s.display.filter ?? {}].filter((w) => Object.keys(w).length)
    return {
      where: all.length > 1 ? { and: all } : (all[0] ?? {}),
      rest,
      key: JSON.stringify([where, s.display.filter]),
    }
  })
  const live = createMemo(() =>
    coll.live({ where: query().where as never, orderBy: [["updatedAt", "desc"]], limit: 500 }),
  )
  const primary = s.display.primary ?? s.def.entity?.title ?? s.def.fields[0]!.name
  return {
    cols,
    rows: () =>
      applyView(live()() as unknown as Row[], cols(), { filters: query().rest, sorts: view().sorts }),
    loading: () => live().loading,
    error: () => live().error?.message ?? null,
    open: (r) => {
      if (s.display.view) rookery.workbench.openView(s.display.view as never, { path: r.id })
      else if (s.scheme) openEntity(rookery, `${s.scheme}://${r.id}`)
    },
    set: async (r, col, v) => {
      const f = col.field
      if (!f) return
      let value = v
      if (f.kind === "ref" && Array.isArray(v)) value = v[0] ?? null
      if (f.kind === "boolean") value = v === true
      if ((f.kind === "integer" || f.kind === "number") && v !== null && v !== "") value = Number(v)
      if (v === "" || v === undefined) value = null
      await coll.update(r.id, { [f.name]: value } as never)
    },
    add: s.display.create
      ? async (values) => {
          const row: Record<string, unknown> = {}
          for (const [k, v] of Object.entries(values)) {
            const c = cols().find((x) => x.id === k)
            if (c?.field) row[c.field.name] = Array.isArray(v) && c.field.kind === "ref" ? v[0] : v
          }
          row[primary] ??= values.title ?? "Untitled"
          delete row.title
          if (primary !== "title" && values.title) row[primary] = values.title
          await coll.insert(row as never)
        }
      : null,
    icon: () => (s.def.entity ? (s.display.icon ?? "file") : "file"),
    uri: (r) => (s.scheme ? `${s.scheme}://${r.id}` : null),
    label: () => s.display.title,
    where: () => `${s.display.title} · ${s.plugin}`,
  }
}

const LAYOUTS: Array<{ id: Layout; label: string; icon: string }> = [
  { id: "table", label: "Table", icon: "grid" },
  { id: "board", label: "Board", icon: "board" },
  { id: "list", label: "List", icon: "list" },
]

function Toolbar(props: {
  b: Bound
  view: ViewConfig
  set: (v: Partial<ViewConfig>) => void
  readOnly: boolean
  groupBy: () => Column | undefined
}): JSX.Element {
  const [open, setOpen] = createSignal<"filter" | "sort" | "fields" | "group" | null>(null)
  const anchors: Record<string, HTMLButtonElement> = {}
  const cols = () => props.b.cols()
  const setFilter = (i: number, patch: Partial<Filter>) =>
    props.set({ filters: props.view.filters.map((f, j) => (j === i ? { ...f, ...patch } : f)) })
  return (
    <div class="docs-db__tools">
      <Tabs
        label="Layout"
        items={LAYOUTS.map((l) => ({ id: l.id, label: l.label, icon: l.icon as never }))}
        value={props.view.layout}
        onChange={(id) => props.set({ layout: id as Layout })}
      />
      {/* Narrow, the layout is one button with a menu, so the head stays one row. */}
      <span class="docs-db__layout-menu">
        <DropdownMenu
          label="Layout"
          items={LAYOUTS.map((l) => ({
            id: l.id,
            label: l.label,
            icon: l.icon as never,
            checked: l.id === props.view.layout,
          }))}
          onSelect={(id) => props.set({ layout: id as Layout })}
          trigger={(t) => (
            <IconButton
              {...t}
              icon={(LAYOUTS.find((l) => l.id === props.view.layout)?.icon ?? "grid") as never}
              label={`Layout: ${LAYOUTS.find((l) => l.id === props.view.layout)?.label ?? ""}`}
            />
          )}
        />
      </span>
      <span class="docs-page__spacer" />
      <Show when={props.view.layout === "board" || props.view.groupBy}>
        <IconButton
          ref={(el: HTMLButtonElement) => (anchors.group = el)}
          icon="layers"
          label={`Group by ${props.groupBy()?.name ?? "…"}`}
          pressed={open() === "group"}
          onClick={() => setOpen("group")}
          data-part="db-group"
        />
      </Show>
      <IconButton
        ref={(el: HTMLButtonElement) => (anchors.filter = el)}
        icon="filter"
        label={props.view.filters.length ? `Filter (${props.view.filters.length})` : "Filter"}
        pressed={props.view.filters.length > 0}
        onClick={() => setOpen("filter")}
        data-part="db-filter"
      />
      <IconButton
        ref={(el: HTMLButtonElement) => (anchors.sort = el)}
        icon="sort"
        label={props.view.sorts.length ? `Sort (${props.view.sorts.length})` : "Sort"}
        pressed={props.view.sorts.length > 0}
        onClick={() => setOpen("sort")}
        data-part="db-sort"
      />
      <IconButton
        ref={(el: HTMLButtonElement) => (anchors.fields = el)}
        icon="sliders-horizontal"
        label="Fields"
        onClick={() => setOpen("fields")}
        data-part="db-fields"
      />
      <Popover
        open={open() === "group"}
        anchor={anchors.group}
        onClose={() => setOpen(null)}
        placement="bottom-end"
      >
        <Menu
          label="Group by"
          radio
          items={[
            ...groupable(cols()).map((c) => ({
              id: c.id,
              label: c.name,
              checked: props.groupBy()?.id === c.id,
            })),
            { id: "__none", label: "No grouping", checked: !props.groupBy() },
          ]}
          onSelect={(id) => {
            props.set({ groupBy: id === "__none" ? null : id })
            setOpen(null)
          }}
          onRequestClose={() => setOpen(null)}
        />
      </Popover>
      <Popover
        open={open() === "filter"}
        anchor={anchors.filter}
        onClose={() => setOpen(null)}
        placement="bottom-end"
      >
        <div class="docs-db__pop" data-part="db-filter-pop">
          <For
            each={props.view.filters}
            fallback={<span class="nc-meta">No filters. Rows of every kind show.</span>}
          >
            {(f, i) => {
              const col = () => cols().find((c) => c.id === f.field) ?? cols()[0]!
              return (
                <div class="docs-db__filter">
                  <Select
                    aria-label="Field"
                    options={cols().map((c) => ({ value: c.id, label: c.name }))}
                    value={col().id}
                    onChange={(v) =>
                      setFilter(i(), {
                        field: v,
                        op: opsFor(cols().find((c) => c.id === v)!)[0]!,
                        value: undefined,
                      })
                    }
                  />
                  <Select
                    aria-label="Condition"
                    options={opsFor(col()).map((o) => ({ value: o, label: OP_LABEL[o] }))}
                    value={f.op}
                    onChange={(v) => setFilter(i(), { op: v as FilterOp })}
                  />
                  <Show when={!["empty", "notEmpty", "checked", "unchecked"].includes(f.op)}>
                    <Show
                      when={col().options?.length}
                      fallback={
                        <input
                          class="nc-input docs-db__value"
                          aria-label="Value"
                          value={String(f.value ?? "")}
                          type={col().type === "number" ? "number" : col().type === "date" ? "date" : "text"}
                          onChange={(e) => setFilter(i(), { value: e.currentTarget.value })}
                        />
                      }
                    >
                      <Select
                        aria-label="Value"
                        options={col().options!.map((o) => ({ value: o.id, label: o.name }))}
                        value={f.value as string | undefined}
                        placeholder="Choose"
                        onChange={(v) => setFilter(i(), { value: v })}
                      />
                    </Show>
                  </Show>
                  <IconButton
                    icon="close"
                    label="Remove the filter"
                    onClick={() => props.set({ filters: props.view.filters.filter((_, j) => j !== i()) })}
                  />
                </div>
              )
            }}
          </For>
          <Button
            size="sm"
            variant="ghost"
            icon="plus"
            onClick={() =>
              props.set({
                filters: [
                  ...props.view.filters,
                  { field: cols()[1]?.id ?? cols()[0]!.id, op: opsFor(cols()[1] ?? cols()[0]!)[0]! },
                ],
              })
            }
            data-part="db-add-filter"
          >
            Add a filter
          </Button>
        </div>
      </Popover>
      <Popover
        open={open() === "sort"}
        anchor={anchors.sort}
        onClose={() => setOpen(null)}
        placement="bottom-end"
      >
        <div class="docs-db__pop">
          <For each={props.view.sorts} fallback={<span class="nc-meta">In their own order.</span>}>
            {(s, i) => (
              <div class="docs-db__filter">
                <Select
                  aria-label="Field"
                  options={cols().map((c) => ({ value: c.id, label: c.name }))}
                  value={s.field}
                  onChange={(v) =>
                    props.set({ sorts: props.view.sorts.map((x, j) => (j === i() ? { ...x, field: v } : x)) })
                  }
                />
                <Select
                  aria-label="Direction"
                  options={[
                    { value: "asc", label: "Ascending" },
                    { value: "desc", label: "Descending" },
                  ]}
                  value={s.dir}
                  onChange={(v) =>
                    props.set({
                      sorts: props.view.sorts.map((x, j) =>
                        j === i() ? { ...x, dir: v as "asc" | "desc" } : x,
                      ),
                    })
                  }
                />
                <IconButton
                  icon="close"
                  label="Remove the sort"
                  onClick={() => props.set({ sorts: props.view.sorts.filter((_, j) => j !== i()) })}
                />
              </div>
            )}
          </For>
          <Button
            size="sm"
            variant="ghost"
            icon="plus"
            onClick={() => props.set({ sorts: [...props.view.sorts, { field: cols()[0]!.id, dir: "asc" }] })}
          >
            Add a sort
          </Button>
        </div>
      </Popover>
      <Popover
        open={open() === "fields"}
        anchor={anchors.fields}
        onClose={() => setOpen(null)}
        placement="bottom-end"
      >
        <Menu
          label="Fields"
          items={cols()
            .filter((c) => c.type !== "title")
            .map((c) => {
              const shown = visibleColumns(cols(), props.view).some((v) => v.id === c.id)
              return { id: c.id, label: c.name, checked: shown }
            })}
          onSelect={(id) => {
            const current = visibleColumns(cols(), props.view)
              .filter((c) => c.type !== "title")
              .map((c) => c.id)
            props.set({ fields: current.includes(id) ? current.filter((x) => x !== id) : [...current, id] })
          }}
          onRequestClose={() => setOpen(null)}
        />
      </Popover>
    </div>
  )
}

function Cell(props: {
  rookery: ClientRookeryWithDocs
  b: Bound
  row: Row
  col: Column
  readOnly: boolean
}): JSX.Element {
  const def = (): PropDef => ({
    id: props.col.id,
    name: props.col.name,
    type: props.col.type === "title" ? "text" : props.col.type,
    ...(props.col.options ? { options: props.col.options } : {}),
  })
  const editable = () => !props.readOnly && props.col.id !== "updatedAt" && props.col.id !== "createdAt"
  return (
    <Show
      when={editable()}
      fallback={<PropValue rookery={props.rookery} def={def()} value={props.col.get(props.row)} />}
    >
      <PropEditor
        rookery={props.rookery}
        def={def()}
        value={props.col.get(props.row)}
        readOnly={props.readOnly}
        onChange={(v) =>
          props.b.set(props.row, props.col, v).catch((e) =>
            props.rookery.workbench.toast({
              title: "Not saved",
              body: String(e?.message ?? e),
              kind: "danger",
            }),
          )
        }
        onDefChange={(d) => props.b.setDef?.(d)}
      />
    </Show>
  )
}

function TitleCell(props: { b: Bound; row: Row; col: Column }): JSX.Element {
  return (
    <button
      type="button"
      class="docs-db__title"
      onClick={() => props.b.open(props.row)}
      data-row-title={String(props.col.get(props.row) ?? "")}
    >
      <PageIcon icon={props.b.icon(props.row)} />
      <span>{String(props.col.get(props.row) || "Untitled")}</span>
    </button>
  )
}

function Table(props: {
  rookery: ClientRookeryWithDocs
  b: Bound
  view: ViewConfig
  set: (v: Partial<ViewConfig>) => void
  readOnly: boolean
}): JSX.Element {
  const shown = () => visibleColumns(props.b.cols(), props.view)
  const sortOf = (id: string) => props.view.sorts.find((s) => s.field === id)
  return (
    <div class="docs-db__scroll">
      <table class="docs-db__table" data-part="db-table">
        <thead>
          <tr>
            <For each={shown()}>
              {(c) => (
                <th scope="col">
                  <button
                    type="button"
                    class="docs-db__th"
                    onClick={() => {
                      const s = sortOf(c.id)
                      props.set({
                        sorts: !s
                          ? [{ field: c.id, dir: "asc" }]
                          : s.dir === "asc"
                            ? [{ field: c.id, dir: "desc" }]
                            : [],
                      })
                    }}
                  >
                    {c.name}
                    <Show when={sortOf(c.id)}>
                      {(s) => <Icon name={s().dir === "asc" ? "chevron-down" : "chevron-right"} size="sm" />}
                    </Show>
                  </button>
                </th>
              )}
            </For>
          </tr>
        </thead>
        <tbody>
          <For each={props.b.rows()}>
            {(r) => (
              <tr data-row={r.id}>
                <For each={shown()}>
                  {(c) => (
                    <td>
                      {c.type === "title" ? (
                        <TitleCell b={props.b} row={r} col={c} />
                      ) : (
                        <Cell rookery={props.rookery} b={props.b} row={r} col={c} readOnly={props.readOnly} />
                      )}
                    </td>
                  )}
                </For>
              </tr>
            )}
          </For>
        </tbody>
      </table>
    </div>
  )
}

function defOf(c: Column): PropDef {
  return {
    id: c.id,
    name: c.name,
    type: c.type === "title" ? "text" : c.type,
    ...(c.options ? { options: c.options } : {}),
  }
}

const filled = (v: unknown) => v !== undefined && v !== null && v !== "" && !(Array.isArray(v) && !v.length)

/**
 * A card's body from the source's display fields, for rows whose plugin draws no card of its own: the row's
 * icon and when it changed, its title, and the fields on the bottom edge, in the board's three rows.
 */
function GenericCard(props: {
  rookery: ClientRookeryWithDocs
  b: Bound
  row: Row
  title: Column
  fields: Column[]
}) {
  const updated = () => (props.row as { updatedAt?: string }).updatedAt
  return (
    <>
      <BoardCardTop>
        <PageIcon icon={props.b.icon(props.row)} />
        <Show when={updated()}>
          <span class="nc-meta" title={new Date(updated()!).toLocaleString()}>
            {ago(updated())}
          </span>
        </Show>
      </BoardCardTop>
      <BoardCardTitle>
        <span data-row-title={String(props.title.get(props.row) ?? "")}>
          {String(props.title.get(props.row) || "Untitled")}
        </span>
      </BoardCardTitle>
      <BoardCardMeta>
        <For each={props.fields}>
          {(c) => (
            <Show when={filled(c.get(props.row))}>
              <PropValue rookery={props.rookery} def={defOf(c)} value={c.get(props.row)} />
            </Show>
          )}
        </For>
      </BoardCardMeta>
    </>
  )
}

function DbBoard(props: {
  rookery: ClientRookeryWithDocs
  b: Bound
  view: ViewConfig
  readOnly: boolean
  groupBy: () => Column | undefined
  add: (values: Record<string, unknown>) => void
}): JSX.Element {
  const [over, setOver] = createSignal<string | null>(null)
  const [drag, setDrag] = createSignal<string | null>(null)
  const groups = (): Group[] => {
    const c = props.groupBy()
    // The rows without a value are a lane only while there are some: an empty "No status" is not an option.
    return c
      ? groupRows(props.b.rows(), c).filter((g) => g.key !== null || g.rows.length > 0)
      : [{ key: null, label: "All", rows: props.b.rows() }]
  }
  const shown = () =>
    visibleColumns(props.b.cols(), props.view)
      .filter((c) => c.type !== "title" && c.id !== props.groupBy()?.id)
      .slice(0, 3)
  const title = () => props.b.cols().find((c) => c.type === "title")!
  const valuesFor = (g: Group) =>
    props.groupBy() && g.key !== null ? { [props.groupBy()!.id]: valueForGroup(props.groupBy()!, g.key) } : {}
  return (
    <Board label={`${props.b.label()} board`} dragging={!!drag()} class="docs-board" data-part="db-board">
      <For each={groups()}>
        {(g) => (
          <BoardLane
            name={g.label}
            count={g.rows.length}
            hue={props.groupBy() ? (g.hue ?? "neutral") : undefined}
            onAdd={props.b.add && !props.readOnly ? () => props.add(valuesFor(g)) : undefined}
            addLabel={`New in ${g.label}`}
            drop={over() === String(g.key)}
            data-group={g.key ?? ""}
            onDragOver={(e) => {
              if (!drag() || props.readOnly || !props.groupBy()) return
              e.preventDefault()
              setOver(String(g.key))
            }}
            onDragLeave={(e) => {
              if (!(e.currentTarget as HTMLElement).contains(e.relatedTarget as Node | null)) setOver(null)
            }}
            onDrop={async (e) => {
              const id = drag()
              setOver(null)
              setDrag(null)
              const col = props.groupBy()
              if (!id || !col) return
              e.preventDefault()
              const row = props.b.rows().find((r) => r.id === id)
              if (row)
                await props.b.set(row, col, valueForGroup(col, g.key)).catch((err) =>
                  props.rookery.workbench.toast({
                    title: "Not moved",
                    body: String(err?.message ?? err),
                    kind: "danger",
                  }),
                )
            }}
          >
            <For each={g.rows}>
              {(r) => {
                const generic = () => (
                  <GenericCard rookery={props.rookery} b={props.b} row={r} title={title()} fields={shown()} />
                )
                return (
                  <BoardCard
                    draggable={!props.readOnly}
                    tabindex="0"
                    aria-label={String(title().get(r) || "Untitled")}
                    onDragStart={(e) => {
                      setDrag(r.id)
                      e.dataTransfer?.setData("text/plain", r.id)
                    }}
                    onDragEnd={() => setDrag(null)}
                    onClick={() => props.b.open(r)}
                    onKeyDown={(e) => {
                      if (e.key !== "Enter") return
                      e.preventDefault()
                      props.b.open(r)
                    }}
                    data-card={r.id}
                  >
                    <Show when={props.b.uri(r)} fallback={generic()}>
                      {(uri) => (
                        <EntityCard
                          rookery={props.rookery}
                          uri={uri()}
                          record={r}
                          groupedBy={props.groupBy()?.id}
                          fallback={generic()}
                        />
                      )}
                    </Show>
                  </BoardCard>
                )
              }}
            </For>
          </BoardLane>
        )}
      </For>
    </Board>
  )
}

function List(props: { rookery: ClientRookeryWithDocs; b: Bound; view: ViewConfig }): JSX.Element {
  const shown = () =>
    visibleColumns(props.b.cols(), props.view)
      .filter((c) => c.type !== "title")
      .slice(0, 4)
  const title = () => props.b.cols().find((c) => c.type === "title")!
  return (
    <div class="docs-db__list" data-part="db-list">
      <For each={props.b.rows()}>
        {(r) => {
          const generic = () => (
            <div class="docs-db__item" data-row={r.id}>
              <TitleCell b={props.b} row={r} col={title()} />
              <span class="docs-db__chips">
                <For each={shown()}>
                  {(c) => (
                    <Show when={filled(c.get(r))}>
                      <PropValue rookery={props.rookery} def={defOf(c)} value={c.get(r)} />
                    </Show>
                  )}
                </For>
              </span>
            </div>
          )
          return (
            <Show when={props.b.uri(r)} fallback={generic()}>
              {(uri) => (
                <EntityRow
                  rookery={props.rookery}
                  uri={uri()}
                  record={r}
                  onOpen={() => props.b.open(r)}
                  fallback={generic()}
                />
              )}
            </Show>
          )
        }}
      </For>
    </div>
  )
}

/** Chooses what the block shows. */
function Setup(props: {
  rookery: ClientRookeryWithDocs
  api: Api
  onPick: (src: Source, title: string) => void
}): JSX.Element {
  const showable = () =>
    props.rookery.data.showable().filter((s) => !(s.plugin === "docs" && s.collection === "pages"))
  const [q, setQ] = createSignal("")
  const [hits] = createResource(q, async (t) => {
    if (!t.trim() || !props.rookery.entities) return []
    const raw = await props.rookery.entities.search(t, { schemes: ["doc"], limit: 8 }).catch(() => [])
    return raw.map(entityOfHit)
  })
  const newDatabase = async () => {
    const title = (
      await ask("Name the database", { value: "Untitled database", confirm: "Create database" })
    )?.trim()
    if (!title) return
    const space = props.rookery.spaces.current()?.id
    const made = await props.api.create({ title, parent: hostPage(), ...(space ? { space } : {}) })
    // Starts with a status, so the board has columns.
    await props.rookery.data.space(made.spaceId).pages.update(made.id, {
      icon: "grid:mint",
      schema: [
        {
          id: "status",
          name: "Status",
          type: "select",
          options: [
            { id: "todo", name: "To do", hue: "neutral" },
            { id: "doing", name: "In progress", hue: "sky" },
            { id: "done", name: "Done", hue: "mint" },
          ],
        },
      ],
    } as never)
    props.onPick({ kind: "pages", parent: made.id, space: made.spaceId } as Source, title)
  }
  return (
    <div class="docs-db__setup" data-part="db-setup">
      <span class="label">Show a database</span>
      <div class="docs-db__choices">
        <Button size="sm" variant="primary" icon="plus" onClick={newDatabase} data-part="db-new">
          New database of pages
        </Button>
        <For each={showable()}>
          {(s) => (
            <Button
              size="sm"
              variant="secondary"
              icon={(s.display.icon as never) ?? "list"}
              onClick={() =>
                props.onPick(
                  {
                    kind: "collection",
                    plugin: s.plugin,
                    collection: s.collection,
                    ...(props.rookery.spaces.current() ? { space: props.rookery.spaces.current()!.id } : {}),
                  },
                  s.display.title,
                )
              }
              data-source={`${s.plugin}.${s.collection}`}
            >
              {s.display.title}
            </Button>
          )}
        </For>
      </div>
      <input
        class="nc-input"
        placeholder="Or the pages under a page: search"
        aria-label="Search pages"
        value={q()}
        onInput={(e) => setQ(e.currentTarget.value)}
      />
      <For each={(hits() ?? []).filter((h) => !h.deletedAt)}>
        {(h) => (
          <button
            type="button"
            class="docs-move__item"
            onClick={() =>
              props.onPick(
                { kind: "pages", parent: h.id, ...(h.spaceId ? { space: h.spaceId } : {}) } as Source,
                h.title,
              )
            }
          >
            <PageIcon icon={h.icon} />
            <span>{h.title}</span>
          </button>
        )}
      </For>
    </div>
  )
}

/**
 * The space a space-scoped collection is read from: the document's space when the block was made, and any
 * other the person is in (a project's issues in a teamspace's page).
 */
function SpacePick(props: {
  rookery: ClientRookeryWithDocs
  value: string | undefined
  readOnly: boolean
  onChange: (space: string) => void
}): JSX.Element {
  const [spaces] = createResource(() => props.rookery.spaces.list().catch(() => []))
  const name = () => spaces()?.find((x) => x.id === props.value)?.name
  return (
    <Show when={!props.readOnly} fallback={<span class="nc-meta">{name()}</span>}>
      <Select
        aria-label="Space"
        placeholder="Pick a space"
        value={props.value ?? ""}
        options={(spaces() ?? []).map((x) => ({ value: x.id, label: x.name }))}
        onChange={(v) => props.onChange(v)}
        data-part="db-space"
      />
    </Show>
  )
}

export function DatabaseBlock(props: {
  rookery: ClientRookeryWithDocs
  api: Api
  attrs: Record<string, unknown>
  setAttrs: (p: Record<string, unknown>) => void
  readOnly: boolean
}): JSX.Element {
  const a = (): DatabaseAttrs => attrsOf(props.attrs)
  const setView = (v: Partial<ViewConfig>) => props.setAttrs({ view: { ...a().view, ...v } })
  const showable = (src: Extract<Source, { kind: "collection" }>) =>
    props.rookery.data.showable().find((s) => s.plugin === src.plugin && s.collection === src.collection)
  return (
    <div
      class="docs-db"
      data-part="database"
      data-layout={a().view.layout}
      onKeyDown={(e) => e.stopPropagation()}
    >
      <AskHost />
      <Show
        when={a().source}
        keyed
        fallback={
          <Show when={!props.readOnly} fallback={<span class="nc-meta">An empty database.</span>}>
            <Setup
              rookery={props.rookery}
              api={props.api}
              onPick={(source, title) =>
                props.setAttrs({ source, title, view: { ...a().view, layout: "table" } })
              }
            />
          </Show>
        }
      >
        {(src) => {
          const s = src.kind === "collection" ? showable(src) : null
          if (src.kind === "collection" && !s)
            return (
              <EmptyState
                icon="layers"
                title="This database is not available"
                description={`${src.plugin} is disabled, or ${src.collection} no longer offers itself here.`}
              />
            )
          const view = () => a().view
          const b =
            src.kind === "pages"
              ? bindPages(props.rookery, props.api, src as never, view)
              : bindCollection(props.rookery, s!, src, view)
          const groupBy = () => {
            const cols = b.cols()
            const id =
              view().groupBy ??
              (view().layout === "board" ? (s?.display.status ?? groupable(cols)[0]?.id) : null)
            return id ? cols.find((c) => c.id === id) : undefined
          }
          const add = async (values: Record<string, unknown>) => {
            if (!b.add) return
            const title = (
              await ask("Name the new row", { value: "", placeholder: "Untitled", confirm: "Add" })
            )?.trim()
            if (title === undefined || title === null) return
            await b.add({ ...values, title: title || "Untitled" }).catch((e) =>
              props.rookery.workbench.toast({
                title: "Not added",
                body: String(e?.message ?? e),
                kind: "danger",
              }),
            )
          }
          return (
            <>
              <div class="docs-db__head">
                <span class="heading docs-db__name">{a().title || b.label()}</span>
                <span class="nc-meta docs-db__where">{b.where()}</span>
                <Show when={src.kind === "collection" && (s!.def.scope ?? "space") === "space"}>
                  <SpacePick
                    rookery={props.rookery}
                    value={(src as Extract<Source, { kind: "collection" }>).space}
                    readOnly={props.readOnly}
                    onChange={(space) => props.setAttrs({ source: { ...src, space } })}
                  />
                </Show>
                <Toolbar b={b} view={view()} set={setView} readOnly={props.readOnly} groupBy={groupBy} />
                <Show when={!props.readOnly}>
                  <DropdownMenu
                    label="Database"
                    placement="bottom-end"
                    items={[{ id: "source", label: "Choose another source", icon: "layers" }]}
                    onSelect={(id) => id === "source" && props.setAttrs({ source: null })}
                    trigger={(t) => <IconButton {...t} icon="more" label="More" data-part="db-more" />}
                  />
                </Show>
              </div>
              <Show when={b.error()}>
                <p class="docs-error">{b.error()}</p>
              </Show>
              <Show when={view().layout === "table"}>
                <Table rookery={props.rookery} b={b} view={view()} set={setView} readOnly={props.readOnly} />
              </Show>
              <Show when={view().layout === "board"}>
                <DbBoard
                  rookery={props.rookery}
                  b={b}
                  view={view()}
                  readOnly={props.readOnly}
                  groupBy={groupBy}
                  add={add}
                />
              </Show>
              <Show when={view().layout === "list"}>
                <List rookery={props.rookery} b={b} view={view()} />
              </Show>
              <div class="docs-db__foot">
                <Show when={b.add && !props.readOnly && view().layout !== "board"}>
                  <button
                    type="button"
                    class="docs-board__new nc-meta"
                    onClick={() => add({})}
                    data-part="db-new-row"
                  >
                    <Icon name="plus" size="sm" /> New
                  </button>
                </Show>
                <span class="nc-meta">{b.loading() ? "Loading…" : `${b.rows().length} rows`}</span>
              </div>
            </>
          )
        }}
      </Show>
    </div>
  )
}
