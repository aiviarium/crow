// Filters over issues: a structured filter that views save, a query bar that reads and writes it as text
// (`state:"In progress" assignee:me -label:bug priority:urgent,high fix login`), and matching an issue
// against it. The client half matches all of a project's issues in memory; the host half's tools use the
// same matcher after fetching.
import type { Category, IssueRow } from "./model"
import { CATEGORIES, PRIORITIES } from "./model"

export type FilterField =
  | "state"
  | "category"
  | "assignee"
  | "creator"
  | "priority"
  | "label"
  | "cycle"
  | "parent"
  | "project"
  | "due"
  | "estimate"

/**
 * One condition. `is` matches any of the values, `not` none of them; for labels `all` needs every value.
 * `due` takes `before`/`after` with a date, or `is` with `overdue`, `none`, `any`. Special values: `none`
 * (unset), `any` (set), `me` (the viewer), `current` (the current cycle).
 */
export interface Condition {
  field: FilterField
  op: "is" | "not" | "all" | "before" | "after"
  values: string[]
}

export interface Filter {
  conditions: Condition[]
  /** Words that must all appear in the key or title. */
  text?: string
}

export const EMPTY_FILTER: Filter = { conditions: [] }

/** What matching needs beyond the issue: who is looking and what today is. */
export interface MatchContext {
  me: string | null
  /** The current cycle of each project (space id -> cycle id). */
  currentCycles?: Record<string, string | null>
  today?: string
}

const has = (values: string[], v: string | null | undefined, ctx: MatchContext, issue: IssueRow) =>
  values.some((x) => {
    if (x === "none") return v == null || v === ""
    if (x === "any") return v != null && v !== ""
    if (x === "me") return v != null && v === ctx.me
    if (x === "current") return v != null && v === (ctx.currentCycles?.[issue.spaceId] ?? undefined)
    return v === x
  })

function today(ctx: MatchContext): string {
  return ctx.today ?? new Date().toISOString().slice(0, 10)
}

function matchCondition(issue: IssueRow, c: Condition, ctx: MatchContext): boolean {
  const neg = c.op === "not"
  let hit: boolean
  switch (c.field) {
    case "state":
      hit = has(c.values, issue.state, ctx, issue)
      break
    case "category":
      hit = has(c.values, issue.stateCategory, ctx, issue)
      break
    case "assignee":
      hit = has(c.values, issue.assignee, ctx, issue)
      break
    case "creator":
      hit = has(c.values, issue.createdBy, ctx, issue)
      break
    case "priority":
      hit = c.values.includes(String(issue.priority ?? 0))
      break
    case "estimate":
      hit = has(c.values, issue.estimate == null ? null : String(issue.estimate), ctx, issue)
      break
    case "cycle":
      hit = has(c.values, issue.cycle, ctx, issue)
      break
    case "parent":
      hit = has(c.values, issue.parent, ctx, issue)
      break
    case "project":
      hit = has(c.values, issue.spaceId, ctx, issue)
      break
    case "label": {
      const labels = issue.labels ?? []
      const test = (v: string) =>
        v === "none" ? labels.length === 0 : v === "any" ? labels.length > 0 : labels.includes(v)
      hit = c.op === "all" ? c.values.every(test) : c.values.some(test)
      break
    }
    case "due": {
      const d = issue.due
      if (c.op === "before") return !!d && d < (c.values[0] ?? "")
      if (c.op === "after") return !!d && d > (c.values[0] ?? "")
      hit = c.values.some((v) =>
        v === "none" ? !d : v === "any" ? !!d : v === "overdue" ? !!d && d < today(ctx) : d === v,
      )
      break
    }
    default:
      hit = true
  }
  return neg ? !hit : hit
}

const KEY_WORD = /^[a-z][a-z0-9]{1,9}-[1-9][0-9]*$/

/** Words of free text, lower case. */
export function words(text: string | undefined): string[] {
  return (text ?? "").toLowerCase().split(/\s+/).filter(Boolean)
}

