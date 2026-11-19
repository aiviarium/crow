// Issues from other trackers (docs/issues.md). A Projects issue may have a `source`: the tracker it syncs
// with (GitHub first), its id there, and what the two sides last agreed on, field by field. This file is the
// pure part, shared by the host half and the tests: how states map, how labels' colours map, and how an
// inbound change to one field is decided against what Crow changed meanwhile.
import { type Category, firstOf, type Hue, type StateRow } from "./model"

/** The fields a source has. The others (priority, estimate, cycle, sub-issues…) stay in Crow. */
export const SYNC_FIELDS = ["title", "body", "state", "labels", "assignee"] as const
export type SyncField = (typeof SYNC_FIELDS)[number]

/** A person on the source's side: a Crow user when the source maps them, else only their login. */
export interface SourcePerson {
  /** `user://<id>`, when the source knows who they are in Crow. */
  user?: string | null
  login: string
  avatar?: string | null
  url?: string | null
}

/** Open or closed with GitHub's reason, as one comparable value. */
export type RemoteState = "open" | "closed:completed" | "closed:not_planned"

export interface SourceError {
  /** `github_forbidden`, `github_not_found`, `github_rate_limited`, … */
  reason: string
  message: string
  fix?: string
  at: string
  /** When a retry is due (a rate limit's reset). */
  retryAt?: string
  /** What did not get through. */
  fields?: SyncField[]
}

export interface SourceConflict {
  field: SyncField
  at: string
  /** Which side's value the issue kept. */
  won: "crow" | "source"
  /** The value that lost: shown in the issue's activity (a description as Markdown, shown as a diff). */
  lost: unknown
  /** The value that won. */
  kept: unknown
}

/** `issues.source`: where an issue comes from and the state of its sync. */
export interface IssueSource {
  /** The contribution to `projects.issueSources` (`github`). */
  provider: string
  /** The source's stable id of the issue. */
  external: string
  /** How people name it there: `owner/repo#212`. */
  ref: string
  url: string
  number?: number
  /** The `projectSources` row it syncs through. */
  link?: string | null
  remoteUpdatedAt?: string | null
  syncedAt?: string | null
  /**
   * What both sides last agreed on, per field: the source's own value (`body` is GitHub's Markdown as GitHub
   * has it) and, for the description, `bodyCrow`, the Markdown of Crow's document at that moment, so a change
   * is noticed on each side without comparing one converter's output with the other's.
   */
  base?: {
    title?: string
    body?: string
    bodyCrow?: string
    state?: RemoteState
    labels?: string[]
    assignee?: string | null
  }
  /** When Crow last wrote each field (a person's edit). */
  crowAt?: Partial<Record<SyncField, string>>
  author?: SourcePerson | null
  /** The source's assignees who are not Crow users: shown, not assignable in Crow until mapped. */
  people?: SourcePerson[]
  error?: SourceError | null
  removed?: "deleted" | "transferred" | null
  conflicts?: SourceConflict[]
}

/** A comment's `origin`: the source's comment it is. */
export interface CommentOrigin {
  provider: string
  external: string
  url?: string | null
  author?: SourcePerson | null
  remoteUpdatedAt?: string | null
}

/** The unique key of an issue's source within a space: `github:12345`. */
export const sourceKey = (provider: string, external: string) => `${provider}:${external}`

// ── state ─────────────────────────────────────────────────────────────────────────────────────────────

/** What GitHub calls a Crow category. Backlog, unstarted and started are all open. */
export function remoteStateOf(category: Category | null | undefined): RemoteState {
  if (category === "completed") return "closed:completed"
  if (category === "cancelled") return "closed:not_planned"
  return "open"
}

/** GitHub's state and reason as one value: a closed issue without a reason was completed. */
export function remoteState(state: string, reason?: string | null): RemoteState {
  if (state !== "closed") return "open"
  return reason === "not_planned" ? "closed:not_planned" : "closed:completed"
}

/** The project's default unstarted state: the first unstarted one, else backlog, else the first. */
export function unstarted(states: StateRow[]): StateRow | null {
  const sorted = [...states].sort((a, b) => (a.rank < b.rank ? -1 : 1))
  return firstOf(sorted, "unstarted") ?? firstOf(sorted, "backlog") ?? sorted[0] ?? null
}

/**
 * The Crow state for a state on the source (the table in docs/issues.md), or undefined to leave the issue
 * where it is. `current` is the issue's state now (null for an issue seen for the first time).
 *   open, first seen                       the default unstarted state
 *   open, while the issue is open in Crow  unchanged (an issue in progress stays in progress)
 *   closed completed                       the first completed state (unchanged when it is completed)
 *   closed not_planned                     the first cancelled state (unchanged when it is cancelled)
 *   reopened                               the default unstarted state, unless Crow has it unstarted or started
 */
export function stateFor(
  remote: RemoteState,
  current: Category | null,
  states: StateRow[],
): StateRow | null | undefined {
  if (remote === "closed:completed")
    return current === "completed" ? undefined : (firstOf(states, "completed") ?? undefined)
  if (remote === "closed:not_planned")
    return current === "cancelled" ? undefined : (firstOf(states, "cancelled") ?? undefined)
  if (current === null) return unstarted(states)
  if (current === "unstarted" || current === "started") return undefined
  // Reopened (it was completed or cancelled in Crow), or open while in the backlog after being reopened.
  if (current === "completed" || current === "cancelled") return unstarted(states)
  return undefined
}

