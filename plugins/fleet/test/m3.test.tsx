// The M3 host parts: port links and the addresses `env.portUrl` gives, a desktop's picture at view,
// files with their SHA-256 and the conflict a stale `ifMatch` is, and sharing a host with grants.
// Rendered with fakes; nothing here opens a socket or a VNC connection.
import { afterEach, describe, expect, test } from "bun:test"
import type { GrantInfo } from "@rookery/client"
import type { ClientRookery, ViewHandle } from "@rookery/sdk/client"
import { render } from "solid-js/web"
import { allows, explain, why } from "../src/access"
import { DesktopBody, DesktopPage } from "../src/DesktopPage"
import { createFleetEnvApi, envName, envUri, type FleetEnvApi, portPath } from "../src/env"
import { PortPage, PortsCard, portFromPath } from "../src/Ports"
import { ShareDialog } from "../src/ShareDialog"
import type { EnvInfo } from "../src/types"

const cleanup: Array<() => void> = []
afterEach(() => {
  while (cleanup.length) cleanup.pop()!()
  document.body.innerHTML = ""
  localStorage.clear()
})

const settle = () => new Promise((r) => setTimeout(r, 20))

function env(name: string, overrides: Partial<EnvInfo> = {}): EnvInfo {
  return {
    name,
    uri: envUri(name),
    kind: "workstation",
    state: "online",
    level: "use",
    supports: {
      terminal: true,
      process: true,
      files: true,
      connect: true,
      checkouts: true,
      desktop: true,
      privileged: false,
      persistentSessions: true,
      deploy: false,
    },
    ...overrides,
  }
}

const grant = (principal: string, level: GrantInfo["level"]): GrantInfo => ({
  principal,
  level,
  createdBy: "user:u-ops",
  createdAt: new Date().toISOString(),
})

interface Call {
  method: string
  params: Record<string, unknown>
}

/** The RPC answers the M3 views ask for, recorded so a test can read what was sent. */
function fakeRookery(opts: {
  me?: { id: string; name: string; admin: boolean } | null
  users?: Array<{ id: string; name: string; email?: string; admin: boolean; disabled: boolean }>
  grants?: GrantInfo[]
  owner?: string | null
  forbidGrants?: boolean
  calls?: Call[]
  opened?: string[]
  envs?: EnvInfo[]
  ticket?: string
  file?: { base64: string; sha256: string }
}): ClientRookery {
  const grants = [...(opts.grants ?? [])]
  const rpc = {
    call: async (method: string, params: Record<string, unknown> = {}) => {
      opts.calls?.push({ method, params })
      switch (method) {
        case "auth.me":
          return {
            user: opts.me ? { id: opts.me.id, name: opts.me.name, admin: opts.me.admin } : null,
            principal: { kind: "user", id: opts.me?.id ?? "" },
            admin: opts.me?.admin ?? false,
            auth: "local",
            version: "0.1.0",
            apiVersion: 1,
          }
        case "admin.users":
          return { users: opts.users ?? [] }
        case "admin.groups":
          return { groups: [] }
        case "env.list":
          return { environments: opts.envs ?? [] }
        case "env.get": {
          const name = envName(String(params.env))
          return (opts.envs ?? []).find((e) => e.name === name) ?? env(name)
        }
        case "env.presence":
          return { users: [] }
        case "env.portUrl":
          return {
            url: `${opts.ticket ?? "https://5173-port.example.test/.rookery/claim?ticket=t"}`,
            origin: "https://5173-port.example.test",
          }
        case "env.readFile":
          return { base64: opts.file?.base64 ?? "", size: 4, sha256: opts.file?.sha256 ?? "abc" }
        case "env.writeFile": {
          // A stale `ifMatch` is the server's CONFLICT: the file moved on since it was read.
          if (params.ifMatch && params.ifMatch !== "abc")
            throw Object.assign(new Error("/srv/app.env changed since it was read"), {
              code: "CONFLICT",
            })
          return { sha256: "def", size: 7 }
        }
        case "access.grants": {
          if (opts.forbidGrants)
            throw Object.assign(new Error("you may not see who can use env://studio"), {
              code: "FORBIDDEN",
            })
          return { resource: params.resource, owner: opts.owner ?? null, grants }
        }
        case "access.grant": {
          const level = params.level as GrantInfo["level"]
          const entry = grant(String(params.principal), level)
          const at = grants.findIndex((g) => g.principal === entry.principal)
          if (at >= 0) grants[at] = entry
          else grants.push(entry)
          return entry
        }
        case "access.revoke": {
          const at = grants.findIndex((g) => g.principal === params.principal)
          if (at >= 0) grants.splice(at, 1)
          return {}
        }
        default:
          throw Object.assign(new Error(`unknown method ${method}`), { code: "NOT_FOUND" })
      }
    },
  }
  const call = rpc.call as (method: string, params?: Record<string, unknown>) => Promise<any>
  const envApi = {
    list: async () => (await call("env.list", {})).environments,
    get: (name: string) => call("env.get", { env: name }),
    presence: (name: string) => call("env.presence", { env: name }),
    readFile: (name: string, path: string) => call("env.readFile", { env: name, path }),
    writeFile: (name: string, path: string, content: string | Uint8Array, o: Record<string, unknown> = {}) =>
      call("env.writeFile", {
        env: name,
        path,
        base64: typeof content === "string" ? btoa(content) : btoa(String.fromCharCode(...content)),
        ...o,
      }),
    deleteFile: async () => {},
    listDir: async () => ({ entries: [] }),
    stat: async () => ({}),
    connect: async () => {
      throw new Error("not in this test")
    },
    portUrl: (name: string, port: number, path?: string) =>
      call("env.portUrl", { env: name, port, ...(path ? { path } : {}) }),
    exec: async () => ({}),
  }
  return {
    rpc,
    env: envApi,
    workbench: {
      openView: (id: string, o?: { path?: string }) => opts.opened?.push(`${id}:${o?.path ?? ""}`),
      toast: () => {},
      href: () => null,
    },
    views: { href: (id: string, o?: { path?: string }) => `/${id}/${o?.path ?? ""}` },
  } as unknown as ClientRookery
}