export function matches(issue: IssueRow, filter: Filter, ctx: MatchContext): boolean {
  for (const c of filter.conditions) if (!matchCondition(issue, c, ctx)) return false
  const w = words(filter.text)
  if (w.length) {
    const hay = `${issue.key} ${issue.title}`.toLowerCase()
    // A word shaped like a key means that issue, not every key it is a prefix of.
    const key = issue.key.toLowerCase()
    if (!w.every((x) => (KEY_WORD.test(x) ? key === x : hay.includes(x)))) return false
  }
  return true
}

export function filterIssues<T extends IssueRow>(issues: T[], filter: Filter, ctx: MatchContext): T[] {
  if (!filter.conditions.length && !words(filter.text).length) return issues
  return issues.filter((i) => matches(i, filter, ctx))
}

// ── the query bar ───────────────────────────────────────────────────────────────────────────────────

/** Names the query bar uses for fields, with aliases. */
const FIELD_NAMES: Record<string, FilterField> = {
  state: "state",
  status: "state",
  is: "category",
  category: "category",
  assignee: "assignee",
  assigned: "assignee",
  creator: "creator",
  author: "creator",
  priority: "priority",
  p: "priority",
  label: "label",
  labels: "label",
  cycle: "cycle",
  parent: "parent",
  project: "project",
  due: "due",
  estimate: "estimate",
}

/** Turns names in the query bar into ids, and ids back into names. */
export interface Resolver {
  /** An id for the name (case-insensitive), or null when nothing has that name. */
  id(field: FilterField, name: string): string | null
  /** The name to show for an id. */
  name(field: FilterField, id: string): string
}

const SPECIAL = new Set(["none", "any", "me", "current", "overdue"])

/** A resolver for the values that need no lookups: categories and priorities. */
export function builtinId(field: FilterField, name: string): string | null {
  const n = name.toLowerCase()
  if (SPECIAL.has(n)) return n
  if (field === "category") {
    return CATEGORIES.find((x) => x === n) ?? CATEGORIES.find((x) => x.startsWith(n)) ?? null
  }
  if (field === "priority") {
    if (/^[0-4]$/.test(n)) return n
    const p = PRIORITIES.find((x) => x.name.toLowerCase() === n || (n === "no" && x.value === 0))
    return p ? String(p.value) : null
  }
  if (field === "due" || field === "estimate") return name
  return null
}

export function builtinName(field: FilterField, id: string): string | null {
  if (SPECIAL.has(id)) return id
  if (field === "category") return id
  if (field === "priority") return PRIORITIES.find((p) => String(p.value) === id)?.name.toLowerCase() ?? id
  if (field === "due" || field === "estimate") return id
  return null
}

/** Splits a query into tokens, keeping quoted parts together: `a "b c" d:"e f"` -> [a, "b c", d:"e f"]. */
export function tokenize(q: string): string[] {
  const out: string[] = []
  let cur = ""
  let quote = false
  for (const ch of q) {
    if (ch === '"') {
      quote = !quote
      cur += ch
    } else if (/\s/.test(ch) && !quote) {
      if (cur) out.push(cur)
      cur = ""
    } else cur += ch
  }
  if (cur) out.push(cur)
  return out
}

/** Splits `a,"b, c",d` on commas outside quotes and drops the quotes. */
function splitValues(v: string): string[] {
  const out: string[] = []
  let cur = ""
  let quote = false
  for (const ch of v) {
    if (ch === '"') quote = !quote
    else if (ch === "," && !quote) {
      out.push(cur)
      cur = ""
    } else cur += ch
  }
  out.push(cur)
  return out.map((s) => s.trim()).filter(Boolean)
}

export interface ParseResult {
  filter: Filter
  /** Tokens that named a field but a value nothing has: shown to the person, not silently dropped. */
  unknown: string[]
}

