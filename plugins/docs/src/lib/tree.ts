// The page tree: pages are rows of `pages` whose `parent` is another page's URI (`doc://<id>`) or null at the
// top of a space, ordered among siblings by `rank` (rank.ts). These functions work on plain rows so the host
// half, the client half and the tests share them.
import { between, byRank } from "./rank"

export const SCHEME = "doc"

export interface PageRow {
  id: string
  spaceId?: string
  title: string
  icon?: string | null
  cover?: string | null
  parent?: string | null
  rank?: string | null
  private?: boolean | null
  document?: string | null
  props?: Record<string, unknown> | null
  schema?: unknown
  localSchema?: unknown
  template?: boolean | null
  trashedWith?: string | null
  wide?: boolean | null
  session?: string | null
  createdAt?: string
  updatedAt?: string
  createdBy?: string | null
  updatedBy?: string | null
  deletedAt?: string | null
  rev?: number
}

export const uriOf = (id: string) => `${SCHEME}://${id}`

/** The id of a `doc://` URI (or the id itself); null for anything else. */
export function idOf(uri: string | null | undefined): string | null {
  if (!uri) return null
  if (uri.startsWith(`${SCHEME}://`)) return uri.slice(SCHEME.length + 3)
  return uri.includes("://") ? null : uri
}

/** The parent page's id, or null at the top. */
export const parentId = (p: Pick<PageRow, "parent">) => idOf(p.parent ?? null)

/** The children of `parent` (an id, or null for the top), in order. */
export function childrenOf<T extends PageRow>(rows: readonly T[], parent: string | null): T[] {
  return rows.filter((r) => parentId(r) === parent).sort(byRank)
}

/**
 * The rank for a page placed at `index` among `siblings` (in order, without the page being placed): between
 * the neighbours there. Siblings without a usable rank (rows written by hand) are placed as they sort.
 */
export function rankAt(siblings: readonly Pick<PageRow, "rank">[], index: number): string {
  const i = Math.max(0, Math.min(index, siblings.length))
  const before = i > 0 ? siblings[i - 1]!.rank : null
  const after = i < siblings.length ? siblings[i]!.rank : null
  try {
    return between(before || null, after || null)
  } catch {
    // Neighbours with equal or invalid ranks: go after the one before.
    return between(before || null, null)
  }
}

/** The rank of a new last child. */
export const rankAfter = (siblings: readonly Pick<PageRow, "rank">[]) => rankAt(siblings, siblings.length)

/** The ids from `id` up to the top (`id` first), following `parentOf`. Stops at a loop. */
export function ancestry(id: string, parentOf: (id: string) => string | null | undefined): string[] {
  const out = [id]
  const seen = new Set(out)
  let at = parentOf(id)
  while (at && !seen.has(at)) {
    out.push(at)
    seen.add(at)
    at = parentOf(at)
  }
  return out
}

/** Moving `id` under `parent` would put a page inside itself. */
export function wouldCycle(
  id: string,
  parent: string | null,
  parentOf: (id: string) => string | null | undefined,
): boolean {
  if (!parent) return false
  return ancestry(parent, parentOf).includes(id)
}

/** Every page below `root` (not `root` itself), parents before children. */
export function descendants<T extends PageRow>(rows: readonly T[], root: string): T[] {
  const kids = new Map<string, T[]>()
  for (const r of rows) {
    const p = parentId(r)
    if (!p) continue
    const list = kids.get(p) ?? []
    list.push(r)
    kids.set(p, list)
  }
  const out: T[] = []
  const queue = [root]
  const seen = new Set(queue)
  while (queue.length) {
    const at = queue.shift()!
    for (const c of (kids.get(at) ?? []).sort(byRank)) {
      if (seen.has(c.id)) continue
      seen.add(c.id)
      out.push(c)
      queue.push(c.id)
    }
  }
  return out
}

export interface TreeNode<T extends PageRow = PageRow> {
  page: T
  depth: number
  children: TreeNode<T>[]
}

/** The rows as a forest; pages whose parent is not among the rows are roots. */
export function buildTree<T extends PageRow>(rows: readonly T[]): TreeNode<T>[] {
  const ids = new Set(rows.map((r) => r.id))
  const byParent = new Map<string | null, T[]>()
  for (const r of rows) {
    const p = parentId(r)
    const key = p && ids.has(p) ? p : null
    const list = byParent.get(key) ?? []
    list.push(r)
    byParent.set(key, list)
  }
  const make = (parent: string | null, depth: number, seen: Set<string>): TreeNode<T>[] =>
    (byParent.get(parent) ?? [])
      .sort(byRank)
      .filter((p) => !seen.has(p.id))
      .map((page) => {
        const next = new Set(seen).add(page.id)
        return { page, depth, children: make(page.id, depth + 1, next) }
      })
  return make(null, 0, new Set())
}

/** The rows a tree shows: depth first, children only under expanded nodes. */
export function visibleRows<T extends PageRow>(
  forest: readonly TreeNode<T>[],
  expanded: (id: string) => boolean,
): TreeNode<T>[] {
  const out: TreeNode<T>[] = []
  const walk = (nodes: readonly TreeNode<T>[]) => {
    for (const n of nodes) {
      out.push(n)
      if (n.children.length && expanded(n.page.id)) walk(n.children)
    }
  }
  walk(forest)
  return out
}

/** Where a drop on a row puts the dragged page: before it, after it, or as its last child. */
export type DropZone = "before" | "after" | "inside"

/** The zone of a drop at `y` (from the row's top) on a row of `height`: the middle half means inside. */
export function zoneAt(y: number, height: number): DropZone {
  if (y < height / 4) return "before"
  if (y > (height * 3) / 4) return "after"
  return "inside"
}

/**
 * The parent and index a drop means, given the target row and the zone. `siblingsOf(parent)` lists a parent's
 * children in order (the dragged page may be among them; it is left out of the index).
 */
export function dropTarget<T extends PageRow>(
  dragged: string,
  target: T,
  zone: DropZone,
  siblingsOf: (parent: string | null) => readonly T[],
): { parent: string | null; index: number } {
  if (zone === "inside") {
    const kids = siblingsOf(target.id).filter((k) => k.id !== dragged)
    return { parent: target.id, index: kids.length }
  }
  const parent = parentId(target)
  const sibs = siblingsOf(parent).filter((s) => s.id !== dragged)
  const at = sibs.findIndex((s) => s.id === target.id)
  return { parent, index: zone === "before" ? Math.max(0, at) : at + 1 }
}
