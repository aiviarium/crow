// The filter bar above a list or a board: a query bar that reads and writes the filter as text, a chip per
// condition (click the × to drop it), a builder (field, then values), the display options, and saving the
// result as a view, personal or shared with the project.

import {
  Button,
  Dialog,
  DropdownMenu,
  Icon,
  IconButton,
  Popover,
  Select,
  Switch,
  TextField,
} from "@aiviarium/nocturne"
import type { ClientRookery } from "@rookery/sdk/client"
import { createEffect, createSignal, For, on, Show } from "solid-js"
import { type Display, GROUPINGS, ORDERINGS } from "../lib/display"
import {
  type Condition,
  type Filter,
  type FilterField,
  parseQuery,
  printQuery,
  type Resolver,
  removeCondition,
  toggleValue,
} from "../lib/filter"
import { CATEGORIES, CATEGORY_TITLE, PRIORITIES } from "../lib/model"
import { Picker, type PickItem } from "./picker"
import { assigneeItems, cycleItems, labelItems, priorityItems, stateItems } from "./props"
import { nameOf, type ProjectStore } from "./store"

export const FIELD_TITLE: Record<FilterField, string> = {
  state: "State",
  category: "Status type",
  assignee: "Assignee",
  creator: "Creator",
  priority: "Priority",
  label: "Label",
  cycle: "Cycle",
  parent: "Parent",
  project: "Project",
  due: "Due date",
  estimate: "Estimate",
}

/** Names in the query bar for one project (or, without a store, only what needs no project). */
export function resolverFor(
  crow: ClientRookery,
  store: ProjectStore | null,
  projects?: Array<{ space: string; key: string; name: string }>,
): Resolver {
  const people = () => [...(store?.members() ?? [])]
  return {
    id(field, name) {
      const n = name.toLowerCase()
      switch (field) {
        case "state":
          return store?.states().find((s) => s.name.toLowerCase() === n)?.id ?? null
        case "label": {
          const l = store?.labels().find((x) => x.name.toLowerCase() === n)
          return l ? `label://${l.id}` : null
        }
        case "assignee":
        case "creator": {
          const m = people().find(
            (p) =>
              (p.name ?? "").toLowerCase() === n ||
              (p.email ?? "").toLowerCase() === n ||
              (p.name ?? "").toLowerCase().split(/\s+/)[0] === n,
          )
          return m ? m.uri : null
        }
        case "cycle": {
          const c = store?.cycles().find((x) => x.name.toLowerCase() === n || String(x.number) === n)
          return c ? `cycle://${c.id}` : null
        }
        case "parent": {
          const i = store?.issues().find((x) => x.key.toLowerCase() === n)
          return i ? `issue://${i.id}` : null
        }
        case "project":
          return projects?.find((p) => p.key.toLowerCase() === n || p.name.toLowerCase() === n)?.space ?? null
        default:
          return null
      }
    },
    name(field, id) {
      switch (field) {
        case "state":
          return store?.states().find((s) => s.id === id)?.name ?? id
        case "label":
          return store?.labels().find((l) => `label://${l.id}` === id)?.name ?? id
        case "assignee":
        case "creator":
          return store?.members().find((m) => m.uri === id)?.name ?? nameOf(crow, id)
        case "cycle":
          return store?.cycles().find((c) => `cycle://${c.id}` === id)?.name ?? id
        case "parent":
          return store?.issue(id)?.key ?? id
        case "project":
          return projects?.find((p) => p.space === id)?.key ?? id
        default:
          return id
      }
    },
  }
}

function valueItems(crow: ClientRookery, store: ProjectStore | null, field: FilterField): PickItem[] {
  const none = (label: string): PickItem => ({ id: "none", label })
  switch (field) {
    case "state":
      return store ? stateItems(store) : []
    case "category":
      return CATEGORIES.map((c) => ({ id: c, label: CATEGORY_TITLE[c] }))
    case "assignee":
      return [
        { id: "me", label: "Me" },
        ...assigneeItems(crow, store).map((i) => (i.id === "" ? none("No assignee") : i)),
      ]
    case "creator":
      return [{ id: "me", label: "Me" }, ...assigneeItems(crow, store).filter((i) => i.id)]
    case "priority":
      return priorityItems()
    case "label":
      return [...(store ? labelItems(store) : []), none("No label")]
    case "cycle":
      return [
        { id: "current", label: "Current cycle" },
        ...(store ? cycleItems(store).map((i) => (i.id === "" ? none("No cycle") : i)) : []),
      ]
    case "parent":
      return [{ id: "any", label: "Has a parent (sub-issues)" }, none("No parent")]
    case "due":
      return [
        { id: "overdue", label: "Overdue" },
        { id: "any", label: "Has a due date" },
        none("No due date"),
      ]
    default:
      return []
  }
}

