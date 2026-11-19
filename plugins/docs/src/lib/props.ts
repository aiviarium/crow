// Typed page properties. A page's values live in its `props` (property id → value); the definitions come
// from its parent's `schema` (shared by every page under that parent: "a database of pages") and the page's
// own `localSchema`. Relations and people are also copied into the page's `links` (a `refs` field), so the
// reference index has them and the other side shows the page under "linked from".

export type PropType =
  | "text"
  | "number"
  | "select"
  | "multi"
  | "date"
  | "person"
  | "checkbox"
  | "url"
  | "relation"

export const PROP_TYPES: Array<{ type: PropType; label: string; icon: string }> = [
  { type: "text", label: "Text", icon: "edit" },
  { type: "number", label: "Number", icon: "chart" },
  { type: "select", label: "Select", icon: "list" },
  { type: "multi", label: "Multi-select", icon: "tag" },
  { type: "date", label: "Date", icon: "calendar" },
  { type: "person", label: "Person", icon: "user" },
  { type: "checkbox", label: "Checkbox", icon: "check" },
  { type: "url", label: "URL", icon: "link" },
  { type: "relation", label: "Relation", icon: "arrow-up-right" },
]

/** Label hues for options, as Nocturne names them; `neutral` is the plain chip. */
export const HUES = ["neutral", "sky", "teal", "mint", "amber", "ember", "rose", "orchid"] as const
export type Hue = (typeof HUES)[number]

export interface PropOption {
  id: string
  name: string
  hue?: Hue
}

export interface PropDef {
  id: string
  name: string
  type: PropType
  /** `select` and `multi`. */
  options?: PropOption[]
  /** `relation`: only entities of these schemes are offered. */
  schemes?: string[]
}

export type Props = Record<string, unknown>

const DATE = /^\d{4}-\d{2}-\d{2}$/

/** The definitions in a `schema` or `localSchema` value, with anything malformed left out. */
export function defsOf(value: unknown): PropDef[] {
  if (!Array.isArray(value)) return []
  const out: PropDef[] = []
  for (const d of value) {
    if (!d || typeof d !== "object") continue
    const { id, name, type } = d as Record<string, unknown>
    if (typeof id !== "string" || typeof name !== "string") continue
    if (!PROP_TYPES.some((t) => t.type === type)) continue
    const def: PropDef = { id, name, type: type as PropType }
    const opts = (d as { options?: unknown }).options
    if (Array.isArray(opts))
      def.options = opts
        .filter((o) => o && typeof o.id === "string" && typeof o.name === "string")
        .map((o) => ({ id: o.id, name: o.name, ...(HUES.includes(o.hue) ? { hue: o.hue } : {}) }))
    const schemes = (d as { schemes?: unknown }).schemes
    if (Array.isArray(schemes)) def.schemes = schemes.filter((s) => typeof s === "string")
    out.push(def)
  }
  return out
}

/** A short random id for a property or an option. */
export function newId(prefix = "p"): string {
  return `${prefix}${Math.random().toString(36).slice(2, 8)}`
}

/** The value, made to fit the definition; undefined when it cannot (and the property is then unset). */
export function normalize(def: PropDef, v: unknown): unknown {
  if (v === null || v === undefined || v === "") return undefined
  switch (def.type) {
    case "text":
    case "url":
      return typeof v === "string" ? v : String(v)
    case "number": {
      const n = typeof v === "number" ? v : Number(String(v).replace(/,/g, ""))
      return Number.isFinite(n) ? n : undefined
    }
    case "checkbox":
      return v === true || v === "true" || v === "yes" || v === 1
    case "date": {
      const s = String(v)
      if (DATE.test(s)) return s
      const t = Date.parse(s)
      return Number.isNaN(t) ? undefined : new Date(t).toISOString().slice(0, 10)
    }
    case "select": {
      const s = String(Array.isArray(v) ? v[0] : v)
      return def.options?.some((o) => o.id === s) ? s : undefined
    }
    case "multi": {
      const list = (Array.isArray(v) ? v : [v]).map(String)
      const ok = list.filter((s, i) => def.options?.some((o) => o.id === s) && list.indexOf(s) === i)
      return ok.length ? ok : undefined
    }
    case "person": {
      const s = String(Array.isArray(v) ? v[0] : v)
      return s.startsWith("user://") ? s : undefined
    }
    case "relation": {
      const list = (Array.isArray(v) ? v : [v]).map(String).filter((s) => /^[a-z][a-z0-9-]*:\/\/./.test(s))
      const uniq = list.filter((s, i) => list.indexOf(s) === i)
      return uniq.length ? uniq : undefined
    }
  }
}

