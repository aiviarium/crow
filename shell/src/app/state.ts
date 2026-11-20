// Reactive shell application state built on @rookery/client: session lifecycle, WebSocket
// connection, plugin client-half loader, URL routing, and view title tracking.
import { toast } from "@aiviarium/nocturne"
import {
  buildRouteTable,
  Connection,
  type ConnectionPhase,
  type ConnectionPhaseTimings,
  createConnectionPhase,
  createEventBus,
  createPluginLoader,
  createSession,
  type EventBus,
  fetchSession,
  matchUrl,
  type PluginLoader,
  type RouteEntry,
  type RouteMatch,
  signOut as rookerySignOut,
  type SessionStore,
  type SignInOptions,
  type SpaceInfo,
  viewUrl,
  wsUrlFromLocation,
} from "@rookery/client"
import type { OpenViewOptions } from "@rookery/sdk/runtime/client"
import { type Accessor, createMemo, createSignal } from "solid-js"
import { createInboxStore, type InboxStore } from "../inbox/state"
import { createJobsStore, type JobsStore } from "../jobs/state"
import { withBuiltinImporter, withBuiltinPlugins } from "./builtins"

export const HOME_VIEW = "crow.home"
export const JOBS_VIEW = "crow.jobs"
export const JOB_VIEW = "crow.job"
export const INBOX_VIEW = "crow.inbox"
export const INBOX_ITEM_VIEW = "crow.inboxItem"

export type AuthPhase = "checking" | "signed-out" | "ready" | "ended"

export interface ShellAppOptions {
  /** Base HTTP origin (e.g. `http://127.0.0.1:4790`). Defaults to relative URLs on the current origin. */
  baseUrl?: string
  /** WebSocket endpoint URL. Derived from `baseUrl` or `location` when omitted. */
  wsUrl?: string
  /** Custom module importer for plugin client halves (useful in tests). */
  importModule?: (url: string) => Promise<{ default?: unknown }>
  /** Include the built-in plugins from `crow/plugins/*`. Default: only under `bun run dev` and the tests. */
  includeBuiltins?: boolean
  /** Navigation callback for full-page redirects (OIDC, local link, devLogin). Defaults to `location.assign`. */
  goExternal?: (url: string) => void
  /** Initial pathname + search. Defaults to `location.pathname + location.search`. */
  initialUrl?: string
  /** Override connection phase timers (useful in tests). */
  phaseTimings?: ConnectionPhaseTimings
  /** Whether the WebSocket reconnects automatically. Default `true`. */
  reconnect?: boolean
}

export interface SpaceStore {
  /** The spaces the signed-in person can see. */
  readonly list: Accessor<SpaceInfo[]>
  /** The space every space-scoped call of this connection is made in. */
  readonly current: Accessor<SpaceInfo | null>
  readonly loading: Accessor<boolean>
  refresh(): Promise<void>
  /** Enters a space, so the plugins' space-scoped data follows it. */
  enter(space: SpaceInfo): Promise<void>
}

export interface ShellApp {
  readonly baseUrl: string | undefined
  readonly conn: Connection
  readonly bus: EventBus
  readonly session: SessionStore
  readonly jobs: JobsStore
  readonly inbox: InboxStore
  readonly spaces: SpaceStore
  readonly phase: Accessor<ConnectionPhase>
  readonly loader: PluginLoader
  readonly authPhase: Accessor<AuthPhase>
  readonly signInOptions: Accessor<SignInOptions>
  readonly aboutOpen: Accessor<boolean>
  readonly setAboutOpen: (open: boolean) => void
  readonly currentUrl: Accessor<{ pathname: string; search: string }>
  readonly routeTable: Accessor<RouteEntry[]>
  readonly routeMatch: Accessor<RouteMatch | null>
  readonly title: Accessor<string>
  readonly setViewTitle: (title: string) => void
  readonly goExternal: (url: string) => void
  navigate(to: string, opts?: { replace?: boolean }): void
  openView(id: string, opts?: OpenViewOptions): void
  href(id: string, opts?: { path?: string; params?: Record<string, string> }): string | null
  boot(): Promise<void>
  signOut(): Promise<void>
  dispose(): void
}

function parseHref(input: string): { pathname: string; search: string } {
  try {
    const u = new URL(input, "http://localhost")
    return { pathname: u.pathname || "/", search: u.search }
  } catch {
    return { pathname: "/", search: "" }
  }
}

