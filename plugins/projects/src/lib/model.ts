// The shapes of the plugin's rows, shared by the host and client halves, and the defaults a new project
// starts with.
import type { CommentOrigin, IssueSource } from "./source"

export type Category = "backlog" | "unstarted" | "started" | "completed" | "cancelled"

export const CATEGORIES: Category[] = ["backlog", "unstarted", "started", "completed", "cancelled"]

export const CATEGORY_TITLE: Record<Category, string> = {
  backlog: "Backlog",
  unstarted: "Unstarted",
  started: "Started",
  completed: "Completed",
  cancelled: "Cancelled",
}

/** The icon the entity index carries for an issue in each category (chips, search results). */
export const CATEGORY_ICON: Record<Category, string> = {
  backlog: "inbox",
  unstarted: "list",
  started: "play",
  completed: "check",
  cancelled: "close",
}

/** Done: neither counts as open work. */
export const closed = (c: Category | null | undefined) => c === "completed" || c === "cancelled"

/** Hues of `@aiviarium/nocturne`'s LabelChip (`--label-<hue>` and the status colours), and `muted` for text-3. */
export const HUES = [
  "accent",
  "sky",
  "teal",
  "mint",
  "amber",
  "ember",
  "rose",
  "orchid",
  "success",
  "warning",
  "danger",
  "info",
  "muted",
] as const
export type Hue = (typeof HUES)[number]

export interface StateRow {
  id: string
  spaceId: string
  name: string
  category: Category
  color: string
  rank: string
  description?: string | null
}

export interface LabelRow {
  id: string
  name: string
  color: string
  /** `space://<id>` for a project's own label; null for a label of the whole workspace. */
  scope: string | null
  description?: string | null
}

export interface ProjectRow {
  id: string
  spaceId: string
  key: string
  name: string
  icon: string | null
  summary: string | null
  document: string | null
  lead: string | null
  archived: boolean
  autoCloseParent: boolean
  cycleWeeks: number | null
  cycleAuto: boolean
  createdAt: string
  updatedAt: string
}

export type Priority = 0 | 1 | 2 | 3 | 4

/** Linear's order: 0 none, 1 urgent, 2 high, 3 medium, 4 low. */
export const PRIORITIES: Array<{ value: Priority; name: string; key: string }> = [
  { value: 1, name: "Urgent", key: "1" },
  { value: 2, name: "High", key: "2" },
  { value: 3, name: "Medium", key: "3" },
  { value: 4, name: "Low", key: "4" },
  { value: 0, name: "No priority", key: "0" },
]

export const priorityName = (p: number | null | undefined) =>
  PRIORITIES.find((x) => x.value === (p ?? 0))?.name ?? "No priority"

/** Sort weight of a priority: urgent first, none last. */
export const priorityWeight = (p: number | null | undefined) => (p ? p : 5)

export interface IssueRow {
  id: string
  spaceId: string
  number: number
  key: string
  keyWords?: string | null
  title: string
  label: string
  document: string | null
  state: string | null
  stateName: string | null
  stateCategory: Category | null
  icon: string | null
  priority: number
  assignee: string | null
  labels: string[]
  estimate: number | null
  due: string | null
  parent: string | null
  cycle: string | null
  rank: string | null
  followers: string[]
  /** Entities linked to the issue by hand or by an agent (`projects.link`). */
  links?: string[]
  startedAt: string | null
  completedAt: string | null
  /** The tracker the issue syncs with (docs/issues.md), or null for an issue of Crow's own. */
  source?: IssueSource | null
  /** `provider:external`, unique in a project. */
  sourceKey?: string | null
  /** `<the source's repository>#<number>`, to find an issue by its number there. */
  sourceRef?: string | null
  /** The id an import gave (a CSV column, GitHub's number in an export). */
  importedFrom?: string | null
  createdAt: string
  updatedAt: string
  createdBy: string | null
  updatedBy: string | null
  rev: number
  deletedAt?: string | null
}

export interface CommentRow {
  id: string
  spaceId: string
  issue: string
  body: unknown
  excerpt: string
  reactions: Record<string, string[]>
  editedAt: string | null
  /** For a comment from a source: the Crow user who wrote it there, when they are one. */
  author?: string | null
  /** The source's comment it is. */
  origin?: (CommentOrigin & { createdAt?: string | null; body?: string }) | null
  originKey?: string | null
  createdAt: string
  createdBy: string | null
  rev: number
  deletedAt?: string | null
}

export type RelationKind = "blocks" | "relates" | "duplicate"

export interface RelationRow {
  id: string
  spaceId: string
  source: string
  target: string
  kind: RelationKind
  createdAt: string
  createdBy: string | null
}

/** How a relation reads from one side. */
export function relationLabel(kind: RelationKind, outgoing: boolean): string {
  if (kind === "blocks") return outgoing ? "Blocks" : "Blocked by"
  if (kind === "duplicate") return outgoing ? "Duplicate of" : "Duplicated by"
  return "Related to"
}

export interface CycleRow {
  id: string
  spaceId: string
  number: number
  name: string
  startsOn: string
  endsOn: string
  closed: boolean
  summary: string | null
  rolledTo: string | null
  createdAt: string
}

export interface TemplateRow {
  id: string
  spaceId: string
  name: string
  title: string | null
  priority: number | null
  labels: string[]
  estimate: number | null
  body: unknown
}

export interface SavedViewRow {
  id: string
  spaceId: string
  name: string
  filter: unknown
  display: unknown
  personal: boolean
  createdBy: string | null
}

/** The workflow a new project starts with. */
export const DEFAULT_STATES: Array<{ name: string; category: Category; color: Hue }> = [
  { name: "Backlog", category: "backlog", color: "muted" },
  { name: "Todo", category: "unstarted", color: "muted" },
  { name: "In progress", category: "started", color: "warning" },
  { name: "In review", category: "started", color: "info" },
  { name: "Done", category: "completed", color: "accent" },
  { name: "Cancelled", category: "cancelled", color: "muted" },
]

/** Labels a new project gets. */
export const DEFAULT_LABELS: Array<{ name: string; color: Hue }> = [
  { name: "Bug", color: "danger" },
  { name: "Feature", color: "accent" },
  { name: "Improvement", color: "info" },
]

/** The first state of a category in workflow order, or null. */
export function firstOf(states: StateRow[], category: Category): StateRow | null {
  return (
    [...states].filter((s) => s.category === category).sort((a, b) => (a.rank < b.rank ? -1 : 1))[0] ?? null
  )
}

/** The state a new issue gets: the first unstarted one, else the first backlog one, else the first. */
export function defaultState(states: StateRow[]): StateRow | null {
  const sorted = [...states].sort((a, b) => (a.rank < b.rank ? -1 : 1))
  return firstOf(sorted, "unstarted") ?? firstOf(sorted, "backlog") ?? sorted[0] ?? null
}

/** The entity title of an issue: its key and title, so chips, search and mentions show both. */
export const issueLabel = (key: string, title: string) => `${key} ${title}`
