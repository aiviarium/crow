// Anthropic's Messages API as a Crow model provider, with the official SDK. Kept apart from host.ts so the
// tests can run it against a mock of the API without a Rookery host runtime.
import Anthropic from "@anthropic-ai/sdk"
import { type ErrorCode, RookeryError } from "@rookery/sdk"

type Task = "text" | "fast" | "transcription"

/** A model the provider offers. */
export interface ModelInfo {
  id: string
  title?: string
  tasks?: Task[]
}

/** What the Models plugin asks for, with the connection's values (its API key included) read by the host half. */
export interface ProviderCall {
  task: Task
  model?: string
  system?: string
  messages: Array<{ role: "user" | "assistant"; content: string }>
  schema?: Record<string, unknown>
  maxTokens?: number
  connection: { values: Record<string, unknown> }
}

export interface ProviderResult {
  text: string
  object?: unknown
  model: string
  usage: { inputTokens: number; outputTokens: number }
}

export const DEFAULT_BASE_URL = "https://api.anthropic.com"

/** The models offered before the API lists its own. */
export const MODELS: ModelInfo[] = [
  { id: "claude-opus-5-5", title: "Claude Opus 5.5", tasks: ["text"] },
  { id: "claude-sonnet-5-5", title: "Claude Sonnet 5.5", tasks: ["text", "fast"] },
  { id: "claude-haiku-5-5", title: "Claude Haiku 5.5", tasks: ["fast"] },
]

/** Models with server-side refusal fallbacks (`fallbacks: "default"`). */
const FALLBACK_MODELS = new Set([
  "claude-opus-5-5",
  "claude-sonnet-5-5",
  "claude-fable-5-2",
  "claude-fable-5-1",
])

export function client(values: Record<string, unknown>): Anthropic {
  const apiKey = typeof values.apiKey === "string" ? values.apiKey : ""
  if (!apiKey) throw new RookeryError("UNAVAILABLE", "the Anthropic connection has no API key")
  const baseURL =
    typeof values.baseUrl === "string" && values.baseUrl.trim() ? values.baseUrl.trim() : DEFAULT_BASE_URL
  return new Anthropic({
    apiKey,
    baseURL: baseURL.replace(/\/+$/, ""),
    maxRetries: 1,
    ...(values.rejectRedirects === true ? { fetchOptions: { redirect: "error" } } : {}),
  })
}

/** An SDK error as one of the protocol's codes. */
export function mapError(e: unknown, signal?: AbortSignal): unknown {
  if (signal?.aborted) return signal.reason ?? e
  if (e instanceof RookeryError) return e
  if (e instanceof Anthropic.APIUserAbortError)
    return new RookeryError("UNAVAILABLE", "the request was cancelled")
  if (e instanceof Anthropic.APIConnectionTimeoutError)
    return new RookeryError("TIMEOUT", "Anthropic did not answer in time")
  if (e instanceof Anthropic.APIConnectionError)
    return new RookeryError("UNAVAILABLE", `cannot reach Anthropic: ${e.message}`)
  if (e instanceof Anthropic.APIError) {
    const status = e.status ?? 0
    const code: ErrorCode =
      e instanceof Anthropic.BadRequestError || status === 413 || status === 422
        ? "INVALID"
        : e instanceof Anthropic.NotFoundError
          ? "NOT_FOUND"
          : status === 408 || status === 504
            ? "TIMEOUT"
            : "UNAVAILABLE"
    const lead =
      e instanceof Anthropic.AuthenticationError || e instanceof Anthropic.PermissionDeniedError
        ? "Anthropic refused the connection's key"
        : e instanceof Anthropic.RateLimitError
          ? "Anthropic is rate limiting requests"
          : status >= 500
            ? "Anthropic failed"
            : "Anthropic refused the request"
    return new RookeryError(code, `${lead} (${status}): ${e.message}`, { status })
  }
  return e
}

/** A generation, streamed: `emit` gets each piece of text. */
export async function generate(
  req: ProviderCall,
  emit: (text: string) => void,
  signal?: AbortSignal,
): Promise<ProviderResult> {
  const anthropic = client(req.connection.values)
  const model = req.model || (req.task === "fast" ? "claude-haiku-5-5" : "claude-opus-5-5")
  // Fast requests get less effort; everything else the API's default for the model.
  const output_config: Anthropic.Beta.BetaOutputConfig = {}
  if (req.task === "fast") output_config.effort = "low"
  if (req.schema)
    output_config.format = { type: "json_schema", schema: req.schema as Record<string, unknown> }
  const fallback = FALLBACK_MODELS.has(model)
  try {
    const stream = anthropic.beta.messages.stream(
      {
        model,
        max_tokens: req.maxTokens ?? (req.task === "fast" ? 4096 : 16000),
        ...(req.system ? { system: req.system } : {}),
        messages: req.messages.map((m) => ({ role: m.role, content: m.content })),
        ...(Object.keys(output_config).length ? { output_config } : {}),
        ...(fallback ? { betas: ["server-side-fallback-2026-07-01"], fallbacks: "default" as const } : {}),
      },
      { signal },
    )
    for await (const event of stream) {
      if (event.type === "content_block_delta" && event.delta.type === "text_delta") emit(event.delta.text)
    }
    const message = await stream.finalMessage()
    if (message.stop_reason === "refusal") {
      throw new RookeryError("UNAVAILABLE", "the model declined the request", {
        refusal: message.stop_details ?? null,
      })
    }
    const text = message.content
      .filter((b): b is Anthropic.Beta.BetaTextBlock => b.type === "text")
      .map((b) => b.text)
      .join("")
    let object: unknown
    if (req.schema) {
      try {
        object = JSON.parse(text)
      } catch {
        // The router looks for the JSON itself and reports a mismatch.
      }
    }
    return {
      text,
      ...(object === undefined ? {} : { object }),
      model: message.model,
      usage: { inputTokens: message.usage.input_tokens, outputTokens: message.usage.output_tokens },
    }
  } catch (e) {
    throw mapError(e, signal)
  }
}

/** The models the key may use. */
export async function models(values: Record<string, unknown>, signal?: AbortSignal): Promise<ModelInfo[]> {
  const anthropic = client(values)
  try {
    const out: ModelInfo[] = []
    for await (const m of anthropic.models.list({ limit: 100 }, { signal })) {
      const known = MODELS.find((k) => k.id === m.id)
      out.push({ id: m.id, title: m.display_name, ...(known?.tasks ? { tasks: known.tasks } : {}) })
    }
    return out
  } catch (e) {
    throw mapError(e, signal)
  }
}
