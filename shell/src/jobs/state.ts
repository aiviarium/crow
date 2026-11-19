// Reactive shell Jobs store backed by Rookery's `jobs.*` RPCs, `jobs.follow` NDJSON stream, and
// live `jobs.changed` server notifications.
import type { DotStatus, LogEntry, LogLevel } from "@aiviarium/nocturne"
import type {
  ClientStream,
  Connection,
  JobChanged,
  JobEnd,
  JobInfo,
  JobList,
  JobQuery,
  JobRetry,
  JobState,
  LogItem,
} from "@rookery/client"
import { type Accessor, createSignal } from "solid-js"

export interface JobsStore {
  readonly jobs: Accessor<JobInfo[]>
  readonly loading: Accessor<boolean>
  readonly error: Accessor<string | null>
  readonly activeCount: Accessor<number>
  refresh(query?: JobQuery): Promise<void>
  get(id: string): Promise<JobInfo>
  cancel(id: string): Promise<void>
  retry(id: string, attempts?: number): Promise<JobInfo>
  onChanged(fn: (job: JobInfo) => void): () => void
  start(): void
  stop(): void
}

export function isJobActive(state: JobState): boolean {
  return state === "queued" || state === "running"
}

export function jobStatusInfo(state: JobState): { dot: DotStatus; label: string } {
  switch (state) {
    case "queued":
      return { dot: "idle", label: "Queued" }
    case "running":
      return { dot: "live", label: "Running" }
    case "succeeded":
      return { dot: "ok", label: "Succeeded" }
    case "failed":
      return { dot: "error", label: "Failed" }
    case "cancelled":
      return { dot: "off", label: "Cancelled" }
    default:
      return { dot: "neutral", label: state }
  }
}

export function formatTimeAgo(iso: string | null | undefined, nowMs = Date.now()): string {
  if (!iso) return "—"
  const t = new Date(iso).getTime()
  if (Number.isNaN(t)) return iso
  const sec = Math.max(0, Math.round((nowMs - t) / 1000))
  if (sec < 10) return "just now"
  if (sec < 60) return `${sec}s ago`
  const min = Math.round(sec / 60)
  if (min < 60) return `${min}m ago`
  const hr = Math.round(min / 60)
  if (hr < 24) return `${hr}h ago`
  const day = Math.round(hr / 24)
  return `${day}d ago`
}

const LEVELS: Record<string, LogLevel> = {
  error: "error",
  err: "error",
  stderr: "error",
  warn: "warn",
  warning: "warn",
  debug: "debug",
  trace: "debug",
}

/** Maps a job log line's `level` to a Nocturne log level. */
export function logLevel(level: string | undefined): LogLevel {
  return LEVELS[(level ?? "info").toLowerCase()] ?? "info"
}

/** Converts a Rookery `LogItem` into a Nocturne `LogEntry`. */
export function jobLogItemToEntry(item: LogItem): LogEntry {
  return { id: item.seq, at: item.at, level: logLevel(item.level), text: item.text }
}

/** A job's title in a list: its kind. */
export function jobTitle(job: JobInfo): string {
  return job.kind
}

/** A job's second line: its subject, or its id when it has none. */
export function jobSubtitle(job: JobInfo): string {
  return job.subject ?? job.id
}

export type JobProgressInfo = { done: number; total: number; message?: string }

/** Reads `{ done, total, message }` out of a job's untyped `progress`, if it has that shape. */
export function jobProgress(progress: unknown): JobProgressInfo | null {
  if (!progress || typeof progress !== "object") return null
  const p = progress as Record<string, unknown>
  if (typeof p.done !== "number" || typeof p.total !== "number" || p.total <= 0) return null
  return {
    done: p.done,
    total: p.total,
    ...(typeof p.message === "string" ? { message: p.message } : {}),
  }
}

