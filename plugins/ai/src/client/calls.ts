// The router's methods, called through the plugin's own `contributes.rpc` (`plugins.rpc` behind `rookery.host`).
import { type ClientRookery, type ErrorCode, RookeryError } from "@rookery/sdk/client"

type Host = ClientRookery["host"]

export type Task = "text" | "fast" | "transcription"
export type Scope = "global" | "space" | "user"

export interface TaskInfo {
  task: Task
  available: boolean
  scope?: Scope
  provider?: string
  model?: string
  destination?: string
  live: boolean
  detectsLanguage: boolean
}

export interface MappingInfo {
  task: Task
  scope: Scope
  spaceId?: string
  userId?: string
  connection: string
  connectionName: string
  connectionType: string
  provider: string
  model: string
  live: boolean
  destination: string
  local: boolean
  updatedAt: string
}

export interface ProviderInfo {
  id: string
  title: string
  plugin?: string
  connectionType: string
  tasks: Task[]
  detectsLanguage: boolean
}

export interface ModelInfo {
  id: string
  title?: string
  tasks?: Task[]
}

export interface Limits {
  requests?: number
  tokens?: number
  audioSeconds?: number
}

export interface LimitsInfo {
  default: Limits
  users: Array<{ userId: string; name?: string; limits: Limits }>
}

export interface UsageRow {
  key: string
  label?: string
  requests: number
  errors: number
  inputTokens: number
  outputTokens: number
  audioSeconds: number
}

export type UsageBy = "user" | "plugin" | "task" | "model" | "day"

export interface Generated {
  request: string
  text: string
  model: string
  provider: string
  usage: { inputTokens?: number; outputTokens?: number; audioSeconds?: number }
}

export type GenerateEvent = { type: "delta"; text: string } | { type: "done"; generated: Generated }

export interface GenerateParams {
  task: Task
  system?: string
  prompt?: string
  plugin?: string
}

function abortError(signal?: AbortSignal): Error {
  if (signal?.reason instanceof Error) return signal.reason
  return new DOMException("Aborted", "AbortError")
}

/** Adapts Rookery's callback-based `ClientStream` (NDJSON UTF-8 frames) into an AsyncIterable. */
async function* streamNdjson<T>(
  host: Host,
  method: string,
  params: Record<string, unknown> = {},
  signal?: AbortSignal,
): AsyncIterable<T> {
  if (signal?.aborted) throw abortError(signal)

  const stream = await host.stream(method, params)
  if (signal?.aborted) {
    stream.close()
    throw abortError(signal)
  }

  const dec = new TextDecoder()
  const queue: T[] = []
  let buf = ""
  let done = false
  let failure: Error | undefined
  let wake: (() => void) | undefined

  const notify = () => {
    const fn = wake
    wake = undefined
    fn?.()
  }

  const onAbort = () => {
    failure = abortError(signal)
    done = true
    stream.close()
    notify()
  }
  signal?.addEventListener("abort", onAbort, { once: true })

  const pushLines = (chunkText: string) => {
    buf += chunkText
    const lines = buf.split("\n")
    buf = lines.pop() ?? ""
    for (const line of lines) {
      const trimmed = line.trim()
      if (!trimmed) continue
      queue.push(JSON.parse(trimmed) as T)
    }
  }

  stream.onData = (chunk) => {
    try {
      pushLines(dec.decode(chunk, { stream: true }))
    } catch (err) {
      failure = err instanceof Error ? err : new Error(String(err))
      done = true
      stream.close()
    }
    notify()
  }

  stream.onEnd = (error) => {
    try {
      const tail = dec.decode()
      if (tail || buf.trim()) {
        pushLines(`${tail}\n`)
      }
    } catch (err) {
      if (!failure) failure = err instanceof Error ? err : new Error(String(err))
    }
    if (error && !failure) {
      failure = new RookeryError((error.code as ErrorCode) ?? "INTERNAL", error.message, error.details)
    }
    done = true
    notify()
  }

  try {
    for (;;) {
      while (queue.length > 0) {
        yield queue.shift()!
      }
      if (failure) throw failure
      if (done) break
      await new Promise<void>((resolve) => {
        wake = resolve
      })
    }
  } finally {
    signal?.removeEventListener("abort", onAbort)
    if (!done) stream.close()
  }
}

export function calls(host: Host) {
  return {
    tasks: () => host.call<{ tasks: TaskInfo[] }>("tasks").then((r) => r.tasks),
    generate: (params: GenerateParams, signal?: AbortSignal) =>
      streamNdjson<GenerateEvent>(host, "generate", params as unknown as Record<string, unknown>, signal),
    mappings: () => host.call<{ mappings: MappingInfo[] }>("mappings").then((r) => r.mappings),
    setMapping: (p: Record<string, unknown>) => host.call<MappingInfo>("setMapping", p),
    removeMapping: (p: Record<string, unknown>) => host.call("removeMapping", p),
    providers: () => host.call<{ providers: ProviderInfo[] }>("providers").then((r) => r.providers),
    models: (connection: string) =>
      host.call<{ models: ModelInfo[] }>("models", { connection }).then((r) => r.models),
    usage: (by: UsageBy, days: number) =>
      host.call<{ rows: UsageRow[]; since: string }>("usage", { by, days }),
    limits: () => host.call<LimitsInfo>("limits"),
    setLimits: (p: { user?: string; limits: Limits }) => host.call<LimitsInfo>("setLimits", p),
    dictate: (p: Record<string, unknown>, signal?: AbortSignal) =>
      streamNdjson<unknown>(host, "dictate", p, signal),
    dictateAudio: (p: Record<string, unknown>) => host.call("dictateAudio", p),
  }
}

export type Calls = ReturnType<typeof calls>
