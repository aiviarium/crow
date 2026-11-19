// In-process fake Parrot runtime served over a fake Rookery WebSocket server's `agents.connect`
// binary stream (NDJSON JSON-RPC 2.0). Used by `agents.test.tsx` to test the Agents plugin
// end-to-end through `@rookery/client`'s plugin loader without modifying `shell/test/fakeRookery.ts`.
import type {
  Action,
  Agent,
  Answer,
  ConfigOption,
  Environment,
  ItemPatch,
  Request,
  Session,
  SessionNewParams,
  SessionPromptParams,
  SessionSnapshot,
  SessionSummary,
  State,
  SubscribeParams,
  Update,
  Usage,
} from "@aiviarium/parrot-client"
import type { EnvInfo, Me, StreamOpened, User } from "@rookery/client"
import type { ParrotItem } from "../src/parrot"
import { applyItemPatch } from "../src/parrot"

const enc = new TextEncoder()
const dec = new TextDecoder()

const TEST_USER: User = {
  id: "u-ada",
  name: "Ada Lovelace",
  email: "ada@example.test",
  admin: true,
}

function binaryFrame(streamId: number, text: string): Uint8Array {
  const payload = enc.encode(text)
  const out = new Uint8Array(4 + payload.byteLength)
  new DataView(out.buffer).setUint32(0, streamId)
  out.set(payload, 4)
  return out
}

export interface FakeSessionRecord {
  session: Session
  items: ParrotItem[]
  requests: Request[]
  options: ConfigOption[]
  actions: Action[]
  usage: Usage | null
}

export interface PromptScenarioContext {
  host: FakeParrotHost
  record: FakeSessionRecord
  prompt: SessionPromptParams
  turnId: string
  emitItem(patch: ItemPatch): void
  emitRequest(request: Request): void
  emitState(state: State, detail?: string | null): void
  emitUsage(usage: Usage): void
  emitNotice(level: "info" | "warning" | "error", text: string): void
}

export interface AnswerScenarioContext {
  host: FakeParrotHost
  record: FakeSessionRecord
  request: Request
  answer: Answer
  emitItem(patch: ItemPatch): void
  emitRequest(request: Request): void
  emitState(state: State, detail?: string | null): void
  emitUsage(usage: Usage): void
}

export interface FakeParrotHostSeed {
  name: string
  state?: "online" | "offline"
  kind?: string
  agents?: Agent[]
  sessions?: FakeSessionRecord[]
  onPrompt?: (ctx: PromptScenarioContext) => void | Promise<void>
  onAnswer?: (ctx: AnswerScenarioContext) => void | Promise<void>
}

interface ActiveParrotStream {
  ws: any
  streamId: number
  host: FakeParrotHost
  buf: string
  subs: Map<string, { target: SubscribeParams["target"] }>
}

export function defaultAgents(): Agent[] {
  return [
    {
      id: "claude",
      name: "Claude Code",
      driver: { name: "claude", version: "1.0.0", kind: "builtin", data: "1" },
      harness: { version: "2.1.0", verified: true },
      installed: true,
      auth: "signed_in",
      usable: true,
      controls: ["native", "tui"],
      features: {},
      levels: ["read", "write", "sandboxed", "host"],
      isolation: ["none", "sandbox"],
      options: [
        {
          id: "model",
          role: "model",
          label: "Model",
          applies: "now",
          value: "claude-sonnet-4-6",
          schema: {
            oneOf: [
              { const: "claude-sonnet-4-6", title: "Sonnet 4.6", description: "Fast and capable" },
              { const: "claude-opus-4-6", title: "Opus 4.6", description: "Deep reasoning" },
            ],
          },
        },
        {
          id: "mode",
          role: "mode",
          label: "Mode",
          applies: "now",
          value: "default",
          schema: {
            oneOf: [
              { const: "default", title: "Default", description: "Ask before edits" },
              { const: "plan", title: "Plan", description: "Read-only planning" },
            ],
          },
        },
        {
          id: "effort",
          role: "effort",
          label: "Effort",
          applies: "now",
          value: "medium",
          schema: { enum: ["low", "medium", "high"] },
        },
      ],
      actions: [
        {
          id: "compact",
          name: "/compact",
          label: "Compact",
          description: "Compact conversation context",
          scope: "session",
          when: ["idle"],
          effects: ["write"],
          source: "harness",
        },
      ],
    },
    {
      id: "codex",
      name: "Codex",
      driver: { name: "codex", version: "1.0.0", kind: "builtin", data: "1" },
      harness: { version: "0.40.0", verified: true },
      installed: true,
      auth: "signed_in",
      usable: true,
      controls: ["native"],
      features: {},
      levels: ["read", "write", "sandboxed", "host"],
      isolation: ["sandbox"],
      options: [
        {
          id: "model",
          role: "model",
          label: "Model",
          applies: "now",
          value: "gpt-5-codex",
          schema: {
            oneOf: [{ const: "gpt-5-codex", title: "GPT-5 Codex" }],
          },
        },
      ],
      actions: [],
    },
  ]
}

