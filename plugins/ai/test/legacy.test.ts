import { expect, test } from "bun:test"
import type { MigrationTx, Storage } from "@rookery/sdk"
import importLegacy from "../migrations/importLegacy"
import { limit, mapping, usage } from "../migrations/legacy"
import { importToStorage, LIMIT_PREFIX, MAPPING_PREFIX } from "../migrations/storageFallback"

// Rows as the pre-plugin `ai_*` tables had them.
const ann = "0198a2b0-0000-7000-8000-000000000001"
const space = "0198a2b0-0000-7000-8000-0000000000a1"
const conn = "0198a2b0-0000-7000-8000-0000000000c1"
const oldMappings = [
  {
    task: "text",
    scope: "global",
    space_id: null,
    user_id: null,
    connection_id: conn,
    model: "gpt-x",
    options: {},
    updated_by: ann,
    updated_at: "2026-11-01T10:00:00+00:00",
  },
  {
    task: "transcription",
    scope: "space",
    space_id: space,
    user_id: null,
    connection_id: conn,
    model: "whisper",
    options: { live: true },
    updated_by: null,
    updated_at: "2026-11-02T10:00:00+00:00",
  },
  {
    task: "fast",
    scope: "user",
    space_id: null,
    user_id: ann,
    connection_id: conn,
    model: "mini",
    options: {},
    updated_by: ann,
    updated_at: "2026-11-03T10:00:00+00:00",
  },
]
const oldLimits = [
  { user_id: null, requests: 100, tokens: null, audio_seconds: 600, updated_at: "2026-11-01T10:00:00+00:00" },
  {
    user_id: ann,
    requests: null,
    tokens: 5000,
    audio_seconds: null,
    updated_at: "2026-11-01T10:00:00+00:00",
  },
]
const oldUsage = [
  {
    id: 1,
    at: "2026-11-10T08:30:00.123456+00:00",
    user_id: ann,
    principal: "user:ann",
    plugin: "projects",
    task: "fast",
    provider: "openai-compatible",
    model: "mini",
    connection_id: conn,
    input_tokens: 10,
    output_tokens: 4,
    audio_seconds: null,
    ok: true,
    error: null,
    duration_ms: 812,
  },
  {
    id: 2,
    at: "2026-11-10T09:00:00+00:00",
    user_id: null,
    principal: "service:agents",
    plugin: "agents",
    task: "transcription",
    provider: "openai-compatible",
    model: "whisper",
    connection_id: null,
    input_tokens: null,
    output_tokens: null,
    audio_seconds: 12.5,
    ok: false,
    error: "UNAVAILABLE: upstream",
    duration_ms: 90,
  },
]

/** A transaction over in-memory collections and legacy tables. */
function fakeTx(initial: Record<string, Record<string, any>[]> = {}) {
  const data: Record<string, Record<string, any>[]> = { mappings: [], limits: [], usage: [], ...initial }
  const legacy: Record<string, Record<string, any>[]> = {
    ai_mappings: oldMappings,
    ai_limits: oldLimits,
    ai_usage: oldUsage,
  }
  const logs: string[] = []
  const tx = {
    rows: async () => [],
    async *each(c: string) {
      for (const r of data[c] ?? []) yield r
    },
    async *legacy(t: string) {
      for (const r of legacy[t] ?? []) yield r
    },
    insert: async (c: string, v: Record<string, unknown>) => {
      data[c]!.push(v)
      return v
    },
    update: async () => ({}),
    delete: async () => {},
    log: (...a: unknown[]) => void logs.push(a.join(" ")),
  } as unknown as MigrationTx
  return { tx, data, logs }
}

