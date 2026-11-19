// Inline databases: a view of rows (the pages under a parent with their shared properties, or any plugin's
// collection that marks itself showable) as a table, a board or a list, with filters, sorts, grouping and
// visible fields. The view is saved in the block's attributes. Rows of a collection are queried with the data
// layer's own `where` as far as the filters allow (so the store does the work and its access rules apply);
// what `where` cannot say (text contains, page properties in JSON) is applied here, on the rows that came.
import type { CollectionContribution, CollectionDisplay, FieldContribution } from "@rookery/sdk/client"
import { compare, display, HUES, type Hue, type PropDef, type PropOption, type PropType } from "./props"

export type Layout = "table" | "board" | "list"

export type FilterOp =
  | "is"
  | "isNot"
  | "contains"
  | "empty"
  | "notEmpty"
  | "gt"
  | "lt"
  | "checked"
  | "unchecked"

export interface Filter {
  field: string
  op: FilterOp
  value?: unknown
}

export interface Sort {
  field: string
  dir: "asc" | "desc"
}

export interface ViewConfig {
  layout: Layout
  /** The column a board groups by (and a table or list, when set). */
  groupBy?: string | null
  sorts: Sort[]
  filters: Filter[]
  /** Visible columns in order; empty means the source's default. */
  fields: string[]
}

export type Source =
  | { kind: "pages"; parent: string; space?: string }
  | { kind: "collection"; plugin: string; collection: string; space?: string }

export interface DatabaseAttrs {
  source: Source | null
  view: ViewConfig
  title?: string
}

export const DEFAULT_VIEW: ViewConfig = { layout: "table", groupBy: null, sorts: [], filters: [], fields: [] }

/** The attributes of a block, with everything missing filled in. */
export function attrsOf(raw: Record<string, unknown> | undefined): DatabaseAttrs {
  const src = raw?.source as Source | null | undefined
  const v = (raw?.view ?? {}) as Partial<ViewConfig>
  return {
    source:
      src && (src.kind === "pages" ? typeof src.parent === "string" : typeof src.plugin === "string")
        ? src
        : null,
    view: {
      layout: v.layout === "board" || v.layout === "list" ? v.layout : "table",
      groupBy: typeof v.groupBy === "string" ? v.groupBy : null,
      sorts: Array.isArray(v.sorts) ? v.sorts.filter((s) => s && typeof s.field === "string") : [],
      filters: Array.isArray(v.filters) ? v.filters.filter((f) => f && typeof f.field === "string") : [],
      fields: Array.isArray(v.fields) ? v.fields.filter((f) => typeof f === "string") : [],
    },
    ...(typeof raw?.title === "string" ? { title: raw.title } : {}),
  }
}

/** A database shown as a table or a board needs the room: the block is forced wide. A list, or a block that has
 * no source yet, is as wide as the person chose. */
export function databaseIsWide(raw: Record<string, unknown> | undefined): boolean {
  const a = attrsOf(raw)
  return a.source !== null && a.view.layout !== "list"
}

/** One column of a view, whatever the source. */
export interface Column {
  id: string
  name: string
  type: PropType | "title"
  options?: PropOption[]
  /** The value of a row. */
  get(row: Record<string, unknown>): unknown
  /** A real field of a collection that `where` can filter on (and how), or none for computed columns. */
  field?: { name: string; kind: FieldContribution["type"] }
  /** Shown as a column by default. */
  shown?: boolean
}

export type Row = Record<string, unknown> & { id: string }

/** Columns for pages: the title, then the parent's properties. */
export function pageColumns(defs: readonly PropDef[]): Column[] {
  return [
    {
      id: "title",
      name: "Name",
      type: "title",
      get: (r) => r.title,
      field: { name: "title", kind: "text" },
      shown: true,
    },
    ...defs.map(
      (d): Column => ({
        id: d.id,
        name: d.name,
        type: d.type,
        ...(d.options ? { options: d.options } : {}),
        get: (r) => (r.props as Record<string, unknown> | null | undefined)?.[d.id],
        shown: true,
      }),
    ),
  ]
}

function typeOfField(f: FieldContribution): PropType | null {
  switch (f.type) {
    case "text":
    case "longtext":
    case "path":
      return "text"
    case "integer":
    case "number":
    case "sequence":
      return "number"
    case "boolean":
      return "checkbox"
    case "date":
    case "datetime":
      return "date"
    case "enum":
      return "select"
    case "ref":
      return f.to === "user" ? "person" : "relation"
    case "refs":
      return "relation"
    default:
      return null
  }
}

const label = (name: string) => name.replace(/([a-z])([A-Z])/g, "$1 $2").replace(/^./, (c) => c.toUpperCase())

