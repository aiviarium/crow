// The activity timeline of an issue: field changes from the collection's history, comments, references
// other entities made to it (a doc that mentions it, an agent session started on it, a pull request), and
// sub-issues, merged into one list, oldest first.
import type { Category } from "./model"

export interface HistoryLike {
  op: string
  rev: number
  principal: string
  onBehalfOf: string | null
  at: string
  changes: Record<string, [unknown, unknown]>
}

/** Fields whose changes the timeline shows, in this order within one entry. */
export const SHOWN_FIELDS = [
  "title",
  "state",
  "priority",
  "assignee",
  "labels",
  "estimate",
  "due",
  "parent",
  "cycle",
] as const
export type ShownField = (typeof SHOWN_FIELDS)[number]

export interface FieldChange {
  field: ShownField
  from: unknown
  to: unknown
}

export type TimelineItem =
  | { kind: "created"; at: string; actor: string }
  | { kind: "change"; at: string; actor: string; onBehalfOf: string | null; changes: FieldChange[] }
  | { kind: "comment"; at: string; id: string }
  | { kind: "link"; at: string; source: string; field: string }
  /** Both sides of a synced issue changed a field (docs/issues.md): which kept its value, and what was lost. */
  | {
      kind: "conflict"
      at: string
      provider: string
      field: string
      won: "crow" | "source"
      lost: unknown
      kept: unknown
    }

/** Who acted, as a URI: `user:<id>` principals become `user://<id>`, agents stay as they are. */
export function actorUri(principal: string, onBehalfOf: string | null): string {
  const p =
    principal.startsWith("user:") && !principal.startsWith("user://")
      ? `user://${principal.slice(5)}`
      : principal
  if (p.startsWith("user://")) return p
  // An agent session or a service acting for someone: the session is the actor.
  if (p.startsWith("agent:")) return `session://${p.slice(6)}`
  return onBehalfOf ? `user://${onBehalfOf.replace(/^user:\/?\/?/, "")}` : p
}

/**
 * Turns history entries into timeline entries: the insert as "created", and each update with the shown
 * fields it touched. Several updates by one actor within `mergeMs` collapse into one entry, keeping the
 * first `from` and the last `to` of each field, and dropping fields that ended where they started.
 */
export function historyItems(entries: HistoryLike[], mergeMs = 60_000): TimelineItem[] {
  const out: TimelineItem[] = []
  const sorted = [...entries].sort((a, b) => (a.at < b.at ? -1 : a.at > b.at ? 1 : a.rev - b.rev))
  for (const e of sorted) {
    const actor = actorUri(e.principal, e.onBehalfOf)
    if (e.op === "insert") {
      out.push({ kind: "created", at: e.at, actor })
      continue
    }
    if (e.op !== "update") continue
    const changes: FieldChange[] = []
    for (const f of SHOWN_FIELDS) {
      const c = e.changes?.[f]
      if (c) changes.push({ field: f, from: c[0], to: c[1] })
    }
    if (!changes.length) continue
    const last = out[out.length - 1]
    if (last?.kind === "change" && last.actor === actor && Date.parse(e.at) - Date.parse(last.at) < mergeMs) {
      for (const c of changes) {
        const had = last.changes.find((x) => x.field === c.field)
        if (had) had.to = c.to
        else last.changes.push(c)
      }
      last.changes = last.changes.filter((c) => JSON.stringify(c.from) !== JSON.stringify(c.to))
      last.at = e.at
      if (!last.changes.length) out.pop()
      continue
    }
    out.push({ kind: "change", at: e.at, actor, onBehalfOf: e.onBehalfOf, changes })
  }
  return out
}

/** Merges the parts of a timeline into one list, oldest first. */
export function mergeTimeline(...parts: TimelineItem[][]): TimelineItem[] {
  return parts.flat().sort((a, b) => (a.at < b.at ? -1 : a.at > b.at ? 1 : 0))
}

/** Backlinks the links panel and the timeline show, without the plugin's own bookkeeping. */
export function isOwnBookkeeping(link: { source: string; field: string }, issueUri: string): boolean {
  // Comments reference their issue through `issue`, which is not a link someone made.
  if (link.source.startsWith("comment://") && link.field === "issue") return true
  if (link.source === issueUri) return true
  return false
}

/** How the links panel groups a backlink: by the scheme of what references the issue. */
export function linkGroup(source: string, field: string): string {
  const scheme = source.slice(0, Math.max(0, source.indexOf("://")))
  if (scheme === "issue" && field === "parent") return "sub-issue"
  return scheme || "other"
}

/** Words for a state change: "moved from Todo to In progress". */
export function describeCategory(c: Category | null | undefined): string {
  return c ?? "none"
}
