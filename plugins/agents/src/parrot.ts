// Discriminated Parrot item types, `ItemPatch` application (matching `parrot-proto/src/patch.rs`),
// and helpers for Parrot `ConfigOption` schemas and `Request` payloads.
//
// `@aiviarium/parrot-client`'s generated `ItemBody` carries the wire's `kind` discriminant, so
// `ParrotItem` is the body plus the streaming flags' update patches add; a `notice` is the one kind
// the client makes up, for what a session says outside an item.
import type {
  Choice,
  ConfigOption,
  ItemBody,
  ItemPatch,
  NoticeLevel,
  OptionRole,
  Question,
  Request,
  Subject,
} from "@aiviarium/parrot-client"

export type {
  Action,
  Agent,
  Answer,
  Background,
  Choice,
  CommandItem,
  CompactionItem,
  ConfigOption,
  Control,
  Environment,
  ErrorItem,
  FileChange,
  FileChangeItem,
  HandoffItem,
  HookItem,
  ItemBody,
  ItemCommon,
  ItemKind,
  ItemPatch,
  NoticeLevel,
  OptionRole,
  Origin,
  PlanEntry,
  PlanItem,
  Question,
  QueueState,
  ReasoningItem,
  Request,
  ReviewItem,
  RunStatus,
  ScriptItem,
  Session,
  SessionSnapshot,
  SessionSummary,
  State,
  SubagentItem,
  Subject,
  TextItem,
  ToolItem,
  ToolStatus,
  Turn,
  Update,
  Usage,
  UserItem,
  WebItem,
  Workspace,
} from "@aiviarium/parrot-client"

export interface StreamFlags {
  streaming?: boolean
  removed?: boolean
}

export interface NoticeItem {
  id: string
  kind: "notice"
  turn?: string | null
  level: NoticeLevel
  text: string
  code?: string | null
  streaming?: false
}

export type ParrotItem = (ItemBody & StreamFlags) | NoticeItem

const HEADER_FIELDS = ["turn", "binding", "parent", "source", "ref", "origin"] as const

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v)
}

/**
 * Normalizes a raw item body from a `SessionSnapshot` or `session/read` result into a `ParrotItem`.
 * Returns `null` if the object lacks an `id`.
 */
export function normalizeItem(raw: ItemBody): ParrotItem | null {
  if (!raw?.id) return null
  return raw
}

/**
 * Applies a Parrot `ItemPatch` to an immutable list of `ParrotItem`s, following the exact rules
 * of `parrot-proto/src/patch.rs`:
 * - `removed: true` deletes the item from the list.
 * - Header fields (`turn`, `binding`, `parent`, `source`, `ref`, `origin`) are copied when present.
 * - `set` replaces fields (`null` deletes a field; `_meta` merges object keys).
 * - `append` concatenates strings onto existing string fields after `set`.
 * - `streaming` updates the streaming flag when provided.
 */
export function applyItemPatch(items: readonly ParrotItem[], patch: ItemPatch): ParrotItem[] {
  const index = items.findIndex((it) => it.id === patch.id)

  if (patch.removed) {
    if (index === -1) return [...items]
    return [...items.slice(0, index), ...items.slice(index + 1)]
  }

  let target: Record<string, unknown>
  if (index >= 0) {
    target = { ...(items[index] as unknown as Record<string, unknown>) }
  } else {
    if (!patch.kind) return [...items]
    target = { id: patch.id, kind: patch.kind }
  }

  for (const field of HEADER_FIELDS) {
    const val = patch[field]
    if (val !== undefined && val !== null) {
      target[field] = val
    }
  }

  if (isRecord(patch.set)) {
    for (const [key, value] of Object.entries(patch.set)) {
      if (value === null) {
        delete target[key]
      } else if (key === "_meta" && isRecord(value) && isRecord(target._meta)) {
        target._meta = { ...target._meta, ...value }
      } else {
        target[key] = value
      }
    }
  }

  if (isRecord(patch.append)) {
    for (const [key, delta] of Object.entries(patch.append)) {
      if (typeof delta !== "string") continue
      const existing = target[key]
      target[key] = typeof existing === "string" ? existing + delta : delta
    }
  }

  if (isRecord(patch._meta)) {
    target._meta = isRecord(target._meta) ? { ...target._meta, ...patch._meta } : { ...patch._meta }
  }

  if (patch.streaming !== undefined && patch.streaming !== null) {
    target.streaming = patch.streaming
  }

  const next = target as unknown as ParrotItem
  if (index >= 0) {
    return [...items.slice(0, index), next, ...items.slice(index + 1)]
  }
  return [...items, next]
}

export interface OptionChoice {
  id: string
  label: string
  description?: string
}

/**
 * Extracts selectable choices from a Parrot `ConfigOption`'s JSON Schema (`oneOf`, `anyOf`, or
 * `enum`). Respects `dependsOn` overrides when `allOptions` is provided.
 */