// ── deciding one field ───────────────────────────────────────────────────────────────────────────────

export type Decision =
  /** Nothing to do: the sides agree, or only Crow changed (its push will follow). */
  | { kind: "keep" }
  /** Only the source changed: take its value. */
  | { kind: "apply" }
  /** Both changed and the source's write is later: take its value, record Crow's as lost. */
  | { kind: "conflict"; won: "source" }
  /** Both changed and Crow's write is later: keep Crow's, record the source's as lost. */
  | { kind: "conflict"; won: "crow" }

const t = (iso: string | null | undefined) => (iso ? Date.parse(iso) : Number.NaN)

/**
 * How an inbound value of one field is applied. `remoteChanged` and `crowChanged` say whether each side
 * moved away from the value both last agreed on; `same` that they ended at the same value anyway. A field
 * Crow never wrote (no `crowAt`) loses to the source. The later write wins: GitHub's `updated_at` against
 * the time of Crow's last write of the field.
 */
export function decide(o: {
  remoteChanged: boolean
  crowChanged: boolean
  same: boolean
  remoteAt: string | null | undefined
  crowAt: string | null | undefined
}): Decision {
  if (o.same || !o.remoteChanged) return { kind: "keep" }
  if (!o.crowChanged) return { kind: "apply" }
  const r = t(o.remoteAt)
  const c = t(o.crowAt)
  if (!Number.isFinite(c) || (Number.isFinite(r) && r > c)) return { kind: "conflict", won: "source" }
  return { kind: "conflict", won: "crow" }
}

/** Markdown compared as text that means the same: line endings, trailing spaces, blank lines at the ends. */
export function sameMarkdown(a: string | null | undefined, b: string | null | undefined): boolean {
  const n = (s: string | null | undefined) =>
    (s ?? "")
      .replace(/\r\n?/g, "\n")
      .split("\n")
      .map((l) => l.replace(/\s+$/, ""))
      .join("\n")
      .trim()
  return n(a) === n(b)
}

/** Label names as a set that compares: lower case, sorted, once each. */
export function labelSet(names: string[]): string[] {
  return [...new Set(names.map((n) => n.trim().toLowerCase()).filter(Boolean))].sort()
}

export const sameList = (a: string[] | undefined, b: string[] | undefined) =>
  JSON.stringify(labelSet(a ?? [])) === JSON.stringify(labelSet(b ?? []))

/** Keeps the last few conflicts on the issue: the activity shows them, the issue row stays small. */
export function withConflict(list: SourceConflict[] | undefined, c: SourceConflict, keep = 20) {
  return [...(list ?? []), c].slice(-keep)
}

// ── labels ───────────────────────────────────────────────────────────────────────────────────────────

/** The accents labels can have, as RGB: what a GitHub colour is mapped to the nearest of. */
const HUE_RGB: Array<[Hue, [number, number, number]]> = [
  ["accent", [124, 108, 246]],
  ["sky", [56, 189, 248]],
  ["teal", [45, 212, 191]],
  ["mint", [74, 222, 128]],
  ["amber", [251, 191, 36]],
  ["ember", [249, 115, 22]],
  ["rose", [244, 63, 94]],
  ["orchid", [217, 70, 239]],
  ["muted", [148, 148, 160]],
]

/** A GitHub label colour (`d73a4a`) as the nearest accent; greys and unknowns are muted. */
export function hueOf(hex: string | null | undefined): Hue {
  const m = /^#?([0-9a-f]{6})$/i.exec((hex ?? "").trim())
  if (!m) return "muted"
  const n = Number.parseInt(m[1]!, 16)
  const rgb = [(n >> 16) & 255, (n >> 8) & 255, n & 255] as const
  const max = Math.max(...rgb)
  const min = Math.min(...rgb)
  // Without much colour, it is a grey whatever its lightness.
  if (max - min < 40) return "muted"
  let best: Hue = "muted"
  let dist = Number.POSITIVE_INFINITY
  for (const [hue, c] of HUE_RGB) {
    if (hue === "muted") continue
    // Compare directions, not brightness: a pale and a deep red are both rose.
    const norm = (v: readonly number[]) => {
      const lo = Math.min(...v)
      const span = Math.max(...v) - lo || 1
      return v.map((x) => (x - lo) / span)
    }
    const a = norm(rgb)
    const b = norm(c)
    const d = a.reduce((s, x, i) => s + (x - b[i]!) ** 2, 0)
    if (d < dist) {
      dist = d
      best = hue
    }
  }
  return best
}

// ── what a source's link looks like ──────────────────────────────────────────────────────────────────

/** A `projectSources` row: a project linked to a repository. */
export interface SourceLink {
  id: string
  /** The project's space. */
  space: string
  provider: string
  /** The source's id of the repository (`gh-repo://<id>` for GitHub). */
  repository: string
  /** `owner/name`. */
  name: string
  url?: string | null
  /** The space the repository is attached to. */
  repoSpace?: string | null
  /** The connection it syncs with. */
  connection?: string | null
}

/** A contribution to `projects.issueSources`. */
export interface IssueSourceContribution {
  id: string
  title: string
  icon?: string
  /** The service of the contributing plugin, and its methods. */
  service: string
  /** Writes a change of an issue or a comment to the source. */
  push: string
  /** The repositories a person may link a project to. */
  repositories?: string
  /** Told when a project was linked to or unlinked from a repository from the project's settings. */
  linked?: string
  unlinked?: string
}