/** A condition in words: "Priority is Urgent, High". */
export function describe(c: Condition, r: Resolver): string {
  const names = c.values.map((v) =>
    v === "me"
      ? "me"
      : v === "none"
        ? "none"
        : v === "current"
          ? "current"
          : v === "any"
            ? "any"
            : c.field === "priority"
              ? (PRIORITIES.find((p) => String(p.value) === v)?.name ?? v)
              : c.field === "category"
                ? v
                : r.name(c.field, v),
  )
  const verb =
    c.op === "not"
      ? "is not"
      : c.op === "all"
        ? "has all of"
        : c.op === "before"
          ? "before"
          : c.op === "after"
            ? "after"
            : c.values.length > 1
              ? "is any of"
              : "is"
  return `${FIELD_TITLE[c.field]} ${verb} ${names.join(", ")}`
}

export function FilterBar(props: {
  crow: ClientRookery
  store: ProjectStore | null
  filter: Filter
  setFilter: (f: Filter) => void
  fields: FilterField[]
  resolver: Resolver
  /** Ref for `/` and `f` from the view. */
  api?: (a: { focusQuery: () => void; openBuilder: () => void }) => void
}) {
  const [text, setText] = createSignal(printQuery(props.filter, props.resolver))
  const [editing, setEditing] = createSignal(false)
  const [unknown, setUnknown] = createSignal<string[]>([])
  const [field, setField] = createSignal<FilterField | null>(null)
  const [menuOpen, setMenuOpen] = createSignal(false)
  let input: HTMLInputElement | undefined
  let addBtn: HTMLButtonElement | undefined
  createEffect(
    on(
      () => props.filter,
      (f) => {
        if (!editing()) setText(printQuery(f, props.resolver))
      },
    ),
  )
  props.api?.({ focusQuery: () => input?.focus(), openBuilder: () => setMenuOpen(true) })
  const apply = () => {
    const r = parseQuery(text(), props.resolver)
    setUnknown(r.unknown)
    props.setFilter(r.filter)
  }
  return (
    <div class="projects__filters" data-part="filters">
      <label class="nc-search projects__query">
        <Icon name="search" size="sm" />
        <input
          ref={input}
          class="projects__query-input"
          aria-label="Filter issues"
          placeholder="Filter: state:todo assignee:me label:bug, or words…"
          value={text()}
          data-testid="query"
          onFocus={() => setEditing(true)}
          onBlur={() => {
            setEditing(false)
            apply()
          }}
          onInput={(e) => setText(e.currentTarget.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              apply()
              e.currentTarget.blur()
            } else if (e.key === "Escape") {
              setText(printQuery(props.filter, props.resolver))
              e.currentTarget.blur()
            }
            e.stopPropagation()
          }}
        />
      </label>
      <div class="projects__chips">
        <For each={props.filter.conditions}>
          {(c, n) => (
            <span class="nc-chip projects__chip" data-field={c.field}>
              <span>{describe(c, props.resolver)}</span>
              <button
                type="button"
                class="projects__chip-x"
                aria-label={`Remove ${FIELD_TITLE[c.field]} filter`}
                onClick={() => props.setFilter(removeCondition(props.filter, n()))}
              >
                <Icon name="close" size="sm" />
              </button>
            </span>
          )}
        </For>
        <Show when={unknown().length}>
          <span class="nc-chip projects__chip projects__chip--warn" title="Nothing has these names">
            Unknown: {unknown().join(" ")}
          </span>
        </Show>
      </div>
      <DropdownMenu
        label="Add a filter"
        open={menuOpen()}
        onOpenChange={setMenuOpen}
        items={props.fields.map((f) => ({ id: f, label: FIELD_TITLE[f] }))}
        onSelect={(id) => queueMicrotask(() => setField(id as FilterField))}
        trigger={(t) => (
          <button
            {...t}
            ref={(el) => {
              addBtn = el
              t.ref(el)
            }}
            type="button"
            class="nc-btn nc-btn--ghost nc-btn--sm"
            data-testid="add-filter"
          >
            <Icon name="filter" size="sm" />
            Filter
          </button>
        )}
      />
      <Picker
        open={!!field()}
        anchor={addBtn}
        label={field() ? FIELD_TITLE[field()!] : "Values"}
        multi
        items={field() ? valueItems(props.crow, props.store, field()!) : []}
        selected={props.filter.conditions.find((c) => c.field === field() && c.op === "is")?.values ?? []}
        onPick={(id) => props.setFilter(toggleValue(props.filter, field()!, id))}
        onClose={() => setField(null)}
      />
      <Show when={props.filter.conditions.length || props.filter.text}>
        <Button variant="ghost" size="sm" onClick={() => props.setFilter({ conditions: [] })}>
          Clear
        </Button>
      </Show>
    </div>
  )
}