function defaultWsUrl(baseUrl?: string): string {
  if (baseUrl) {
    const u = new URL(baseUrl)
    const scheme = u.protocol === "https:" ? "wss" : "ws"
    return `${scheme}://${u.host}/ws`
  }
  return wsUrlFromLocation()
}

const DEFAULT_SIGN_IN: SignInOptions = { devLogin: false, local: false, sso: null, auth: "local" }

export function createShellApp(opts: ShellAppOptions = {}): ShellApp {
  const baseUrl = opts.baseUrl
  const goExternal =
    opts.goExternal ??
    ((url: string) => {
      location.assign(url)
    })

  const [authPhase, setAuthPhase] = createSignal<AuthPhase>("checking")
  const [signInOptions, setSignInOptions] = createSignal<SignInOptions>(DEFAULT_SIGN_IN)
  const [aboutOpen, setAboutOpen] = createSignal(false)
  const [viewTitle, setViewTitle] = createSignal<string | null>(null)
  const [spaces, setSpaces] = createSignal<SpaceInfo[]>([])
  const [currentSpace, setCurrentSpace] = createSignal<SpaceInfo | null>(null)
  const [spacesLoading, setSpacesLoading] = createSignal(false)
  const [spaceVersion, setSpaceVersion] = createSignal(0)

  const initial = parseHref(
    opts.initialUrl ?? (typeof location !== "undefined" ? location.pathname + location.search : "/"),
  )
  const [currentUrl, setCurrentUrl] = createSignal(initial)

  const handleSignedOut = async () => {
    const wasReady = authPhase() === "ready"
    conn.stop()
    const check = await fetchSession({ baseUrl })
    if (!check.authenticated) {
      setSignInOptions(check.options)
    }
    session.setSignedOut(true)
    setAuthPhase(wasReady ? "ended" : "signed-out")
  }

  const conn = new Connection({
    url: opts.wsUrl ?? defaultWsUrl(baseUrl),
    reconnect: opts.reconnect ?? true,
    onSignedOut: () => {
      void handleSignedOut()
    },
    checkSession: async () => {
      const check = await fetchSession({ baseUrl })
      if (!check.authenticated && !check.unreachable) {
        setSignInOptions(check.options)
        return false
      }
      return true
    },
  })

  const bus = createEventBus(conn)
  const session = createSession(conn)
  const jobs = createJobsStore(conn)
  const inbox = createInboxStore(conn)
  const phase = createConnectionPhase(conn, opts.phaseTimings)

  const refreshSpaces = async () => {
    setSpacesLoading(true)
    try {
      const listed = await conn.call<{ spaces: SpaceInfo[] }>("spaces.list", {})
      const visible = listed?.spaces ?? []
      setSpaces(visible)
      const current = currentSpace()
      const stillThere = current ? visible.find((s) => s.id === current.id) : undefined
      const chosen = stillThere ?? visible.find((s) => s.personal) ?? visible[0] ?? null
      if (chosen && chosen.id !== current?.id) {
        await conn.call("spaces.enter", { space: chosen.id })
        setCurrentSpace(chosen)
        setSpaceVersion((v) => v + 1)
      } else if (chosen) {
        setCurrentSpace(chosen)
      }
    } catch {
      // A server without spaces yet: the shell keeps no current space, and every call is the person's own.
      setSpaces([])
    } finally {
      setSpacesLoading(false)
    }
  }

  const enterSpace = async (space: SpaceInfo) => {
    await conn.call("spaces.enter", { space: space.id })
    setCurrentSpace(space)
    setSpaceVersion((v) => v + 1)
  }

  const navigate = (to: string, navOpts?: { replace?: boolean }) => {
    const parsed = parseHref(to)
    setViewTitle(null)
    setCurrentUrl(parsed)
    const full = parsed.pathname + parsed.search
    if (typeof history !== "undefined") {
      try {
        if (navOpts?.replace) history.replaceState(null, "", full)
        else history.pushState(null, "", full)
      } catch {
        // Ignore history restrictions in non-standard environments.
      }
    }
  }

  // A packaged shell loads the server's plugins from `plugins.list`, each client half from its hashed
  // address. `bun run dev` and the tests read a server with none installed, so they add the ones in
  // `crow/plugins` from this bundle instead.
  const development = (import.meta as { env?: { DEV?: boolean } }).env?.DEV === true
  const useBuiltins = opts.includeBuiltins ?? (development || process.env.NODE_ENV === "test")
  const loaderConn = useBuiltins ? withBuiltinPlugins(conn) : conn
  const importModule = useBuiltins ? withBuiltinImporter(opts.importModule) : opts.importModule

  const loader = createPluginLoader(loaderConn, {
    eventBus: bus,
    baseUrl,
    importModule,
    runtime: {
      openView: (id, openOpts) => openView(id, openOpts),
      href: (id, linkOpts) => href(id, linkOpts),
      toast: (t) => {
        toast({
          title: t.title,
          description: t.body,
          tone:
            t.kind === "danger"
              ? "danger"
              : t.kind === "warning"
                ? "warning"
                : t.kind === "success"
                  ? "success"
                  : "neutral",
        })
      },
      me: () => {
        const u = session.me()?.user
        return u ? { id: u.id, name: u.name } : null
      },
      space: () => currentSpace(),
    },
  })

  const routeTable = createMemo(() =>
    buildRouteTable(Object.values(loader.plugins), [
      { view: HOME_VIEW, pattern: "/", title: "Home" },
      { view: JOBS_VIEW, pattern: "/jobs", title: "Jobs" },
      { view: JOB_VIEW, pattern: "/jobs/:id", title: "Job" },
      { view: INBOX_VIEW, pattern: "/inbox", title: "Inbox" },
      { view: INBOX_ITEM_VIEW, pattern: "/inbox/:id", title: "Inbox" },
    ]),
  )

  const routeMatch = createMemo(() => {
    const cur = currentUrl()
    // A different space remounts the view: its live queries follow the space it is shown in.
    spaceVersion()
    const match = matchUrl(routeTable(), cur.pathname, cur.search)
    return match ? { ...match } : null
  })

  const href = (id: string, linkOpts?: { path?: string; params?: Record<string, string> }): string | null => {
    if (id === HOME_VIEW) return "/"
    return viewUrl(routeTable(), id, linkOpts)
  }

  const openView = (id: string, openOpts?: OpenViewOptions) => {
    const url = href(id, { path: openOpts?.path, params: openOpts?.params })
    if (url) navigate(url, { replace: openOpts?.replace })
  }

  const title = createMemo(() => {
    const custom = viewTitle()
    if (custom) return custom
    const m = routeMatch()
    if (!m || m.view === HOME_VIEW) return "Home"
    if (m.view === JOBS_VIEW || m.view === JOB_VIEW) return "Jobs"
    if (m.view === INBOX_VIEW || m.view === INBOX_ITEM_VIEW) return "Inbox"
    const declared = loader.declaredView(m.view)
    return declared?.view.title ?? m.view
  })

  const onPopState = () => {
    if (typeof location === "undefined") return
    setViewTitle(null)
    setCurrentUrl({ pathname: location.pathname || "/", search: location.search })
  }
  if (typeof window !== "undefined") {
    window.addEventListener("popstate", onPopState)
  }

  const boot = async () => {
    const check = await fetchSession({ baseUrl })
    if (!check.authenticated) {
      setSignInOptions(check.options)
      setAuthPhase("signed-out")
      return
    }
    setAuthPhase("ready")
    loader.start()
    jobs.start()
    inbox.start()
    conn.connect()
    conn.onOpen(() => void refreshSpaces())
    void refreshSpaces()
  }

  const signOut = async () => {
    loader.stop()
    jobs.stop()
    inbox.stop()
    const { redirect } = await rookerySignOut({ baseUrl, conn })
    if (redirect) {
      goExternal(redirect)
      return
    }
    session.setMe(null)
    session.setSignedOut(true)
    const check = await fetchSession({ baseUrl })
    if (!check.authenticated) setSignInOptions(check.options)
    setAuthPhase("signed-out")
  }

  const dispose = () => {
    if (typeof window !== "undefined") {
      window.removeEventListener("popstate", onPopState)
    }
    loader.stop()
    jobs.stop()
    inbox.stop()
    session.dispose()
    bus.dispose()
    conn.stop()
  }

  return {
    baseUrl,
    conn,
    bus,
    session,
    jobs,
    inbox,
    spaces: {
      list: spaces,
      current: currentSpace,
      loading: spacesLoading,
      refresh: refreshSpaces,
      enter: enterSpace,
    },
    phase,
    loader,
    authPhase,
    signInOptions,
    aboutOpen,
    setAboutOpen,
    currentUrl,
    routeTable,
    routeMatch,
    title,
    setViewTitle,
    goExternal,
    navigate,
    openView,
    href,
    boot,
    signOut,
    dispose,
  }
}
