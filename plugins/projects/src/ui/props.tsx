// The properties of an issue as controls: state, priority, assignee, labels, estimate, due date, cycle and
// parent. The same control edits a row in the list (compact, an icon), a card, the issue's side panel
// (with its value in words) and the create dialog's draft. Changes go to `onChange` as a patch.

import { Icon } from "@aiviarium/nocturne"
import type { ClientRookery } from "@rookery/sdk/client"
import { For, type JSX, Show } from "solid-js"
import { cycleStatus } from "../lib/cycles"
import { type IssueRow, PRIORITIES, priorityName } from "../lib/model"
import { Label, Person, PriorityIcon, StateIcon, Unassigned } from "./glyphs"
import { PickerButton, type PickItem } from "./picker"
import { nameOf, type ProjectStore, today, useMe } from "./store"

export type Prop = "state" | "priority" | "assignee" | "labels" | "estimate" | "due" | "cycle" | "parent"

/** What a property control edits: an issue, or a draft with the same fields. */
export type Editable = Pick<
  IssueRow,
  "state" | "stateCategory" | "priority" | "assignee" | "labels" | "estimate" | "due" | "cycle" | "parent"
> & { id?: string }

export const ESTIMATES = [1, 2, 3, 5, 8, 13]

export function stateItems(store: ProjectStore): PickItem[] {
  return [...store.states()]
    .sort((a, b) => (a.rank < b.rank ? -1 : 1))
    .map((s, n) => ({
      id: s.id,
      label: s.name,
      keywords: s.category,
      shortcut: n < 9 ? String(n + 1) : undefined,
      leading: <StateIcon category={s.category} color={s.color} />,
    }))
}

export function priorityItems(): PickItem[] {
  return PRIORITIES.map((p) => ({
    id: String(p.value),
    label: p.name,
    shortcut: p.key,
    leading: <PriorityIcon priority={p.value} />,
  }))
}

export function assigneeItems(crow: ClientRookery, store: ProjectStore | null): PickItem[] {
  const me = useMe(crow)()
  const out: PickItem[] = [{ id: "", label: "No assignee", leading: <Unassigned /> }]
  const seen = new Set<string>()
  const add = (uri: string, name: string, hint?: string) => {
    if (seen.has(uri)) return
    seen.add(uri)
    out.push({ id: uri, label: name, hint, keywords: hint, leading: <Person name={name} /> })
  }
  if (me) add(me.uri, me.name, "you")
  for (const m of store?.members() ?? []) add(m.uri, m.name ?? m.email ?? m.uri, m.email ?? undefined)
  return out
}

export function labelItems(store: ProjectStore): PickItem[] {
  return store.labels().map((l) => ({
    id: `label://${l.id}`,
    label: l.name,
    hint: l.scope ? undefined : "workspace",
    leading: <span class="projects__dot" style={{ background: hueDot(l.color) }} />,
  }))
}

const hueDot = (c: string | null | undefined) =>
  c === "accent"
    ? "var(--accent-strong)"
    : c && ["success", "warning", "danger", "info"].includes(c)
      ? `var(--${c})`
      : c && c !== "muted"
        ? `var(--label-${c})`
        : "var(--text-3)"

export function cycleItems(store: ProjectStore): PickItem[] {
  const t = today()
  return [
    { id: "", label: "No cycle" },
    ...store
      .cycles()
      .filter((c) => !c.closed)
      .map((c) => ({
        id: `cycle://${c.id}`,
        label: c.name,
        hint: cycleStatus(c, t) === "current" ? "current" : `${c.startsOn} – ${c.endsOn}`,
        leading: <Icon name="clock" size="sm" />,
      })),
  ]
}