/** Props with `patch` applied, every value normalised against its definition. */
export function setProps(defs: readonly PropDef[], props: Props | null | undefined, patch: Props): Props {
  const out: Props = { ...(props ?? {}) }
  for (const [id, v] of Object.entries(patch)) {
    const def = defs.find((d) => d.id === id)
    const n = def ? normalize(def, v) : v
    if (n === undefined) delete out[id]
    else out[id] = n
  }
  return out
}

/** The entity URIs the props point at (relations and people), for the page's `links` field. */
export function linksOf(defs: readonly PropDef[], props: Props | null | undefined): string[] {
  const out: string[] = []
  for (const d of defs) {
    const v = props?.[d.id]
    if (d.type === "relation" && Array.isArray(v)) out.push(...v.map(String))
    if (d.type === "person" && typeof v === "string") out.push(v)
  }
  return out.filter((u, i) => out.indexOf(u) === i)
}

/** The value as text, for tables, search and export. `names` resolves entity URIs to titles. */
export function display(def: PropDef, v: unknown, names?: (uri: string) => string | undefined): string {
  if (v === undefined || v === null) return ""
  const opt = (id: unknown) => def.options?.find((o) => o.id === id)?.name ?? String(id)
  switch (def.type) {
    case "checkbox":
      return v ? "Yes" : "No"
    case "number":
      return typeof v === "number" ? v.toLocaleString("en-US") : String(v)
    case "select":
      return opt(v)
    case "multi":
      return (Array.isArray(v) ? v : [v]).map(opt).join(", ")
    case "date":
      return formatDate(String(v))
    case "person":
    case "relation":
      return (Array.isArray(v) ? v : [v]).map((u) => names?.(String(u)) ?? String(u)).join(", ")
    default:
      return String(v)
  }
}

/** "Dec 4, 2026" from "2026-12-04". */
export function formatDate(s: string): string {
  if (!DATE.test(s)) return s
  const [y, m, d] = s.split("-").map(Number) as [number, number, number]
  const months = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"]
  return `${months[m - 1]} ${d}, ${y}`
}

/** Orders two values of a property: empty last, then by kind. */
export function compare(def: PropDef, a: unknown, b: unknown): number {
  const ea = a === undefined || a === null || a === ""
  const eb = b === undefined || b === null || b === ""
  if (ea || eb) return ea === eb ? 0 : ea ? 1 : -1
  switch (def.type) {
    case "number":
      return Number(a) - Number(b)
    case "checkbox":
      return a === b ? 0 : a ? -1 : 1
    case "select": {
      const ia = def.options?.findIndex((o) => o.id === a) ?? -1
      const ib = def.options?.findIndex((o) => o.id === b) ?? -1
      return ia - ib
    }
    default: {
      const sa = display(def, a)
      const sb = display(def, b)
      return def.type === "date"
        ? String(a) < String(b)
          ? -1
          : String(a) > String(b)
            ? 1
            : 0
        : sa.localeCompare(sb)
    }
  }
}

// ── Front matter ────────────────────────────────────────────────────────────────────────────────────

