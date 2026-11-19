// The list: issues in groups (state, assignee, priority, label, cycle or parent), each row with its
// properties editable in place. Only the rows in view are in the DOM, so a project of ten thousand issues
// scrolls as one of ten. Keyboard handling lives in the view around it (issues.tsx); this draws rows, the
// cursor and the selection.

import { createRowSwipe, Icon, touchScreen } from "@aiviarium/nocturne"
import type { ClientRookery } from "@rookery/sdk/client"
import { createMemo, createSignal, For, type JSX, Match, onCleanup, onMount, Show, Switch } from "solid-js"
import type { Grouping, ListRow } from "../lib/display"
import type { IssueRow } from "../lib/model"
import { updateIssues } from "./actions"
import { Key, StateIcon } from "./glyphs"
import { formatDay, PropControl } from "./props"
import { SourceBadge } from "./source"
import type { ProjectStore } from "./store"

export const ROW = 36

export interface ListProps {
  crow: ClientRookery
  rows: ListRow[]
  grouping: Grouping
  storeOf: (space: string) => ProjectStore | null
  selected: Set<string>
  onSelect: (id: string, how: "toggle" | "range" | "only") => void
  cursor: number
  setCursor: (n: number) => void
  onOpen: (issue: IssueRow) => void
  /** A right click or a long press on an issue: its context menu, at this point. */
  onMenu?: (issue: IssueRow, at: { x: number; y: number }) => void
  onToggleGroup: (key: string) => void
  onAddToGroup?: (groupKey: string) => void
  /** Show the project's name before the key (lists across projects). */
  showProject?: boolean
  readOnly?: (issue: IssueRow) => boolean
  /** Receives a function that scrolls a row into view. */
  scrollRef?: (scroll: (index: number) => void) => void
  empty?: JSX.Element
}

export function IssueList(props: ListProps) {
  let el!: HTMLDivElement
  const [top, setTop] = createSignal(0)
  const [height, setHeight] = createSignal(800)
  onMount(() => {
    setHeight(el.clientHeight || 800)
    const ro = new ResizeObserver(() => setHeight(el.clientHeight || 800))
    ro.observe(el)
    onCleanup(() => ro.disconnect())
    props.scrollRef?.((i) => {
      const y = i * ROW
      if (y < el.scrollTop) el.scrollTop = y
      else if (y + ROW > el.scrollTop + el.clientHeight) el.scrollTop = y + ROW - el.clientHeight
      setTop(el.scrollTop)
    })
  })
  const range = createMemo(() => {
    const first = Math.max(0, Math.floor(top() / ROW) - 8)
    const last = Math.min(props.rows.length, Math.ceil((top() + height()) / ROW) + 8)
    return Array.from({ length: Math.max(0, last - first) }, (_, k) => first + k)
  })
  return (
    <div ref={el} class="projects__list" data-part="issue-list" onScroll={() => setTop(el.scrollTop)}>
      <Show when={props.rows.length} fallback={props.empty}>
        <div class="projects__list-space" style={{ height: `${props.rows.length * ROW}px` }}>
          <For each={range()}>
            {(index) => (
              <div class="projects__list-slot" style={{ transform: `translateY(${index * ROW}px)` }}>
                <RowAt {...props} index={index} />
              </div>
            )}
          </For>
        </div>
      </Show>
    </div>
  )
}

function RowAt(props: ListProps & { index: number }) {
  const row = () => props.rows[props.index]
  return (
    <Switch>
      <Match when={row()?.kind === "group" && row()} keyed>
        {(r) => <GroupRow {...props} row={r as Extract<ListRow, { kind: "group" }>} />}
      </Match>
      <Match when={row()?.kind === "issue" && (row() as Extract<ListRow, { kind: "issue" }>)}>
        {(r) => <IssueRowView {...props} issue={r().issue} groupKey={r().group} />}
      </Match>
    </Switch>
  )
}

function GroupRow(props: ListProps & { index: number; row: Extract<ListRow, { kind: "group" }> }) {
  const g = () => props.row.group
  return (
    // biome-ignore lint/a11y/useKeyWithClickEvents lint/a11y/noStaticElementInteractions: the surface around the list handles the keys (j, k, Enter, x)
    <div
      class="projects__group"
      data-group={g().key}
      data-active={props.cursor === props.index ? "" : undefined}
      onClick={() => props.setCursor(props.index)}
    >
      <button
        type="button"
        class="projects__group-toggle"
        aria-expanded={!props.row.collapsed}
        aria-label={`${props.row.collapsed ? "Expand" : "Collapse"} ${g().name}`}
        onClick={(e) => {
          e.stopPropagation()
          props.onToggleGroup(g().key)
        }}
      >
        <Icon name={props.row.collapsed ? "chevron-right" : "chevron-down"} size="sm" />
      </button>
      <Show when={props.grouping === "state"}>
        <StateIcon category={g().state?.category} color={g().state?.color} />
      </Show>
      <span class="label">{g().name}</span>
      <span class="nc-meta nc-num">{g().issues.length}</span>
      <Show when={props.onAddToGroup}>
        <button
          type="button"
          class="nc-icon-btn projects__group-add"
          aria-label={`New issue in ${g().name}`}
          onClick={(e) => {
            e.stopPropagation()
            props.onAddToGroup?.(g().key)
          }}
        >
          <Icon name="plus" size="sm" />
        </button>
      </Show>
    </div>
  )
}