/** Columns for a showable collection: its primary field first, then the fields `display` offers. */
export function collectionColumns(def: CollectionContribution, shown: CollectionDisplay): Column[] {
  const primary = shown.primary ?? def.entity?.title ?? def.fields[0]?.name
  const offered = shown.fields?.length
    ? shown.fields
    : def.fields.filter((f) => f.type !== "json" && f.type !== "richtext").map((f) => f.name)
  const names = [primary, ...offered.filter((n) => n !== primary)].filter((n): n is string => !!n)
  const out: Column[] = []
  for (const name of names) {
    const f = def.fields.find((x) => x.name === name)
    if (!f) continue
    const type = name === primary ? "title" : typeOfField(f)
    if (!type) continue
    const options =
      f.type === "enum"
        ? (f.values ?? []).map((v, i) => {
            const val = typeof v === "string" ? v : v.value
            const title = typeof v === "string" ? undefined : v.title
            return {
              id: val,
              name: title ?? label(val),
              hue: HUES[(i % (HUES.length - 1)) + 1] as Hue,
            }
          })
        : undefined
    out.push({
      id: name,
      name: f.title ?? f.label ?? label(name),
      type,
      ...(options ? { options } : {}),
      get: (r) => {
        const v = r[name]
        if (f.type === "datetime" && typeof v === "string") return v.slice(0, 10)
        if (f.type === "ref" && typeof v === "string") return type === "person" ? v : [v]
        return v
      },
      field: { name, kind: f.type },
      shown: true,
    })
  }
  out.push(
    {
      id: "updatedAt",
      name: "Updated",
      type: "date",
      get: (r) => String(r.updatedAt ?? "").slice(0, 10),
      field: { name: "updatedAt", kind: "datetime" },
    },
    {
      id: "createdAt",
      name: "Created",
      type: "date",
      get: (r) => String(r.createdAt ?? "").slice(0, 10),
      field: { name: "createdAt", kind: "datetime" },
    },
  )
  return out
}

/** The visible columns of a view, in order (the title always first). */
export function visibleColumns(cols: readonly Column[], view: ViewConfig): Column[] {
  const title = cols.find((c) => c.type === "title")
  const rest = view.fields.length
    ? view.fields
        .map((id) => cols.find((c) => c.id === id))
        .filter((c): c is Column => !!c && c.type !== "title")
    : cols.filter((c) => c.shown && c.type !== "title")
  return title ? [title, ...rest] : rest
}

const asDef = (c: Column): PropDef => ({
  id: c.id,
  name: c.name,
  type: c.type === "title" ? "text" : c.type,
  ...(c.options ? { options: c.options } : {}),
})

const empty = (v: unknown) =>
  v === undefined || v === null || v === "" || (Array.isArray(v) && v.length === 0)

/** The operators that make sense for a column. */
export function opsFor(c: Column): FilterOp[] {
  switch (c.type) {
    case "checkbox":
      return ["checked", "unchecked"]
    case "number":
    case "date":
      return ["is", "isNot", "gt", "lt", "empty", "notEmpty"]
    case "select":
    case "person":
      return ["is", "isNot", "empty", "notEmpty"]
    case "multi":
    case "relation":
      return ["contains", "empty", "notEmpty"]
    default:
      return ["contains", "is", "isNot", "empty", "notEmpty"]
  }
}

export const OP_LABEL: Record<FilterOp, string> = {
  is: "is",
  isNot: "is not",
  contains: "contains",
  empty: "is empty",
  notEmpty: "is not empty",
  gt: "is after / above",
  lt: "is before / below",
  checked: "is checked",
  unchecked: "is not checked",
}

/** Whether a row passes one filter. */
export function passes(f: Filter, c: Column, row: Row): boolean {
  const v = c.get(row)
  switch (f.op) {
    case "empty":
      return empty(v)
    case "notEmpty":
      return !empty(v)
    case "checked":
      return v === true
    case "unchecked":
      return v !== true
    case "contains": {
      if (Array.isArray(v)) return v.map(String).includes(String(f.value ?? ""))
      return String(v ?? "")
        .toLowerCase()
        .includes(String(f.value ?? "").toLowerCase())
    }
    case "is":
      if (Array.isArray(v)) return v.map(String).includes(String(f.value))
      return c.type === "number" ? Number(v) === Number(f.value) : String(v ?? "") === String(f.value ?? "")
    case "isNot":
      if (Array.isArray(v)) return !v.map(String).includes(String(f.value))
      return c.type === "number" ? Number(v) !== Number(f.value) : String(v ?? "") !== String(f.value ?? "")
    case "gt":
      return !empty(v) && compare(asDef(c), v, f.value) > 0
    case "lt":
      return !empty(v) && compare(asDef(c), v, f.value) < 0
  }
}

/**
 * The part of the filters the data layer can do itself, as a `where`, and the filters left for `passes`.
 * Only real fields with plain comparisons go to the store.
 */