export function makeSessionRecord(opts: {
  id: string
  host: string
  agent?: string
  title?: string
  cwd?: string
  state?: State
  items?: ParrotItem[]
  requests?: Request[]
  options?: ConfigOption[]
  actions?: Action[]
  usage?: Usage | null
  updated?: string
}): FakeSessionRecord {
  const now = opts.updated ?? new Date().toISOString()
  const agent = opts.agent ?? "claude"
  const session: Session = {
    id: opts.id,
    runtime: `rt-${opts.host}`,
    title: opts.title ?? null,
    workspace: "ws-default",
    cwd: opts.cwd ?? "/srv/project",
    state: opts.state ?? "idle",
    background: [],
    binding: {
      id: `bind-${opts.id}`,
      session: opts.id,
      agent,
      env: `env-${opts.host}`,
      control: "native",
      isolation: "none",
      level: "write",
      network: true,
      status: opts.state === "stopped" ? "stopped" : "running",
      via: "new",
      started: now,
    },
    bindings: [`bind-${opts.id}`],
    kind: "root",
    origin: { kind: "client", principal: TEST_USER.email },
    grant: ["read", "prompt", "answer", "configure", "manage"],
    ceiling: {},
    advisory: false,
    created: now,
    updated: now,
    archived: false,
  }
  return {
    session,
    items: opts.items ?? [],
    requests: opts.requests ?? [],
    options: opts.options ?? defaultAgents().find((a) => a.id === agent)?.options ?? [],
    actions: opts.actions ?? defaultAgents().find((a) => a.id === agent)?.actions ?? [],
    usage: opts.usage ?? null,
  }
}

export class FakeParrotHost {
  readonly name: string
  readonly runtimeId: string
  readonly envId: string
  readonly state: "online" | "offline"
  readonly kind: string
  readonly agents: Agent[]
  readonly sessions = new Map<string, FakeSessionRecord>()
  readonly rpcLog: Array<{ method: string; params: unknown }> = []
  private streams = new Set<ActiveParrotStream>()
  private seq = 0
  private subSeq = 0
  private sessSeq = 0
  private turnSeq = 0
  private msgSeq = 0
  private onPrompt?: (ctx: PromptScenarioContext) => void | Promise<void>
  private onAnswer?: (ctx: AnswerScenarioContext) => void | Promise<void>

  constructor(seed: FakeParrotHostSeed) {
    this.name = seed.name
    this.runtimeId = `rt-${seed.name}`
    this.envId = `env-${seed.name}`
    this.state = seed.state ?? "online"
    this.kind = seed.kind ?? "host"
    this.agents = structuredClone(seed.agents ?? defaultAgents())
    for (const s of seed.sessions ?? []) {
      this.sessions.set(s.session.id, structuredClone(s))
    }
    this.onPrompt = seed.onPrompt
    this.onAnswer = seed.onAnswer
  }

  attach(stream: ActiveParrotStream) {
    this.streams.add(stream)
  }

  detach(stream: ActiveParrotStream) {
    this.streams.delete(stream)
  }

  private nextSeq(): string {
    return String(++this.seq)
  }

  private summaryOf(rec: FakeSessionRecord): SessionSummary {
    const s = rec.session
    return {
      id: s.id,
      runtime: s.runtime,
      title: s.title ?? null,
      state: s.state,
      kind: s.kind,
      parent: s.parent?.session ?? null,
      agent: s.binding?.agent ?? null,
      env: s.binding?.env ?? null,
      task: null,
      archived: s.archived,
      updated: s.updated,
    }
  }

  private snapshotOf(rec: FakeSessionRecord): SessionSnapshot {
    return {
      session: structuredClone(rec.session),
      items: structuredClone(rec.items) as unknown as SessionSnapshot["items"],
      requests: structuredClone(rec.requests),
      queue: { paused: false, entries: [] },
      options: structuredClone(rec.options),
      actions: structuredClone(rec.actions),
      usage: rec.usage ? structuredClone(rec.usage) : null,
      subscribers: [],
    }
  }

