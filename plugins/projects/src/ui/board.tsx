// The board: a column per group (states by default), cards in the manual order, swimlanes by a second
// grouping, a count per column and lane. Cards are dragged with the pointer (mouse, pen or touch) between
// columns, which changes the grouped property, and within a column, which changes the manual order. A
// column shows only the cards in view, so a backlog of thousands stays light.

import {
  BOARD_CARD_GAP,
  BOARD_CARD_HEIGHT,
  Board,
  BoardCard,
  BoardCardMeta,
  BoardCardTitle,
  BoardCardTop,
  BoardDrop,
  BoardLane,
  BoardLaneHead,
  useBoard,
} from "@aiviarium/nocturne"
import type { ClientRookery } from "@rookery/sdk/client"
import { createMemo, createSignal, For, onCleanup, onMount, Show } from "solid-js"
import {
  type Display,
  type Group,
  type Grouping,
  groupIssues,
  type Lookup,
  neighbours,
  patchForGroup,
} from "../lib/display"
import type { IssueRow } from "../lib/model"
import { moveIssue } from "./actions"
import { Key, Label, Person, PriorityIcon, StateIcon } from "./glyphs"
import { formatDay } from "./props"
import { SourceBadge } from "./source"
import { nameOf, type ProjectStore } from "./store"

export const CARD = BOARD_CARD_HEIGHT
const SLOT = CARD + BOARD_CARD_GAP
/** Cards in a swimlane cell before "Show more". */
const LANE_CARDS = 30

export interface BoardProps {
  crow: ClientRookery
  store: ProjectStore
  issues: IssueRow[]
  display: Display
  lookup: Lookup
  selected: Set<string>
  cursor: string | null
  setCursor: (id: string) => void
  onOpen: (issue: IssueRow) => void
  onSelect: (id: string, how: "toggle" | "range" | "only") => void
  /** A right click on a card: its context menu, at this point. */
  onMenu?: (issue: IssueRow, at: { x: number; y: number }) => void
  onAdd: (patch: Record<string, unknown>) => void
  readOnly: boolean
}

interface Drag {
  id: string
  issue: IssueRow
  /** Where the pointer is. */
  x: number
  y: number
  dx: number
  dy: number
  width: number
  /** The drop target: column key, lane key, index among the column's cards (without the dragged one). */
  column: string | null
  lane: string | null
  index: number
}

export function IssueBoard(props: BoardProps) {
  const [drag, setDrag] = createSignal<Drag | null>(null)
  const lanes = createMemo<Array<{ key: string; name: string; groups: Group[] }>>(() => {
    const d = { ...props.display, layout: "board" as const, showEmpty: true }
    if (props.display.subGroupBy === "none" || props.display.subGroupBy === props.display.groupBy)
      return [{ key: "", name: "", groups: groupIssues(props.issues, d, props.lookup) }]
    const byLane = groupIssues(
      props.issues,
      { ...d, showEmpty: false, layout: "list" },
      props.lookup,
      props.display.subGroupBy,
    )
    const all = groupIssues(props.issues, d, props.lookup).map((g) => g.key)
    return byLane.map((lane) => {
      const cols = groupIssues(lane.issues, d, props.lookup)
      // Every lane has every column, in the same order.
      const map = new Map(cols.map((c) => [c.key, c]))
      return { key: lane.key, name: lane.name, groups: all.map((k) => map.get(k)!).filter(Boolean) }
    })
  })
  const columns = () => lanes()[0]?.groups ?? []
  const swimlanes = () =>
    props.display.subGroupBy !== "none" && props.display.subGroupBy !== props.display.groupBy

  const drop = (d: Drag) => {
    if (d.column === null) return
    const lane = lanes().find((l) => l.key === (d.lane ?? ""))
    const col = lane?.groups.find((g) => g.key === d.column)
    const list = col?.issues ?? []
    const n = neighbours(list, d.id, d.index)
    // Leaving a column for another changes the grouped property; a lane, the second one.
    const fromKey = groupKeyOf(d.issue, props.display.groupBy)
    const patch: Record<string, unknown> = {
      ...(patchForGroup(d.issue, props.display.groupBy, d.column, fromKey) ?? {}),
    }
    if (swimlanes() && d.lane !== null)
      Object.assign(patch, patchForGroup(d.issue, props.display.subGroupBy, d.lane) ?? {})
    // In a manual order the neighbours decide the rank; otherwise only the group changes.
    const manual = props.display.orderBy === "manual"
    if (!manual && !Object.keys(patch).length) return
    void moveIssue(props.crow, props.store, {
      id: d.id,
      above: manual ? n.above : null,
      below: manual ? n.below : null,
      patch: Object.keys(patch).length ? (patch as never) : null,
    })
  }

  let el!: HTMLDivElement
  return (
    <Board ref={el} label="Board" fill fixed dragging={!!drag()} class="projects__board" custom={swimlanes()}>
      <Show
        when={swimlanes()}
        fallback={
          <For each={columns()}>
            {(g) => (
              <Column
                {...props}
                board={() => el}
                group={g}
                lane={null}
                drag={drag()}
                setDrag={setDrag}
                onDrop={drop}
                virtual
              />
            )}
          </For>
        }
      >
        <Lanes
          {...props}
          lanes={lanes()}
          columns={columns()}
          board={() => el}
          drag={drag()}
          setDrag={setDrag}
          drop={drop}
        />
      </Show>
      <Show when={drag()}>
        {(d) => (
          <BoardCard
            ghost
            aria-hidden="true"
            style={{
              width: `${d().width}px`,
              transform: `translate(${d().x - d().dx}px, ${d().y - d().dy}px) rotate(2deg)`,
            }}
          >
            <CardBody {...props} issue={d().issue} />
          </BoardCard>
        )}
      </Show>
    </Board>
  )
}

