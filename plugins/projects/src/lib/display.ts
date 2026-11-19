// How a list or board lays issues out: grouping (by state, assignee, priority, label, cycle or parent),
// ordering inside a group, whether closed issues show, and the rows of a grouped list.

import type { CycleRow, IssueRow, LabelRow, StateRow } from "./model"
import { closed, PRIORITIES, priorityWeight } from "./model"
import { compareRank } from "./rank"

export type Grouping = "state" | "assignee" | "priority" | "label" | "cycle" | "parent" | "none"
export type Ordering = "manual" | "priority" | "updated" | "created" | "due" | "estimate" | "title"

export interface Display {
  layout: "list" | "board"
  groupBy: Grouping
  /** Board swimlanes. */
  subGroupBy: Grouping
  orderBy: Ordering
  /** Closed issues: all, those closed in the last week, or none. */
  completed: "all" | "week" | "none"
  showEmpty: boolean
}

export const DEFAULT_DISPLAY: Display = {
  layout: "list",
  groupBy: "state",
  subGroupBy: "none",
  orderBy: "manual",
  completed: "all",
  showEmpty: false,
}

export const GROUPINGS: Array<{ id: Grouping; name: string }> = [
  { id: "state", name: "State" },
  { id: "assignee", name: "Assignee" },
  { id: "priority", name: "Priority" },
  { id: "label", name: "Label" },
  { id: "cycle", name: "Cycle" },
  { id: "parent", name: "Parent issue" },
  { id: "none", name: "No grouping" },
]

export const ORDERINGS: Array<{ id: Ordering; name: string }> = [
  { id: "manual", name: "Manual" },
  { id: "priority", name: "Priority" },
  { id: "updated", name: "Last updated" },
  { id: "created", name: "Created" },
  { id: "due", name: "Due date" },
  { id: "estimate", name: "Estimate" },
  { id: "title", name: "Title" },
]

export function normalizeDisplay(v: unknown): Display {
  const o = (v && typeof v === "object" ? v : {}) as Partial<Display>
  const g = (x: unknown, d: Grouping): Grouping => (GROUPINGS.some((y) => y.id === x) ? (x as Grouping) : d)
  return {
    layout: o.layout === "board" ? "board" : "list",
    groupBy: g(o.groupBy, DEFAULT_DISPLAY.groupBy),
    subGroupBy: g(o.subGroupBy, "none"),
    orderBy: ORDERINGS.some((x) => x.id === o.orderBy) ? (o.orderBy as Ordering) : "manual",
    completed: o.completed === "none" || o.completed === "week" ? o.completed : "all",
    showEmpty: !!o.showEmpty,
  }
}

/** What grouping needs to name and order groups. */
export interface Lookup {
  states: StateRow[]
  labels: LabelRow[]
  cycles: CycleRow[]
  /** Users by id: display names. */
  userName(id: string): string
  /** Parent issues by id: key and title. */
  issue(id: string): IssueRow | undefined
}

export interface Group {
  /** A stable key: the value grouped on, or "" for none. */
  key: string
  name: string
  /** Sorts groups. */
  order: string | number
  /** For state groups: the state, so the header can draw its ring. */
  state?: StateRow
  issues: IssueRow[]
}

/** The group keys of one issue for a grouping: one, except for labels, where an issue sits under each. */
export function groupKeys(issue: IssueRow, g: Grouping): string[] {
  switch (g) {
    case "state":
      return [issue.state ?? ""]
    case "assignee":
      return [issue.assignee ?? ""]
    case "priority":
      return [String(issue.priority ?? 0)]
    case "label":
      return issue.labels?.length ? issue.labels : [""]
    case "cycle":
      return [issue.cycle ?? ""]
    case "parent":
      return [issue.parent ?? ""]
    default:
      return [""]
  }
}

/** The value to write when an issue is dropped into a group: the patch that puts it there. */
export function patchForGroup(
  issue: IssueRow,
  g: Grouping,
  to: string,
  from?: string,
): Partial<IssueRow> | null {
  switch (g) {
    case "state":
      return to && to !== issue.state ? { state: to } : null
    case "assignee":
      return (to || null) !== issue.assignee ? { assignee: to || null } : null
    case "priority":
      return Number(to) !== (issue.priority ?? 0) ? { priority: Number(to) } : null
    case "cycle":
      return (to || null) !== issue.cycle ? { cycle: to || null } : null
    case "parent":
      return (to || null) !== issue.parent && to !== issue.id ? { parent: to || null } : null
    case "label": {
      const labels = (issue.labels ?? []).filter((l) => l !== from)
      if (to && !labels.includes(to)) labels.push(to)
      const same = labels.length === issue.labels?.length && labels.every((l) => issue.labels.includes(l))
      return same ? null : { labels }
    }
    default:
      return null
  }
}