function IssueRowView(props: ListProps & { index: number; issue: IssueRow; groupKey: string }) {
  const i = () => props.issue
  const store = () => props.storeOf(i().spaceId)
  const selected = () => props.selected.has(i().id)
  const change = (patch: Partial<IssueRow>) => updateIssues(props.crow, props.storeOf, [i()], patch as never)
  const ro = () => props.readOnly?.(i()) ?? false
  // A long press on a touch screen opens the issue's menu, as a right click does.
  const press = createRowSwipe({
    element: () => undefined,
    leading: () => 0,
    trailing: () => 0,
    menu: () => Boolean(props.onMenu) && touchScreen(),
    onLongPress: (at) => props.onMenu?.(i(), at),
  })
  return (
    // biome-ignore lint/a11y/useKeyWithClickEvents lint/a11y/noStaticElementInteractions: the surface around the list handles the keys (j, k, Enter, x)
    <div
      class="projects__row"
      data-issue={i().id}
      data-key={i().key}
      data-selected={selected() ? "" : undefined}
      data-active={props.cursor === props.index ? "" : undefined}
      {...press.handlers}
      onMouseDown={(e) => {
        // A Shift or Cmd click selects issues, not the text between them.
        if (e.shiftKey || e.metaKey || e.ctrlKey) e.preventDefault()
      }}
      onClick={(e) => {
        if (press.swallowClick(e)) return
        if ((e.target as HTMLElement).closest(".projects__prop, .nc-check, input")) return
        props.setCursor(props.index)
        if (e.shiftKey) props.onSelect(i().id, "range")
        else if (e.metaKey || e.ctrlKey) props.onSelect(i().id, "toggle")
        else props.onOpen(i())
      }}
      onContextMenu={(e) => {
        if (!props.onMenu || (e.target as HTMLElement).closest("input, textarea")) return
        e.preventDefault()
        props.onMenu(i(), { x: e.clientX, y: e.clientY })
      }}
    >
      {/* biome-ignore lint/a11y/useSemanticElements: a styled button, as @crow/ui's Checkbox draws it */}
      <button
        type="button"
        role="checkbox"
        class="nc-check projects__row-check"
        aria-checked={selected()}
        aria-label={`Select ${i().key}`}
        data-on={selected() ? "" : undefined}
        onClick={(e) => {
          e.stopPropagation()
          props.setCursor(props.index)
          props.onSelect(i().id, e.shiftKey ? "range" : "toggle")
        }}
      >
        <Show when={selected()}>
          <Icon name="check" size="sm" />
        </Show>
      </button>
      <IssueRowCells
        crow={props.crow}
        store={store()}
        issue={i()}
        readOnly={ro()}
        onChange={change}
        showProject={props.showProject}
      />
    </div>
  )
}

/**
 * An issue's row after its checkbox: priority, key, state, title, its properties, when it was made and the
 * assignee. The list draws it, and so does the issue's row anywhere else (crow.entities.row).
 */
export function IssueRowCells(props: {
  crow: ClientRookery
  store: ProjectStore | null
  issue: IssueRow
  readOnly: boolean
  onChange: (patch: Partial<IssueRow>) => void
  showProject?: boolean
}) {
  const i = () => props.issue
  return (
    <>
      <Show when={props.store} fallback={<span />}>
        {(s) => (
          <PropControl
            crow={props.crow}
            store={s()}
            issue={i()}
            prop="priority"
            compact
            disabled={props.readOnly}
            onChange={(p) => props.onChange(p)}
          />
        )}
      </Show>
      <Key>{i().key}</Key>
      <Show when={props.store} fallback={<span />}>
        {(s) => (
          <PropControl
            crow={props.crow}
            store={s()}
            issue={i()}
            prop="state"
            compact
            disabled={props.readOnly}
            onChange={(p) => props.onChange(p)}
          />
        )}
      </Show>
      <span class="projects__row-title">
        <span class="projects__row-text">{i().title}</span>
        <Show when={i().parent ? props.store?.issue(i().parent!) : undefined}>
          {(p) => <span class="nc-meta projects__row-parent">› {p().key}</span>}
        </Show>
        <Show when={props.showProject && props.store?.project()}>
          {(p) => <span class="nc-meta projects__row-project">{p().name}</span>}
        </Show>
      </span>
      <span class="projects__row-props">
        <Show when={props.store}>
          {(s) => (
            <>
              <Show when={i().labels?.length}>
                <PropControl
                  crow={props.crow}
                  store={s()}
                  issue={i()}
                  prop="labels"
                  compact
                  disabled={props.readOnly}
                  onChange={(p) => props.onChange(p)}
                />
              </Show>
              <Show when={i().due}>
                <PropControl
                  crow={props.crow}
                  store={s()}
                  issue={i()}
                  prop="due"
                  compact
                  disabled={props.readOnly}
                  onChange={(p) => props.onChange(p)}
                />
              </Show>
              <Show when={i().estimate != null}>
                <PropControl
                  crow={props.crow}
                  store={s()}
                  issue={i()}
                  prop="estimate"
                  compact
                  disabled={props.readOnly}
                  onChange={(p) => props.onChange(p)}
                />
              </Show>
              <Show when={i().cycle}>
                <PropControl
                  crow={props.crow}
                  store={s()}
                  issue={i()}
                  prop="cycle"
                  compact
                  disabled={props.readOnly}
                  onChange={(p) => props.onChange(p)}
                />
              </Show>
            </>
          )}
        </Show>
        {/* The source's number sits before the date, so the date and the assignee stay in their columns. */}
        <SourceBadge crow={props.crow} issue={i()} />
        <span
          class="nc-meta projects__row-date"
          title={`Updated ${new Date(i().updatedAt).toLocaleString()}`}
        >
          {formatDay(i().createdAt.slice(0, 10))}
        </span>
        <Show when={props.store}>
          {(s) => (
            <PropControl
              crow={props.crow}
              store={s()}
              issue={i()}
              prop="assignee"
              compact
              disabled={props.readOnly}
              onChange={(p) => props.onChange(p)}
            />
          )}
        </Show>
      </span>
    </>
  )
}
