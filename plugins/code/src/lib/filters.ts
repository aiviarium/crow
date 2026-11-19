// The filters of the pull request and issue lists. The state is asked of the store (it is the one filter
// nearly every view sets); the rest run on the rows that come back, which is the repositories' open and recent
// items and so a few hundred at most. The store's `where` has no operator for "a label is in this list".
export interface ItemRow {
  id: string
  repo: string
  number: number
  title: string
  state: string
  author: string
  assignees?: string[] | null
  labels?: Array<{ name: string; color: string }> | null
  reviewers?: string[] | null
  reviewState?: string
  checksState?: string
  draft?: boolean
  ghUpdatedAt?: string | null
  removed?: string | null
}

export interface Filters {
  state: "open" | "closed" | "merged" | "all"
  mine: "all" | "authored" | "assigned" | "review"
  author: string
  label: string
  review: string
  checks: string
  repo: string
  text: string
}

export const NO_FILTERS: Filters = {
  state: "open",
  mine: "all",
  author: "",
  label: "",
  review: "",
  checks: "",
  repo: "",
  text: "",
}

export const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase()
const has = (list: string[] | null | undefined, logins: string[]) =>
  (list ?? []).some((l) => logins.some((m) => same(l, m)))

export function matches(r: ItemRow, f: Filters, me: string[]): boolean {
  if (f.state !== "all" && r.state !== f.state) return false
  if (f.repo && r.repo !== f.repo) return false
  if (f.author && !same(r.author, f.author)) return false
  if (f.label && !(r.labels ?? []).some((l) => same(l.name, f.label))) return false
  if (f.review && r.reviewState !== f.review) return false
  if (f.checks && r.checksState !== f.checks) return false
  if (f.mine === "authored" && !has([r.author], me)) return false
  if (f.mine === "assigned" && !has(r.assignees, me)) return false
  if (f.mine === "review" && !has(r.reviewers, me)) return false
  if (f.text) {
    const t = f.text.toLowerCase()
    if (!`${r.title} #${r.number} ${r.author}`.toLowerCase().includes(t)) return false
  }
  return true
}

export function applyFilters<T extends ItemRow>(rows: T[], f: Filters, me: string[]): T[] {
  return rows
    .filter((r) => matches(r, f, me))
    .sort((a, b) => Date.parse(b.ghUpdatedAt ?? "") - Date.parse(a.ghUpdatedAt ?? ""))
}

/** The people and labels the rows have, for the filter menus. */
export function facets(rows: ItemRow[]) {
  const authors = new Set<string>()
  const labels = new Map<string, string>()
  for (const r of rows) {
    authors.add(r.author)
    for (const l of r.labels ?? []) labels.set(l.name, l.color)
  }
  return {
    authors: [...authors].sort((a, b) => a.localeCompare(b)),
    labels: [...labels.entries()]
      .map(([name, color]) => ({ name, color }))
      .sort((a, b) => a.name.localeCompare(b.name)),
  }
}

export function toQuery(f: Filters): Record<string, string> {
  const q: Record<string, string> = {}
  for (const [k, v] of Object.entries(f) as Array<[keyof Filters, string]>)
    if (v && v !== NO_FILTERS[k]) q[k] = v
  return q
}

export function fromQuery(q: Record<string, string> | undefined): Filters {
  return {
    ...NO_FILTERS,
    ...Object.fromEntries(Object.entries(q ?? {}).filter(([k]) => k in NO_FILTERS)),
  } as Filters
}