function groupMeta(key: string, g: Grouping, look: Lookup): Omit<Group, "issues" | "key"> {
  switch (g) {
    case "state": {
      const s = look.states.find((x) => x.id === key)
      return s ? { name: s.name, order: s.rank, state: s } : { name: "No state", order: "~" }
    }
    case "assignee":
      return key
        ? { name: look.userName(key), order: look.userName(key).toLowerCase() }
        : { name: "No assignee", order: "~" }
    case "priority": {
      const p = PRIORITIES.find((x) => String(x.value) === key)
      return { name: p?.name ?? "No priority", order: priorityWeight(Number(key)) }
    }
    case "label": {
      const l = look.labels.find((x) => x.id === key)
      return l ? { name: l.name, order: l.name.toLowerCase() } : { name: "No label", order: "~" }
    }
    case "cycle": {
      const c = look.cycles.find((x) => x.id === key)
      return c ? { name: c.name, order: c.startsOn } : { name: "No cycle", order: "~" }
    }
    case "parent": {
      const p = key ? look.issue(key) : undefined
      return key
        ? { name: p ? `${p.key} ${p.title}` : "Parent not shown", order: p?.rank ?? key }
        : { name: "No parent", order: "~" }
    }
    default:
      return { name: "Issues", order: 0 }
  }
}

/** The groups every value of a grouping has, for showing empty columns and as drop targets. */
export function allGroupKeys(g: Grouping, look: Lookup): string[] {
  switch (g) {
    case "state":
      return [...look.states].sort((a, b) => (a.rank < b.rank ? -1 : 1)).map((s) => s.id)
    case "priority":
      return PRIORITIES.map((p) => String(p.value))
    case "label":
      return [...look.labels.map((l) => l.id), ""]
    case "cycle":
      return [...look.cycles.filter((c) => !c.closed).map((c) => c.id), ""]
    default:
      return []
  }
}

const cmpStr = (a: string | null | undefined, b: string | null | undefined) =>
  a === b ? 0 : a == null ? 1 : b == null ? -1 : a < b ? -1 : 1

/** Orders the issues of a group. Ties fall back to the manual order, so every viewer sees the same list. */
export function comparator(o: Ordering): (a: IssueRow, b: IssueRow) => number {
  switch (o) {
    case "priority":
      return (a, b) => priorityWeight(a.priority) - priorityWeight(b.priority) || compareRank(a, b)
    case "updated":
      return (a, b) => cmpStr(b.updatedAt, a.updatedAt) || compareRank(a, b)
    case "created":
      return (a, b) => cmpStr(b.createdAt, a.createdAt) || compareRank(a, b)
    case "due":
      return (a, b) => cmpStr(a.due, b.due) || compareRank(a, b)
    case "estimate":
      return (a, b) => (b.estimate ?? -1) - (a.estimate ?? -1) || compareRank(a, b)
    case "title":
      return (a, b) => a.title.localeCompare(b.title) || compareRank(a, b)
    default:
      return compareRank
  }
}

const WEEK = 7 * 24 * 3600 * 1000

/** Whether a closed issue still shows under the "completed" option. */
export function showsClosed(issue: IssueRow, opt: Display["completed"], now = Date.now()): boolean {
  if (!closed(issue.stateCategory)) return true
  if (opt === "all") return true
  if (opt === "none") return false
  const at = issue.completedAt ?? issue.updatedAt
  return !!at && now - Date.parse(at) < WEEK
}

/** Groups and orders issues. With `showEmpty`, groups without issues are kept (board columns). */
export function groupIssues(issues: IssueRow[], d: Display, look: Lookup, g: Grouping = d.groupBy): Group[] {
  const by = new Map<string, IssueRow[]>()
  for (const i of issues) {
    for (const k of groupKeys(i, g)) {
      const list = by.get(k)
      if (list) list.push(i)
      else by.set(k, [i])
    }
  }
  if (d.showEmpty || d.layout === "board")
    for (const k of allGroupKeys(g, look)) if (!by.has(k)) by.set(k, [])
  const cmp = comparator(d.orderBy)
  const groups: Group[] = [...by.entries()].map(([key, list]) => ({
    key,
    ...groupMeta(key, g, look),
    issues: list.sort(cmp),
  }))
  groups.sort((a, b) =>
    typeof a.order === "number" && typeof b.order === "number"
      ? a.order - b.order
      : String(a.order) < String(b.order)
        ? -1
        : String(a.order) > String(b.order)
          ? 1
          : 0,
  )
  return groups
}

/** A row of the grouped list: a group header or an issue. */
export type ListRow =
  | { kind: "group"; group: Group; collapsed: boolean }
  | { kind: "issue"; issue: IssueRow; group: string }

/** Flattens groups into the rows a virtualised list renders. */
export function listRows(groups: Group[], collapsed: Set<string>, grouping: Grouping): ListRow[] {
  const out: ListRow[] = []
  for (const g of groups) {
    if (grouping !== "none") out.push({ kind: "group", group: g, collapsed: collapsed.has(g.key) })
    if (grouping !== "none" && collapsed.has(g.key)) continue
    for (const i of g.issues) out.push({ kind: "issue", issue: i, group: g.key })
  }
  return out
}

/** The neighbours an issue gets when dropped at `index` of a group's list (without the issue itself). */
export function neighbours(list: IssueRow[], movingId: string, index: number) {
  const rest = list.filter((i) => i.id !== movingId)
  const at = Math.max(0, Math.min(index, rest.length))
  return { above: rest[at - 1] ?? null, below: rest[at] ?? null, after: rest[at + 1] ?? null }
}