export function DisplayOptions(props: {
  display: Display
  setDisplay: (d: Display) => void
  board?: boolean
}) {
  const [open, setOpen] = createSignal(false)
  let btn: HTMLButtonElement | undefined
  const set = <K extends keyof Display>(k: K, v: Display[K]) => props.setDisplay({ ...props.display, [k]: v })
  return (
    <>
      <span ref={(el) => (btn = el.querySelector("button") ?? undefined)}>
        <IconButton
          icon="sort"
          label="Display options"
          pressed={open()}
          onClick={() => setOpen((o) => !o)}
          data-testid="display"
        />
      </span>
      <Popover
        open={open()}
        anchor={btn}
        onClose={() => setOpen(false)}
        placement="bottom-end"
        class="projects__display"
        data-part="display-options"
      >
        <div class="projects__display-row">
          <span class="label">Layout</span>
          <div class="nc-seg" role="tablist" aria-label="Layout">
            <For each={["list", "board"] as const}>
              {(l) => (
                <button
                  type="button"
                  role="tab"
                  class="nc-seg__item"
                  aria-selected={props.display.layout === l}
                  onClick={() => set("layout", l)}
                >
                  {l === "list" ? "List" : "Board"}
                </button>
              )}
            </For>
          </div>
        </div>
        <div class="projects__display-row">
          <span class="label">{props.display.layout === "board" ? "Columns" : "Grouping"}</span>
          <Select
            aria-label="Grouping"
            value={props.display.groupBy}
            options={GROUPINGS.filter((g) => props.display.layout === "list" || g.id !== "none").map((g) => ({
              value: g.id,
              label: g.name,
            }))}
            onChange={(v) => set("groupBy", v)}
          />
        </div>
        <Show when={props.display.layout === "board"}>
          <div class="projects__display-row">
            <span class="label">Rows</span>
            <Select
              aria-label="Swimlanes"
              value={props.display.subGroupBy}
              options={GROUPINGS.map((g) => ({
                value: g.id,
                label: g.id === "none" ? "No swimlanes" : g.name,
              }))}
              onChange={(v) => set("subGroupBy", v)}
            />
          </div>
        </Show>
        <div class="projects__display-row">
          <span class="label">Ordering</span>
          <Select
            aria-label="Ordering"
            value={props.display.orderBy}
            options={ORDERINGS.map((o) => ({ value: o.id, label: o.name }))}
            onChange={(v) => set("orderBy", v)}
          />
        </div>
        <div class="projects__display-row">
          <span class="label">Completed issues</span>
          <Select
            aria-label="Completed issues"
            value={props.display.completed}
            options={[
              { value: "all", label: "All" },
              { value: "week", label: "Past week" },
              { value: "none", label: "None" },
            ]}
            onChange={(v) => set("completed", v as Display["completed"])}
          />
        </div>
        <Show when={props.display.layout === "list"}>
          <div class="projects__display-row">
            <span class="label">Show empty groups</span>
            <Switch
              checked={props.display.showEmpty}
              onChange={(v) => set("showEmpty", v)}
              aria-label="Show empty groups"
            />
          </div>
        </Show>
      </Popover>
    </>
  )
}

/** Saves the current filter and display as a view: a name, and whether it is yours or the project's. */
export function SaveViewDialog(props: {
  open: boolean
  onClose: () => void
  onSave: (v: { name: string; personal: boolean }) => Promise<void>
  initial?: { name: string; personal: boolean }
}) {
  const [name, setName] = createSignal("")
  const [personal, setPersonal] = createSignal(false)
  const [busy, setBusy] = createSignal(false)
  createEffect(
    on(
      () => props.open,
      (o) => {
        if (!o) return
        setName(props.initial?.name ?? "")
        setPersonal(props.initial?.personal ?? false)
      },
    ),
  )
  const save = async () => {
    if (!name().trim()) return
    setBusy(true)
    try {
      await props.onSave({ name: name().trim(), personal: personal() })
      props.onClose()
    } finally {
      setBusy(false)
    }
  }
  return (
    <Dialog
      open={props.open}
      onClose={props.onClose}
      title="Save view"
      description="The filter and the display options, under a name. A shared view shows for everyone in the project."
      size="sm"
      footer={
        <>
          <Button variant="ghost" onClick={props.onClose}>
            Cancel
          </Button>
          <Button
            variant="primary"
            loading={busy()}
            disabled={!name().trim()}
            onClick={save}
            data-testid="save-view-confirm"
          >
            Save view
          </Button>
        </>
      }
    >
      <form
        class="projects__form"
        onSubmit={(e) => {
          e.preventDefault()
          void save()
        }}
      >
        <TextField
          label="Name"
          value={name()}
          onInput={(e) => setName(e.currentTarget.value)}
          autofocus
          data-testid="view-name"
        />
        <div class="nc-seg" role="tablist" aria-label="Who sees it">
          <button
            type="button"
            role="tab"
            class="nc-seg__item"
            aria-selected={!personal()}
            onClick={() => setPersonal(false)}
          >
            Shared with the project
          </button>
          <button
            type="button"
            role="tab"
            class="nc-seg__item"
            aria-selected={personal()}
            onClick={() => setPersonal(true)}
          >
            Only me
          </button>
        </div>
      </form>
    </Dialog>
  )
}