/** Props as front matter values, keyed by property name. Options by name, people and relations as URIs. */
export function toFrontMatter(
  defs: readonly PropDef[],
  props: Props | null | undefined,
): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const d of defs) {
    const v = props?.[d.id]
    if (v === undefined || v === null) continue
    const opt = (id: unknown) => d.options?.find((o) => o.id === id)?.name ?? String(id)
    if (d.type === "select") out[d.name] = opt(v)
    else if (d.type === "multi") out[d.name] = (Array.isArray(v) ? v : [v]).map(opt)
    else out[d.name] = v
  }
  return out
}

const URL_RE = /^https?:\/\/\S+$/
const URI_RE = /^[a-z][a-z0-9-]*:\/\/\S+$/

/** The type a front matter value suggests. */
export function inferType(values: unknown[]): PropType {
  const vs = values.filter((v) => v !== null && v !== undefined && v !== "")
  if (!vs.length) return "text"
  if (vs.every((v) => typeof v === "boolean")) return "checkbox"
  if (vs.every((v) => typeof v === "number")) return "number"
  if (vs.every((v) => typeof v === "string" && DATE.test(v))) return "date"
  if (vs.every((v) => typeof v === "string" && URL_RE.test(v))) return "url"
  if (vs.every((v) => typeof v === "string" && v.startsWith("user://"))) return "person"
  if (vs.every((v) => (Array.isArray(v) ? v : [v]).every((x) => typeof x === "string" && URI_RE.test(x))))
    return "relation"
  if (vs.some((v) => Array.isArray(v))) return "multi"
  const distinct = new Set(vs.map(String))
  if (vs.every((v) => typeof v === "string" && v.length <= 40) && distinct.size <= Math.max(1, vs.length / 2))
    return "select"
  return "text"
}

/**
 * Definitions for front matter values of several pages: existing definitions are reused by name, new names
 * get a definition whose type fits every page's value, and select options are added as values need them.
 */
export function defsFromFrontMatter(
  existing: readonly PropDef[],
  all: Array<Record<string, unknown>>,
): PropDef[] {
  const defs: PropDef[] = existing.map((d) => ({ ...d, ...(d.options ? { options: [...d.options] } : {}) }))
  const names = new Set<string>()
  for (const fm of all) for (const k of Object.keys(fm)) names.add(k)
  for (const name of names) {
    if (RESERVED_KEYS.has(name.toLowerCase())) continue
    const values = all.map((fm) => fm[name]).filter((v) => v !== undefined)
    let def: PropDef | undefined = defs.find((d) => d.name.toLowerCase() === name.toLowerCase())
    if (!def) {
      def = { id: newId(), name, type: inferType(values) }
      defs.push(def)
    }
    const d = def
    if (d.type === "select" || d.type === "multi") {
      d.options ??= []
      const options = d.options
      for (const v of values.flatMap((v) => (Array.isArray(v) ? v : [v]))) {
        const s = String(v)
        if (!options.some((o) => o.name === s))
          options.push({ id: newId("o"), name: s, hue: HUES[(options.length % (HUES.length - 1)) + 1]! })
      }
    }
  }
  return defs
}

/** Front matter keys that are about the page, not properties. */
export const RESERVED_KEYS = new Set(["title", "icon", "cover", "tags_", "aliases", "id", "crow"])

/** Front matter (by name) as props (by id) for `defs`. */
export function propsFromFrontMatter(defs: readonly PropDef[], fm: Record<string, unknown>): Props {
  const out: Props = {}
  for (const [name, raw] of Object.entries(fm)) {
    const def = defs.find((d) => d.name.toLowerCase() === name.toLowerCase())
    if (!def) continue
    let v = raw
    if (def.type === "select") v = def.options?.find((o) => o.name === String(raw))?.id
    if (def.type === "multi")
      v = (Array.isArray(raw) ? raw : [raw]).map((x) => def.options?.find((o) => o.name === String(x))?.id)
    const n = normalize(def, v)
    if (n !== undefined) out[def.id] = n
  }
  return out
}
