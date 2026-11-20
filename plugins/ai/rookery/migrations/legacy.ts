// The rows a release before the Models plugin kept in its own tables (`ai_mappings`, `ai_limits`,
// `ai_usage`), as the plugin's collections have them. Pure, so a test can feed it rows in the old shape.

type LegacyRow = Record<string, any>

const text = (v: unknown): string | undefined => (typeof v === "string" && v !== "" ? v : undefined)
const int = (v: unknown): number | undefined =>
  v === null || v === undefined ? undefined : Math.trunc(Number(v))

/** The key of a mapping row: one per task at each scope (and space or person). */
export function mappingKey(task: string, scope: string, space?: string, user?: string): string {
  return `${task}|${scope}|${space ?? ""}|${user ?? ""}`
}

export function mapping(r: LegacyRow) {
  const space = text(r.space_id)
  const user = text(r.user_id)
  return {
    key: mappingKey(r.task, r.scope, space, user),
    task: r.task as "text" | "fast" | "transcription",
    scope: r.scope as "global" | "space" | "user",
    ...(space ? { space } : {}),
    ...(user ? { user } : {}),
    connection: String(r.connection_id),
    model: String(r.model),
    live: r.options?.live === true,
  }
}

/** A limit row; the default's `user_id` was null. */
export function limit(r: LegacyRow) {
  return {
    user: text(r.user_id) ?? "default",
    ...(int(r.requests) !== undefined ? { requests: int(r.requests) } : {}),
    ...(int(r.tokens) !== undefined ? { tokens: int(r.tokens) } : {}),
    ...(int(r.audio_seconds) !== undefined ? { audioSeconds: int(r.audio_seconds) } : {}),
  }
}

export function usage(r: LegacyRow) {
  return {
    at: new Date(r.at).toISOString(),
    ...(text(r.user_id) ? { user: text(r.user_id) } : {}),
    principal: String(r.principal),
    plugin: String(r.plugin),
    task: r.task as "text" | "fast" | "transcription",
    provider: String(r.provider),
    model: String(r.model),
    ...(text(r.connection_id) ? { connection: text(r.connection_id) } : {}),
    ...(int(r.input_tokens) !== undefined ? { inputTokens: int(r.input_tokens) } : {}),
    ...(int(r.output_tokens) !== undefined ? { outputTokens: int(r.output_tokens) } : {}),
    ...(r.audio_seconds !== null && r.audio_seconds !== undefined
      ? { audioSeconds: Number(r.audio_seconds) }
      : {}),
    ok: r.ok === true,
    ...(text(r.error) ? { error: String(r.error) } : {}),
    ...(int(r.duration_ms) !== undefined ? { durationMs: int(r.duration_ms) } : {}),
  }
}
