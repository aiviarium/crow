// The fleet plugin's `jobs.*` calls, typed from @rookery/client's generated wire types.
//
// `jobs.follow` streams one JSON line per `LogItem` (`{ seq, at, attempt, level, text, data }`)
// and a last `JobEnd` (`{ state, result, error }`) whose `error` is an `ErrorBody`.
import type {
  ErrorBody,
  JobDetail,
  JobEnd,
  JobInfo,
  JobList,
  JobQuery,
  JobRetry,
  LogItem,
} from "@rookery/client"
import type { ClientRookery, ClientStream } from "@rookery/sdk/client"

export type { ErrorBody, JobDetail, JobEnd, JobInfo, JobList, JobQuery, JobRetry, LogItem }

export interface JobsApi {
  listJobs(query?: JobQuery): Promise<JobInfo[]>
  getJob(id: string): Promise<JobDetail>
  cancelJob(id: string): Promise<void>
  retryJob(id: string, attempts?: number): Promise<JobInfo>
  followJob(
    id: string,
    opts: {
      after?: number
      onItem: (item: LogItem) => void
      onDone?: (end: JobEnd) => void
      onEnd?: () => void
      onError?: (err: Error) => void
    },
  ): Promise<{ close(): void }>
}

function isLogItem(value: unknown): value is LogItem {
  return typeof value === "object" && value !== null && typeof (value as LogItem).seq === "number"
}

function isJobEnd(value: unknown): value is JobEnd {
  return typeof value === "object" && value !== null && "state" in value
}

/** Parses an NDJSON `jobs.follow` binary stream into log items and the terminal `JobEnd`. */
export function attachJobFollowStream(
  stream: ClientStream,
  handlers: {
    onItem: (item: LogItem) => void
    onDone?: (end: JobEnd) => void
    onEnd?: () => void
    onError?: (err: Error) => void
  },
): { close(): void } {
  const dec = new TextDecoder()
  let buf = ""
  let finished = false

  const handleLine = (line: string) => {
    const trimmed = line.trim()
    if (!trimmed) return
    try {
      const parsed = JSON.parse(trimmed) as unknown
      if (isLogItem(parsed)) {
        handlers.onItem(parsed)
      } else if (isJobEnd(parsed)) {
        finished = true
        handlers.onDone?.(parsed)
      }
    } catch {
      // Ignore malformed lines rather than breaking an active stream.
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

/** Builds the fleet plugin's jobs API over a Rookery plugin client handle. */
export function createJobsApi(rookery: ClientRookery): JobsApi {
  return {
    async listJobs(query = {}) {
      const res = await rookery.rpc.call<JobList>("jobs.list", query as Record<string, unknown>)
      return res.jobs ?? []
    },
    getJob(id) {
      return rookery.rpc.call<JobDetail>("jobs.get", { id })
    },
    async cancelJob(id) {
      await rookery.rpc.call("jobs.cancel", { id })
    },
    retryJob(id, attempts) {
      const params: JobRetry = attempts === undefined ? { id } : { id, attempts }
      return rookery.rpc.call<JobInfo>("jobs.retry", params as Record<string, unknown>)
    },
    async followJob(id, opts) {
      const stream = await rookery.streams.open("jobs.follow", { id, after: opts.after ?? 0 })
      return attachJobFollowStream(stream, {
        onItem: opts.onItem,
        onDone: opts.onDone,
        onEnd: opts.onEnd,
        onError: opts.onError,
      })
    },
  }
}
