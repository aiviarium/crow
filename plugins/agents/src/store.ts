// Reactive multi-host Parrot store for the Agents plugin.
//
// Connections, agent lists, and session indexes live here (created once in `defineClient`) rather
// than inside view components, so navigating between `/agents`, `/agents/:host`, and
// `/agents/:host/:session` reuses the open `agents.connect` stream and preserves sidebar state.
import type {
  Action,
  Agent,
  Answer,
  Attachment,
  Background,
  BindingScreenResult,
  ConfigOption,
  ConnectionInfo,
  ContextEntry,
  Control,
  Delivery,
  Environment,
  QueueState,
  Request,
  Session,
  SessionNewParams,
  SessionRebindParams,
  SessionSnapshot,
  SessionSummary,
  State,
  Turn,
  Update,
  Usage,
  Workspace,
  WorkspaceRequest,
} from "@aiviarium/parrot-client"
import type { ClientRookery } from "@rookery/sdk/client"
import { type Accessor, batch, createSignal } from "solid-js"
import { type AgentHost, errorMessage, hostNameFromEnv, listAgentHosts } from "./api"
import { applyItemPatch, normalizeItem, type ParrotItem } from "./parrot"
import { connectParrot, type ParrotConnection } from "./transport"

export type ConnectionStatus = "idle" | "connecting" | "connected" | "error"

export interface HostRuntime {
  readonly host: string
  readonly status: Accessor<ConnectionStatus>
  readonly error: Accessor<string | null>
  readonly agents: Accessor<Agent[]>
  readonly agentsHint: Accessor<string | null>
  readonly sessions: Accessor<SessionSummary[]>
  readonly envs: Accessor<Environment[]>
  readonly workspaces: Accessor<Workspace[]>
  connect(force?: boolean): Promise<ParrotConnection>
  refresh(): Promise<void>
  close(): void
}

export interface SessionFollower {
  readonly host: string
  readonly sessionId: string
  readonly ready: Accessor<boolean>
  readonly error: Accessor<string | null>
  readonly session: Accessor<Session | null>
  readonly state: Accessor<State>
  readonly detail: Accessor<string | null>
  readonly background: Accessor<Background[]>
  readonly items: Accessor<ParrotItem[]>
  readonly requests: Accessor<Request[]>
  readonly turns: Accessor<Turn[]>
  readonly queue: Accessor<QueueState>
  readonly options: Accessor<ConfigOption[]>
  readonly actions: Accessor<Action[]>
  readonly usage: Accessor<Usage | null>
  readonly subscribers: Accessor<ConnectionInfo[]>
  dispose(): void
}

export interface StartSessionInput {
  agent: string
  env?: string | null
  workspace?: WorkspaceRequest | null
  cwd?: string | null
  options?: Record<string, unknown> | null
  title?: string | null
  control?: Control | null
  prompt?: string
  context?: ContextEntry[] | null
  attachments?: Attachment[] | null
}

export interface PromptInput {
  text: string
  context?: ContextEntry[] | null
  attachments?: Attachment[] | null
  delivery?: Delivery | null
}

export interface AgentsStore {
  readonly hosts: Accessor<AgentHost[]>
  readonly hostsLoading: Accessor<boolean>
  readonly hostsError: Accessor<string | null>
  readonly selectedHost: Accessor<string | null>
  setSelectedHost(host: string | null): void
  refreshHosts(): Promise<AgentHost[]>
  hostRuntime(host: string): HostRuntime
  ensureHost(host: string): Promise<HostRuntime>
  followSession(host: string, sessionId: string): SessionFollower
  startSession(host: string, input: StartSessionInput): Promise<{ host: string; session: Session }>
  sendPrompt(host: string, sessionId: string, input: PromptInput): Promise<void>
  answerRequest(host: string, requestId: string, answer: Answer): Promise<void>
  cancelSession(host: string, sessionId: string): Promise<void>
  stopSession(host: string, sessionId: string): Promise<void>
  startBinding(host: string, sessionId: string): Promise<void>
  renameSession(host: string, sessionId: string, title: string): Promise<void>
  archiveSession(host: string, sessionId: string, archived: boolean): Promise<void>
  setOptions(host: string, sessionId: string, values: Record<string, unknown>): Promise<ConfigOption[]>
  invokeAction(host: string, sessionId: string, action: string, args?: string): Promise<void>
  rebindSession(host: string, sessionId: string, params: Omit<SessionRebindParams, "session">): Promise<void>
  getScreen(host: string, sessionId: string): Promise<BindingScreenResult>
  sendKeys(host: string, sessionId: string, keys: { text?: string; press?: string[] }): Promise<void>
  allSessions(): Array<{ host: string; session: SessionSummary }>
  needsYouCount(): number
  dispose(): void
}

