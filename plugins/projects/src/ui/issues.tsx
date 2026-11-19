// A project's issues as a list or a board, and the same surface for "My issues" across projects. Filters,
// display options and saved views sit above; selected issues get a bulk bar. Keyboard first, as in Linear:
// j/k or the arrows move, x selects (Shift extends), Enter opens, s/a/l/p/e change state, assignee,
// labels, priority or estimate of the selection (or the issue under the cursor), i assigns to me, c creates,
// / filters, Escape clears, ? shows all of them.

import {
  Button,
  EmptyState,
  Icon,
  IconButton,
  isMenuKey,
  keyboardMenuPoint,
  type MenuEntry,
  menuTarget,
  RowMenu,
  usePhone,
  ViewHeader,
} from "@aiviarium/nocturne"
import type { ClientRookery } from "@rookery/sdk/client"
import {
  batch,
  createEffect,
  createMemo,
  createSignal,
  For,
  type JSX,
  on,
  onCleanup,
  onMount,
  Show,
} from "solid-js"
import {
  type Display,
  type Group,
  groupIssues,
  type ListRow,
  type Lookup,
  listRows,
  normalizeDisplay,
  showsClosed,
} from "../lib/display"
import {
  type Filter,
  type FilterField,
  filterIssues,
  type MatchContext,
  normalizeFilter,
  type Resolver,
} from "../lib/filter"
import type { IssueRow } from "../lib/model"
import { removeIssues, updateIssues } from "./actions"
import { IssueBoard } from "./board"
import { openCreate } from "./create"
import { DisplayOptions, FilterBar, SaveViewDialog } from "./filters"
import { IssueList } from "./list"
import { Picker, type PickItem } from "./picker"
import { assigneeItems, cycleItems, estimateItems, labelItems, priorityItems, stateItems } from "./props"
import { openShortcuts } from "./shortcuts"
import { nameOf, type ProjectStore, today, useMe } from "./store"

export interface Tab {
  id: string
  name: string
  filter: Filter
  /** A saved view: its row, so it can be updated or deleted. */
  view?: { id: string; personal: boolean; display: Display }
}

export interface SurfaceProps {
  crow: ClientRookery
  /** The project, for a single project's issues; null across projects. */
  store: ProjectStore | null
  issues: () => IssueRow[]
  storeOf: (space: string) => ProjectStore | null
  lookup: Lookup
  resolver: Resolver
  fields: FilterField[]
  tabs: Tab[]
  tab: string
  setTab: (id: string) => void
  /** Where display options are kept per person, per surface. */
  displayKey: string
  head: JSX.Element
  onOpen: (issue: IssueRow) => void
  /** The project allows writing (members with use). */
  canWrite: (issue: IssueRow | null) => boolean
  matchContext: () => MatchContext
  onSaveView?: (v: {
    name: string
    personal: boolean
    filter: Filter
    display: Display
    id?: string
  }) => Promise<void>
  onDeleteView?: (id: string) => Promise<void>
  showProject?: boolean
  loading?: boolean
}

const readDisplay = (key: string): Display => {
  try {
    return normalizeDisplay(JSON.parse(localStorage.getItem(key) ?? "{}"))
  } catch {
    return normalizeDisplay({})
  }
}