/** Swimlanes: a sticky row of column heads, then a section per lane with its row of columns. */
function Lanes(
  props: BoardProps & {
    lanes: Array<{ key: string; name: string; groups: Group[] }>
    columns: Group[]
    board: () => HTMLElement
    drag: Drag | null
    setDrag: (d: Drag | null) => void
    drop: (d: Drag) => void
  },
) {
  const board = useBoard()
  return (
    <div class="projects__board-lanes">
      <Show when={!board.stacked()}>
        <div class="nc-board__lanes projects__board-columns--heads">
          <For each={props.columns}>
            {(g) => <ColumnHead {...props} group={g} count={countIn(props.lanes, g.key)} />}
          </For>
        </div>
      </Show>
      <For each={props.lanes}>
        {(lane) => (
          <section class="projects__lane" aria-label={lane.name} data-lane={lane.key}>
            <header class="projects__lane-head">
              <span class="label">{lane.name}</span>
              <span class="nc-meta nc-num">{lane.groups.reduce((n, g) => n + g.issues.length, 0)}</span>
            </header>
            <div class="nc-board__lanes">
              <For each={lane.groups}>
                {(g) => (
                  <Column
                    {...props}
                    group={g}
                    lane={lane.key}
                    drag={props.drag}
                    setDrag={props.setDrag}
                    onDrop={props.drop}
                    virtual={false}
                    hideHead={!board.stacked()}
                  />
                )}
              </For>
            </div>
          </section>
        )}
      </For>
    </div>
  )
}

function countIn(lanes: Array<{ groups: Group[] }>, key: string) {
  let n = 0
  for (const l of lanes) n += l.groups.find((g) => g.key === key)?.issues.length ?? 0
  return n
}

function groupKeyOf(issue: IssueRow, g: Grouping): string | undefined {
  if (g === "label") return undefined
  return (
    (
      {
        state: issue.state,
        assignee: issue.assignee,
        priority: String(issue.priority ?? 0),
        cycle: issue.cycle,
        parent: issue.parent,
      } as Record<string, string | null | undefined>
    )[g] ?? undefined
  )
}

function ColumnHead(props: BoardProps & { group: Group; count?: number }) {
  const g = () => props.group
  return (
    <BoardLaneHead
      data-column-head={g().key}
      name={g().name}
      count={props.count ?? g().issues.length}
      icon={
        props.display.groupBy === "state" ? (
          <StateIcon category={g().state?.category} color={g().state?.color} />
        ) : undefined
      }
      onAdd={props.readOnly ? undefined : () => add(props, g())}
      addLabel={`New issue in ${g().name}`}
    />
  )
}

function add(props: BoardProps, g: Group) {
  props.onAdd(patchForGroup({ labels: [] } as never, props.display.groupBy, g.key) ?? {})
}

