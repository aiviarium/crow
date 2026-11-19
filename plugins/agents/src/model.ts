// Helpers for the Agents views on Parrot's protocol: grouping sessions by day, assembling turns
// from Parrot items and requests, tool step labels/icons/statuses, and state wording.
import type { DotStatus, IconName, StepStatus } from "@aiviarium/nocturne"
import type { ParrotItem, Request, SessionSummary, State } from "./parrot"

export function needsYou(s: Pick<SessionSummary, "state">): boolean {
  return s.state === "requires_action"
}

export function busy(state: State): boolean {
  return state === "running" || state === "requires_action" || state === "starting"
}

export function stateDot(s: Pick<SessionSummary, "state">): DotStatus | null {
  if (needsYou(s)) return "warn"
  if (s.state === "running" || s.state === "starting") return "ai"
  if (s.state === "lost") return "error"
  return null
}

export const STATE_WORD: Record<State, string> = {
  starting: "Starting",
  idle: "Ready",
  running: "Working",
  requires_action: "Needs your action",
  stopped: "Stopped",
  lost: "Lost",
  unrecognised: "Screen not recognised",
  unknown: "Unknown",
}

export function relative(iso: string, now = Date.now()): string {
  const t = Date.parse(iso)
  if (!Number.isFinite(t)) return ""
  const s = Math.max(0, Math.round((now - t) / 1000))
  if (s < 60) return "now"
  if (s < 3600) return `${Math.floor(s / 60)}m`
  if (s < 86400) return `${Math.floor(s / 3600)}h`
  const d = new Date(t)
  return d.toLocaleDateString(undefined, { month: "short", day: "numeric" })
}

/** Sessions by day of their last activity: Today, Yesterday, Previous 7 days, then by month. */
export function byDay(
  sessions: readonly SessionSummary[],
  now = new Date(),
): Array<{ title: string; items: SessionSummary[] }> {
  const start = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime()
  const day = 86400_000
  const groups = new Map<string, SessionSummary[]>()
  const sorted = [...sessions].sort((a, b) => Date.parse(b.updated) - Date.parse(a.updated))
  for (const s of sorted) {
    const t = Date.parse(s.updated)
    const title =
      t >= start
        ? "Today"
        : t >= start - day
          ? "Yesterday"
          : t >= start - 7 * day
            ? "Previous 7 days"
            : new Date(t).toLocaleDateString(undefined, { month: "long", year: "numeric" })
    if (!groups.has(title)) groups.set(title, [])
    groups.get(title)!.push(s)
  }
  return [...groups].map(([title, items]) => ({ title, items }))
}

/** Tools whose call the chat shows as another item (a question, a plan) or not at all. */
const HIDDEN_TOOLS = new Set(["AskUserQuestion", "ExitPlanMode", "TodoWrite"])

export type StepItem = Extract<ParrotItem, { kind: "tool" | "command" | "web" | "script" }>

export type TurnPart =
  | { kind: "tools"; items: StepItem[] }
  | { kind: "item"; item: ParrotItem }
  | { kind: "request"; request: Request }

export interface TurnView {
  turn: string
  user: Array<Extract<ParrotItem, { kind: "user" }>>
  /** The assistant's part, in order; consecutive tool/command/web/script steps are grouped. */
  parts: TurnPart[]
}

function isStepItem(it: ParrotItem): it is StepItem {
  return it.kind === "tool" || it.kind === "command" || it.kind === "web" || it.kind === "script"
}

/**
 * Groups Parrot items and requests into conversation turns.
 *
 * Requests linked to a turn (`request.turn`) are placed in that turn; unlinked requests attach to
 * the last turn (or create a trailing turn if the conversation has no items yet).
 */
export function turns(items: readonly ParrotItem[], requests: readonly Request[] = []): TurnView[] {
  const out: TurnView[] = []
  let cur: TurnView | null = null
  let autoTurn = 0

  for (const it of items) {
    const key = it.turn ?? (cur ? cur.turn : `turn-${++autoTurn}`)
    if (!cur || cur.turn !== key || (it.kind === "user" && cur.parts.length > 0)) {
      const nextKey = it.turn ?? `turn-${++autoTurn}`
      cur = { turn: nextKey, user: [], parts: [] }
      out.push(cur)
    }

    if (it.kind === "user") {
      cur.user.push(it)
      continue
    }

    if (isStepItem(it)) {
      if (it.kind === "tool" && (HIDDEN_TOOLS.has(it.tool) || it.parent)) continue
      if (it.parent) continue
      const last = cur.parts[cur.parts.length - 1]
      if (last?.kind === "tools") last.items.push(it)
      else cur.parts.push({ kind: "tools", items: [it] })
      continue
    }

    if (it.kind === "assistant" && !it.text?.trim() && !it.streaming) continue
    cur.parts.push({ kind: "item", item: it })
  }

  for (const req of requests) {
    let target = req.turn ? out.find((t) => t.turn === req.turn) : undefined
    if (!target) target = out[out.length - 1]
    if (!target) {
      target = { turn: req.turn ?? "turn-requests", user: [], parts: [] }
      out.push(target)
    }
    target.parts.push({ kind: "request", request: req })
  }

  return out
}

export function toolIcon(name: string): IconName {
  if (name === "Bash" || name === "shell" || name === "command") return "terminal"
  if (name === "Read" || name === "NotebookRead") return "file"
  if (name === "Edit" || name === "Write" || name === "MultiEdit" || name === "NotebookEdit") return "edit"
  if (name === "Grep" || name === "Glob" || name === "WebSearch") return "search"
  if (name === "WebFetch") return "link"
  if (name === "Task" || name === "Agent") return "agent"
  if (name.startsWith("mcp__")) return "bolt"
  return "command"
}