export function IssuesSurface(props: SurfaceProps) {
  const crow = props.crow
  const me = useMe(crow)
  const current = () => props.tabs.find((t) => t.id === props.tab) ?? props.tabs[0]!
  const [filter, setFilter] = createSignal<Filter>(current().filter)
  const [display, setDisplay] = createSignal<Display>(
    current().view?.display ?? readDisplay(props.displayKey),
  )
  createEffect(
    on(
      () => props.tab,
      () => {
        batch(() => {
          setFilter(normalizeFilter(current().filter))
          setDisplay(current().view?.display ?? readDisplay(props.displayKey))
          setSelected(new Set<string>())
        })
      },
      { defer: true },
    ),
  )
  const changeDisplay = (d: Display) => {
    setDisplay(d)
    if (!current().view) {
      try {
        localStorage.setItem(props.displayKey, JSON.stringify(d))
      } catch {}
    }
  }
  const dirty = () =>
    JSON.stringify(normalizeFilter(filter())) !== JSON.stringify(normalizeFilter(current().filter)) ||
    (!!current().view && JSON.stringify(display()) !== JSON.stringify(current().view!.display))

  // What is shown: filtered, closed issues by the option, then grouped.
  const visible = createMemo(() => {
    const ctx = props.matchContext()
    const now = Date.now()
    const opt = display().completed
    const list = filterIssues(props.issues(), filter(), ctx)
    return opt === "all" ? list : list.filter((i) => showsClosed(i, opt, now))
  })
  const groups = createMemo<Group[]>(() => groupIssues(visible(), display(), props.lookup))
  const [collapsed, setCollapsed] = createSignal(new Set<string>())
  const rows = createMemo<ListRow[]>(() => listRows(groups(), collapsed(), display().groupBy))
  /** The issues in the order the keyboard walks them. */
  const order = createMemo<IssueRow[]>(() => {
    if (display().layout === "board") return groups().flatMap((g) => g.issues)
    return rows().flatMap((r) => (r.kind === "issue" ? [r.issue] : []))
  })

  const [selected, setSelected] = createSignal(new Set<string>())
  const [cursor, setCursor] = createSignal<string | null>(null)
  const [anchor, setAnchor] = createSignal<string | null>(null)
  const cursorIndex = () => rows().findIndex((r) => r.kind === "issue" && r.issue.id === cursor())
  let scrollTo: ((i: number) => void) | undefined

  const select = (id: string, how: "toggle" | "range" | "only") => {
    const next = new Set(selected())
    if (how === "only") {
      setSelected(new Set([id]))
      setAnchor(id)
      return
    }
    if (how === "range" && anchor()) {
      const list = order()
      const a = list.findIndex((i) => i.id === anchor())
      const b = list.findIndex((i) => i.id === id)
      if (a >= 0 && b >= 0) {
        for (let k = Math.min(a, b); k <= Math.max(a, b); k++) next.add(list[k]!.id)
        setSelected(next)
        return
      }
    }
    if (next.has(id)) next.delete(id)
    else next.add(id)
    setAnchor(id)
    setSelected(next)
  }
  // Selected issues that are still there.
  const chosen = () => {
    const s = selected()
    return s.size ? props.issues().filter((i) => s.has(i.id)) : []
  }
  const targets = () => {
    const c = chosen()
    if (c.length) return c
    const at = props.issues().find((i) => i.id === cursor())
    return at ? [at] : []
  }

  // ── the keyboard picker (s, a, l, p, e) ─────────────────────────────────────────────────────────────

  const [keyPicker, setKeyPicker] = createSignal<{
    prop: "state" | "assignee" | "labels" | "priority" | "estimate" | "cycle"
    anchor: HTMLElement
  } | null>(null)
  const pickerStore = () => props.store ?? (targets()[0] ? props.storeOf(targets()[0]!.spaceId) : null)
  const pickerItems = (): PickItem[] => {
    const k = keyPicker()
    const s = pickerStore()
    if (!k) return []
    switch (k.prop) {
      case "state":
        return s ? stateItems(s) : []
      case "assignee":
        return assigneeItems(crow, s)
      case "labels":
        return s ? labelItems(s) : []
      case "priority":
        return priorityItems()
      case "estimate":
        return estimateItems()
      case "cycle":
        return s ? cycleItems(s) : []
    }
  }
  const pickerSelected = () => {
    const k = keyPicker()
    const t = targets()
    if (!k || !t.length) return []
    if (k.prop === "labels") return t.length === 1 ? t[0]!.labels : []
    if (t.length > 1) return []
    const i = t[0]!
    return [
      k.prop === "state"
        ? (i.state ?? "")
        : k.prop === "assignee"
          ? (i.assignee ?? "")
          : k.prop === "priority"
            ? String(i.priority ?? 0)
            : k.prop === "estimate"
              ? i.estimate == null
                ? ""
                : String(i.estimate)
              : (i.cycle ?? ""),
    ]
  }
  const pick = (id: string) => {
    const k = keyPicker()
    const t = targets()
    if (!k || !t.length) return
    if (k.prop === "labels") {
      // Toggle on all: when every target has it, it comes off.
      const all = t.every((i) => i.labels?.includes(id))
      for (const i of t) {
        const labels = all ? i.labels.filter((l) => l !== id) : [...new Set([...(i.labels ?? []), id])]
        void updateIssues(crow, props.storeOf, [i], { labels })
      }
      return
    }
    const patch =
      k.prop === "state"
        ? { state: id }
        : k.prop === "assignee"
          ? { assignee: id || null }
          : k.prop === "priority"
            ? { priority: Number(id) }
            : k.prop === "estimate"
              ? { estimate: id ? Number(id) : null }
              : { cycle: id || null }
    // Across projects a state id belongs to one project: the others match it by name.
    if (k.prop === "state" && !props.store) {
      const st = pickerStore()
        ?.states()
        .find((s) => s.id === id)
      for (const i of t) {
        const own = props
          .storeOf(i.spaceId)
          ?.states()
          .find((s) => s.name === st?.name || s.id === id)
        if (own) void updateIssues(crow, props.storeOf, [i], { state: own.id })
      }
      return
    }
    void updateIssues(crow, props.storeOf, t, patch as never)
  }
  const openPicker = (prop: NonNullable<ReturnType<typeof keyPicker>>["prop"]) => {
    if (!targets().length) return
    const el =
      (selected().size ? root.querySelector<HTMLElement>("[data-part=bulkbar]") : null) ??
      root.querySelector<HTMLElement>(`[data-issue="${cursor()}"]`) ??
      root
    if (!props.canWrite(targets()[0]!))
      return crow.workbench.toast({ title: "You can only view this project", kind: "warning" })
    setKeyPicker({ prop, anchor: el })
  }

  // ── the context menu of an issue (a right click, the Menu key, Shift+F10) ────────────────────────────
  // As in a file manager: on an issue of a selection of several it acts on the selection; any other issue is
  // selected alone first. It offers what the bulk bar and the keys do.

  const phone = usePhone()
  const [menu, setMenu] = createSignal<{ at: { x: number; y: number }; ids: string[] } | null>(null)
  const openMenu = (issue: IssueRow, at: { x: number; y: number }) => {
    const target = menuTarget(
      order().map((i) => i.id),
      [...selected()],
      issue.id,
      true,
    )
    setCursor(issue.id)
    if (target.reselect) {
      setSelected(new Set([issue.id]))
      setAnchor(issue.id)
    }
    setMenu({ at, ids: target.keys })
  }
  const menuItems = (ids: string[]): MenuEntry[] => {
    const n = ids.length
    const one = n === 1 ? props.issues().find((i) => i.id === ids[0]) : undefined
    const write = targets().some((i) => props.canWrite(i))
    const count = n > 1 ? ` ${n}` : ""
    return [
      ...(n > 1 ? [{ type: "label" as const, label: `${n} selected` }] : []),
      ...(one
        ? [
            { id: "open", label: "Open", icon: "arrow-up-right" as const, shortcut: "Enter" },
            { id: "copy-link", label: "Copy link", icon: "link" as const },
          ]
        : []),
      ...(write
        ? [
            { type: "separator" as const },
            { id: "state", label: "State…", icon: "circle-dot" as const, shortcut: "S" },
            { id: "assignee", label: "Assignee…", icon: "users" as const, shortcut: "A" },
            { id: "me", label: "Assign to me", icon: "user" as const, shortcut: "I" },
            { id: "priority", label: "Priority…", icon: "chart" as const, shortcut: "P" },
            { id: "labels", label: "Labels…", icon: "tag" as const, shortcut: "L" },
            { id: "estimate", label: "Estimate…", icon: "clock" as const, shortcut: "E" },
            { type: "separator" as const },
            { id: "delete", label: `Delete${count}`, icon: "trash" as const, danger: true },
          ]
        : []),
    ]
  }
  const onMenu = (id: string, ids: string[]) => {
    const one = props.issues().find((i) => i.id === ids[0])
    if (id === "open" && one) props.onOpen(one)
    else if (id === "copy-link" && one) {
      void navigator.clipboard?.writeText(`${location.origin}/e/issue/${one.id}`)
      crow.workbench.toast({ title: "Link copied", kind: "success" })
    } else if (id === "me") {
      if (me()) void updateIssues(crow, props.storeOf, targets(), { assignee: me()!.uri })
    } else if (id === "delete") {
      const t2 = targets()
      if (t2.length && confirm(`Move ${t2.length} issue${t2.length === 1 ? "" : "s"} to the trash?`))
        void removeIssues(crow, t2).then(() => setSelected(new Set<string>()))
    } else if (["state", "assignee", "priority", "labels", "estimate"].includes(id))
      openPicker(id as "state" | "assignee" | "priority" | "labels" | "estimate")
  }

  // ── keys ────────────────────────────────────────────────────────────────────────────────────────────

  let root!: HTMLDivElement
  let filterApi: { focusQuery: () => void; openBuilder: () => void } | undefined
  const moveCursor = (delta: number, extend = false) => {
    const list = order()
    if (!list.length) return
    const at = list.findIndex((i) => i.id === cursor())
    const next = list[Math.max(0, Math.min(list.length - 1, at < 0 ? 0 : at + delta))]!
    if (extend) {
      if (!anchor()) setAnchor(cursor() ?? next.id)
      const s = new Set(selected())
      if (cursor()) s.add(cursor()!)
      s.add(next.id)
      setSelected(s)
    }
    setCursor(next.id)
    const ri = rows().findIndex((r) => r.kind === "issue" && r.issue.id === next.id)
    if (ri >= 0) scrollTo?.(ri)
    root
      .querySelector<HTMLElement>(`.projects__card[data-issue="${next.id}"]`)
      ?.scrollIntoView({ block: "nearest" })
  }
  const moveColumn = (delta: number) => {
    const g = groups()
    const ci = g.findIndex((x) => x.issues.some((i) => i.id === cursor()))
    const col = g[Math.max(0, Math.min(g.length - 1, Math.max(ci, 0) + delta))]
    if (!col?.issues.length) return
    const row = Math.max(0, g[ci]?.issues.findIndex((i) => i.id === cursor()) ?? 0)
    setCursor(col.issues[Math.min(row, col.issues.length - 1)]!.id)
  }
  const onKey = (e: KeyboardEvent) => {
    const t = e.target as HTMLElement
    if (t.closest("input, textarea, select, [contenteditable=true], .projects__picker, [role=dialog]")) return
    if (keyPicker()) return
    const k = e.key
    const mod = e.metaKey || e.ctrlKey
    const board = display().layout === "board"
    const handled = (() => {
      if (isMenuKey(e)) {
        const at = props.issues().find((i) => i.id === cursor())
        const el = at && root.querySelector<HTMLElement>(`[data-issue="${at.id}"]`)
        if (at && el) openMenu(at, keyboardMenuPoint(el))
        return Boolean(at && el)
      }
      if (mod && k.toLowerCase() === "a") {
        setSelected(new Set(order().map((i) => i.id)))
        return true
      }
      if (mod && (k === "Backspace" || k === "Delete")) {
        const t2 = targets()
        if (t2.length && confirm(`Move ${t2.length} issue${t2.length === 1 ? "" : "s"} to the trash?`))
          void removeIssues(crow, t2).then(() => setSelected(new Set<string>()))
        return true
      }
      if (mod || e.altKey) return false
      switch (k) {
        case "j":
        case "ArrowDown":
        case "J":
          moveCursor(1, e.shiftKey)
          return true
        case "k":
        case "ArrowUp":
        case "K":
          moveCursor(-1, e.shiftKey)
          return true
        case "h":
        case "ArrowLeft":
          if (board) moveColumn(-1)
          return board
        case "l":
          if (board) {
            moveColumn(1)
            return true
          }
          openPicker("labels")
          return true
        case "ArrowRight":
          if (board) moveColumn(1)
          return board
        case "L":
          openPicker("labels")
          return true
        case "x":
          if (cursor()) select(cursor()!, e.shiftKey ? "range" : "toggle")
          return true
        case "Enter":
        case "o": {
          const i = props.issues().find((x) => x.id === cursor())
          if (i) props.onOpen(i)
          return !!i
        }
        case "s":
          openPicker("state")
          return true
        case "a":
          openPicker("assignee")
          return true
        case "p":
          openPicker("priority")
          return true
        case "e":
          openPicker("estimate")
          return true
        case "C":
          openPicker("cycle")
          return true
        case "i": {
          const t2 = targets()
          if (t2.length && me()) void updateIssues(crow, props.storeOf, t2, { assignee: me()!.uri })
          return true
        }
        case "c":
          openCreate({ space: props.store?.space })
          return true
        case "/":
          filterApi?.focusQuery()
          return true
        case "f":
          filterApi?.openBuilder()
          return true
        case "?":
          openShortcuts()
          return true
        case "Escape":
          if (!selected().size) return false
          setSelected(new Set<string>())
          return true
        case "v":
          changeDisplay({ ...display(), layout: board ? "list" : "board" })
          return true
      }
      return false
    })()
    if (handled) {
      e.preventDefault()
      e.stopPropagation()
    }
  }
  onMount(() => {
    root.addEventListener("keydown", onKey)
    onCleanup(() => root.removeEventListener("keydown", onKey))
    if (!root.contains(document.activeElement)) root.focus({ preventScroll: true })
  })
  // The cursor starts on the first issue.
  createEffect(() => {
    if (!cursor() && order().length) setCursor(order()[0]!.id)
  })

  const [saving, setSaving] = createSignal(false)
  const counts = () => `${visible().length} issue${visible().length === 1 ? "" : "s"}`

  return (
    <div ref={root} class="projects__surface" tabindex="-1" data-part="issues" data-layout={display().layout}>
      <ViewHeader
        actions={
          props.store && props.canWrite(null)
            ? [
                {
                  id: "new-issue",
                  label: "New issue",
                  icon: "plus",
                  shortcut: "C",
                  onClick: () => openCreate({ space: props.store!.space }),
                },
              ]
            : []
        }
      >
        {props.head}
        <div class="nc-seg projects__tabs" role="tablist" aria-label="Views">
          <For each={props.tabs}>
            {(t) => (
              <button
                type="button"
                role="tab"
                class="nc-seg__item"
                aria-selected={props.tab === t.id}
                data-tab={t.id}
                onClick={() => props.setTab(t.id)}
              >
                <Show when={t.view?.personal}>
                  <Icon name="lock" size="sm" />
                </Show>
                {t.name}
              </button>
            )}
          </For>
        </div>
        <span class="projects__spacer" />
        <span class="nc-meta nc-num" data-testid="count">
          {counts()}
        </span>
        <div class="nc-seg" role="tablist" aria-label="Layout">
          <button
            type="button"
            role="tab"
            class="nc-seg__item"
            aria-selected={display().layout === "list"}
            onClick={() => changeDisplay({ ...display(), layout: "list" })}
            data-testid="layout-list"
            title="List (v)"
          >
            <Icon name="list" size="sm" />
          </button>
          <button
            type="button"
            role="tab"
            class="nc-seg__item"
            aria-selected={display().layout === "board"}
            onClick={() =>
              changeDisplay({
                ...display(),
                layout: "board",
                groupBy: display().groupBy === "none" ? "state" : display().groupBy,
              })
            }
            data-testid="layout-board"
            title="Board (v)"
          >
            <Icon name="board" size="sm" />
          </button>
        </div>
        <DisplayOptions display={display()} setDisplay={changeDisplay} />
      </ViewHeader>
      <Show
        when={selected().size}
        fallback={
          <div class="projects__toolbar">
            <FilterBar
              crow={crow}
              store={props.store ?? (props.issues()[0] ? props.storeOf(props.issues()[0]!.spaceId) : null)}
              filter={filter()}
              setFilter={setFilter}
              fields={props.fields}
              resolver={props.resolver}
              api={(a) => (filterApi = a)}
            />
            <Show when={props.onSaveView && dirty()}>
              <Show
                when={current().view}
                fallback={
                  <Button
                    size="sm"
                    variant="secondary"
                    icon="star"
                    onClick={() => setSaving(true)}
                    data-testid="save-view"
                  >
                    Save view
                  </Button>
                }
              >
                <Button
                  size="sm"
                  variant="secondary"
                  onClick={() =>
                    props.onSaveView?.({
                      id: current().view!.id,
                      name: current().name,
                      personal: current().view!.personal,
                      filter: filter(),
                      display: display(),
                    })
                  }
                  data-testid="update-view"
                >
                  Update view
                </Button>
              </Show>
            </Show>
            <Show when={current().view && props.onDeleteView}>
              <IconButton
                icon="trash"
                label="Delete this view"
                onClick={() =>
                  confirm(`Delete the view ${current().name}?`) && props.onDeleteView?.(current().view!.id)
                }
              />
            </Show>
          </div>
        }
      >
        <div class="nc-bulkbar" data-part="bulkbar" role="toolbar" aria-label="Selected issues">
          <span data-testid="selected-count">{selected().size} selected</span>
          <span class="projects__bulk-sep" />
          <For
            each={
              [
                ["state", "State", "S"],
                ["assignee", "Assignee", "A"],
                ["priority", "Priority", "P"],
                ["labels", "Labels", "L"],
                ["estimate", "Estimate", "E"],
              ] as const
            }
          >
            {([prop, name, key]) => (
              <button
                type="button"
                class="nc-btn nc-btn--secondary nc-btn--sm"
                onClick={() => openPicker(prop)}
                data-bulk={prop}
              >
                {name}
                <span class="nc-kbd">{key}</span>
              </button>
            )}
          </For>
          <button
            type="button"
            class="nc-btn nc-btn--danger nc-btn--sm"
            onClick={() =>
              targets().length &&
              confirm(`Move ${targets().length} issues to the trash?`) &&
              void removeIssues(crow, targets()).then(() => setSelected(new Set<string>()))
            }
          >
            Delete
          </button>
          <span class="nc-bulkbar__spacer" />
          <button
            type="button"
            class="nc-btn nc-btn--ghost nc-btn--sm"
            onClick={() => setSelected(new Set<string>())}
          >
            Clear <span class="nc-kbd">Esc</span>
          </button>
        </div>
      </Show>
      <Picker
        open={!!keyPicker()}
        anchor={keyPicker()?.anchor}
        label={keyPicker() ? `Change ${keyPicker()!.prop}` : "Change"}
        items={pickerItems()}
        selected={pickerSelected()}
        multi={keyPicker()?.prop === "labels"}
        onPick={pick}
        onClose={() => {
          setKeyPicker(null)
          root.focus({ preventScroll: true })
        }}
      />
      <Show when={menu()} keyed>
        {(m) => (
          <RowMenu
            at={m.at}
            phone={phone()}
            label="Issue"
            items={menuItems(m.ids)}
            origin={root}
            returnFocus={() => root}
            onClose={() => setMenu(null)}
            onSelect={(id) => {
              setMenu(null)
              onMenu(id, m.ids)
            }}
          />
        )}
      </Show>
      <div class="projects__body">
        <Show when={!props.loading} fallback={<div class="projects__loading nc-meta">Loading issues…</div>}>
          <Show
            when={display().layout === "board" && props.store}
            fallback={
              <IssueList
                crow={crow}
                rows={rows()}
                grouping={display().groupBy}
                storeOf={props.storeOf}
                selected={selected()}
                onSelect={select}
                cursor={cursorIndex()}
                setCursor={(n) => {
                  const r = rows()[n]
                  if (r?.kind === "issue") setCursor(r.issue.id)
                }}
                onOpen={props.onOpen}
                onMenu={openMenu}
                onToggleGroup={(key) =>
                  setCollapsed((c) => {
                    const n = new Set(c)
                    if (n.has(key)) n.delete(key)
                    else n.add(key)
                    return n
                  })
                }
                onAddToGroup={
                  props.store && props.canWrite(null)
                    ? (key) =>
                        openCreate({ space: props.store!.space, values: presetFor(display().groupBy, key) })
                    : undefined
                }
                showProject={props.showProject}
                readOnly={(i) => !props.canWrite(i)}
                scrollRef={(f) => (scrollTo = f)}
                empty={
                  <EmptyState
                    icon="list"
                    title={filter().conditions.length || filter().text ? "No issues match" : "No issues yet"}
                    description={
                      filter().conditions.length || filter().text
                        ? "Change or clear the filter."
                        : "Press C to create one."
                    }
                  >
                    <Show when={filter().conditions.length || filter().text}>
                      <Button variant="secondary" onClick={() => setFilter({ conditions: [] })}>
                        Clear filters
                      </Button>
                    </Show>
                  </EmptyState>
                }
              />
            }
          >
            <IssueBoard
              crow={crow}
              store={props.store!}
              issues={visible()}
              display={display()}
              lookup={props.lookup}
              selected={selected()}
              cursor={cursor()}
              setCursor={setCursor}
              onOpen={props.onOpen}
              onMenu={openMenu}
              onSelect={select}
              onAdd={(patch) => openCreate({ space: props.store!.space, values: patch as never })}
              readOnly={!props.canWrite(null)}
            />
          </Show>
        </Show>
      </div>
      <SaveViewDialog
        open={saving()}
        onClose={() => setSaving(false)}
        onSave={async (v) => {
          await props.onSaveView?.({ ...v, filter: filter(), display: display() })
        }}
      />
    </div>
  )
}