function Column(
  props: BoardProps & {
    group: Group
    lane: string | null
    drag: Drag | null
    setDrag: (d: Drag | null) => void
    onDrop: (d: Drag) => void
    virtual: boolean
    hideHead?: boolean
    board: () => HTMLElement
  },
) {
  let body!: HTMLDivElement
  const board = useBoard()
  // A stacked board (a narrow one) lays its cards out as rows in the flow: no virtual space, no dragging.
  const virtual = () => props.virtual && !board.stacked()
  const placed = () => !board.stacked()
  const [top, setTop] = createSignal(0)
  const [height, setHeight] = createSignal(800)
  const [more, setMore] = createSignal(false)
  onMount(() => {
    setHeight(body.clientHeight || 800)
    const ro = new ResizeObserver(() => setHeight(body.clientHeight || 800))
    ro.observe(body)
    onCleanup(() => ro.disconnect())
  })
  const g = () => props.group
  const here = () => props.drag && props.drag.column === g().key && (props.drag.lane ?? null) === props.lane
  // The cards as laid out: the dragged one is lifted out, and a gap opens where it would land.
  const cards = createMemo(() => {
    const list = props.drag ? g().issues.filter((i) => i.id !== props.drag!.id) : g().issues
    return virtual() || more() ? list : list.slice(0, LANE_CARDS)
  })
  const gapAt = () => (here() ? props.drag!.index : -1)
  const slots = createMemo(() => {
    if (!virtual()) return cards().map((_, n) => n)
    const first = Math.max(0, Math.floor(top() / SLOT) - 3)
    const last = Math.min(cards().length, Math.ceil((top() + height()) / SLOT) + 3)
    return Array.from({ length: Math.max(0, last - first) }, (_, k) => first + k)
  })
  const yOf = (n: number) => n * SLOT + (gapAt() >= 0 && n >= gapAt() ? SLOT : 0)
  const total = () => cards().length + (here() ? 1 : 0)

  const startDrag = (e: PointerEvent, issue: IssueRow, el: HTMLElement) => {
    if (props.readOnly || e.button !== 0 || board.stacked()) return
    const r = el.getBoundingClientRect()
    const sx = e.clientX
    const sy = e.clientY
    let started = false
    const move = (ev: PointerEvent) => {
      if (!started && Math.hypot(ev.clientX - sx, ev.clientY - sy) < 5) return
      if (!started) {
        started = true
        el.setPointerCapture?.(ev.pointerId)
      }
      ev.preventDefault()
      props.setDrag({
        ...target(props.board(), ev.clientX, ev.clientY),
        id: issue.id,
        issue,
        x: ev.clientX,
        y: ev.clientY,
        dx: sx - r.left,
        dy: sy - r.top,
        width: r.width,
      })
      autoScroll(props.board(), ev.clientX, ev.clientY)
    }
    const up = (ev: PointerEvent) => {
      window.removeEventListener("pointermove", move)
      window.removeEventListener("pointerup", up)
      window.removeEventListener("pointercancel", cancel)
      if (!started) return
      const d = {
        ...target(props.board(), ev.clientX, ev.clientY),
        id: issue.id,
        issue,
        x: ev.clientX,
        y: ev.clientY,
        dx: 0,
        dy: 0,
        width: 0,
      }
      props.setDrag(null)
      props.onDrop(d)
      // The click that follows a drag does not open the card.
      const swallow = (c: MouseEvent) => {
        c.stopPropagation()
        c.preventDefault()
      }
      window.addEventListener("click", swallow, { capture: true, once: true })
      setTimeout(() => window.removeEventListener("click", swallow, { capture: true }), 50)
    }
    const cancel = () => {
      window.removeEventListener("pointermove", move)
      window.removeEventListener("pointerup", up)
      window.removeEventListener("pointercancel", cancel)
      props.setDrag(null)
    }
    window.addEventListener("pointermove", move)
    window.addEventListener("pointerup", up)
    window.addEventListener("pointercancel", cancel)
  }

  return (
    <BoardLane
      name={g().name}
      count={g().issues.length}
      icon={
        props.display.groupBy === "state" ? (
          <StateIcon category={g().state?.category} color={g().state?.color} />
        ) : undefined
      }
      onAdd={props.readOnly ? undefined : () => add(props, g())}
      addLabel={`New issue in ${g().name}`}
      hideHead={props.hideHead}
      drop={!!here()}
      data-column={g().key}
      data-lane={props.lane ?? undefined}
      bodyRef={(el) => (body = el)}
      bodyProps={{
        "data-col-body": g().key,
        "data-lane-body": props.lane ?? "",
        "data-virtual": virtual() ? "" : undefined,
        "data-count": String(cards().length),
        onScroll: () => setTop(body.scrollTop),
      }}
      footer={
        <Show when={!virtual() && !more() && g().issues.length > LANE_CARDS}>
          <button type="button" class="nc-btn nc-btn--ghost nc-btn--sm" onClick={() => setMore(true)}>
            Show {g().issues.length - LANE_CARDS} more
          </button>
        </Show>
      }
    >
      <Show when={g().issues.length || here()}>
        <div
          class="projects__col-space"
          style={placed() ? { height: `${Math.max(total() * SLOT, here() ? SLOT : 0)}px` } : undefined}
        >
          <For each={slots()}>
            {(n) => {
              const issue = () => cards()[n]
              return (
                <Show when={issue()}>
                  {(i) => (
                    <BoardCard
                      placed={placed()}
                      data-issue={i().id}
                      data-key={i().key}
                      selected={props.selected.has(i().id)}
                      active={props.cursor === i().id}
                      tabindex="-1"
                      style={placed() ? { transform: `translateY(${yOf(n)}px)` } : undefined}
                      onPointerDown={(e) => startDrag(e, i(), e.currentTarget)}
                      onClick={(e) => {
                        props.setCursor(i().id)
                        if (e.shiftKey) props.onSelect(i().id, "range")
                        else if (e.metaKey || e.ctrlKey) props.onSelect(i().id, "toggle")
                        else props.onOpen(i())
                      }}
                      onContextMenu={(e) => {
                        if (!props.onMenu) return
                        e.preventDefault()
                        props.onMenu(i(), { x: e.clientX, y: e.clientY })
                      }}
                    >
                      <CardBody {...props} issue={i()} />
                    </BoardCard>
                  )}
                </Show>
              )
            }}
          </For>
          <Show when={here() && placed()}>
            <BoardDrop placed style={{ transform: `translateY(${gapAt() * SLOT}px)` }} />
          </Show>
        </div>
      </Show>
    </BoardLane>
  )
}