  private sendLine(stream: ActiveParrotStream, msg: unknown) {
    stream.ws.send(binaryFrame(stream.streamId, `${JSON.stringify(msg)}\n`))
  }

  broadcastSession(sessionId: string, update: Update) {
    const seq = this.nextSeq()
    const at = new Date().toISOString()
    for (const st of this.streams) {
      for (const [subId, entry] of st.subs) {
        if ("session" in entry.target && entry.target.session === sessionId) {
          this.sendLine(st, {
            jsonrpc: "2.0",
            method: "update",
            params: {
              subscription: subId,
              seq,
              runtime: this.runtimeId,
              at,
              session: sessionId,
              update,
            },
          })
        }
      }
    }
  }

  broadcastIndex(update: Update) {
    const seq = this.nextSeq()
    const at = new Date().toISOString()
    for (const st of this.streams) {
      for (const [subId, entry] of st.subs) {
        if ("index" in entry.target && entry.target.index) {
          this.sendLine(st, {
            jsonrpc: "2.0",
            method: "update",
            params: {
              subscription: subId,
              seq,
              runtime: this.runtimeId,
              at,
              update,
            },
          })
        }
      }
    }
  }

  emitItem(rec: FakeSessionRecord, patch: ItemPatch) {
    rec.items = applyItemPatch(rec.items, patch)
    rec.session.updated = new Date().toISOString()
    this.broadcastSession(rec.session.id, { type: "item", item: patch })
  }

  emitRequest(rec: FakeSessionRecord, req: Request) {
    const idx = rec.requests.findIndex((r) => r.id === req.id)
    if (idx === -1) rec.requests.push(structuredClone(req))
    else rec.requests[idx] = structuredClone(req)
    this.broadcastSession(rec.session.id, { type: "request", request: req })
  }

  emitState(rec: FakeSessionRecord, state: State, detail?: string | null) {
    rec.session.state = state
    rec.session.updated = new Date().toISOString()
    this.broadcastSession(rec.session.id, {
      type: "state",
      state,
      background: rec.session.background,
      ...(detail !== undefined ? { detail } : {}),
    })
    this.broadcastIndex({ type: "summary", session: this.summaryOf(rec) })
  }

  emitUsage(rec: FakeSessionRecord, usage: Usage) {
    rec.usage = structuredClone(usage)
    this.broadcastSession(rec.session.id, { type: "usage", usage })
  }

  emitNotice(rec: FakeSessionRecord, level: "info" | "warning" | "error", text: string) {
    this.broadcastSession(rec.session.id, { type: "notice", level, text })
  }