function fakeEnv(rookery: ClientRookery, envs: EnvInfo[]): FleetEnvApi {
  const api = createFleetEnvApi(rookery)
  return {
    ...api,
    list: async () => envs,
    get: async (name) => envs.find((e) => e.name === envName(name)) ?? env(envName(name)),
    presence: async () => ({ users: [] }),
  }
}

function view(path: string): ViewHandle {
  return {
    id: "fleet.port",
    plugin: "fleet",
    path,
    params: {},
    setTitle: () => {},
    setDirty: () => {},
    setLoading: () => {},
  } as ViewHandle
}

describe("levels", () => {
  test("view is below use is below manage, and an admin holds manage", () => {
    expect(allows({ level: "view" }, "view")).toBe(true)
    expect(allows({ level: "view" }, "use")).toBe(false)
    expect(allows({ level: "use" }, "manage")).toBe(false)
    expect(allows({ level: "manage" }, "manage")).toBe(true)
    expect(allows({ admin: true }, "manage")).toBe(true)
    expect(allows({ admin: true }, "admin")).toBe(true)
    expect(why({ level: "view" }, "use", "env://studio")).toContain("Needs use on env://studio")
    expect(why({ level: "manage" }, "use")).toBeNull()
  })

  test("a forbidden call says to ask the host's owner", () => {
    const x = explain(Object.assign(new Error("no"), { code: "FORBIDDEN" }), {
      env: "studio",
      doing: "open a terminal",
    })
    expect(x.code).toBe("403")
    expect(x.fix).toContain("env://studio")
  })
})

