// Adopts what a release before the Models plugin kept in its own tables: the task mappings, the limits
// and the usage of requests. It runs when the plugin is installed on a deployment that has them (the
// server parks the old tables in `crow_legacy` and leaves them for the operator to drop), and never twice.
// A row already imported is skipped, so a migration that stopped halfway is safe to run again.
//
// Requires Rookery's plugin migration runner (`MigrationTx.each`, `legacy`, `insert` over `contributes.collections`),
// which arrives in M2; see `API.md` and `storageFallback.ts` for what uses Rookery's `storage` facility today.
import type { MigrationTx } from "@rookery/sdk"
import { limit, mapping, usage } from "./legacy"

export default async function importLegacy(tx: MigrationTx) {
  const have = async (collection: string, field: string) => {
    const seen = new Set<string>()
    for await (const row of tx.each(collection)) seen.add(String(row[field]))
    return seen
  }

  const keys = await have("mappings", "key")
  let mappings = 0
  for await (const r of tx.legacy("ai_mappings")) {
    const row = mapping(r)
    if (keys.has(row.key)) continue
    await tx.insert("mappings", row)
    mappings++
  }

  const users = await have("limits", "user")
  let limits = 0
  for await (const r of tx.legacy("ai_limits")) {
    const row = limit(r)
    if (users.has(row.user)) continue
    await tx.insert("limits", row)
    limits++
  }

  // A request is told apart by the time and who made it; the old table's own numbers are not kept.
  const seen = new Set<string>()
  for await (const row of tx.each("usage")) seen.add(usageKey(row))
  let requests = 0
  for await (const r of tx.legacy("ai_usage")) {
    const row = usage(r)
    if (seen.has(usageKey(row))) continue
    await tx.insert("usage", row)
    requests++
  }
  if (mappings || limits || requests)
    tx.log(`adopted ${mappings} mappings, ${limits} limits and ${requests} requests`)
}

function usageKey(row: Record<string, any>): string {
  return [
    new Date(row.at).getTime(),
    row.user ?? "",
    row.principal,
    row.task,
    row.model,
    row.durationMs ?? "",
  ].join("|")
}
