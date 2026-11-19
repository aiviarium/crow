// The M3 host parts: port links through the server's proxy, sharing a host with grants, and the gates on a
// host's desktop. Rendered with fakes; nothing here opens a socket or a VNC connection.
import { afterEach, describe, expect, test } from "bun:test"
import type { EnvInfo, GrantInfo } from "@rookery/client"
import type { ClientRookery } from "@rookery/sdk/client"
import { render } from "solid-js/web"
import { allows, explain, why } from "../src/access"
import { DesktopBody } from "../src/DesktopPage"
import { envName, envUri, portUrl } from "../src/env"
import { PortsCard, portFromPath } from "../src/Ports"
import { ShareDialog } from "../src/ShareDialog"

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

function fakeRookery(opts: {
  me?: { id: string; name: string; admin: boolean } | null
  users?: Array<{ id: string; name: string; email?: string; admin: boolean; disabled: boolean }>
  grants?: GrantInfo[]
  owner?: string | null
  forbidGrants?: boolean
  calls?: Call[]
  opened?: string[]
}): ClientRookery {
  const grants = [...(opts.grants ?? [])]
  return {
    rpc: {
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
    },
    workbench: {
      openView: (id: string, o?: { path?: string }) => opts.opened?.push(`${id}:${o?.path ?? ""}`),
      toast: () => {},
      href: () => null,
    },
    views: { href: (id: string, o?: { path?: string }) => `/${id}/${o?.path ?? ""}` },
  } as unknown as ClientRookery
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
    expect(portUrl("studio", 5173)).toBe("/env/studio/port/5173/")
    expect(portUrl("env://studio", 5173, "/health")).toBe("/env/studio/port/5173/health")
    expect(portFromPath("studio/5173")).toBe(5173)
    expect(portFromPath("5173")).toBe(5173)
    expect(portFromPath("studio/none")).toBeNull()
  })

  test("a port link keeps the port and opens the proxy", async () => {
    const opened: string[] = []
    const rookery = fakeRookery({ opened })
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

    document.body.querySelector<HTMLButtonElement>("[data-port='5173'] button")!.click()
    expect(opened).toEqual(["fleet.port:studio/5173"])
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

  test("use is needed, and the host must be online", async () => {
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