describe("ports", () => {
  test("the proxy URL is /env/<name>/port/<n>/", () => {
    expect(envName("env://studio")).toBe("studio")
    expect(portPath("studio", 5173)).toBe("/env/studio/port/5173/")
    expect(portPath("env://studio", 5173, "/health")).toBe("/env/studio/port/5173/health")
    expect(portFromPath("studio/5173")).toBe(5173)
    expect(portFromPath("5173")).toBe(5173)
    expect(portFromPath("studio/none")).toBeNull()
  })

  test("a port link keeps the port and opens it in a tab of its own", async () => {
    const opened: string[] = []
    const realOpen = window.open
    window.open = ((url: string | URL | undefined) => {
      if (url) opened.push(String(url))
      return null
    }) as typeof window.open
    cleanup.push(() => {
      window.open = realOpen
    })
    const rookery = fakeRookery({ ticket: "https://5173-port.example.test/.rookery/claim?t=t" })
    const dispose = render(
      () => <PortsCard host="studio" env={env("studio")} who={{ level: "use" }} rookery={rookery} />,
      document.body,
    )
    cleanup.push(dispose)
    await settle()

    const input = document.body.querySelector<HTMLInputElement>("[data-part='host-ports'] input")
    expect(input).not.toBeNull()
    input!.value = "5173"
    input!.dispatchEvent(new Event("input", { bubbles: true }))
    document.body.querySelector<HTMLButtonElement>("[data-part='host-ports'] button[type='submit']")!.click()
    await settle()

    const link = document.body.querySelector<HTMLAnchorElement>("[data-port='5173'] a")
    expect(link).not.toBeNull()
    expect(link!.getAttribute("href")).toBe("/env/studio/port/5173/")
    expect(link!.getAttribute("target")).toBe("_blank")

    const open = Array.from(
      document.body.querySelectorAll<HTMLButtonElement>("[data-port='5173'] button"),
    ).find((one) => (one.textContent ?? "").includes("Open"))!
    open.click()
    await settle()
    expect(opened).toEqual(["https://5173-port.example.test/.rookery/claim?t=t"])
  })

  test("a viewer may not reach ports", async () => {
    const dispose = render(
      () => <PortsCard host="studio" env={env("studio")} who={{ level: "view" }} rookery={fakeRookery({})} />,
      document.body,
    )
    cleanup.push(dispose)
    await settle()
    expect(document.body.textContent).toContain("403")
  })

  test("the port page opens env.portUrl's one-use address in a new tab", async () => {
    const calls: Call[] = []
    const opened: string[] = []
    const realOpen = window.open
    window.open = ((url: string | URL | undefined) => {
      if (url) opened.push(String(url))
      return null
    }) as typeof window.open
    cleanup.push(() => {
      window.open = realOpen
    })
    const rookery = fakeRookery({ calls, ticket: "https://5173-port.example.test/.rookery/claim?t=t" })
    const envs = fakeEnv(rookery, [env("studio")])
    const dispose = render(
      () => <PortPage view={view("studio/5173")} rookery={rookery} envs={envs} admin={false} port="5173" />,
      document.body,
    )
    cleanup.push(dispose)
    await settle()
    await settle()

    expect(calls.some((c) => c.method === "env.portUrl")).toBe(true)
    const call = calls.find((c) => c.method === "env.portUrl")
    expect(call?.params).toEqual({ env: "env://studio", port: 5173 })
    expect(opened).toEqual(["https://5173-port.example.test/.rookery/claim?t=t"])
    expect(document.body.querySelector("[data-part='port-opened']")).not.toBeNull()
    expect(document.body.querySelector("[data-part='port-frame']")).toBeNull()
  })

  test("a server without env.portUrl falls back to Rookery's route", async () => {
    const opened: string[] = []
    const realOpen = window.open
    window.open = ((url: string | URL | undefined) => {
      if (url) opened.push(String(url))
      return null
    }) as typeof window.open
    cleanup.push(() => {
      window.open = realOpen
    })
    const rookery = {
      rpc: {
        call: async (method: string, params: Record<string, unknown> = {}) => {
          if (method === "env.get") return env(envName(String(params.env)))
          if (method === "env.portUrl")
            throw Object.assign(new Error("unknown method"), { code: "NOT_FOUND" })
          return {}
        },
      },
      env: {
        get: async (name: string) => env(envName(name)),
        portUrl: async () => {
          throw Object.assign(new Error("unknown method"), { code: "NOT_FOUND" })
        },
      },
      workbench: { openView: () => {}, toast: () => {} },
      views: { href: () => null },
    } as unknown as ClientRookery
    const envs = fakeEnv(rookery, [env("studio")])
    const dispose = render(
      () => <PortPage view={view("studio/5173")} rookery={rookery} envs={envs} admin={false} port="5173" />,
      document.body,
    )
    cleanup.push(dispose)
    await settle()
    await settle()

    expect(opened).toEqual(["/env/studio/port/5173/"])
  })
})

