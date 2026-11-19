import { afterEach, describe, expect, test } from "bun:test"
import * as nocturne from "@aiviarium/nocturne"
import { type PluginInfo, publishSharedModules, SHARED_MODULE_GLOBAL, type SignedOut } from "@rookery/client"
import { render } from "solid-js/web"
import { App } from "../src/app/App"
import { createShellApp } from "../src/app/state"
import { setTheme } from "../src/theme"

const cleanup: Array<() => void> = []
afterEach(() => {
  while (cleanup.length) cleanup.pop()!()
  document.body.innerHTML = ""
  setTheme("dark")
  for (const el of Array.from(document.head.querySelectorAll("link[data-plugin]"))) {
    el.remove()
  }
})

async function waitFor(fn: () => boolean, timeoutMs = 3000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (fn()) return
    await Bun.sleep(10)
  }
  throw new Error("timed out waiting for condition")
}

interface FakeRookery {
  baseUrl: string
  wsUrl: string
  setAuth(state: { ok: true } | { ok: false; body: Partial<SignedOut> }): void
  setPlugins(list: PluginInfo[]): void
  closeSockets(): void
  logoutCount(): number
  stop(): void
}

function startFakeRookery(opts: {
  authenticated: boolean
  signedOutBody?: Partial<SignedOut>
  plugins?: PluginInfo[]
  bundles?: Record<string, string>
}): FakeRookery {
  let authState: { ok: true } | { ok: false; body: Partial<SignedOut> } = opts.authenticated
    ? { ok: true }
    : { ok: false, body: opts.signedOutBody ?? { devLogin: false, local: true, sso: null } }
  let plugins = opts.plugins ?? []
  const bundles = opts.bundles ?? {}
  const sockets = new Set<any>()
  let logouts = 0

  const server = Bun.serve({
    port: 0,
    fetch(req, srv) {
      const url = new URL(req.url)
      if (url.pathname === "/ws") {
        if (srv.upgrade(req, { data: undefined })) return undefined
        return new Response("upgrade failed", { status: 400 })
      }
      if (url.pathname === "/auth/session") {
        if (authState.ok) {
          return Response.json({
            user: { id: "u-ada", name: "Ada Lovelace", email: "ada@example.test", admin: true },
          })
        }
        return Response.json(authState.body, { status: 401 })
      }
      if (url.pathname === "/auth/logout" && req.method === "POST") {
        logouts++
        authState = { ok: false, body: { devLogin: false, local: true, sso: null } }
        return Response.json({ redirect: null })
      }
      const bundle = bundles[url.pathname]
      if (bundle !== undefined) {
        return new Response(bundle, { headers: { "content-type": "application/javascript" } })
      }
      return new Response("not found", { status: 404 })
    },
    websocket: {
      open(ws) {
        sockets.add(ws)
      },
      close(ws) {
        sockets.delete(ws)
      },
      message(ws, data) {
        const msg = JSON.parse(String(data))
        if (msg.method === "auth.me") {
          if (!authState.ok) {
            ws.send(
              JSON.stringify({
                jsonrpc: "2.0",
                id: msg.id,
                error: { code: -32001, message: "session ended", data: { code: "UNAUTHENTICATED" } },
              }),
            )
            return
          }
          ws.send(
            JSON.stringify({
              jsonrpc: "2.0",
              id: msg.id,
              result: {
                user: { id: "u-ada", name: "Ada Lovelace", email: "ada@example.test", admin: true },
                principal: { kind: "user", id: "u-ada" },
                dev: false,
                localAuth: true,
                kernelVersion: "0.4.0",
                apiVersion: 1,
              },
            }),
          )
        } else if (msg.method === "plugins.list") {
          ws.send(JSON.stringify({ jsonrpc: "2.0", id: msg.id, result: { plugins } }))
        } else if (msg.method === "commands.list") {
          ws.send(JSON.stringify({ jsonrpc: "2.0", id: msg.id, result: { commands: [] } }))
        } else if (msg.method === "events.subscribe") {
          ws.send(JSON.stringify({ jsonrpc: "2.0", id: msg.id, result: { subscription: "sub-1" } }))
        } else if (msg.method === "events.unsubscribe") {
          ws.send(JSON.stringify({ jsonrpc: "2.0", id: msg.id, result: {} }))
        }
      },
    },
  })

  return {
    baseUrl: `http://127.0.0.1:${server.port}`,
    wsUrl: `ws://127.0.0.1:${server.port}/ws`,
    setAuth(next) {
      authState = next
    },
    setPlugins(list) {
      plugins = list
    },
    closeSockets() {
      for (const ws of sockets) ws.close(1012, "drop")
    },
    logoutCount() {
      return logouts
    },
    stop() {
      server.stop(true)
    },
  }
}