/** Reads the query bar. `field:value`, `field:a,b`, `-field:value` (not), `label:a+b` (all), free text. */
export function parseQuery(q: string, resolve: Resolver): ParseResult {
  const conditions: Condition[] = []
  const text: string[] = []
  const unknown: string[] = []
  for (const tok of tokenize(q)) {
    const m = /^(-?)([a-z]+):(.*)$/i.exec(tok)
    const field = m ? FIELD_NAMES[m[2]!.toLowerCase()] : undefined
    if (!m || !field || !m[3]) {
      text.push(tok.replace(/^"|"$/g, ""))
      continue
    }
    const neg = m[1] === "-"
    let raw = m[3]!
    let op: Condition["op"] = neg ? "not" : "is"
    if (field === "due" && /^[<>]/.test(raw)) {
      op = raw[0] === "<" ? "before" : "after"
      raw = raw.slice(1)
    } else if (field === "label" && raw.includes("+") && !neg) {
      op = "all"
    }
    const names = op === "all" ? raw.split("+").map((s) => s.replace(/"/g, "").trim()) : splitValues(raw)
    const ids: string[] = []
    for (const n of names) {
      const id = builtinId(field, n) ?? resolve.id(field, n)
      if (id === null) unknown.push(`${field}:${n}`)
      else if (!ids.includes(id)) ids.push(id)
    }
    if (!ids.length) continue
    // Two tokens for one field and op combine into one condition.
    const same = conditions.find((c) => c.field === field && c.op === op && op !== "all")
    if (same && op !== "before" && op !== "after") {
      for (const id of ids) if (!same.values.includes(id)) same.values.push(id)
    } else conditions.push({ field, op, values: ids })
  }
  const t = text.join(" ").trim()
  return { filter: t ? { conditions, text: t } : { conditions }, unknown }
}

const quoteIfNeeded = (s: string) => (/[\s,+"]/.test(s) ? `"${s.replace(/"/g, "")}"` : s)

/** Writes a filter as the query bar shows it; `parseQuery(printQuery(f))` gives `f` back. */
export function printQuery(filter: Filter, resolve: Resolver): string {
  const parts: string[] = []
  for (const c of filter.conditions) {
    const names = c.values.map((id) => quoteIfNeeded(builtinName(c.field, id) ?? resolve.name(c.field, id)))
    if (c.op === "before" || c.op === "after")
      parts.push(`${c.field}:${c.op === "before" ? "<" : ">"}${names[0]}`)
    else if (c.op === "all") parts.push(`${c.field}:${names.join("+")}`)
    else parts.push(`${c.op === "not" ? "-" : ""}${c.field}:${names.join(",")}`)
  }
  if (filter.text?.trim()) parts.push(filter.text.trim())
  return parts.join(" ")
}

/** Adds a value to a filter, or removes it when it is there: what clicking an option in the builder does. */
export function toggleValue(
  filter: Filter,
  field: FilterField,
  value: string,
  op: Condition["op"] = "is",
): Filter {
  const conditions = filter.conditions.map((c) => ({ ...c, values: [...c.values] }))
  const at = conditions.findIndex((c) => c.field === field && c.op === op)
  if (at < 0) conditions.push({ field, op, values: [value] })
  else {
    const c = conditions[at]!
    if (c.values.includes(value)) c.values = c.values.filter((v) => v !== value)
    else c.values.push(value)
    if (!c.values.length) conditions.splice(at, 1)
  }
  return { ...filter, conditions }
}

export function removeCondition(filter: Filter, index: number): Filter {
  return { ...filter, conditions: filter.conditions.filter((_, i) => i !== index) }
}

/** Reads a stored filter defensively: views are written by people and plugins. */
export function normalizeFilter(v: unknown): Filter {
  const o = (v && typeof v === "object" ? v : {}) as Partial<Filter>
  const conditions = Array.isArray(o.conditions)
    ? o.conditions
        .filter(
          (c): c is Condition =>
            !!c &&
            typeof c === "object" &&
            typeof (c as Condition).field === "string" &&
            Array.isArray((c as Condition).values),
        )
        .map((c) => ({ field: c.field, op: c.op ?? "is", values: c.values.map(String) }))
    : []
  return typeof o.text === "string" && o.text.trim() ? { conditions, text: o.text } : { conditions }
}

export const categoryOf = (c: string): Category | null =>
  (CATEGORIES as string[]).includes(c) ? (c as Category) : null
