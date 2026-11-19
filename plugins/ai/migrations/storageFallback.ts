// Pre-M2 Rookery facility adapter for migrating legacy task mappings and budget limits onto
// `rookery.storage` (`storage.*` in rookery-facilities) when plugin collections and raw SQL legacy
// tables are not yet mounted. Usage logs (`usage` log collection + `data.aggregate`) remain a gap
// listed in `API.md` because key-value storage cannot efficiently aggregate monthly log rows.
// Connection credentials / API keys belong strictly in Rookery `connections` / `secrets` — never here.
import type { Storage } from "@rookery/sdk"
import { limit, mapping } from "./legacy"

export const MAPPING_PREFIX = "ai.mapping:"
export const LIMIT_PREFIX = "ai.limit:"

export interface LegacySnapshot {
  mappings?: Array<Record<string, unknown>>
  limits?: Array<Record<string, unknown>>
}

/** Idempotently imports legacy mapping and limit rows into Rookery `storage` (`scope: "global"`). */
export async function importToStorage(
  storage: Storage,
  snapshot: LegacySnapshot,
): Promise<{ mappings: number; limits: number }> {
  const existingMappings = new Set(
    (await storage.list({ scope: "global", prefix: MAPPING_PREFIX })).map((e) => e.key),
  )
  let mappings = 0
  for (const raw of snapshot.mappings ?? []) {
    const row = mapping(raw)
    const key = `${MAPPING_PREFIX}${row.key}`
    if (existingMappings.has(key)) continue
    await storage.set(key, row, { scope: "global", expectedRevision: 0 })
    existingMappings.add(key)
    mappings++
  }

  const existingLimits = new Set(
    (await storage.list({ scope: "global", prefix: LIMIT_PREFIX })).map((e) => e.key),
  )
  let limits = 0
  for (const raw of snapshot.limits ?? []) {
    const row = limit(raw)
    const key = `${LIMIT_PREFIX}${row.user}`
    if (existingLimits.has(key)) continue
    await storage.set(key, row, { scope: "global", expectedRevision: 0 })
    existingLimits.add(key)
    limits++
  }

  return { mappings, limits }
}