function summaryFromSession(s: Session): SessionSummary {
  return {
    id: s.id,
    runtime: s.runtime,
    title: s.title ?? null,
    state: s.state,
    kind: s.kind,
    parent: s.parent?.session ?? null,
    agent: s.binding?.agent ?? null,
    env: s.binding?.env ?? null,
    cwd: s.cwd,
    workspace: s.workspace,
    task: null,
    archived: s.archived,
    updated: s.updated,
  }
}

function upsertById<T extends { id: string }>(list: readonly T[], item: T): T[] {
  const i = list.findIndex((x) => x.id === item.id)
  if (i === -1) return [item, ...list]
  return [...list.slice(0, i), item, ...list.slice(i + 1)]
}

/** Parses `host/session` or `host` from the `*rest` route path of `agents.chat`. */
export function parseChatPath(path: string): { host: string | null; sessionId: string | null } {
  const clean = path.replace(/^\/+|\/+$/g, "")
  if (!clean) return { host: null, sessionId: null }
  const slash = clean.indexOf("/")
  if (slash === -1) return { host: decodeURIComponent(clean), sessionId: null }
  const host = decodeURIComponent(clean.slice(0, slash))
  const sessionId = decodeURIComponent(clean.slice(slash + 1))
  return { host: host || null, sessionId: sessionId || null }
}

export function formatChatPath(host: string, sessionId?: string | null): string {
  const h = encodeURIComponent(hostNameFromEnv(host))
  return sessionId ? `${h}/${encodeURIComponent(sessionId)}` : h
}