export function toolVerb(name: string, running: boolean): string {
  const v: Record<string, [string, string]> = {
    Bash: ["Running", "Ran"],
    Read: ["Reading", "Read"],
    Edit: ["Editing", "Edited"],
    MultiEdit: ["Editing", "Edited"],
    Write: ["Writing", "Wrote"],
    Grep: ["Searching", "Searched"],
    Glob: ["Finding", "Found"],
    WebFetch: ["Fetching", "Fetched"],
    WebSearch: ["Searching", "Searched"],
    Task: ["Delegating", "Delegated"],
    Agent: ["Delegating", "Delegated"],
  }
  if (v[name]) return v[name]![running ? 0 : 1]
  if (name.startsWith("mcp__")) return running ? "Calling" : "Called"
  return name
}

export function stepIcon(it: StepItem): IconName {
  switch (it.kind) {
    case "command":
      return "terminal"
    case "web":
      return it.url ? "link" : "search"
    case "script":
      return "command"
    case "tool":
      return toolIcon(it.tool)
  }
}

export function stepVerb(it: StepItem, running: boolean): string {
  switch (it.kind) {
    case "command":
      return running ? "Running" : "Ran"
    case "web":
      return it.url ? (running ? "Fetching" : "Fetched") : running ? "Searching" : "Searched"
    case "script":
      return running ? `Running ${it.language}` : `Ran ${it.language}`
    case "tool":
      return toolVerb(it.tool, running)
  }
}

/** A tool/command/web/script step's status: a step left running when its turn is over did not finish. */
export function stepStatus(it: StepItem, turnOver: boolean): StepStatus {
  if (it.status === "error") return "error"
  if (it.status === "ok") return "ok"
  if (it.status === "cancelled") return "pending"
  if (it.kind === "tool" && (it.status === "pending" || it.status === "paused")) return "pending"
  return turnOver ? "pending" : "running"
}

/** A step's argument; a path inside the session's folder is shown relative to it. */
export function stepArg(it: StepItem, cwd?: string): string {
  switch (it.kind) {
    case "command":
      return relativeTo(it.command, cwd)
    case "web":
      return it.query || it.url || ""
    case "script":
      return it.code ? (it.code.split("\n")[0] ?? "") : it.language
    case "tool": {
      if (it.title) return relativeTo(it.title, cwd)
      if (it.tool.startsWith("mcp__")) return it.tool.split("__").slice(1).join(" · ")
      if (it.server) return `${it.server} · ${it.tool}`
      return ""
    }
  }
}

export function stepOutput(it: StepItem): string | undefined {
  switch (it.kind) {
    case "command":
      return it.output || undefined
    case "tool":
      if (typeof it.output === "string" && it.output) return it.output
      if (it.output !== undefined && it.output !== null) return JSON.stringify(it.output, null, 2)
      return undefined
    case "script":
      if (typeof it.result === "string" && it.result) return it.result
      if (it.error) return typeof it.error === "string" ? it.error : JSON.stringify(it.error, null, 2)
      if (it.result !== undefined && it.result !== null) return JSON.stringify(it.result, null, 2)
      return undefined
    case "web":
      if (typeof it.results === "string" && it.results) return it.results
      if (it.results !== undefined && it.results !== null) return JSON.stringify(it.results, null, 2)
      return undefined
  }
}

export function countDiffLines(diff: string | null | undefined): { additions: number; deletions: number } {
  if (!diff) return { additions: 0, deletions: 0 }
  let additions = 0
  let deletions = 0
  for (const line of diff.split("\n")) {
    if (line.startsWith("+") && !line.startsWith("+++")) additions++
    else if (line.startsWith("-") && !line.startsWith("---")) deletions++
  }
  return { additions, deletions }
}

const KEY = String.raw`(?:esc|enter|return|tab|space|ctrl[+-]\w|shift[+-]\w|alt[+-]\w|[↑↓←→]+(?:\s*/\s*[↑↓←→]+)?)`
/** A line that is a key hint, or what is left of one when the CLI wrapped it: "Esc to cancel", "to cancel", "↓ More models". */
const HINT = new RegExp(
  String.raw`^(?:[·•|]\s*)?(?:(?:press\s+)?${KEY}\b.*\bto\b.*|to\s+\w+(?:\s+\w+)?|(?:[↑↓]\s*)?more\s+\w+(?:\s*[↑↓…])?)$`,
  "i",
)

/** A surface's text for the card: no repeated title, no key hints. */
export function surfaceText(s: { title?: string; text: string; hints?: string[] }): string {
  const hints = s.hints?.length ? s.hints.join(" ").toLowerCase() : undefined
  const lines = s.text.trim().split("\n")
  if (s.title && lines[0]?.trim() === s.title) lines.shift()
  return lines
    .filter((l) => {
      const t = l.trim()
      if (!t) return true
      return !HINT.test(t) && !hints?.includes(t.toLowerCase())
    })
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim()
}

/** `text` with every occurrence of the folder `cwd` (and the slash after it) left out. */
export function relativeTo(text: string, cwd?: string): string {
  if (!cwd || cwd === "/") return text
  const dir = cwd.endsWith("/") ? cwd : `${cwd}/`
  return text.split(dir).join("")
}
