// Import: issues from a CSV file (any columns, mapped to fields by the person) or from GitHub's issue JSON
// (the REST API's shape, or `gh issue list --json …`). Both become ImportIssue rows; the host half then
// resolves states, labels and people in the project and writes them in batches.
import { parseIssueKey } from "./keys"
import type { Category } from "./model"
import { PRIORITIES } from "./model"

export interface ImportIssue {
  title: string
  description?: string
  /** A state's name in the project, matched case-insensitively. */
  state?: string
  /** Used when `state` names nothing: the first state of this category. */
  category?: Category
  priority?: number
  /** An email or a name of someone in Crow. */
  assignee?: string
  labels: string[]
  estimate?: number
  due?: string
  /** Where it came from: `#123`, a URL, a key in the old tracker. */
  source?: string
  createdAt?: string
}

/** Fields a CSV column can map to. */
export type ImportField =
  | "title"
  | "description"
  | "state"
  | "priority"
  | "assignee"
  | "labels"
  | "estimate"
  | "due"
  | "source"
  | "ignore"

export const IMPORT_FIELDS: Array<{ id: ImportField; name: string }> = [
  { id: "title", name: "Title" },
  { id: "description", name: "Description" },
  { id: "state", name: "State" },
  { id: "priority", name: "Priority" },
  { id: "assignee", name: "Assignee" },
  { id: "labels", name: "Labels" },
  { id: "estimate", name: "Estimate" },
  { id: "due", name: "Due date" },
  { id: "source", name: "Source id" },
  { id: "ignore", name: "Ignore" },
]

/** Parses CSV (RFC 4180: quotes, doubled quotes, newlines inside quotes, CRLF). Returns rows of cells. */
export function parseCsv(text: string): string[][] {
  const rows: string[][] = []
  let row: string[] = []
  let cell = ""
  let quoted = false
  let i = 0
  const src = text.replace(/^﻿/, "")
  while (i < src.length) {
    const ch = src[i]!
    if (quoted) {
      if (ch === '"') {
        if (src[i + 1] === '"') {
          cell += '"'
          i += 2
          continue
        }
        quoted = false
      } else cell += ch
      i++
      continue
    }
    if (ch === '"' && cell === "") quoted = true
    else if (ch === ",") {
      row.push(cell)
      cell = ""
    } else if (ch === "\n" || ch === "\r") {
      if (ch === "\r" && src[i + 1] === "\n") i++
      row.push(cell)
      rows.push(row)
      row = []
      cell = ""
    } else cell += ch
    i++
  }
  if (cell !== "" || row.length) {
    row.push(cell)
    rows.push(row)
  }
  return rows.filter((r) => r.some((c) => c.trim() !== ""))
}