describe("@crow/shell sign-in flows", () => {
  test("local-account one-time sign-in link validates input and redirects on valid code", async () => {
    const fake = startFakeRookery({
      authenticated: false,
      signedOutBody: { devLogin: false, local: true, sso: null },
    })
    cleanup.push(() => fake.stop())

    const redirects: string[] = []
    const app = createShellApp({
      baseUrl: fake.baseUrl,
      wsUrl: fake.wsUrl,
      goExternal: (u) => redirects.push(u),
      initialUrl: "/",
      reconnect: false,
    })
    cleanup.push(() => app.dispose())

    const host = document.createElement("div")
    document.body.appendChild(host)
    cleanup.push(render(() => <App app={app} />, host))

    await app.boot()
    await waitFor(() => host.querySelector("[data-part='signin-local']") !== null)

    const input = host.querySelector("#local-signin-link") as HTMLInputElement
    const form = host.querySelector("[data-part='signin-local']") as HTMLFormElement

    // Cross-origin URL is rejected.
    input.value = "https://other.example.test/auth/link/valid_code_1234"
    input.dispatchEvent(new Event("input", { bubbles: true }))
    form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }))
    expect(redirects).toHaveLength(0)
    expect(host.textContent).toContain("Paste a valid sign-in link")

    // Valid one-time code redirects to /auth/link/<code> on the Rookery server.
    input.value = "one_time_code_9876"
    input.dispatchEvent(new Event("input", { bubbles: true }))
    form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }))
    expect(redirects).toEqual([`${fake.baseUrl}/auth/link/one_time_code_9876`])
  })

  test("OIDC sign-in button and devLogin form navigate to expected Rookery endpoints", async () => {
    const fake = startFakeRookery({
      authenticated: false,
      signedOutBody: {
        devLogin: true,
        local: false,
        sso: { name: "Example ID", ready: true },
      },
    })
    cleanup.push(() => fake.stop())

    const redirects: string[] = []
    const app = createShellApp({
      baseUrl: fake.baseUrl,
      wsUrl: fake.wsUrl,
      goExternal: (u) => redirects.push(u),
      initialUrl: "/notes?tab=1",
      reconnect: false,
    })
    cleanup.push(() => app.dispose())

    const host = document.createElement("div")
    document.body.appendChild(host)
    cleanup.push(render(() => <App app={app} />, host))

    await app.boot()
    await waitFor(() => host.querySelector("[data-part='signin-sso']") !== null)

    const ssoBtn = host.querySelector("[data-part='signin-sso']") as HTMLAnchorElement
    ssoBtn.click()
    expect(redirects[0]).toBe(`${fake.baseUrl}/auth/login?return_to=%2Fnotes%3Ftab%3D1`)

    const adminChip = host.querySelector("[data-dev-user='admin']") as HTMLButtonElement
    adminChip.click()
    const devForm = host.querySelector("[data-part='signin-dev']") as HTMLFormElement
    devForm.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }))
    expect(redirects[1]).toBe(`${fake.baseUrl}/dev/login?user=admin&next=%2Fnotes%3Ftab%3D1`)
  })
})