test("a mapping row of the old shape becomes a row of the collection", () => {
  expect(mapping(oldMappings[0]!)).toEqual({
    key: "text|global||",
    task: "text",
    scope: "global",
    connection: conn,
    model: "gpt-x",
    live: false,
  })
  expect(mapping(oldMappings[1]!)).toEqual({
    key: `transcription|space|${space}|`,
    task: "transcription",
    scope: "space",
    space,
    connection: conn,
    model: "whisper",
    live: true,
  })
  expect(mapping(oldMappings[2]!).user).toBe(ann)
})

test("the default limits are the row of 'default'; a limit left empty stays empty", () => {
  expect(limit(oldLimits[0]!)).toEqual({ user: "default", requests: 100, audioSeconds: 600 })
  expect(limit(oldLimits[1]!)).toEqual({ user: ann, tokens: 5000 })
})

test("a usage row keeps what was recorded, with the time as ISO text", () => {
  expect(usage(oldUsage[0]!)).toEqual({
    at: "2026-11-10T08:30:00.123Z",
    user: ann,
    principal: "user:ann",
    plugin: "projects",
    task: "fast",
    provider: "openai-compatible",
    model: "mini",
    connection: conn,
    inputTokens: 10,
    outputTokens: 4,
    ok: true,
    durationMs: 812,
  })
  const failed = usage(oldUsage[1]!)
  expect(failed).toMatchObject({ ok: false, error: "UNAVAILABLE: upstream", audioSeconds: 12.5 })
  expect(failed).not.toHaveProperty("user")
})

test("the migration adopts every row once, and running it again changes nothing", async () => {
  const { tx, data, logs } = fakeTx()
  await importLegacy(tx)
  expect(data.mappings).toHaveLength(3)
  expect(data.limits).toHaveLength(2)
  expect(data.usage).toHaveLength(2)
  expect(logs[0]).toContain("3 mappings, 2 limits and 2 requests")
  const again = fakeTx({ mappings: data.mappings!, limits: data.limits!, usage: data.usage! })
  await importLegacy(again.tx)
  expect(again.data.mappings).toHaveLength(3)
  expect(again.data.limits).toHaveLength(2)
  expect(again.data.usage).toHaveLength(2)
  expect(again.logs).toHaveLength(0)
})

test("a deployment that never had the tables adopts nothing", async () => {
  const { tx, data } = fakeTx()
  const empty = { ...tx, legacy: async function* () {} } as unknown as MigrationTx
  await importLegacy(empty)
  expect(data.mappings).toHaveLength(0)
})

test("storageFallback adopts mappings and limits idempotently onto Rookery storage without secrets", async () => {
  const store = new Map<string, { value: unknown; revision: number }>()
  const storage: Storage = {
    async get<T>(key: string) {
      return (store.get(key)?.value as T) ?? null
    },
    async set(key: string, value: unknown, opts) {
      const prev = store.get(key)
      if (opts?.expectedRevision !== undefined && (prev?.revision ?? 0) !== opts.expectedRevision) {
        throw new Error("conflict")
      }
      store.set(key, { value, revision: (prev?.revision ?? 0) + 1 })
    },
    async list(opts) {
      const prefix = opts?.prefix ?? ""
      return Array.from(store.entries())
        .filter(([k]) => k.startsWith(prefix))
        .map(([key, entry]) => ({ key, value: entry.value, revision: entry.revision }))
    },
    async delete(key: string) {
      store.delete(key)
    },
  }

  const first = await importToStorage(storage, { mappings: oldMappings, limits: oldLimits })
  expect(first).toEqual({ mappings: 3, limits: 2 })
  expect(store.get(`${MAPPING_PREFIX}text|global||`)?.value).toMatchObject({
    task: "text",
    connection: conn,
    model: "gpt-x",
  })
  expect(store.get(`${LIMIT_PREFIX}default`)?.value).toEqual({
    user: "default",
    requests: 100,
    audioSeconds: 600,
  })

  const second = await importToStorage(storage, { mappings: oldMappings, limits: oldLimits })
  expect(second).toEqual({ mappings: 0, limits: 0 })
})
