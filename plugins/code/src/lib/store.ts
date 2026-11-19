// Writing GitHub's items into the plugin's collections: look up what is stored, write only what differs,
// one transaction per chunk. Used by sync (polling) and by webhook deliveries, which share a per-repository
// lock so two writers never insert the same pull request.
import type { Collection } from "@rookery/sdk"
import { changedFields, type Fields } from "./mapping"
import type { GhCollections, Rows } from "./rows"

const locks = new Map<string, Promise<unknown>>()

/** Runs `fn` after everything already queued for `key` has finished. */
export function withLock<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const prev = locks.get(key) ?? Promise.resolve()
  const next = prev.catch(() => {}).then(fn)
  locks.set(key, next)
  next.then(
    () => locks.get(key) === next && locks.delete(key),
    () => locks.get(key) === next && locks.delete(key),
  )
  return next
}

export const isRunning = (key: string) => locks.has(key)

export interface Upserted {
  created: Rows[]
  updated: Array<{ before: Rows; after: Rows; patch: Fields }>
  unchanged: Rows[]
}

/** The rows of a collection in a repository with one of the given numbers (or other keys), by key. */
export async function existing(
  c: Collection<any>,
  field: string,
  repoUri: string,
  keys: Array<string | number>,
  extra: Record<string, unknown> = {},
): Promise<Map<string | number, Rows>> {
  const out = new Map<string | number, Rows>()
  for (let i = 0; i < keys.length; i += 200) {
    const chunk = keys.slice(i, i + 200)
    const page = await c.find({
      where: { repo: repoUri, ...extra, [field]: { in: chunk } },
      limit: 1000,
    } as never)
    for (const r of page.rows as Rows[]) out.set(r[field], r)
  }
  return out
}

/**
 * Inserts what is new and updates what changed. `items` carry the key of the row in `field`.
 * Fields the mapping did not produce (undefined) are left as stored.
 */
export async function upsertMany(
  data: GhCollections,
  collection: "prs" | "comments",
  repoUri: string,
  field: string,
  items: Fields[],
  extra: Record<string, unknown> = {},
): Promise<Upserted> {
  const c = data[collection] as unknown as Collection<any>
  const found = await existing(
    c,
    field,
    repoUri,
    items.map((i) => i[field] as string | number),
    extra,
  )
  const out: Upserted = { created: [], updated: [], unchanged: [] }
  const ops: Array<{ op: "insert"; values: Fields } | { op: "update"; id: string; patch: Fields }> = []
  const meta: Array<{ kind: "c" | "u"; before?: Rows; patch: Fields; item: Fields }> = []
  for (const item of items) {
    const row = found.get(item[field] as string | number)
    if (!row) {
      ops.push({ op: "insert", values: item })
      meta.push({ kind: "c", patch: item, item })
      continue
    }
    const patch = changedFields(row, item)
    if (Object.keys(patch).length === 0) out.unchanged.push(row)
    else {
      ops.push({ op: "update", id: row.id, patch })
      meta.push({ kind: "u", before: row, patch, item })
    }
  }
  for (let i = 0; i < ops.length; i += 100) {
    const rows = await c.batch(ops.slice(i, i + 100).map((o) => ({ ...o, collection })) as never)
    rows.forEach((row, j) => {
      const m = meta[i + j]!
      if (!row) return
      if (m.kind === "c") out.created.push(row as Rows)
      else out.updated.push({ before: m.before!, after: row as Rows, patch: m.patch })
    })
  }
  return out
}

/** Runs `fn` over `items` with at most `limit` in flight, in order of results. */
export async function mapLimit<T, R>(
  items: T[],
  limit: number,
  fn: (item: T, i: number) => Promise<R>,
): Promise<R[]> {
  const out = new Array<R>(items.length)
  let next = 0
  const worker = async () => {
    for (;;) {
      const i = next++
      if (i >= items.length) return
      out[i] = await fn(items[i]!, i)
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker))
  return out
}