  handleMessage(stream: ActiveParrotStream, raw: string) {
    const msg = JSON.parse(raw) as { id?: unknown; method?: string; params?: any }
    if (!msg.method) return
    this.rpcLog.push({ method: msg.method, params: msg.params })

    const reply = (result: unknown) => {
      if (msg.id !== undefined) {
        this.sendLine(stream, { jsonrpc: "2.0", id: msg.id, result })
      }
    }
    const fail = (code: number, message: string) => {
      if (msg.id !== undefined) {
        this.sendLine(stream, { jsonrpc: "2.0", id: msg.id, error: { code, message } })
      }
    }

    const p = msg.params ?? {}
    switch (msg.method) {
      case "initialize": {
        reply({
          protocol: 1,
          peer: { kind: "runtime", name: "fake-parrot", version: "0.1.0" },
          runtime: { id: this.runtimeId, env: this.envId },
          features: {},
          connection: {
            id: `conn-${stream.streamId}`,
            principal: TEST_USER.email,
            scopes: ["read", "prompt", "answer", "configure", "manage"],
          },
        })
        return
      }
      case "subscribe": {
        const subId = `sub-${++this.subSeq}`
        const target = p.target as SubscribeParams["target"]
        stream.subs.set(subId, { target })
        if ("index" in target && target.index) {
          const env: Environment = {
            id: this.envId,
            runtime: this.runtimeId,
            name: this.name,
            os: "linux",
            arch: "x86_64",
            status: "online",
            roots: ["/srv"],
            features: {},
          }
          reply({
            subscription: subId,
            head: String(this.seq),
            snapshot: {
              index: {
                sessions: [...this.sessions.values()].map((r) => this.summaryOf(r)),
                agents: structuredClone(this.agents),
                envs: [env],
              },
            },
          })
          return
        }
        if ("session" in target) {
          const rec = this.sessions.get(target.session)
          if (!rec) return fail(-32004, `session not found: ${target.session}`)
          reply({
            subscription: subId,
            head: String(this.seq),
            snapshot: { sessions: [this.snapshotOf(rec)] },
          })
          return
        }
        reply({ subscription: subId, head: String(this.seq) })
        return
      }
      case "unsubscribe": {
        stream.subs.delete(String(p.subscription))
        reply({})
        return
      }
      case "agent/list": {
        reply({ agents: structuredClone(this.agents) })
        return
      }
      case "session/list": {
        const sessions = [...this.sessions.values()]
          .filter((r) => (p.archived === false ? !r.session.archived : true))
          .map((r) => this.summaryOf(r))
        reply({ sessions })
        return
      }
      case "workspace/list": {
        reply({ workspaces: [] })
        return
      }
      case "session/get": {
        const rec = this.sessions.get(String(p.session))
        if (!rec) return fail(-32004, `session not found: ${p.session}`)
        reply({ session: structuredClone(rec.session) })
        return
      }
      case "session/new": {
        const params = p as SessionNewParams
        const id = `ses-${this.name}-${++this.sessSeq}`
        const cwd =
          params.workspace && params.workspace.kind === "dir"
            ? params.workspace.path
            : params.workspace && params.workspace.kind === "worktree"
              ? params.workspace.repo
              : (params.cwd ?? "/srv/project")
        const rec = makeSessionRecord({
          id,
          host: this.name,
          agent: params.agent,
          title: params.title ?? undefined,
          cwd,
          state: "idle",
        })
        if (params.options) {
          for (const opt of rec.options) {
            if (opt.id in params.options) opt.value = params.options[opt.id]
          }
        }
        this.sessions.set(id, rec)
        const subId = `sub-${++this.subSeq}`
        stream.subs.set(subId, { target: { session: id } })
        this.broadcastIndex({ type: "summary", session: this.summaryOf(rec) })
        reply({ session: structuredClone(rec.session), subscription: subId, head: String(this.seq) })
        return
      }
      case "session/prompt": {
        const params = p as SessionPromptParams
        const rec = this.sessions.get(params.session)
        if (!rec) return fail(-32004, `session not found: ${params.session}`)
        const msgId = `msg-${++this.msgSeq}`
        const turnId = `turn-${++this.turnSeq}`
        if (!rec.session.title) {
          rec.session.title = params.text.slice(0, 48)
        }
        reply({ message: msgId, disposition: "started" })

        this.emitItem(rec, {
          id: msgId,
          kind: "user",
          turn: turnId,
          set: { text: params.text, status: "sent" },
        })
        this.emitState(rec, "running")

        const ctx: PromptScenarioContext = {
          host: this,
          record: rec,
          prompt: params,
          turnId,
          emitItem: (patch) => this.emitItem(rec, patch),
          emitRequest: (req) => this.emitRequest(rec, req),
          emitState: (state, detail) => this.emitState(rec, state, detail),
          emitUsage: (usage) => this.emitUsage(rec, usage),
          emitNotice: (level, text) => this.emitNotice(rec, level, text),
        }

        if (this.onPrompt) {
          void Promise.resolve(this.onPrompt(ctx))
        } else {
          // Default echo reply when no custom scenario is supplied.
          queueMicrotask(() => {
            const replyId = `asst-${++this.msgSeq}`
            this.emitItem(rec, {
              id: replyId,
              kind: "assistant",
              turn: turnId,
              set: { text: `Echo from ${rec.session.binding?.agent}: ${params.text}` },
              streaming: false,
            })
            this.emitState(rec, "idle")
          })
        }
        return
      }
      case "request/answer": {
        const reqId = String(p.request)
        const answer = (p.answer ?? {}) as Answer
        let found: { rec: FakeSessionRecord; req: Request } | null = null
        for (const rec of this.sessions.values()) {
          const req = rec.requests.find((r) => r.id === reqId)
          if (req) {
            found = { rec, req }
            break
          }
        }
        if (!found) return fail(-32004, `request not found: ${reqId}`)
        found.req.status = "answered"
        found.req.answer = answer
        found.req.answeredBy = TEST_USER.email
        this.broadcastSession(found.rec.session.id, { type: "request", request: structuredClone(found.req) })
        reply({})

        if (this.onAnswer) {
          const rec = found.rec
          void Promise.resolve(
            this.onAnswer({
              host: this,
              record: rec,
              request: found.req,
              answer,
              emitItem: (patch) => this.emitItem(rec, patch),
              emitRequest: (req) => this.emitRequest(rec, req),
              emitState: (state, detail) => this.emitState(rec, state, detail),
              emitUsage: (usage) => this.emitUsage(rec, usage),
            }),
          )
        } else {
          this.emitState(found.rec, "idle")
        }
        return
      }
      case "session/cancel": {
        const rec = this.sessions.get(String(p.session))
        if (!rec) return fail(-32004, `session not found: ${p.session}`)
        reply({ interrupted: true, queued: 0 })
        this.emitNotice(rec, "info", "Turn cancelled.")
        this.emitState(rec, "idle")
        return
      }
      case "session/stop": {
        const rec = this.sessions.get(String(p.session))
        if (!rec) return fail(-32004, `session not found: ${p.session}`)
        if (rec.session.binding) rec.session.binding.status = "stopped"
        reply({})
        this.emitState(rec, "stopped")
        return
      }
      case "session/start": {
        const rec = this.sessions.get(String(p.session))
        if (!rec) return fail(-32004, `session not found: ${p.session}`)
        if (rec.session.binding) rec.session.binding.status = "running"
        this.emitState(rec, "idle")
        reply({ binding: rec.session.binding })
        return
      }
      case "session/rename": {
        const rec = this.sessions.get(String(p.session))
        if (!rec) return fail(-32004, `session not found: ${p.session}`)
        rec.session.title = String(p.title)
        rec.session.updated = new Date().toISOString()
        this.broadcastSession(rec.session.id, { type: "session", session: structuredClone(rec.session) })
        this.broadcastIndex({ type: "summary", session: this.summaryOf(rec) })
        reply({})
        return
      }
      case "session/archive": {
        const rec = this.sessions.get(String(p.session))
        if (!rec) return fail(-32004, `session not found: ${p.session}`)
        rec.session.archived = Boolean(p.archived)
        this.broadcastSession(rec.session.id, { type: "session", session: structuredClone(rec.session) })
        this.broadcastIndex({ type: "summary", session: this.summaryOf(rec) })
        reply({})
        return
      }
      case "option/set": {
        const rec = this.sessions.get(String(p.session))
        if (!rec) return fail(-32004, `session not found: ${p.session}`)
        const vals = (p.values ?? {}) as Record<string, unknown>
        for (const opt of rec.options) {
          if (opt.id in vals) opt.value = vals[opt.id]
        }
        this.broadcastSession(rec.session.id, { type: "options", options: structuredClone(rec.options) })
        reply({ options: structuredClone(rec.options), reset: [] })
        return
      }
      case "session/screen": {
        reply({ text: "fake tui screen\n> ", cursor: { row: 1, col: 2 }, size: { rows: 24, cols: 80 } })
        return
      }
      case "session/keys": {
        reply({})
        return
      }
      default: {
        fail(-32601, `method not found: ${msg.method}`)
      }
    }
  }
}

