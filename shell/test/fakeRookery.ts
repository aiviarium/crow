// Reusable fake Rookery WebSocket/HTTP server for Bun tests. Answers in the exact shapes of
// @rookery/client's generated wire types: `auth.me` is a `Me`, `jobs.*` use `JobInfo` / `JobDetail`
// / `LogItem` / `JobEnd`, and `notify.*` use `NotificationInfo` with string actions and answers.
// `hosts.*` is still the hand-written contract in `plugins/fleet/src/api.ts` until it lands.
import type {
  CommandList,
  Count,
  ErrorBody,
  EventNotice,
  EventSubscribed,
  JobChanged,
  JobDetail,
  JobEnd,
  JobInfo,
  JobList,
  JobState,
  LogItem,
  Me,
  NotificationInfo,
  NotificationList,
  NotifyChanged,
  NotifyNew,
  PluginInfo,
  PluginList,
  StreamOpened,
  User,
} from "@rookery/client"
import type {
  Action,
  HostCheckResult,
  HostInfo,
  HostProfile,
  HostsActionsResult,
  HostsActParams,
  HostsActResult,
  HostsCheckResult,
  HostsGetResult,
  HostsListResult,
  HostsProfileResult,
  HostsRemoveResult,
  HostsRenameResult,
  HostsSaveParams,
  HostsSaveResult,
} from "../../plugins/fleet/src/api"

export interface FakeRookerySeed {
  hosts?: HostInfo[]
  profiles?: Record<string, HostProfile>
  actions?: Record<string, Action[]>
  checks?: Record<string, HostCheckResult>
  jobs?: JobInfo[]
  jobLogs?: Record<string, LogItem[]>
  notifications?: NotificationInfo[]
  plugins?: PluginInfo[]
}

export interface RecordedCall {
  method: string
  params: Record<string, unknown>
}

interface ActiveFollowStream {
  ws: any
  streamId: number
  jobId: string
}

export interface FakeRookeryServer {
  readonly baseUrl: string
  readonly wsUrl: string
  readonly calls: RecordedCall[]
  readonly followRequests: Array<{ id: string; after: number }>
  getHosts(): HostInfo[]
  getJob(id: string): JobInfo | undefined
  pushJobLog(jobId: string, item: LogItem): void
  finishJob(jobId: string, state: JobState, opts?: { result?: unknown; error?: ErrorBody | null }): void
  pushJobChanged(job: JobInfo): void
  pushNotification(notification: NotificationInfo): void
  pushNotificationChanged(notification: NotificationInfo): void
  pushHostChanged(event: { host: string; info?: HostInfo | null; removed?: boolean }): void
  closeSockets(): void
  stop(): void
}

export const TEST_USER: User = {
  id: "u-ada",
  name: "Ada Lovelace",
  email: "ada@example.test",
  admin: true,
}

export function errorBody(message: string, code: ErrorBody["code"] = "INTERNAL"): ErrorBody {
  return { code, message }
}

export function makeLogItem(overrides: Partial<LogItem> & Pick<LogItem, "seq" | "text">): LogItem {
  return {
    at: new Date().toISOString(),
    attempt: 1,
    level: "info",
    data: null,
    ...overrides,
  }
}

const enc = new TextEncoder()

function binaryFrame(streamId: number, text: string): Uint8Array {
  const payload = enc.encode(text)
  const out = new Uint8Array(4 + payload.byteLength)
  new DataView(out.buffer).setUint32(0, streamId)
  out.set(payload, 4)
  return out
}

function isTerminal(state: JobState): boolean {
  return state === "succeeded" || state === "failed" || state === "cancelled"
}

export function makeJob(overrides: Partial<JobInfo> & Pick<JobInfo, "id" | "kind" | "state">): JobInfo {
  const now = new Date().toISOString()
  return {
    params: null,
    subject: null,
    attempts: 1,
    maxAttempts: 1,
    cancelRequested: false,
    progress: null,
    result: null,
    error: null,
    enqueuedBy: TEST_USER.id,
    createdAt: now,
    startedAt: now,
    finishedAt: null,
    ...overrides,
  }
}