export function parentItems(store: ProjectStore, exclude?: string): PickItem[] {
  return [
    { id: "", label: "No parent" },
    ...store
      .issues()
      .filter((i) => i.id !== exclude && i.parent !== (exclude ? `issue://${exclude}` : "-"))
      .map((i) => ({
        id: `issue://${i.id}`,
        label: `${i.key} ${i.title}`,
        leading: (
          <StateIcon category={i.stateCategory} color={store.states().find((s) => s.id === i.state)?.color} />
        ),
      })),
  ]
}

export function estimateItems(): PickItem[] {
  return [
    { id: "", label: "No estimate" },
    ...ESTIMATES.map((e) => ({
      id: String(e),
      label: `${e} point${e === 1 ? "" : "s"}`,
      shortcut: String(e).length === 1 ? String(e) : undefined,
    })),
  ]
}

/** One property as a button with its picker. `compact` shows the icon only (list rows and cards). */
export function PropControl(props: {
  crow: ClientRookery
  store: ProjectStore
  issue: Editable
  prop: Prop
  compact?: boolean
  disabled?: boolean
  onChange: (patch: Partial<IssueRow>) => void
  openSignal?: () => number
  /** Labels: create a label of the project from the picker. */
  onCreateLabel?: (name: string) => Promise<string | null>
}): JSX.Element {
  const i = () => props.issue
  const st = () => props.store.states().find((s) => s.id === i().state)
  // Getters: the level that decides `disabled` arrives after the first render.
  const common = {
    get disabled() {
      return props.disabled
    },
    get openSignal() {
      return props.openSignal
    },
    "data-prop": props.prop,
    class: props.compact ? "projects__prop--compact" : "projects__prop--full",
  }
  switch (props.prop) {
    case "state":
      return (
        <PickerButton
          {...common}
          label={`State: ${st()?.name ?? "none"}`}
          picker={{
            items: stateItems(props.store),
            selected: i().state ? [i().state!] : [],
            placeholder: "Change state…",
            onPick: (id) => props.onChange({ state: id }),
          }}
        >
          <StateIcon category={st()?.category ?? i().stateCategory} color={st()?.color} />
          <Show when={!props.compact}>
            <span>{st()?.name ?? "No state"}</span>
          </Show>
        </PickerButton>
      )
    case "priority":
      return (
        <PickerButton
          {...common}
          label={`Priority: ${priorityName(i().priority)}`}
          picker={{
            items: priorityItems(),
            selected: [String(i().priority ?? 0)],
            placeholder: "Set priority…",
            onPick: (id) => props.onChange({ priority: Number(id) }),
          }}
        >
          <PriorityIcon priority={i().priority} />
          <Show when={!props.compact}>
            <span>{priorityName(i().priority)}</span>
          </Show>
        </PickerButton>
      )
    case "assignee":
      return (
        <PickerButton
          {...common}
          label={`Assignee: ${i().assignee ? nameOf(props.crow, i().assignee) : "none"}`}
          picker={{
            items: assigneeItems(props.crow, props.store),
            selected: [i().assignee ?? ""],
            placeholder: "Assign to…",
            onPick: (id) => props.onChange({ assignee: id || null }),
          }}
        >
          <Show when={i().assignee} fallback={<Unassigned />}>
            <Person name={nameOf(props.crow, i().assignee)} />
          </Show>
          <Show when={!props.compact}>
            <span>{i().assignee ? nameOf(props.crow, i().assignee) : "Unassigned"}</span>
          </Show>
        </PickerButton>
      )
    case "labels": {
      const chosen = () => i().labels ?? []
      const labels = () => props.store.labels().filter((l) => chosen().includes(`label://${l.id}`))
      return (
        <PickerButton
          {...common}
          label={`Labels: ${
            labels()
              .map((l) => l.name)
              .join(", ") || "none"
          }`}
          picker={{
            items: labelItems(props.store),
            selected: chosen(),
            multi: true,
            placeholder: "Change labels…",
            onPick: (id) =>
              props.onChange({
                labels: chosen().includes(id) ? chosen().filter((x) => x !== id) : [...chosen(), id],
              }),
            create: props.onCreateLabel
              ? (t) =>
                  props.store.labels().some((l) => l.name.toLowerCase() === t.toLowerCase())
                    ? null
                    : `Create label “${t}”`
              : undefined,
            onCreate: async (t) => {
              const uri = await props.onCreateLabel?.(t)
              if (uri) props.onChange({ labels: [...chosen(), uri] })
            },
          }}
        >
          <Show
            when={labels().length}
            fallback={
              <>
                <Icon name="tag" size="sm" />
                <Show when={!props.compact}>
                  <span>Add label</span>
                </Show>
              </>
            }
          >
            <span class="projects__labels">
              <For each={labels().slice(0, props.compact ? 3 : 20)}>
                {(l) => <Label name={l.name} color={l.color} />}
              </For>
              <Show when={props.compact && labels().length > 3}>
                <span class="nc-meta">+{labels().length - 3}</span>
              </Show>
            </span>
          </Show>
        </PickerButton>
      )
    }
    case "estimate":
      return (
        <PickerButton
          {...common}
          label={`Estimate: ${i().estimate ?? "none"}`}
          picker={{
            items: estimateItems(),
            selected: [i().estimate == null ? "" : String(i().estimate)],
            placeholder: "Estimate…",
            onPick: (id) => props.onChange({ estimate: id ? Number(id) : null }),
          }}
        >
          <Icon name="chart" size="sm" />
          <Show when={!props.compact || i().estimate != null}>
            <span>{i().estimate != null ? String(i().estimate) : "Estimate"}</span>
          </Show>
        </PickerButton>
      )
    case "cycle": {
      const c = () => props.store.cycles().find((x) => `cycle://${x.id}` === i().cycle)
      return (
        <PickerButton
          {...common}
          label={`Cycle: ${c()?.name ?? "none"}`}
          picker={{
            items: cycleItems(props.store),
            selected: [i().cycle ?? ""],
            placeholder: "Add to cycle…",
            onPick: (id) => props.onChange({ cycle: id || null }),
          }}
        >
          <Icon name="clock" size="sm" />
          <Show when={!props.compact || c()}>
            <span>{c()?.name ?? "No cycle"}</span>
          </Show>
        </PickerButton>
      )
    }
    case "parent": {
      const p = () => (i().parent ? props.store.issue(i().parent!) : undefined)
      return (
        <PickerButton
          {...common}
          label={`Parent: ${p()?.key ?? "none"}`}
          picker={{
            items: parentItems(props.store, i().id),
            selected: [i().parent ?? ""],
            placeholder: "Set parent issue…",
            limit: 60,
            onPick: (id) => props.onChange({ parent: id || null }),
          }}
        >
          <Icon name="layers" size="sm" />
          <span>{p() ? `${p()!.key} ${p()!.title}` : "No parent"}</span>
        </PickerButton>
      )
    }
    case "due": {
      const overdue = () => !!i().due && i().due! < today() && i().stateCategory !== "completed"
      let input: HTMLInputElement | undefined
      return (
        <label
          class={`projects__prop ${common.class}`}
          data-prop="due"
          data-overdue={overdue() ? "" : undefined}
          title="Due date"
        >
          <Icon name="calendar" size="sm" />
          <Show when={!props.compact || i().due}>
            <span>{i().due ? formatDay(i().due!) : "Due date"}</span>
          </Show>
          <input
            ref={input}
            type="date"
            class="projects__date-input"
            aria-label="Due date"
            disabled={props.disabled}
            value={i().due ?? ""}
            onChange={(e) => props.onChange({ due: e.currentTarget.value || null })}
          />
        </label>
      )
    }
  }
}

export function formatDay(d: string): string {
  const t = today()
  if (d === t) return "Today"
  const date = new Date(`${d}T00:00:00Z`)
  return date.toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
    timeZone: "UTC",
    ...(d.slice(0, 4) !== t.slice(0, 4) ? { year: "numeric" } : {}),
  })
}