export function extractOptionChoices(
  opt: ConfigOption | undefined,
  allOptions?: readonly ConfigOption[],
): OptionChoice[] {
  if (!opt) return []
  let schema: unknown = opt.schema
  if (opt.dependsOn && allOptions) {
    const dep = allOptions.find((o) => o.id === opt.dependsOn?.option)
    const depVal = dep?.value != null ? String(dep.value) : undefined
    if (depVal && opt.dependsOn.schemas[depVal]) {
      schema = opt.dependsOn.schemas[depVal]
    } else if (opt.dependsOn.schemas["*"]) {
      schema = opt.dependsOn.schemas["*"]
    }
  }
  if (!isRecord(schema)) return []

  const variants = Array.isArray(schema.oneOf)
    ? schema.oneOf
    : Array.isArray(schema.anyOf)
      ? schema.anyOf
      : null
  if (variants) {
    const out: OptionChoice[] = []
    for (const v of variants) {
      if (!isRecord(v) || v.const === undefined || v.const === null) continue
      const id = String(v.const)
      out.push({
        id,
        label: typeof v.title === "string" && v.title ? v.title : id,
        description: typeof v.description === "string" ? v.description : undefined,
      })
    }
    if (out.length) return out
  }

  if (Array.isArray(schema.enum)) {
    return schema.enum
      .filter((v) => v !== undefined && v !== null)
      .map((v) => {
        const id = String(v)
        return { id, label: id }
      })
  }

  return []
}

export function findOptionByRole(
  options: readonly ConfigOption[],
  role: OptionRole,
): ConfigOption | undefined {
  return options.find((o) => o.role === role || o.id === role)
}

export function optionStringValue(opt: ConfigOption | undefined): string | undefined {
  if (!opt || opt.value === undefined || opt.value === null) return undefined
  return String(opt.value)
}

/**
 * Turns a Parrot approval `Request.subject` into concise lines suitable for `ApprovalCard`'s
 * `items` list.
 */
export function subjectLines(subject: Subject | null | undefined, cwd?: string): string[] {
  if (!subject) return []
  const rel = (text: string) => {
    if (!cwd || cwd === "/") return text
    const prefix = cwd.endsWith("/") ? cwd : `${cwd}/`
    return text.split(prefix).join("")
  }
  switch (subject.type) {
    case "command":
      return [subject.command, ...(subject.cwd && subject.cwd !== cwd ? [`in ${rel(subject.cwd)}`] : [])]
    case "files":
      return subject.paths.map((p) => rel(p))
    case "network":
      return [subject.host]
    case "tool": {
      if (isRecord(subject.input)) {
        const summary = Object.entries(subject.input)
          .slice(0, 4)
          .map(([k, v]) => `${k}: ${typeof v === "string" ? rel(v) : JSON.stringify(v)}`)
        return summary.length ? summary : [subject.tool]
      }
      return [subject.tool]
    }
    case "function":
      return [subject.function]
    case "plan":
      return []
  }
}

export interface StructuredQuestion {
  id: string
  header?: string
  question: string
  multiSelect?: boolean
  options: Array<{ id: string; label: string; description?: string }>
}

/**
 * Extracts structured questions from a Parrot `Request` (`kind: "question"`). Supports:
 * 1. `request.choices` (standard Parrot choice list)
 * 2. `request.input` carrying `{ questions: [...] }` (multi-question harnesses like Claude Code)
 * 3. Fallback single free-text question using `request.title` / `request.description`.
 */
export function extractQuestions(req: Request): StructuredQuestion[] {
  const asked = req.questions ?? []
  if (asked.length > 0) {
    return asked.map((q: Question) => ({
      id: q.id,
      header: q.header ?? undefined,
      question: q.question,
      multiSelect: q.multiSelect ?? false,
      options: (q.options ?? []).map((c) => ({
        id: c.id,
        label: c.label,
        description: c.description ?? undefined,
      })),
    }))
  }

  const options = (req.choices ?? []).map((c) => ({
    id: c.id,
    label: c.label,
    description: c.description ?? undefined,
  }))
  return [
    {
      id: req.id,
      header: undefined,
      question: req.title || req.description || "Question",
      multiSelect: false,
      options,
    },
  ]
}

export function formatAnswer(req: Request): string {
  const ans = req.answer
  if (!ans) return "—"
  if (isRecord(ans.answers)) {
    const vals = Object.values(ans.answers)
      .flatMap((v) => (Array.isArray(v) ? v : [v]))
      .filter((v) => v != null && String(v).trim() !== "")
      .map((v) => String(v))
    if (vals.length) return vals.join(" · ")
  }
  if (ans.choice) {
    const match = req.choices?.find((c) => c.id === ans.choice)
    return match?.label ?? ans.choice
  }
  if (typeof ans.message === "string" && ans.message) return ans.message
  if (typeof ans.value === "string" && ans.value) return ans.value
  if (isRecord(ans.value)) {
    const vals = Object.values(ans.value)
      .filter((v) => v != null && String(v).trim() !== "")
      .map((v) => String(v))
    if (vals.length) return vals.join(" · ")
  }
  if (typeof ans.input === "string" && ans.input) return ans.input
  if (ans.value !== undefined && ans.value !== null) return JSON.stringify(ans.value)
  return "Answered"
}

export function pickApprovalChoices(choices: readonly Choice[] | null | undefined): {
  allow?: Choice
  allowSession?: Choice
  deny?: Choice
  others: Choice[]
} {
  const list = choices ?? []
  const allow =
    list.find((c) => c.intent === "allow" && c.scope !== "session" && c.scope !== "always") ??
    list.find((c) => c.intent === "allow")
  const allowSession = list.find(
    (c) => c.intent === "allow" && (c.scope === "session" || c.scope === "always") && c.id !== allow?.id,
  )
  const deny = list.find((c) => c.intent === "deny")
  const used = new Set([allow?.id, allowSession?.id, deny?.id].filter(Boolean))
  const others = list.filter((c) => !used.has(c.id))
  return { allow, allowSession, deny, others }
}