/** The draft values a new issue gets from the group it is created in. */
function presetFor(g: Display["groupBy"], key: string): Record<string, unknown> {
  if (!key) return {}
  switch (g) {
    case "state":
      return { state: key }
    case "assignee":
      return { assignee: key }
    case "priority":
      return { priority: Number(key) }
    case "label":
      return { labels: [key] }
    case "cycle":
      return { cycle: key }
    case "parent":
      return { parent: key }
    default:
      return {}
  }
}

/** The lookups a project's grouping needs. */
export function lookupFor(crow: ClientRookery, store: ProjectStore): Lookup {
  return {
    get states() {
      return store.states()
    },
    get labels() {
      return store.labels()
    },
    get cycles() {
      return store.cycles()
    },
    userName: (id) => nameOf(crow, id),
    issue: (id) => store.issue(id),
  }
}

/** The built-in tabs of a project: all issues, active ones, the backlog. */
export function builtinTabs(): Tab[] {
  return [
    { id: "all", name: "All issues", filter: { conditions: [] } },
    {
      id: "active",
      name: "Active",
      filter: { conditions: [{ field: "category", op: "is", values: ["unstarted", "started"] }] },
    },
    {
      id: "backlog",
      name: "Backlog",
      filter: { conditions: [{ field: "category", op: "is", values: ["backlog"] }] },
    },
  ]
}

export const PROJECT_FIELDS: FilterField[] = [
  "state",
  "category",
  "assignee",
  "creator",
  "priority",
  "label",
  "cycle",
  "parent",
  "due",
  "estimate",
]

export function matchContextFor(me: () => { uri: string } | null, stores: () => ProjectStore[]) {
  return (): MatchContext => {
    const currentCycles: Record<string, string | null> = {}
    const t = today()
    for (const s of stores()) {
      const c = s.cycles().find((x) => !x.closed && x.startsOn <= t && x.endsOn >= t)
      currentCycles[s.space] = c ? `cycle://${c.id}` : null
    }
    return { me: me()?.uri ?? null, currentCycles, today: t }
  }
}