/** Opens a `jobs.follow` binary NDJSON stream starting after cursor `after`. */
export async function openJobFollow(
  conn: Connection,
  id: string,
  after: number,
  handlers: {
    onItem: (item: LogItem) => void
    onDone?: (end: JobEnd) => void
    onEnd?: () => void
    onError?: (err: Error) => void
  },
): Promise<{ close(): void }> {
  const stream: ClientStream = await conn.stream("jobs.follow", { id, after })
  const dec = new TextDecoder()
  let buf = ""
  let finished = false

  const handleLine = (line: string) => {
    const trimmed = line.trim()
    if (!trimmed) return
    try {
      const parsed = JSON.parse(trimmed) as unknown
      if (typeof parsed === "object" && parsed !== null && typeof (parsed as LogItem).seq === "number") {
        handlers.onItem(parsed as LogItem)
      } else if (typeof parsed === "object" && parsed !== null && "state" in parsed) {
        finished = true
        handlers.onDone?.(parsed as JobEnd)
      }
    } catch {
      // Ignore malformed chunks rather than killing the stream.
    }
  }

  stream.onData = (chunk) => {
    buf += dec.decode(chunk, { stream: true })
    const lines = buf.split("\n")
    buf = lines.pop() ?? ""
    for (const line of lines) handleLine(line)
  }

  stream.onEnd = (err: { code: string; message: string; details?: unknown } | undefined) => {
    buf += dec.decode()
    if (buf.trim()) handleLine(buf)
    buf = ""
    if (err) {
      handlers.onError?.(new Error(err.message || err.code))
    } else if (!finished) {
      handlers.onEnd?.()
    }
  }

  return {
    close: () => stream.close(),
  }
}

function upsertJob(list: JobInfo[], job: JobInfo): JobInfo[] {
  const idx = list.findIndex((j) => j.id === job.id)
  if (idx >= 0) {
    const next = list.slice()
    next[idx] = job
    return next
  }
  return [job, ...list]
}

export function createJobsStore(conn: Connection): JobsStore {
  const [jobs, setJobs] = createSignal<JobInfo[]>([])
  const [loading, setLoading] = createSignal(false)
  const [error, setError] = createSignal<string | null>(null)
  const listeners = new Set<(job: JobInfo) => void>()
  let started = false
  let unsubs: Array<() => void> = []

  const activeCount = () => jobs().filter((j) => isJobActive(j.state)).length

  const refresh = async (query: JobQuery = { limit: 100 }) => {
    setLoading(true)
    setError(null)
    try {
      const res = await conn.call<JobList>("jobs.list", query as Record<string, unknown>)
      setJobs(res.jobs ?? [])
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setLoading(false)
    }
  }

  const get = (id: string) => conn.call<JobInfo>("jobs.get", { id })

  const cancel = async (id: string) => {
    await conn.call("jobs.cancel", { id })
  }

  const retry = async (id: string, attempts?: number) => {
    const params: JobRetry = attempts === undefined ? { id } : { id, attempts }
    const retried = await conn.call<JobInfo>("jobs.retry", params as Record<string, unknown>)
    setJobs((prev) => upsertJob(prev, retried))
    return retried
  }

  const onChanged = (fn: (job: JobInfo) => void) => {
    listeners.add(fn)
    return () => {
      listeners.delete(fn)
    }
  }

  const start = () => {
    if (started) return
    started = true
    unsubs = [
      conn.on("jobs.changed", (ev: JobChanged) => {
        if (!ev?.job) return
        setJobs((prev) => upsertJob(prev, ev.job))
        for (const fn of listeners) fn(ev.job)
      }),
      conn.onOpen(() => {
        void refresh()
      }),
    ]
    if (conn.state() === "open") {
      void refresh()
    }
  }

  const stop = () => {
    if (!started) return
    started = false
    for (const u of unsubs) u()
    unsubs = []
  }

  return {
    jobs,
    loading,
    error,
    activeCount,
    refresh,
    get,
    cancel,
    retry,
    onChanged,
    start,
    stop,
  }
}