export function toWhere(
  filters: readonly Filter[],
  cols: readonly Column[],
): { where: Record<string, unknown>; rest: Filter[] } {
  const and: Record<string, unknown>[] = []
  const rest: Filter[] = []
  for (const f of filters) {
    const c = cols.find((x) => x.id === f.field)
    const field = c?.field
    if (!c || !field) {
      rest.push(f)
      continue
    }
    const k = field.kind
    const scalar = k !== "refs" && k !== "json" && k !== "richtext"
    let cond: unknown
    if (f.op === "empty" && scalar) cond = null
    else if (f.op === "notEmpty" && scalar) cond = { ne: null }
    else if (f.op === "checked" && k === "boolean") cond = true
    else if (f.op === "unchecked" && k === "boolean") cond = { ne: true }
    else if (
      (f.op === "is" || f.op === "isNot") &&
      scalar &&
      k !== "datetime" &&
      f.value !== undefined &&
      f.value !== ""
    )
      cond = f.op === "is" ? f.value : { ne: f.value }
    else if (
      (f.op === "gt" || f.op === "lt") &&
      (k === "integer" || k === "number" || k === "date" || k === "sequence") &&
      f.value !== undefined &&
      f.value !== ""
    )
      cond = { [f.op]: k === "date" ? String(f.value) : Number(f.value) }
    else if (f.op === "contains" && k === "refs" && f.value) cond = { contains: String(f.value) }
    if (cond === undefined) rest.push(f)
    else and.push({ [field.name]: cond })
  }
  return { where: and.length === 0 ? {} : and.length === 1 ? and[0]! : { and }, rest }
}

/** The rows that pass the filters, in the view's order (`base` breaks ties, then the id). */
export function applyView(
  rows: readonly Row[],
  cols: readonly Column[],
  view: Pick<ViewConfig, "filters" | "sorts">,
  base?: (a: Row, b: Row) => number,
): Row[] {
  const filters = view.filters
    .map((f) => ({ f, c: cols.find((c) => c.id === f.field) }))
    .filter((x): x is { f: Filter; c: Column } => !!x.c)
  const out = rows.filter((r) => filters.every(({ f, c }) => passes(f, c, r)))
  const sorts = view.sorts
    .map((s) => ({ s, c: cols.find((c) => c.id === s.field) }))
    .filter((x): x is { s: Sort; c: Column } => !!x.c)
  return out.sort((a, b) => {
    for (const { s, c } of sorts) {
      const d = compare(asDef(c), c.get(a), c.get(b))
      if (d) return s.dir === "desc" ? -d : d
    }
    if (base) {
      const d = base(a, b)
      if (d) return d
    }
    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0
  })
}

export interface Group {
  /** The value rows of the group have; null for the group of rows without one. */
  key: string | null
  label: string
  hue?: Hue
  rows: Row[]
}

/**
 * Rows in groups by a column. Selects keep their options' order and show every option (an empty column on a
 * board is a place to drop); other values group by what they show. Rows without a value come last.
 */
export function groupRows(
  rows: readonly Row[],
  c: Column,
  names?: (uri: string) => string | undefined,
): Group[] {
  const groups = new Map<string | null, Group>()
  if (c.type === "select" || c.type === "multi")
    for (const o of c.options ?? [])
      groups.set(o.id, { key: o.id, label: o.name, ...(o.hue ? { hue: o.hue } : {}), rows: [] })
  if (c.type === "checkbox") {
    groups.set("true", { key: "true", label: "Checked", rows: [] })
    groups.set("false", { key: "false", label: "Not checked", rows: [] })
  }
  const none: Group = { key: null, label: `No ${c.name.toLowerCase()}`, rows: [] }
  for (const r of rows) {
    const v = c.get(r)
    const keys =
      c.type === "checkbox"
        ? [String(v === true)]
        : empty(v)
          ? []
          : Array.isArray(v)
            ? v.map(String)
            : [String(v)]
    if (!keys.length) none.rows.push(r)
    for (const k of keys) {
      let g = groups.get(k)
      if (!g) {
        g = {
          key: k,
          label: display(asDef(c), c.type === "multi" || c.type === "relation" ? [k] : k, names) || k,
          rows: [],
        }
        groups.set(k, g)
      }
      g.rows.push(r)
    }
  }
  return [...groups.values(), ...(none.rows.length || c.type === "select" ? [none] : [])]
}

/** The columns a view can group by. */
export const groupable = (cols: readonly Column[]) =>
  cols.filter(
    (c) => c.type === "select" || c.type === "multi" || c.type === "checkbox" || c.type === "person",
  )

/** The value a row gets when it is dropped in a group (a board column). */
export function valueForGroup(c: Column, key: string | null): unknown {
  if (c.type === "checkbox") return key === "true"
  if (key === null) return null
  if (c.type === "multi") return [key]
  return key
}
