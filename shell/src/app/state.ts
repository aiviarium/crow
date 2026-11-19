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
  viewUrl,
  wsUrlFromLocation,
} from "@rookery/client"
import type { OpenViewOptions } from "@rookery/sdk/runtime/client"
import { type Accessor, createMemo, createSignal } from "solid-js"

export const HOME_VIEW = "crow.home"

export type AuthPhase = "checking" | "signed-out" | "ready" | "ended"

export interface ShellAppOptions {
  /** Base HTTP origin (e.g. `http://127.0.0.1:4790`). Defaults to relative URLs on the current origin. */
  baseUrl?: string
  /** WebSocket endpoint URL. Derived from `baseUrl` or `location` when omitted. */
  wsUrl?: string
  /** Custom module importer for plugin client halves (useful in tests). */
  importModule?: (url: string) => Promise<{ default?: unknown }>
  /** Navigation callback for full-page redirects (OIDC, local link, devLogin). Defaults to `location.assign`. */
  goExternal?: (url: string) => void
  /** Initial pathname + search. Defaults to `location.pathname + location.search`. */
  initialUrl?: string
  /** Override connection phase timers (useful in tests). */
  phaseTimings?: ConnectionPhaseTimings
  /** Whether the WebSocket reconnects automatically. Default `true`. */
  reconnect?: boolean
}

export interface ShellApp {
  readonly baseUrl: string | undefined
  readonly conn: Connection
  readonly bus: EventBus
  readonly session: SessionStore
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

const DEFAULT_SIGN_IN: SignInOptions = { devLogin: false, local: false, sso: null }

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
  const phase = createConnectionPhase(conn, opts.phaseTimings)

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

  const loader = createPluginLoader(conn, {
    eventBus: bus,
    baseUrl,
    importModule: opts.importModule,
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
    },
  })

  const routeTable = createMemo(() =>
    buildRouteTable(Object.values(loader.plugins), [{ view: HOME_VIEW, pattern: "/", title: "Home" }]),
  )

  const routeMatch = createMemo(() => {
    const cur = currentUrl()
    return matchUrl(routeTable(), cur.pathname, cur.search)
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
    conn.connect()
  }

  const signOut = async () => {
    loader.stop()
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
    session.dispose()
    bus.dispose()
    conn.stop()
  }

  return {
    baseUrl,
    conn,
    bus,
    session,
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