const GUESS: Array<[RegExp, ImportField]> = [
  [/^(title|summary|name|subject)$/i, "title"],
  [/^(description|body|details|content)$/i, "description"],
  [/^(state|status|column)$/i, "state"],
  [/^(priority|prio|severity)$/i, "priority"],
  [/^(assignee|assigned( to)?|owner)$/i, "assignee"],
  [/^(labels?|tags?)$/i, "labels"],
  [/^(estimate|points|story points|size)$/i, "estimate"],
  [/^(due( date)?|deadline)$/i, "due"],
  [/^(id|key|issue( id| key)?|number|#)$/i, "source"],
]

/** A first mapping from the header row: columns whose names say what they are. */
export function guessMapping(header: string[]): ImportField[] {
  const used = new Set<ImportField>()
  return header.map((h) => {
    const hit = GUESS.find(([re]) => re.test(h.trim()))?.[1]
    if (!hit || used.has(hit)) return "ignore"
    used.add(hit)
    return hit
  })
}

/** "high", "P1", "2", "urgent" -> a priority value; undefined when it is not one. */
export function parsePriority(v: string): number | undefined {
  const s = v.trim().toLowerCase()
  if (!s) return undefined
  const byName = PRIORITIES.find((p) => p.name.toLowerCase() === s)
  if (byName) return byName.value
  const p = /^p?([0-4])$/.exec(s)
  if (p) return Number(p[1])
  if (s === "none" || s === "no priority") return 0
  if (s === "critical" || s === "blocker") return 1
  if (s === "normal") return 3
  return undefined
}

/** A date in a few common shapes as `YYYY-MM-DD`, or undefined. */
export function parseDate(v: string): string | undefined {
  const s = v.trim()
  if (!s) return undefined
  const iso = /^(\d{4})-(\d{2})-(\d{2})/.exec(s)
  if (iso) return `${iso[1]}-${iso[2]}-${iso[3]}`
  const t = Date.parse(s)
  return Number.isNaN(t) ? undefined : new Date(t).toISOString().slice(0, 10)
}

const splitList = (v: string) =>
  v
    .split(/[,;|]/)
    .map((s) => s.trim())
    .filter(Boolean)

/** Rows of a CSV as issues, by the mapping (one field per column). Rows without a title are skipped. */
export function mapCsv(
  rows: string[][],
  mapping: ImportField[],
  opts: { header: boolean } = { header: true },
) {
  const issues: ImportIssue[] = []
  const skipped: number[] = []
  const body = opts.header ? rows.slice(1) : rows
  body.forEach((r, n) => {
    const it: ImportIssue = { title: "", labels: [] }
    mapping.forEach((f, col) => {
      const v = (r[col] ?? "").trim()
      if (!v) return
      switch (f) {
        case "title":
          it.title = v
          break
        case "description":
          it.description = v
          break
        case "state":
          it.state = v
          break
        case "priority":
          it.priority = parsePriority(v)
          break
        case "assignee":
          it.assignee = v
          break
        case "labels":
          it.labels.push(...splitList(v))
          break
        case "estimate": {
          const e = Number(v)
          if (Number.isFinite(e)) it.estimate = e
          break
        }
        case "due":
          it.due = parseDate(v)
          break
        case "source":
          it.source = v
          break
      }
    })
    if (it.title) issues.push(it)
    else skipped.push(n + (opts.header ? 2 : 1))
  })
  return { issues, skipped }
}

/** GitHub's issue JSON: the REST API (`labels: [{name}]`, `assignee: {login}`) or `gh --json` (camelCase). */
export interface GithubIssue {
  number?: number
  title?: string
  body?: string | null
  state?: string
  labels?: Array<string | { name?: string }>
  assignee?: { login?: string } | null
  assignees?: Array<{ login?: string; name?: string }>
  milestone?: { title?: string; due_on?: string; dueOn?: string } | null
  html_url?: string
  url?: string
  created_at?: string
  createdAt?: string
  state_reason?: string | null
  stateReason?: string | null
  pull_request?: unknown
}

/** GitHub issues as ImportIssues. Pull requests in a REST listing are left out. */
export function mapGithub(data: unknown): { issues: ImportIssue[]; skipped: number } {
  const list = Array.isArray(data)
    ? data
    : data && typeof data === "object" && Array.isArray((data as any).issues)
      ? (data as any).issues
      : null
  if (!list) throw new Error("expected a JSON array of GitHub issues")
  const issues: ImportIssue[] = []
  let skipped = 0
  for (const raw of list as GithubIssue[]) {
    if (!raw || typeof raw !== "object" || raw.pull_request || !raw.title) {
      skipped++
      continue
    }
    const st = (raw.state ?? "open").toLowerCase()
    const reason = (raw.state_reason ?? raw.stateReason ?? "").toLowerCase()
    const category: Category =
      st === "closed" ? (reason === "not_planned" ? "cancelled" : "completed") : "unstarted"
    const labels = (raw.labels ?? [])
      .map((l) => (typeof l === "string" ? l : (l?.name ?? "")))
      .filter(Boolean)
    const assignee = raw.assignee?.login ?? raw.assignees?.[0]?.login
    const due = raw.milestone?.due_on ?? raw.milestone?.dueOn
    const it: ImportIssue = {
      title: raw.title.trim(),
      labels,
      category,
      ...(raw.body ? { description: raw.body } : {}),
      ...(assignee ? { assignee } : {}),
      ...(due ? { due: parseDate(due) } : {}),
      ...(raw.number ? { source: `#${raw.number}` } : {}),
      ...((raw.created_at ?? raw.createdAt) ? { createdAt: raw.created_at ?? raw.createdAt } : {}),
    }
    const pri = labels.map(parsePriority).find((p) => p !== undefined)
    if (pri !== undefined) it.priority = pri
    issues.push(it)
  }
  return { issues, skipped }
}

/** Whether a source id looks like one of our own keys (re-importing an export): kept as the source only. */
export const isOwnKey = (s: string | undefined) => !!s && !!parseIssueKey(s)
