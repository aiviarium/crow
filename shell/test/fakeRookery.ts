// Reusable fake Rookery WebSocket/HTTP server for Bun tests. Implements every RPC method and
// stream in `plugins/fleet/src/api.ts`, plus `jobs.*` (with binary NDJSON `jobs.follow` streams
// honoring `after` cursors) and `notify.*` (with live `notify.new` / `notify.changed` events).
import type { JobDetail, JobInfo, JobLogItem, JobState, NotificationInfo, PluginInfo } from "@rookery/client"
import type {
  Action,
  HostCheckResult,
  HostInfo,
  HostProfile,
  HostsActParams,
  HostsSaveParams,
} from "../../plugins/fleet/src/api"

export interface FakeRookerySeed {
  hosts?: HostInfo[]
  profiles?: Record<string, HostProfile>
  actions?: Record<string, Action[]>
  checks?: Record<string, HostCheckResult>
  jobs?: JobInfo[]
  jobLogs?: Record<string, JobLogItem[]>
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
  pushJobLog(jobId: string, item: JobLogItem): void
  finishJob(jobId: string, state: JobState, opts?: { result?: unknown; error?: string | null }): void
  pushJobChanged(job: JobInfo): void
  pushNotification(notification: NotificationInfo): void
  pushNotificationChanged(notification: NotificationInfo): void
  pushHostChanged(event: { host: string; info?: HostInfo | null; removed?: boolean }): void
  closeSockets(): void
  stop(): void
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

export function makeJob(
  overrides: Partial<JobInfo> & Pick<JobInfo, "id" | "plugin" | "name" | "state">,
): JobInfo {
  const now = overrides.createdAt ?? new Date().toISOString()
  return {
    uri: `job://${overrides.id}`,
    priority: 0,
    attempts: 1,
    maxAttempts: 1,
    timeoutSecs: 300,
    params: {},
    principal: "user:u-ada",
    cancelRequested: false,
    runAt: now,
    createdAt: now,
    updatedAt: now,
    startedAt: now,
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
  const jobLogs = new Map<string, JobLogItem[]>(
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
  const eventSubs = new Map<string, { ws: any; topic: string }>()
  let nextStreamId = 1
  let nextJobSeq = 100
  let nextSubSeq = 1

  const broadcast = (method: string, params: unknown) => {
    const wire = JSON.stringify({ jsonrpc: "2.0", method, params })
    for (const ws of sockets) ws.send(wire)
  }

  const unreadCount = () =>
    Array.from(notifications.values()).filter((n) => !n.readAt && !n.archivedAt).length

  const sendReply = (ws: any, id: unknown, result: unknown) => {
    ws.send(JSON.stringify({ jsonrpc: "2.0", id, result }))
  }

  const sendError = (ws: any, id: unknown, code: string, message: string) => {
    ws.send(
      JSON.stringify({
        jsonrpc: "2.0",
        id,
        error: { code: -32000, message, data: { code } },
      }),
    )
  }

  const closeFollowStream = (
    stream: ActiveFollowStream,
    done?: { state: JobState; result?: unknown; error?: string | null },
  ) => {
    if (!followStreams.has(stream.streamId)) return
    followStreams.delete(stream.streamId)
    if (done) {
      stream.ws.send(binaryFrame(stream.streamId, `${JSON.stringify(done)}\n`))
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
    broadcast("jobs.changed", { job })
  }

  const finishJob = (
    jobId: string,
    state: JobState,
    opts: { result?: unknown; error?: string | null } = {},
  ) => {
    const existing = jobs.get(jobId)
    if (existing) {
      const now = new Date().toISOString()
      const updated: JobInfo = {
        ...existing,
        state,
        updatedAt: now,
        finishedAt: now,
        error: opts.error ?? (state === "failed" ? "Job failed" : undefined),
      }
      pushJobChanged(updated)
    }
    const done = { state, result: opts.result ?? null, error: opts.error ?? null }
    for (const s of Array.from(followStreams.values())) {
      if (s.jobId === jobId) closeFollowStream(s, done)
    }
  }

  const pushJobLog = (jobId: string, item: JobLogItem) => {
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
        return Response.json({
          user: { id: "u-ada", name: "Ada Lovelace", email: "ada@example.test", admin: true },
        })
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
          case "auth.me":
            sendReply(ws, msg.id, {
              user: { id: "u-ada", name: "Ada Lovelace", email: "ada@example.test", admin: true },
              principal: { kind: "user", id: "u-ada" },
              dev: false,
              localAuth: true,
              kernelVersion: "0.4.0",
              apiVersion: 1,
            })
            return

          case "plugins.list":
            sendReply(ws, msg.id, { plugins })
            return

          case "commands.list":
            sendReply(ws, msg.id, { commands: [] })
            return

          case "events.subscribe": {
            const subId = `sub-${nextSubSeq++}`
            eventSubs.set(subId, { ws, topic: String(params.topic ?? "") })
            sendReply(ws, msg.id, { subscription: subId })
            return
          }

          case "events.unsubscribe":
            eventSubs.delete(String(params.subscription ?? ""))
            sendReply(ws, msg.id, {})
            return

          // ---------------- Hosts (plugins/fleet/src/api.ts) ----------------
          case "hosts.list":
            sendReply(ws, msg.id, { hosts: Array.from(hosts.values()) })
            return

          case "hosts.get": {
            const name = String(params.host ?? "")
            const h = hosts.get(name)
            if (!h) {
              sendError(ws, msg.id, "NOT_FOUND", `host ${name} not found`)
              return
            }
            sendReply(ws, msg.id, h)
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
            sendReply(ws, msg.id, { host: saved })
            return
          }

          case "hosts.remove": {
            const name = String(params.host ?? "")
            hosts.delete(name)
            profiles.delete(name)
            actionsByHost.delete(name)
            sendReply(ws, msg.id, {})
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
            sendReply(ws, msg.id, { host: renamed })
            return
          }

          case "hosts.profile": {
            const name = String(params.host ?? "")
            const prof = profiles.get(name) ?? {}
            sendReply(ws, msg.id, { profile: prof })
            return
          }

          case "hosts.check": {
            const key = `${String(params.host ?? "")}:${String(params.capability ?? "")}`
            const res = checks.get(key) ?? { allowed: true, refusal: null }
            sendReply(ws, msg.id, res)
            return
          }

          case "hosts.actions": {
            const name = String(params.host ?? "")
            sendReply(ws, msg.id, { actions: actionsByHost.get(name) ?? [] })
            return
          }

          case "hosts.act": {
            const p = params as unknown as HostsActParams
            const jobId = `job-${nextJobSeq++}`
            const now = new Date().toISOString()
            const created = makeJob({
              id: jobId,
              plugin: "hosts",
              name: `${p.host}.${p.action}`,
              params: { host: p.host, action: p.action, ...(p.arguments ? { arguments: p.arguments } : {}) },
              state: "running",
              createdAt: now,
              startedAt: now,
              updatedAt: now,
            })
            jobs.set(jobId, created)
            jobLogs.set(jobId, [
              {
                seq: 1,
                at: now,
                payload: { type: "output", level: "info", text: `Starting ${p.action} on ${p.host}` },
              },
            ])
            broadcast("jobs.changed", { job: created })
            sendReply(ws, msg.id, { job: jobId, state: "running" })
            return
          }

          // ---------------- Jobs ----------------
          case "jobs.list": {
            let list = Array.from(jobs.values())
            if (typeof params.state === "string" && params.state) {
              list = list.filter((j) => j.state === params.state)
            }
            if (typeof params.plugin === "string" && params.plugin) {
              list = list.filter((j) => j.plugin === params.plugin)
            }
            if (typeof params.limit === "number") {
              list = list.slice(0, params.limit)
            }
            sendReply(ws, msg.id, { jobs: list })
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
              uri: `job://${retryId}`,
              state: "running",
              attempts: prev.attempts + 1,
              maxAttempts: Math.max(prev.maxAttempts, prev.attempts + 1),
              createdAt: now,
              startedAt: now,
              updatedAt: now,
              finishedAt: undefined,
              error: undefined,
            }
            jobs.set(retryId, retried)
            jobLogs.set(retryId, [
              {
                seq: 1,
                at: now,
                payload: { type: "output", level: "info", text: `Retrying ${prev.name}` },
              },
            ])
            broadcast("jobs.changed", { job: retried })
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
            sendReply(ws, msg.id, { stream: streamId })
            const entry: ActiveFollowStream = { ws, streamId, jobId }
            followStreams.set(streamId, entry)

            const existing = (jobLogs.get(jobId) ?? []).filter((item) => item.seq > after)
            if (existing.length > 0) {
              const ndjson = `${existing.map((i) => JSON.stringify(i)).join("\n")}\n`
              ws.send(binaryFrame(streamId, ndjson))
            }
            if (isTerminal(job.state)) {
              closeFollowStream(entry, { state: job.state, error: job.error ?? null })
            }
            return
          }

          // ---------------- Notifications ----------------
          case "notify.list": {
            let list = Array.from(notifications.values())
            if (params.archived === true) {
              list = list.filter((n) => Boolean(n.archivedAt))
            } else {
              list = list.filter((n) => !n.archivedAt)
            }
            if (params.unreadOnly === true) {
              list = list.filter((n) => !n.readAt)
            }
            if (typeof params.kind === "string" && params.kind) {
              list = list.filter((n) => n.kind === params.kind)
            }
            list.sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime())
            sendReply(ws, msg.id, { notifications: list, unread: unreadCount() })
            return
          }

          case "notify.read": {
            const ids = Array.isArray(params.ids)
              ? (params.ids as string[])
              : typeof params.id === "string"
                ? [params.id]
                : []
            const now = new Date().toISOString()
            for (const id of ids) {
              const n = notifications.get(id)
              if (n && !n.readAt) {
                const updated = { ...n, readAt: now }
                notifications.set(id, updated)
                broadcast("notify.changed", { notification: updated, unread: unreadCount() })
              }
            }
            sendReply(ws, msg.id, { unread: unreadCount() })
            return
          }

          case "notify.unread": {
            const ids = Array.isArray(params.ids)
              ? (params.ids as string[])
              : typeof params.id === "string"
                ? [params.id]
                : []
            for (const id of ids) {
              const n = notifications.get(id)
              if (n) {
                const updated = { ...n, readAt: undefined }
                notifications.set(id, updated)
                broadcast("notify.changed", { notification: updated, unread: unreadCount() })
              }
            }
            sendReply(ws, msg.id, { unread: unreadCount() })
            return
          }

          case "notify.readAll": {
            const now = new Date().toISOString()
            for (const [id, n] of notifications.entries()) {
              if (!n.readAt && !n.archivedAt) {
                notifications.set(id, { ...n, readAt: now })
              }
            }
            sendReply(ws, msg.id, { unread: unreadCount() })
            return
          }

          case "notify.archive": {
            const ids = Array.isArray(params.ids)
              ? (params.ids as string[])
              : typeof params.id === "string"
                ? [params.id]
                : []
            const now = new Date().toISOString()
            for (const id of ids) {
              const n = notifications.get(id)
              if (n) {
                const updated = { ...n, archivedAt: now, readAt: n.readAt ?? now }
                notifications.set(id, updated)
                broadcast("notify.changed", { notification: updated, unread: unreadCount() })
              }
            }
            sendReply(ws, msg.id, { unread: unreadCount() })
            return
          }

          case "notify.answer": {
            const id = String(params.id ?? "")
            const action = String(params.action ?? "")
            const text = typeof params.text === "string" ? params.text : undefined
            const n = notifications.get(id)
            if (!n) {
              sendError(ws, msg.id, "NOT_FOUND", `notification ${id} not found`)
              return
            }
            const now = new Date().toISOString()
            const updated: NotificationInfo = {
              ...n,
              readAt: n.readAt ?? now,
              answer: {
                action,
                by: "u-ada",
                at: now,
                ...(text !== undefined ? { text } : {}),
              },
            }
            notifications.set(id, updated)
            broadcast("notify.changed", { notification: updated, unread: unreadCount() })
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
      broadcast("notify.new", { notification, unread: unreadCount() })
    },
    pushNotificationChanged(notification) {
      notifications.set(notification.id, structuredClone(notification))
      broadcast("notify.changed", { notification, unread: unreadCount() })
    },
    pushHostChanged(event) {
      if (event.removed) {
        hosts.delete(event.host)
      } else if (event.info) {
        hosts.set(event.info.name, structuredClone(event.info))
      }
      for (const [subscription, sub] of eventSubs.entries()) {
        if (sub.topic === "hosts.changed") {
          sub.ws.send(
            JSON.stringify({
              jsonrpc: "2.0",
              method: "events.event",
              params: { subscription, topic: "hosts.changed", payload: event },
            }),
          )
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