describe("the desktop's gates", () => {
  test("a host with no desktop says so", async () => {
    const dispose = render(
      () => (
        <DesktopBody
          name="studio"
          env={env("studio", {
            supports: { ...env("studio").supports, desktop: false },
          })}
          who={{ level: "use" }}
        />
      ),
      document.body,
    )
    cleanup.push(dispose)
    await settle()
    expect(document.body.textContent).toContain("This host has no desktop")
  })

  test("use is needed for the live desktop, and the host must be online", async () => {
    const first = render(
      () => <DesktopBody name="studio" env={env("studio")} who={{ level: "view" }} />,
      document.body,
    )
    await settle()
    expect(document.body.textContent).toContain("403")
    first()
    document.body.innerHTML = ""

    const second = render(
      () => <DesktopBody name="studio" env={env("studio", { state: "offline" })} who={{ level: "use" }} />,
      document.body,
    )
    await settle()
    expect(document.body.textContent).toContain("503")
    second()
  })

  test("view sees a picture of the desktop, not the live one", async () => {
    const picture = { base64: "iVBORw0KGgo=", content_type: "image/png" }
    const dispose = render(
      () => (
        <DesktopBody
          name="studio"
          env={env("studio", { level: "view" })}
          who={{ level: "view" }}
          picture={picture}
        />
      ),
      document.body,
    )
    cleanup.push(dispose)
    await settle()

    const img = document.body.querySelector<HTMLImageElement>("[data-part='desktop-picture']")
    expect(img).not.toBeNull()
    expect(img!.getAttribute("src")).toBe("data:image/png;base64,iVBORw0KGgo=")
    // The live desktop is not rendered, and the picture says what it is.
    expect(document.body.querySelector("[data-part='desktop-view']")).toBeNull()
    expect(document.body.textContent).toContain("Watching it live needs use")
  })

  test("the desktop page asks hosts.desktop.screenshot for the picture at view", async () => {
    const rookery = fakeRookery({})
    const envs = fakeEnv(rookery, [env("studio", { level: "view" })])
    const shots: string[] = []
    const dispose = render(
      () => (
        <DesktopPage
          view={view("studio")}
          rookery={rookery}
          envs={envs}
          admin={false}
          screenshot={async (host) => {
            shots.push(host)
            return { base64: "AAAA", content_type: "image/png" }
          }}
        />
      ),
      document.body,
    )
    cleanup.push(dispose)
    await settle()
    await settle()

    expect(shots).toEqual(["studio"])
    expect(document.body.querySelector("[data-part='desktop-picture']")).not.toBeNull()
  })
})

describe("files", () => {
  test("readFile gives base64 and its SHA-256, and writeFile sends base64 with ifMatch", async () => {
    const calls: Call[] = []
    const rookery = fakeRookery({ calls, file: { base64: "QT0xCg==", sha256: "abc" } })
    const envs = createFleetEnvApi(rookery)

    const read = await envs.readFile("studio", "/srv/app.env")
    expect(read).toEqual({ base64: "QT0xCg==", size: 4, sha256: "abc" })
    expect(calls[0]).toEqual({
      method: "env.readFile",
      params: { env: "env://studio", path: "/srv/app.env" },
    })

    const written = await envs.writeFile("env://studio", "/srv/app.env", "A=2\n", {
      ifMatch: read.sha256,
    })
    expect(written).toEqual({ sha256: "def", size: 7 })
    expect(calls[1]).toEqual({
      method: "env.writeFile",
      params: {
        env: "env://studio",
        path: "/srv/app.env",
        base64: btoa("A=2\n"),
        ifMatch: "abc",
      },
    })
  })

  test("a stale ifMatch is a 409 conflict to show", async () => {
    const envs = createFleetEnvApi(fakeRookery({ file: { base64: "", sha256: "abc" } }))
    try {
      await envs.writeFile("studio", "/srv/app.env", "A=3\n", { ifMatch: "stale" })
      throw new Error("the write should not have gone through")
    } catch (e) {
      const x = explain(e, { env: "studio", doing: "write /srv/app.env" })
      expect(x.code).toBe("409")
      expect(x.what).toContain("changed since it was read")
      expect(x.fix).toContain("Reload")
    }
  })

  test("a new file is written with overwrite and no ifMatch", async () => {
    const calls: Call[] = []
    const envs = createFleetEnvApi(fakeRookery({ calls }))
    await envs.writeFile("studio", "/srv/new.env", new Uint8Array([65, 10]), { overwrite: true })
    expect(calls[0]?.params).toEqual({
      env: "env://studio",
      path: "/srv/new.env",
      base64: "QQo=",
      overwrite: true,
    })
  })
})