describe("@crow/shell authenticated chrome, navigation, plugins, and connection status", () => {
  test("boots authenticated shell, shows empty Home, toggles theme, opens About, and signs out", async () => {
    const fake = startFakeRookery({ authenticated: true })
    cleanup.push(() => fake.stop())

    const app = createShellApp({
      baseUrl: fake.baseUrl,
      wsUrl: fake.wsUrl,
      initialUrl: "/",
      reconnect: false,
    })
    cleanup.push(() => app.dispose())

    const host = document.createElement("div")
    document.body.appendChild(host)
    cleanup.push(render(() => <App app={app} />, host))

    await app.boot()
    await waitFor(() => host.querySelector("[data-part='home']") !== null)
    await waitFor(() => host.querySelector("[data-part='user-menu']") !== null)

    expect(host.querySelector("[data-part='home']")?.textContent).toContain("Welcome to Crow")
    expect(host.querySelector("[data-part='user-menu']")?.textContent).toContain("Ada Lovelace")

    // Open account menu and verify theme toggle & About dialog.
    const menuTrigger = host.querySelector("[data-part='user-menu']") as HTMLButtonElement
    menuTrigger.click()
    await waitFor(() => document.body.querySelector("[data-part='account-who']") !== null)

    // Theme changes update documentElement.dataset.theme.
    setTheme("light")
    expect(document.documentElement.dataset.theme).toBe("light")

    // About dialog displays server version from auth.me.
    app.setAboutOpen(true)
    await waitFor(() => document.body.querySelector("[data-part='about']") !== null)
    expect(document.body.querySelector("[data-part='about']")?.textContent).toContain("v0.4.0")
    app.setAboutOpen(false)

    // Sign out calls POST /auth/logout and transitions back to SignInPage.
    await app.signOut()
    expect(fake.logoutCount()).toBe(1)
    await waitFor(() => host.querySelector("[data-part='signin']") !== null)
  })

  test("navigates to plugin view, reflects connection drop/recovery, and overlays ended session", async () => {
    publishSharedModules({ "@aiviarium/nocturne": nocturne })
    const pluginBundle = `
      const mods = globalThis[${JSON.stringify(SHARED_MODULE_GLOBAL)}].modules;
      const { defineClient } = mods["@rookery/sdk/client"];
      export default defineClient((rookery) => {
        rookery.views.register("fleet.hosts", (props) => {
          props.view.setTitle("Fleet Hosts");
          const div = document.createElement("div");
          div.setAttribute("data-fleet-view", "ready");
          div.textContent = "Hosts view";
          return div;
        });
        rookery.workbench.statusItem("fleet.status", () => {
          const span = document.createElement("span");
          span.setAttribute("data-fleet-status", "ok");
          span.textContent = "2 hosts";
          return span;
        });
      });
    `

    const fleetPlugin = {
      id: "fleet",
      state: "active",
      client: { script: "/plugins/fleet/client.h1.js", styles: null, hash: "h1" },
      manifest: {
        id: "fleet",
        name: "Fleet",
        version: "0.1.0",
        namespace: "fleet",
        contributes: {
          views: [{ id: "fleet.hosts", title: "Hosts" }],
          routes: [{ path: "hosts", view: "fleet.hosts" }],
          nav: [{ id: "fleet.hosts", title: "Hosts", view: "fleet.hosts" }],
          commands: [],
          collections: [],
          settings: [],
          adminPages: [],
        },
      },
    } as unknown as PluginInfo

    const fake = startFakeRookery({
      authenticated: true,
      plugins: [fleetPlugin],
      bundles: { "/plugins/fleet/client.h1.js": pluginBundle },
    })
    cleanup.push(() => fake.stop())

    const app = createShellApp({
      baseUrl: fake.baseUrl,
      wsUrl: fake.wsUrl,
      initialUrl: "/",
      reconnect: false,
      phaseTimings: { graceMs: 15, offlineMs: 40, backMs: 30 },
      importModule: async (url) => {
        const res = await fetch(url)
        const src = await res.text()
        return import(`data:text/javascript;base64,${Buffer.from(src).toString("base64")}`)
      },
    })
    cleanup.push(() => app.dispose())

    const host = document.createElement("div")
    document.body.appendChild(host)
    cleanup.push(render(() => <App app={app} />, host))

    await app.boot()
    await app.loader.clientsSettled(3000)

    // Sidebar displays plugin nav item and status bar renders plugin status item.
    const navLink = Array.from(host.querySelectorAll("a[data-part='nav-item']")).find(
      (el) => el.getAttribute("href") === "/fleet/hosts",
    ) as HTMLAnchorElement | undefined
    expect(navLink).toBeDefined()
    expect(host.querySelector("[data-fleet-status='ok']")?.textContent).toBe("2 hosts")

    // Clicking nav link performs SPA navigation and mounts the plugin view.
    navLink!.click()
    await waitFor(() => host.querySelector("[data-fleet-view='ready']") !== null)
    expect(host.querySelector("[data-part='topbar-title']")?.textContent).toBe("Fleet Hosts")

    // Socket drop surfaces connection status in status bar, then recovers.
    fake.closeSockets()
    await waitFor(() => host.querySelector("[data-part='connection-status'][data-phase='offline']") !== null)
    app.conn.connect()
    await waitFor(() => host.querySelector("[data-part='connection-status'][data-phase='back']") !== null)

    // Session expiring while open overlays SignInPage[data-state='ended'] over the mounted Shell.
    fake.setAuth({ ok: false, body: { devLogin: false, local: true, sso: null } })
    await app.session.refresh()
    await waitFor(() => host.querySelector("[data-part='signin'][data-state='ended']") !== null)
    expect(host.querySelector("[data-part='shell']")).not.toBeNull()
  })
})