export function startFakeRookery(seed: FakeRookerySeed = {}): FakeRookeryServer {
  const hosts = new Map<string, HostInfo>((seed.hosts ?? []).map((h) => [h.name, structuredClone(h)]))
  const profiles = new Map<string, HostProfile>(
    Object.entries(seed.profiles ?? {}).map(([k, v]) => [k, structuredClone(v)]),
  )
  const actionsByHost = new Map<string, Action[]>(
    Object.entries(seed.actions ?? {}).map(([k, v]) => [k, structuredClone(v)]),
  )
  const checks = new Map<string, HostCheckResult>(Object.entries(seed.checks ?? {}))
  const jobs = new Map<string, JobInfo>((seed.jobs ?? []).map((j) => [j.id, structuredClone(j)]))
  const jobLogs = new Map<string, LogItem[]>(
    Object.entries(seed.jobLogs ?? {}).map(([k, v]) => [k, structuredClone(v)]),
  )
  const notifications = new Map<string, NotificationInfo>(
    (seed.notifications ?? []).map((n) => [n.id, structuredClone(n)]),
  )
  const plugins = seed.plugins ?? []

  const calls: RecordedCall[] = []
  const followRequests: Array<{ id: string; after: number }> = []
  const sockets = new Set<any>()
  const followStreams = new Map<number, ActiveFollowStream>()
  const eventSubs = new Map<string, { ws: any; names: string[] }>()
  let nextStreamId = 1
  let nextJobSeq = 100
  let nextSubSeq = 1

  const broadcast = (method: string, params: unknown) => {
    const wire = JSON.stringify({ jsonrpc: "2.0", method, params })
    for (const ws of sockets) ws.send(wire)
  }

  const unreadCount = () => Array.from(notifications.values()).filter((n) => !n.readAt).length

  const sendReply = (ws: any, id: unknown, result: unknown) => {
    ws.send(JSON.stringify({ jsonrpc: "2.0", id, result }))
  }

  const sendError = (ws: any, id: unknown, code: ErrorBody["code"], message: string) => {
    ws.send(JSON.stringify({ jsonrpc: "2.0", id, error: { code: -32000, message, data: { code } } }))
  }

  const closeFollowStream = (stream: ActiveFollowStream, end?: JobEnd) => {
    if (!followStreams.has(stream.streamId)) return
    followStreams.delete(stream.streamId)
    if (end) {
      stream.ws.send(binaryFrame(stream.streamId, `${JSON.stringify(end)}\n`))
    }
    stream.ws.send(
      JSON.stringify({
        jsonrpc: "2.0",
        method: "streams.close",
        params: { stream: stream.streamId },
      }),
    )
  }

  const pushJobChanged = (job: JobInfo) => {
    jobs.set(job.id, structuredClone(job))
    const changed: JobChanged = { job }
    broadcast("jobs.changed", changed)
  }

  const finishJob = (
    jobId: string,
    state: JobState,
    opts: { result?: unknown; error?: ErrorBody | null } = {},
  ) => {
    const existing = jobs.get(jobId)
    if (existing) {
      const finishedAt = new Date().toISOString()
      const updated: JobInfo = {
        ...existing,
        state,
        finishedAt,
        result: opts.result ?? null,
        error: opts.error ?? (state === "failed" ? errorBody("Job failed") : null),
      }
      pushJobChanged(updated)
    }
    const end: JobEnd = {
      state,
      result: opts.result ?? null,
      error: opts.error ?? (state === "failed" ? errorBody("Job failed") : null),
    }
    for (const s of Array.from(followStreams.values())) {
      if (s.jobId === jobId) closeFollowStream(s, end)
    }
  }

  const pushJobLog = (jobId: string, item: LogItem) => {
    const list = jobLogs.get(jobId) ?? []
    list.push(structuredClone(item))
    jobLogs.set(jobId, list)
    const line = `${JSON.stringify(item)}\n`
    for (const s of followStreams.values()) {
      if (s.jobId === jobId) {
        s.ws.send(binaryFrame(s.streamId, line))
      }
    }
  }

  const server = Bun.serve({
    port: 0,
    fetch(req, srv) {
      const url = new URL(req.url)
      if (url.pathname === "/ws") {
        if (srv.upgrade(req, { data: undefined })) return undefined
        return new Response("upgrade failed", { status: 400 })
      }
      if (url.pathname === "/auth/session") {
        const body: { user: User } = { user: TEST_USER }
        return Response.json(body)
      }
      if (url.pathname === "/auth/logout" && req.method === "POST") {
        return Response.json({ redirect: null })
      }
      return new Response("not found", { status: 404 })
    },
    websocket: {
      open(ws) {
        sockets.add(ws)
      },
      close(ws) {
        sockets.delete(ws)
        for (const [id, s] of followStreams.entries()) {
          if (s.ws === ws) followStreams.delete(id)
        }
        for (const [subId, sub] of eventSubs.entries()) {
          if (sub.ws === ws) eventSubs.delete(subId)
        }
      },
      message(ws, data) {
        if (typeof data !== "string" && !(data instanceof Buffer)) return
        const text = typeof data === "string" ? data : data.toString("utf8")
        if (!text.startsWith("{")) return
        const msg = JSON.parse(text) as {
          id?: unknown
          method?: string
          params?: Record<string, unknown>
        }
        if (!msg.method) return
        const params = msg.params ?? {}

        // Ignore client-to-server notifications without an id.
        if (msg.id === undefined) {
          if (msg.method === "streams.close") {
            const sid = Number(params.stream)
            followStreams.delete(sid)
          }
          return
        }

        calls.push({ method: msg.method, params: structuredClone(params) })

        switch (msg.method) {
          case "auth.me": {
            const me: Me = {
              user: TEST_USER,
              principal: { kind: "user", id: TEST_USER.id },
              admin: true,
              auth: "local",
              version: "0.4.0",
              apiVersion: 1,
            }
            sendReply(ws, msg.id, me)
            return
          }

          case "plugins.list": {
            const list: PluginList = { plugins }
            sendReply(ws, msg.id, list)
            return
          }

          case "commands.list": {
            const list: CommandList = { commands: [] }
            sendReply(ws, msg.id, list)
            return
          }

          case "events.subscribe": {
            const subId = `sub-${nextSubSeq++}`
            const names = Array.isArray(params.names)
              ? params.names.map(String)
              : [String(params.names ?? "")]
            eventSubs.set(subId, { ws, names })
            const subscribed: EventSubscribed = { subscription: subId }
            sendReply(ws, msg.id, subscribed)
            return
          }

          case "events.unsubscribe":
            eventSubs.delete(String(params.subscription ?? ""))
            sendReply(ws, msg.id, {})
            return

          // ---------------- Hosts (hosts.* is not on the server yet) ----------------
          case "hosts.list": {
            const list: HostsListResult = { hosts: Array.from(hosts.values()) }
            sendReply(ws, msg.id, list)
            return
          }

          case "hosts.get": {
            const name = String(params.host ?? "")
            const h = hosts.get(name)
            if (!h) {
              sendError(ws, msg.id, "NOT_FOUND", `host ${name} not found`)
              return
            }
            const result: HostsGetResult = h
            sendReply(ws, msg.id, result)
            return
          }

          case "hosts.save": {
            const p = params as unknown as HostsSaveParams
            const existing = hosts.get(p.host)
            const saved: HostInfo = existing
              ? {
                  ...existing,
                  address: p.profile.access?.address ?? existing.address,
                  type: p.profile.type ?? existing.type,
                }
              : {
                  id: `host-${p.host}`,
                  name: p.host,
                  address: p.profile.access?.address ?? "192.0.2.99",
                  reachable: true,
                  version: null,
                  api: null,
                  error: null,
                  applied: null,
                  behind: null,
                  type: p.profile.type ?? "ssh",
                  seen: null,
                  rotating: false,
                  power: { start: false, stop: false, state: "running" },
                  machine: null,
                }
            hosts.set(p.host, saved)
            profiles.set(p.host, structuredClone(p.profile))
            const result: HostsSaveResult = { host: saved }
            sendReply(ws, msg.id, result)
            return
          }

          case "hosts.remove": {
            const name = String(params.host ?? "")
            hosts.delete(name)
            profiles.delete(name)
            actionsByHost.delete(name)
            const result: HostsRemoveResult = {}
            sendReply(ws, msg.id, result)
            return
          }

          case "hosts.rename": {
            const from = String(params.host ?? "")
            const to = String(params.to ?? "")
            const h = hosts.get(from)
            if (!h) {
              sendError(ws, msg.id, "NOT_FOUND", `host ${from} not found`)
              return
            }
            const renamed = { ...h, name: to }
            hosts.delete(from)
            hosts.set(to, renamed)
            const prof = profiles.get(from)
            if (prof) {
              profiles.delete(from)
              profiles.set(to, prof)
            }
            const result: HostsRenameResult = { host: renamed }
            sendReply(ws, msg.id, result)
            return
          }

          case "hosts.profile": {
            const name = String(params.host ?? "")
            const prof = profiles.get(name) ?? {}
            const result: HostsProfileResult = { profile: prof }
            sendReply(ws, msg.id, result)
            return
          }

          case "hosts.check": {
            const key = `${String(params.host ?? "")}:${String(params.capability ?? "")}`
            const res: HostsCheckResult = checks.get(key) ?? { allowed: true, refusal: null }
            sendReply(ws, msg.id, res)
            return
          }

          case "hosts.actions": {
            const name = String(params.host ?? "")
            const result: HostsActionsResult = { actions: actionsByHost.get(name) ?? [] }
            sendReply(ws, msg.id, result)
            return
          }

          case "hosts.act": {
            const p = params as unknown as HostsActParams
            const jobId = `job-${nextJobSeq++}`
            const now = new Date().toISOString()
            const created = makeJob({
              id: jobId,
              kind: `host.${p.action}`,
              subject: `host://${p.host}`,
              params: { host: p.host, action: p.action, ...(p.arguments ? { arguments: p.arguments } : {}) },
              state: "running",
              createdAt: now,
              startedAt: now,
            })
            jobs.set(jobId, created)
            jobLogs.set(jobId, [makeLogItem({ seq: 1, at: now, text: `Starting ${p.action} on ${p.host}` })])
            const changed: JobChanged = { job: created }
            broadcast("jobs.changed", changed)
            const result: HostsActResult = { job: jobId, state: "running" }
            sendReply(ws, msg.id, result)
            return
          }

          // ---------------- Jobs ----------------
          case "jobs.list": {
            let list = Array.from(jobs.values())
            if (typeof params.state === "string" && params.state) {
              list = list.filter((j) => j.state === params.state)
            }
            if (typeof params.kind === "string" && params.kind) {
              list = list.filter((j) => j.kind === params.kind)
            }
            if (typeof params.subject === "string" && params.subject) {
              list = list.filter((j) => j.subject === params.subject)
            }
            if (typeof params.limit === "number") {
              list = list.slice(0, params.limit)
            }
            const res: JobList = { jobs: list }
            sendReply(ws, msg.id, res)
            return
          }

          case "jobs.get": {
            const id = String(params.id ?? "")
            const job = jobs.get(id)
            if (!job) {
              sendError(ws, msg.id, "NOT_FOUND", `job ${id} not found`)
              return
            }
            const detail: JobDetail = { job, attempts: [] }
            sendReply(ws, msg.id, detail)
            return
          }

          case "jobs.cancel": {
            const id = String(params.id ?? "")
            const job = jobs.get(id)
            if (!job) {
              sendError(ws, msg.id, "NOT_FOUND", `job ${id} not found`)
              return
            }
            finishJob(id, "cancelled", { error: null })
            sendReply(ws, msg.id, {})
            return
          }

          case "jobs.retry": {
            const id = String(params.id ?? "")
            const prev = jobs.get(id)
            if (!prev) {
              sendError(ws, msg.id, "NOT_FOUND", `job ${id} not found`)
              return
            }
            const retryId = `job-${nextJobSeq++}`
            const now = new Date().toISOString()
            const retried: JobInfo = {
              ...prev,
              id: retryId,
              state: "running",
              attempts: prev.attempts + 1,
              maxAttempts: Math.max(prev.maxAttempts, prev.attempts + 1),
              createdAt: now,
              startedAt: now,
              finishedAt: null,
              progress: null,
              result: null,
              error: null,
            }
            jobs.set(retryId, retried)
            jobLogs.set(retryId, [makeLogItem({ seq: 1, at: now, text: `Retrying ${prev.kind}` })])
            const changed: JobChanged = { job: retried }
            broadcast("jobs.changed", changed)
            sendReply(ws, msg.id, retried)
            return
          }

          case "jobs.follow": {
            const jobId = String(params.id ?? "")
            const after = typeof params.after === "number" ? params.after : 0
            followRequests.push({ id: jobId, after })
            const job = jobs.get(jobId)
            if (!job) {
              sendError(ws, msg.id, "NOT_FOUND", `job ${jobId} not found`)
              return
            }
            const streamId = nextStreamId++
            const opened: StreamOpened = { stream: streamId }
            sendReply(ws, msg.id, opened)
            const entry: ActiveFollowStream = { ws, streamId, jobId }
            followStreams.set(streamId, entry)

            const existing = (jobLogs.get(jobId) ?? []).filter((item) => item.seq > after)
            if (existing.length > 0) {
              const ndjson = `${existing.map((i) => JSON.stringify(i)).join("\n")}\n`
              ws.send(binaryFrame(streamId, ndjson))
            }
            if (isTerminal(job.state)) {
              const end: JobEnd = { state: job.state, result: job.result, error: job.error }
              closeFollowStream(entry, end)
            }
            return
          }

          // ---------------- Notifications ----------------
          case "notify.list": {
            let list = Array.from(notifications.values())
            if (params.unread === true) {
              list = list.filter((n) => !n.readAt)
            }
            if (typeof params.limit === "number") {
              list = list.slice(0, params.limit)
            }
            list.sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime())
            const page: NotificationList = { notifications: list, unread: unreadCount() }
            sendReply(ws, msg.id, page)
            return
          }

          case "notify.read": {
            const ids = Array.isArray(params.ids) ? (params.ids as string[]) : null
            const now = new Date().toISOString()
            const changed: NotificationInfo[] = []
            let count = 0
            for (const [id, n] of notifications.entries()) {
              if (ids && !ids.includes(id)) continue
              if (n.readAt) continue
              const updated: NotificationInfo = { ...n, readAt: now }
              notifications.set(id, updated)
              changed.push(updated)
              count++
            }
            if (changed.length > 0) {
              const event: NotifyChanged = { notifications: changed, unread: unreadCount() }
              broadcast("notify.changed", event)
            }
            const res: Count = { count }
            sendReply(ws, msg.id, res)
            return
          }

          case "notify.answer": {
            const id = String(params.id ?? "")
            const action = String(params.answer ?? "")
            const n = notifications.get(id)
            if (!n) {
              sendError(ws, msg.id, "NOT_FOUND", `notification ${id} not found`)
              return
            }
            const updated: NotificationInfo = {
              ...n,
              readAt: n.readAt ?? new Date().toISOString(),
              answer: action,
            }
            notifications.set(id, updated)
            const event: NotifyChanged = { notifications: [updated], unread: unreadCount() }
            broadcast("notify.changed", event)
            sendReply(ws, msg.id, updated)
            return
          }

          default:
            sendError(ws, msg.id, "NOT_FOUND", `unknown method ${msg.method}`)
        }
      },
    },
  })

  return {
    baseUrl: `http://127.0.0.1:${server.port}`,
    wsUrl: `ws://127.0.0.1:${server.port}/ws`,
    calls,
    followRequests,
    getHosts: () => Array.from(hosts.values()),
    getJob: (id) => jobs.get(id),
    pushJobLog,
    finishJob,
    pushJobChanged,
    pushNotification(notification) {
      notifications.set(notification.id, structuredClone(notification))
      const event: NotifyNew = { notification, unread: unreadCount(), native: false }
      broadcast("notify.new", event)
    },
    pushNotificationChanged(notification) {
      notifications.set(notification.id, structuredClone(notification))
      const event: NotifyChanged = { notifications: [notification], unread: unreadCount() }
      broadcast("notify.changed", event)
    },
    pushHostChanged(event) {
      if (event.removed) {
        hosts.delete(event.host)
      } else if (event.info) {
        hosts.set(event.info.name, structuredClone(event.info))
      }
      for (const [subscription, sub] of eventSubs.entries()) {
        const name = "rookery/hosts.changed"
        const wanted = sub.names.some((n) => (n.endsWith("*") ? name.startsWith(n.slice(0, -1)) : n === name))
        if (wanted) {
          const notice: EventNotice = { subscription, name, payload: event }
          sub.ws.send(JSON.stringify({ jsonrpc: "2.0", method: "events.event", params: notice }))
        }
      }
    },
    closeSockets() {
      for (const ws of sockets) ws.close(1012, "drop")
    },
    stop() {
      server.stop(true)
    },
  }
}