describe("sharing a host", () => {
  test("shows who has access and adds a person at a level", async () => {
    const calls: Call[] = []
    const rookery = fakeRookery({
      me: { id: "u-ops", name: "Ops", admin: true },
      users: [
        { id: "u-ops", name: "Ops", email: "ops@example.test", admin: true, disabled: false },
        { id: "u-eve", name: "Eve", email: "eve@example.test", admin: false, disabled: false },
      ],
      owner: "u-ops",
      grants: [grant("user:u-eve", "view")],
      calls,
    })
    const dispose = render(
      () => <ShareDialog host="studio" rookery={rookery} onClose={() => {}} />,
      document.body,
    )
    cleanup.push(dispose)
    await settle()

    expect(calls.some((c) => c.method === "access.grants" && c.params.resource === "env://studio")).toBe(true)
    expect(calls.some((c) => c.method === "admin.users")).toBe(true)
    expect(calls.some((c) => c.method === "admin.groups")).toBe(true)
    const list = document.body.querySelector("[data-part='share-list']")
    expect(list?.textContent).toContain("Ops")
    expect(list?.textContent).toContain("Owner")
    expect(list?.textContent).toContain("Eve")

    // Eve already has access; the row offers a level to change.
    const eveRow = document.body.querySelector("[data-principal='user:u-eve']")
    expect(eveRow).not.toBeNull()

    // Pick Eve's level: manage.
    const levelButton = eveRow!.querySelector("button[aria-haspopup='listbox']")!
    levelButton.dispatchEvent(new MouseEvent("click", { bubbles: true }))
    await settle()
    const manage = Array.from(document.querySelectorAll("[role='menuitemradio'], [role='menuitem']")).find(
      (el) => el.textContent?.includes("Can manage"),
    )
    expect(manage).toBeDefined()
    ;(manage as HTMLElement).dispatchEvent(new MouseEvent("click", { bubbles: true }))
    await settle()
    const grantCall = [...calls].reverse().find((c) => c.method === "access.grant")
    expect(grantCall?.params).toEqual({ resource: "env://studio", principal: "user:u-eve", level: "manage" })

    // Removing it calls access.revoke.
    const remove = document.body.querySelector<HTMLButtonElement>(
      "[data-principal='user:u-eve'] button[aria-label^='Remove']",
    )
    expect(remove).not.toBeNull()
    remove!.click()
    await settle()
    expect(calls.some((c) => c.method === "access.revoke" && c.params.principal === "user:u-eve")).toBe(true)
  })

  test("a manager who is not an admin types a user id", async () => {
    const calls: Call[] = []
    const rookery = fakeRookery({
      me: { id: "u-eve", name: "Eve", admin: false },
      owner: "u-ops",
      grants: [],
      calls,
    })
    const dispose = render(
      () => <ShareDialog host="studio" rookery={rookery} onClose={() => {}} />,
      document.body,
    )
    cleanup.push(dispose)
    await settle()

    // No admin, so no people list: the dialog asks for `user:<id>` instead.
    expect(calls.some((c) => c.method === "admin.users")).toBe(true)
    expect(document.body.querySelector("[data-part='share-search']")).toBeNull()
    const field = document.body.querySelector<HTMLInputElement>("input[data-part='share-principal']")
    expect(field).not.toBeNull()
    field!.value = "user:u-new"
    field!.dispatchEvent(new Event("input", { bubbles: true }))
    field!.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }))
    await settle()

    const grantCall = calls.find((c) => c.method === "access.grant")
    expect(grantCall?.params).toEqual({ resource: "env://studio", principal: "user:u-new", level: "use" })
  })

  test("a person without manage is told so", async () => {
    const rookery = fakeRookery({ me: { id: "u-eve", name: "Eve", admin: false }, forbidGrants: true })
    const dispose = render(
      () => <ShareDialog host="studio" rookery={rookery} onClose={() => {}} />,
      document.body,
    )
    cleanup.push(dispose)
    await settle()
    expect(document.body.textContent).toContain("403")
    expect(document.body.textContent).toContain("manage")
  })
})