export function createAgentsStore(rookery: ClientRookery): AgentsStore {
  const [hosts, setHosts] = createSignal<AgentHost[]>([])
  const [hostsLoading, setHostsLoading] = createSignal(false)
  const [hostsError, setHostsError] = createSignal<string | null>(null)
  const [selectedHost, setSelectedHostSignal] = createSignal<string | null>(null)

  const runtimes = new Map<string, HostRuntime>()
  const [runtimeTick, setRuntimeTick] = createSignal(0)

  const setSelectedHost = (host: string | null) => {
    setSelectedHostSignal(host ? hostNameFromEnv(host) : null)
  }

  const refreshHosts = async (): Promise<AgentHost[]> => {
    setHostsLoading(true)
    setHostsError(null)
    try {
      const list = await listAgentHosts(rookery)
      batch(() => {
        setHosts(list)
        const current = selectedHost()
        if (!current || !list.some((h) => h.name === current)) {
          const preferred = list.find((h) => h.state === "online") ?? list[0] ?? null
          if (preferred) setSelectedHostSignal(preferred.name)
        }
      })
      return list
    } catch (err) {
      setHostsError(errorMessage(err))
      return hosts()
    } finally {
      setHostsLoading(false)
    }
  }

  const createHostRuntime = (rawHost: string): HostRuntime => {
    const host = hostNameFromEnv(rawHost)
    const [status, setStatus] = createSignal<ConnectionStatus>("idle")
    const [error, setError] = createSignal<string | null>(null)
    const [agents, setAgents] = createSignal<Agent[]>([])
    const [agentsHint, setAgentsHint] = createSignal<string | null>(null)
    const [sessions, setSessions] = createSignal<SessionSummary[]>([])
    const [envs, setEnvs] = createSignal<Environment[]>([])
    const [workspaces, setWorkspaces] = createSignal<Workspace[]>([])

    let activeConn: ParrotConnection | null = null
    let connecting: Promise<ParrotConnection> | null = null
    let indexSubId: string | null = null
    let offUpdate: (() => void) | null = null

    const applyIndexUpdate = (u: Update) => {
      switch (u.type) {
        case "summary":
          setSessions((prev) => upsertById(prev, u.session))
          break
        case "agent":
          setAgents((prev) => upsertById(prev, u.agent))
          break
        case "env":
          setEnvs((prev) => upsertById(prev, u.env))
          break
        case "workspace":
          setWorkspaces((prev) => upsertById(prev, u.workspace))
          break
        case "deleted":
          if (u.kind === "session") {
            setSessions((prev) => prev.filter((s) => s.id !== u.id))
          } else if (u.kind === "workspace") {
            setWorkspaces((prev) => prev.filter((w) => w.id !== u.id))
          }
          break
      }
    }

    const tearDown = () => {
      offUpdate?.()
      offUpdate = null
      indexSubId = null
      if (activeConn) {
        const c = activeConn
        activeConn = null
        c.close()
      }
    }

    const hydrateLists = async (conn: ParrotConnection) => {
      const [agentRes, sessionRes, workspaceRes] = await Promise.all([
        conn.client.call("agent/list", {}).catch(() => null),
        conn.client.call("session/list", { archived: false, limit: 200 }).catch(() => null),
        conn.client.call("workspace/list", {}).catch(() => null),
      ])
      batch(() => {
        if (agentRes) {
          setAgents(agentRes.agents)
          setAgentsHint(agentRes.hint ?? null)
        }
        if (sessionRes) {
          setSessions(sessionRes.sessions)
        }
        if (workspaceRes) {
          setWorkspaces(workspaceRes.workspaces)
        }
      })
    }

    const connect = async (force = false): Promise<ParrotConnection> => {
      if (!force && activeConn && !activeConn.client.connection.closed) {
        return activeConn
      }
      if (!force && connecting) return connecting
      if (force) tearDown()

      setStatus("connecting")
      setError(null)

      const promise = (async () => {
        const conn = await connectParrot(rookery, host)
        activeConn = conn

        offUpdate = conn.client.on("update", (params) => {
          if (indexSubId && params.subscription !== indexSubId) return
          applyIndexUpdate(params.update)
        })

        // Detect stream drop while idle so UI reflects disconnected state and allows reconnect.
        const origEnd = conn.stream.onEnd
        conn.stream.onEnd = (endErr) => {
          origEnd(endErr)
          if (activeConn === conn) {
            activeConn = null
            indexSubId = null
            offUpdate?.()
            offUpdate = null
            setStatus("error")
            setError(endErr ? `${endErr.code}: ${endErr.message}` : "Disconnected from host")
          }
        }

        try {
          const sub = await conn.client.subscribe({ index: true })
          indexSubId = sub.subscription
          if (sub.snapshot?.index) {
            batch(() => {
              setSessions(sub.snapshot!.index!.sessions)
              setAgents(sub.snapshot!.index!.agents)
              setEnvs(sub.snapshot!.index!.envs)
            })
            // Best-effort workspace list (not part of IndexSnapshot).
            conn.client
              .call("workspace/list", {})
              .then((res) => setWorkspaces(res.workspaces))
              .catch(() => {})
          } else {
            await hydrateLists(conn)
          }
        } catch {
          // If a runtime doesn't support index subscriptions yet, fall back to RPC lists.
          await hydrateLists(conn)
        }

        setStatus("connected")
        return conn
      })()

      connecting = promise
      try {
        return await promise
      } catch (err) {
        setStatus("error")
        setError(errorMessage(err))
        tearDown()
        throw err
      } finally {
        if (connecting === promise) connecting = null
      }
    }

    const refresh = async () => {
      const conn = await connect()
      await hydrateLists(conn)
    }

    return {
      host,
      status,
      error,
      agents,
      agentsHint,
      sessions,
      envs,
      workspaces,
      connect,
      refresh,
      close() {
        tearDown()
        setStatus("idle")
      },
    }
  }

  const hostRuntime = (rawHost: string): HostRuntime => {
    const host = hostNameFromEnv(rawHost)
    let rt = runtimes.get(host)
    if (!rt) {
      rt = createHostRuntime(host)
      runtimes.set(host, rt)
      setRuntimeTick((n) => n + 1)
    }
    return rt
  }

  const ensureHost = async (rawHost: string): Promise<HostRuntime> => {
    const rt = hostRuntime(rawHost)
    await rt.connect()
    return rt
  }

  const followSession = (rawHost: string, sessionId: string): SessionFollower => {
    const host = hostNameFromEnv(rawHost)
    const [ready, setReady] = createSignal(false)
    const [error, setError] = createSignal<string | null>(null)
    const [session, setSession] = createSignal<Session | null>(null)
    const [state, setState] = createSignal<State>("starting")
    const [detail, setDetail] = createSignal<string | null>(null)
    const [background, setBackground] = createSignal<Background[]>([])
    const [items, setItems] = createSignal<ParrotItem[]>([])
    const [requests, setRequests] = createSignal<Request[]>([])
    const [turns, setTurns] = createSignal<Turn[]>([])
    const [queue, setQueue] = createSignal<QueueState>({ paused: false, entries: [] })
    const [options, setOptions] = createSignal<ConfigOption[]>([])
    const [actions, setActions] = createSignal<Action[]>([])
    const [usage, setUsage] = createSignal<Usage | null>(null)
    const [subscribers, setSubscribers] = createSignal<ConnectionInfo[]>([])

    let disposed = false
    let subId: string | null = null
    let offUpdate: (() => void) | null = null
    let connRef: ParrotConnection | null = null
    let noticeSeq = 0

    const hydrateSnapshot = (snap: SessionSnapshot) => {
      const normalized = snap.items.map(normalizeItem).filter((x): x is ParrotItem => x !== null)
      batch(() => {
        setSession(snap.session)
        setState(snap.session.state)
        setBackground(snap.session.background ?? [])
        setItems(normalized)
        setRequests(snap.requests ?? [])
        setQueue(snap.queue ?? { paused: false, entries: [] })
        setOptions(snap.options ?? [])
        setActions(snap.actions ?? [])
        setUsage(snap.usage ?? null)
        setSubscribers(snap.subscribers ?? [])
        setReady(true)
      })
    }

    const applySessionUpdate = (u: Update) => {
      switch (u.type) {
        case "state":
          batch(() => {
            setState(u.state)
            setBackground(u.background ?? [])
            setDetail(u.detail ?? null)
            setSession((prev) => (prev ? { ...prev, state: u.state, background: u.background ?? [] } : prev))
          })
          break
        case "session":
          batch(() => {
            setSession(u.session)
            setState(u.session.state)
            setBackground(u.session.background ?? [])
          })
          break
        case "item":
          setItems((prev) => applyItemPatch(prev, u.item))
          break
        case "turn":
          setTurns((prev) => upsertById(prev, u.turn))
          if (u.turn.usage) setUsage(u.turn.usage)
          break
        case "request":
          setRequests((prev) => {
            const idx = prev.findIndex((r) => r.id === u.request.id)
            if (idx === -1) return [...prev, u.request]
            return [...prev.slice(0, idx), u.request, ...prev.slice(idx + 1)]
          })
          break
        case "queue":
          setQueue(u.queue)
          break
        case "options":
          setOptions(u.options)
          break
        case "actions":
          setActions(u.actions)
          break
        case "usage":
          setUsage(u.usage)
          break
        case "notice": {
          const id = `notice-${++noticeSeq}`
          setItems((prev) => [
            ...prev,
            {
              id,
              kind: "notice",
              turn: prev[prev.length - 1]?.turn ?? null,
              level: u.level,
              text: u.text,
              code: u.code ?? null,
            },
          ])
          break
        }
      }
    }

    void (async () => {
      try {
        const rt = hostRuntime(host)
        const conn = await rt.connect()
        if (disposed) return
        connRef = conn

        // Buffer updates that race with the `subscribe` response.
        const buffered: Array<{ subscription: string; update: Update }> = []
        offUpdate = conn.client.on("update", (params) => {
          if (disposed) return
          if (!subId) {
            if (params.session === sessionId) {
              buffered.push({ subscription: params.subscription, update: params.update })
            }
            return
          }
          if (params.subscription !== subId) return
          if (params.session && params.session !== sessionId) return
          applySessionUpdate(params.update)
        })

        const sub = await conn.client.subscribe({ session: sessionId })
        if (disposed) {
          void conn.client.unsubscribe(sub.subscription).catch(() => {})
          return
        }
        subId = sub.subscription

        const snap =
          sub.snapshot?.sessions?.find((s) => s.session.id === sessionId) ?? sub.snapshot?.sessions?.[0]
        if (snap) {
          hydrateSnapshot(snap)
        } else {
          // Fallback if a runtime omits the snapshot on subscribe.
          const [sRes, rRes, oRes, aRes, reqRes] = await Promise.all([
            conn.client.call("session/get", { session: sessionId }),
            conn.client
              .call("session/read", { session: sessionId, direction: "back", limit: 200 })
              .catch(() => null),
            conn.client.call("option/list", { session: sessionId }).catch(() => null),
            conn.client.call("action/list", { session: sessionId }).catch(() => null),
            conn.client.call("request/list", { session: sessionId }).catch(() => null),
          ])
          if (disposed) return
          batch(() => {
            setSession(sRes.session)
            setState(sRes.session.state)
            setBackground(sRes.session.background ?? [])
            if (rRes) {
              setItems(rRes.items.map(normalizeItem).filter((x): x is ParrotItem => x !== null))
            }
            if (oRes) setOptions(oRes.options)
            if (aRes) setActions(aRes.actions)
            if (reqRes) setRequests(reqRes.requests)
            setReady(true)
          })
        }

        for (const entry of buffered) {
          if (entry.subscription === subId) applySessionUpdate(entry.update)
        }
      } catch (err) {
        if (!disposed) setError(errorMessage(err))
      }
    })()

    return {
      host,
      sessionId,
      ready,
      error,
      session,
      state,
      detail,
      background,
      items,
      requests,
      turns,
      queue,
      options,
      actions,
      usage,
      subscribers,
      dispose() {
        disposed = true
        offUpdate?.()
        offUpdate = null
        if (subId && connRef && !connRef.client.connection.closed) {
          const id = subId
          subId = null
          void connRef.client.unsubscribe(id).catch(() => {})
        }
      },
    }
  }

  const startSession = async (
    rawHost: string,
    input: StartSessionInput,
  ): Promise<{ host: string; session: Session }> => {
    const host = hostNameFromEnv(rawHost)
    const rt = hostRuntime(host)
    const conn = await rt.connect()
    const params: SessionNewParams = {
      agent: input.agent,
      ...(input.env ? { env: input.env } : {}),
      ...(input.workspace ? { workspace: input.workspace } : {}),
      ...(input.cwd ? { cwd: input.cwd } : {}),
      ...(input.options && Object.keys(input.options).length > 0 ? { options: input.options } : {}),
      ...(input.title ? { title: input.title } : {}),
      ...(input.control ? { control: input.control } : {}),
      // A first prompt is queued by `session/new`, so no empty session shows between the two calls.
      ...(input.prompt?.trim() ? { prompt: input.prompt } : {}),
      ...(input.context?.length ? { context: input.context } : {}),
      ...(input.attachments?.length ? { attachments: input.attachments } : {}),
    }
    const created = await conn.client.call("session/new", params)
    // `session/new` returns an auto-subscription; release it because `Conversation` creates its own
    // scoped follower subscription when the session opens.
    if (created.subscription) {
      void conn.client.unsubscribe(created.subscription).catch(() => {})
    }
    // Refresh session index if the server didn't push a summary synchronously.
    if (!rt.sessions().some((s) => s.id === created.session.id)) {
      const summary = summaryFromSession(created.session)
      void rt.refresh().catch(() => {})
      // Optimistically show it if refresh is async.
      if (!rt.sessions().some((s) => s.id === summary.id)) {
        // Handled by live summary update or refresh above.
      }
    }
    return { host, session: created.session }
  }

  const sendPrompt = async (rawHost: string, sessionId: string, input: PromptInput) => {
    const conn = await hostRuntime(rawHost).connect()
    await conn.client.prompt(sessionId, input.text, {
      ...(input.context?.length ? { context: input.context } : {}),
      ...(input.attachments?.length ? { attachments: input.attachments } : {}),
      ...(input.delivery ? { delivery: input.delivery } : {}),
    })
  }

  const answerRequest = async (rawHost: string, requestId: string, answer: Answer) => {
    const conn = await hostRuntime(rawHost).connect()
    await conn.client.call("request/answer", { request: requestId, answer })
  }

  const cancelSession = async (rawHost: string, sessionId: string) => {
    const conn = await hostRuntime(rawHost).connect()
    await conn.client.call("session/cancel", { session: sessionId })
  }

  const stopSession = async (rawHost: string, sessionId: string) => {
    const conn = await hostRuntime(rawHost).connect()
    await conn.client.call("session/stop", { session: sessionId })
  }

  const startBinding = async (rawHost: string, sessionId: string) => {
    const conn = await hostRuntime(rawHost).connect()
    await conn.client.call("session/start", { session: sessionId })
  }

  const renameSession = async (rawHost: string, sessionId: string, title: string) => {
    const conn = await hostRuntime(rawHost).connect()
    await conn.client.call("session/rename", { session: sessionId, title })
  }

  const archiveSession = async (rawHost: string, sessionId: string, archived: boolean) => {
    const conn = await hostRuntime(rawHost).connect()
    await conn.client.call("session/archive", { session: sessionId, archived })
  }

  const setOptions = async (
    rawHost: string,
    sessionId: string,
    values: Record<string, unknown>,
  ): Promise<ConfigOption[]> => {
    const conn = await hostRuntime(rawHost).connect()
    const res = await conn.client.call("option/set", { session: sessionId, values })
    return res.options
  }

  const invokeAction = async (rawHost: string, sessionId: string, action: string, args?: string) => {
    const conn = await hostRuntime(rawHost).connect()
    await conn.client.call("action/invoke", {
      session: sessionId,
      action,
      ...(args ? { args } : {}),
    })
  }

  const rebindSession = async (
    rawHost: string,
    sessionId: string,
    params: Omit<SessionRebindParams, "session">,
  ) => {
    const conn = await hostRuntime(rawHost).connect()
    await conn.client.call("session/rebind", { session: sessionId, ...params })
  }

  const getScreen = async (rawHost: string, sessionId: string): Promise<BindingScreenResult> => {
    const conn = await hostRuntime(rawHost).connect()
    return conn.client.call("session/screen", { session: sessionId })
  }

  const sendKeys = async (rawHost: string, sessionId: string, keys: { text?: string; press?: string[] }) => {
    const conn = await hostRuntime(rawHost).connect()
    await conn.client.call("session/keys", {
      session: sessionId,
      ...(keys.text ? { text: keys.text } : {}),
      ...(keys.press?.length ? { press: keys.press } : {}),
    })
  }

  const allSessions = (): Array<{ host: string; session: SessionSummary }> => {
    runtimeTick()
    const out: Array<{ host: string; session: SessionSummary }> = []
    for (const [host, rt] of runtimes) {
      for (const s of rt.sessions()) {
        if (!s.archived) out.push({ host, session: s })
      }
    }
    return out
  }

  const needsYouCount = (): number =>
    allSessions().filter(({ session }) => session.state === "requires_action").length

  const dispose = () => {
    for (const rt of runtimes.values()) rt.close()
    runtimes.clear()
  }

  return {
    hosts,
    hostsLoading,
    hostsError,
    selectedHost,
    setSelectedHost,
    refreshHosts,
    hostRuntime,
    ensureHost,
    followSession,
    startSession,
    sendPrompt,
    answerRequest,
    cancelSession,
    stopSession,
    startBinding,
    renameSession,
    archiveSession,
    setOptions,
    invokeAction,
    rebindSession,
    getScreen,
    sendKeys,
    allSessions,
    needsYouCount,
    dispose,
  }
}