export interface FakeAgentsRookery {
  readonly baseUrl: string
  readonly wsUrl: string
  readonly hosts: Map<string, FakeParrotHost>
  readonly rookeryCalls: Array<{ method: string; params: Record<string, unknown> }>
  stop(): void
}

export function startFakeAgentsRookery(opts: {
  hosts: FakeParrotHostSeed[]
  useLegacyHostsList?: boolean
}): FakeAgentsRookery {
  const hosts = new Map<string, FakeParrotHost>()
  for (const h of opts.hosts) {
    hosts.set(h.name, new FakeParrotHost(h))
  }
  const rookeryCalls: Array<{ method: string; params: Record<string, unknown> }> = []
  const activeStreams = new Map<number, ActiveParrotStream>()
  let nextStreamId = 1

  const sendReply = (ws: any, id: unknown, result: unknown) => {
    ws.send(JSON.stringify({ jsonrpc: "2.0", id, result }))
  }
  const sendError = (ws: any, id: unknown, code: string, message: string) => {
    ws.send(JSON.stringify({ jsonrpc: "2.0", id, error: { code: -32000, message, data: { code } } }))
  }

  const server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    fetch(req, srv) {
      const url = new URL(req.url)
      if (url.pathname === "/ws") {
        if (srv.upgrade(req)) return undefined
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
      message(ws, raw) {
        if (typeof raw !== "string") {
          const bytes = new Uint8Array(raw.buffer, raw.byteOffset, raw.byteLength)
          if (bytes.byteLength < 4) return
          const streamId = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(0)
          const st = activeStreams.get(streamId)
          if (!st) return
          const payload = bytes.subarray(4)
          st.buf += dec.decode(payload, { stream: true })
          ws.send(
            JSON.stringify({
              jsonrpc: "2.0",
              method: "streams.credit",
              params: { stream: streamId, bytes: payload.byteLength },
            }),
          )
          let nl = st.buf.indexOf("\n")
          while (nl !== -1) {
            const line = st.buf.slice(0, nl).trim()
            st.buf = st.buf.slice(nl + 1)
            if (line) st.host.handleMessage(st, line)
            nl = st.buf.indexOf("\n")
          }
          return
        }

        const msg = JSON.parse(raw) as {
          id?: unknown
          method?: string
          params?: Record<string, unknown>
        }
        if (!msg.method) return
        const params = msg.params ?? {}

        if (msg.method === "streams.close") {
          const id = Number(params.stream)
          const st = activeStreams.get(id)
          if (st) {
            st.host.detach(st)
            activeStreams.delete(id)
          }
          return
        }
        if (msg.method === "streams.credit" || msg.method === "streams.eof") return

        rookeryCalls.push({ method: msg.method, params })

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
            return sendReply(ws, msg.id, me)
          }
          case "commands.list":
            return sendReply(ws, msg.id, { commands: [] })
          case "plugins.list":
            return sendReply(ws, msg.id, { plugins: [] })
          case "notify.list":
            return sendReply(ws, msg.id, { notifications: [] })
          case "notify.unread":
            return sendReply(ws, msg.id, { count: 0 })
          case "events.subscribe":
            return sendReply(ws, msg.id, { subscription: `ev-${nextStreamId++}` })
          case "env.list": {
            if (opts.useLegacyHostsList) {
              return sendError(ws, msg.id, "NOT_FOUND", "method not found: env.list")
            }
            const environments: EnvInfo[] = [...hosts.values()].map((h) => ({
              uri: `env://${h.name}`,
              name: h.name,
              kind: h.kind,
              state: h.state,
              level: "use",
              supports: {
                exec: true,
                files: true,
                terminal: true,
                connect: true,
                desktop: false,
                workspaces: true,
                process: true,
                checkouts: true,
                privileged: false,
                persistentSessions: true,
                deploy: false,
              },
              error: h.state === "offline" ? "host unreachable" : undefined,
            }))
            return sendReply(ws, msg.id, { environments })
          }
          case "hosts.list": {
            const list = [...hosts.values()].map((h) => ({
              name: h.name,
              address: "192.0.2.10",
              reachable: h.state === "online",
              type: h.kind,
              error: h.state === "offline" ? "host unreachable" : null,
              power: { start: false, stop: true, state: h.state === "online" ? "running" : "stopped" },
            }))
            return sendReply(ws, msg.id, { hosts: list })
          }
          case "agents.connect": {
            const env = String(params.env ?? "")
            const hostName = env.startsWith("env://") ? env.slice("env://".length) : env
            const host = hosts.get(hostName)
            if (!host) return sendError(ws, msg.id, "NOT_FOUND", `unknown host: ${hostName}`)
            if (host.state !== "online") {
              return sendError(ws, msg.id, "UNAVAILABLE", `host ${hostName} is offline`)
            }
            const streamId = nextStreamId++
            const st: ActiveParrotStream = { ws, streamId, host, buf: "", subs: new Map() }
            activeStreams.set(streamId, st)
            host.attach(st)
            return sendReply(ws, msg.id, { stream: streamId } satisfies StreamOpened)
          }
          default:
            return sendError(ws, msg.id, "NOT_FOUND", `method not found: ${msg.method}`)
        }
      },
      close(ws) {
        for (const [id, st] of activeStreams) {
          if (st.ws === ws) {
            st.host.detach(st)
            activeStreams.delete(id)
          }
        }
      },
    },
  })

  return {
    baseUrl: `http://127.0.0.1:${server.port}`,
    wsUrl: `ws://127.0.0.1:${server.port}/ws`,
    hosts,
    rookeryCalls,
    stop() {
      for (const st of activeStreams.values()) st.host.detach(st)
      activeStreams.clear()
      server.stop(true)
    },
  }
}