/** The column, lane and index under a point, from the columns' boxes and their scroll. */
function target(
  board: HTMLElement,
  x: number,
  y: number,
): { column: string | null; lane: string | null; index: number } {
  const bodies = [...board.querySelectorAll<HTMLElement>("[data-col-body]")]
  for (const b of bodies) {
    const r = b.getBoundingClientRect()
    const col = b.closest<HTMLElement>("[data-column]")!
    const cr = col.getBoundingClientRect()
    if (x < cr.left || x > cr.right || y < cr.top || y > cr.bottom) continue
    const offset = y - r.top + b.scrollTop
    // The slot whose upper half the pointer is in: before that card; its lower half, after it.
    const count = Number(b.dataset.count ?? "0")
    const index = Math.max(0, Math.min(count, Math.floor(offset / SLOT + 0.5)))
    const lane = b.dataset.laneBody || col.dataset.lane || null
    return { column: b.dataset.colBody ?? null, lane, index }
  }
  return { column: null, lane: null, index: 0 }
}

let scrolling: ReturnType<typeof setInterval> | null = null
function autoScroll(board: HTMLElement, x: number, y: number) {
  if (scrolling) clearInterval(scrolling)
  scrolling = null
  const bodies = [...board.querySelectorAll<HTMLElement>("[data-col-body]")]
  const b = bodies.find((el) => {
    const r = el.getBoundingClientRect()
    return x >= r.left && x <= r.right && y >= r.top && y <= r.bottom
  })
  if (!b) return
  const r = b.getBoundingClientRect()
  const edge = 48
  const dir = y < r.top + edge ? -1 : y > r.bottom - edge ? 1 : 0
  if (!dir) return
  scrolling = setInterval(() => {
    b.scrollTop += dir * 12
    b.dispatchEvent(new Event("scroll"))
  }, 16)
  setTimeout(() => {
    if (scrolling) clearInterval(scrolling)
    scrolling = null
  }, 400)
}

/** An issue's card: its key (and due date) and assignee, its title, and its priority, labels and estimate. */
export function CardBody(props: {
  crow: ClientRookery
  store: ProjectStore
  issue: IssueRow
  display: Pick<Display, "groupBy">
}) {
  const i = () => props.issue
  const labels = () => props.store.labels().filter((l) => i().labels?.includes(`label://${l.id}`))
  const st = () => props.store.states().find((s) => s.id === i().state)
  return (
    <>
      <BoardCardTop>
        <span class="projects__card-id">
          <Key>{i().key}</Key>
          <SourceBadge crow={props.crow} issue={i()} />
          {/* A due date is worth a place on the card, beside the key where it always fits (on a line of its own a
              card with a two-line title outgrew its slot; at the end of the labels it was cut off); when it was
              created is not. */}
          <Show when={i().due}>
            <span class="nc-meta">· Due {formatDay(i().due!)}</span>
          </Show>
        </span>
        <Show when={i().assignee}>
          <Person name={nameOf(props.crow, i().assignee)} />
        </Show>
      </BoardCardTop>
      <BoardCardTitle
        icon={
          props.display.groupBy !== "state" ? (
            <StateIcon category={i().stateCategory} color={st()?.color} />
          ) : undefined
        }
      >
        {i().title}
      </BoardCardTitle>
      <BoardCardMeta>
        <Show when={(i().priority ?? 0) > 0}>
          <PriorityIcon priority={i().priority} />
        </Show>
        <For each={labels().slice(0, 3)}>{(l) => <Label name={l.name} color={l.color} />}</For>
        <Show when={i().estimate != null}>
          <span class="nc-meta projects__card-est">{i().estimate}</span>
        </Show>
      </BoardCardMeta>
    </>
  )
}
