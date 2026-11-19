// The plugins page in admin, with fakes: what is installed and why one is not usable, installing from a
// package of the registries, starting a failed plugin, removing one, and asking the registries for a
// newer version. Nothing here opens a socket or reaches Hatchery.
import { afterEach, describe, expect, test } from "bun:test"
import type { PluginInfo } from "@rookery/client"
import type { ClientRookery, ViewHandle } from "@rookery/sdk/client"
import { render } from "solid-js/web"
import { AdminView } from "../src/AdminView"
import { createFleetApi } from "../src/fleetApi"

const cleanup: Array<() => void> = []
afterEach(() => {
  while (cleanup.length) cleanup.pop()!()
  document.body.innerHTML = ""
})

const settle = (ms = 40) => new Promise((resolve) => setTimeout(resolve, ms))

async function waitFor(fn: () => boolean, label = "condition", timeoutMs = 5000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (fn()) return
    await settle(10)
  }
  throw new Error(`timed out waiting for: ${label}`)
}

interface Call {
  method: string
  params: Record<string, unknown>
}

function plugin(over: Partial<PluginInfo> & Pick<PluginInfo, "id">): PluginInfo {
  return {
    state: "active",
    package: `crow/${over.id}`,
    version: "0.1.0",
    origin: "shipped",
    source: "",
    label: over.id,
    description: "",
    dir: `/home/ops/.config/rookery/plugins/crow/${over.id}`,
    problem: "",
    ...over,
  } as PluginInfo
}

function fakeRookery(state: { plugins: PluginInfo[]; added: PluginInfo[] }) {
  const calls: Call[] = []
  const toasts: Array<{ kind?: string; title: string; body?: string }> = []

  const call = async (method: string, params: Record<string, unknown> = {}): Promise<unknown> => {
    calls.push({ method, params: structuredClone(params) })
    switch (method) {
      case "auth.me":
        return {
          user: { id: "u-ada", name: "Ada", email: "ada@example.test" },
          principal: { kind: "user", id: "u-ada" },
          admin: true,
          auth: "local",
          version: "0.4.0",
          apiVersion: 1,
        }
      case "plugins.list":
        return { plugins: structuredClone([...state.plugins, ...state.added]) }
      case "plugins.registry.list":
        return {
          file: "/home/ops/.config/rookery/hatchery.kdl",
          registries: [
            { kind: "builtin", location: "plugins", name: "rookery", only: ["rookery"], builtin: true },
            {
              kind: "git",
              location: "https://github.com/aiviarium/crow.git",
              name: "",
              only: [],
              key: null,
              min_age: null,
              unsigned_tags: false,
            },
          ],
        }
      case "plugins.add": {
        const spec = String(params.spec)
        const id = spec.split("/").pop()?.split("@")[0] ?? spec
        const added = plugin({ id, label: "Crow", package: spec, version: "0.2.0", origin: "registry" })
        state.added.push(added)
        return { lines: [`installed ${spec} 0.2.0`], plugins: [...state.plugins, ...state.added] }
      }
      case "plugins.upload": {
        const added = plugin({ id: "hello", label: "Hello", origin: "file", version: "1.0.0" })
        state.added.push(added)
        return { lines: ["installed hello 1.0.0"], plugins: [...state.plugins, ...state.added] }
      }
      case "plugins.activate": {
        const found = state.plugins.find((one) => one.id === params.id)
        if (!found) throw new Error(`no plugin ${params.id}`)
        found.state = "active"
        return structuredClone(found)
      }
      case "plugins.remove": {
        state.plugins = state.plugins.filter((one) => one.id !== params.id)
        return { lines: [`removed ${params.id}`], plugins: [...state.plugins, ...state.added] }
      }
      case "plugins.update":
        return { lines: ["updated crow/shell 0.2.0"], plugins: [...state.plugins, ...state.added] }
      case "plugins.check":
        return {
          plugins: [
            { id: "shell", package: "crow/shell", version: "0.1.0", latest: "0.2.0", note: "" },
            { id: "fleet", package: "crow/fleet", version: "0.1.0", latest: null, note: "" },
          ],
        }
      default:
        throw Object.assign(new Error(`unknown method ${method}`), { code: "NOT_FOUND" })
    }
  }

  const rookery = {
    rpc: { call },
    workbench: {
      openView: () => {},
      toast: (toast: { kind?: string; title: string; body?: string }) => toasts.push(toast),
      href: () => null,
    },
    views: { href: () => "/fleet/hosts" },
    events: { subscribe: async () => ({ dispose() {} }) },
  } as unknown as ClientRookery

  return { rookery, calls, toasts }
}

function view(section: string): ViewHandle {
  return {
    id: "fleet.admin",
    plugin: "fleet",
    path: section,
    params: {},
    setTitle() {},
    setDirty() {},
    setLoading() {},
  } as ViewHandle
}

function state() {
  return {
    plugins: [
      plugin({ id: "shell", label: "Crow", description: "The web shell.", version: "0.1.0" }),
      plugin({
        id: "fleet",
        label: "Fleet",
        version: "0.1.0",
        state: "failed",
        origin: "registry",
        source: "crow",
        problem: "its host half ended three times",
        error: { code: "INTERNAL", message: "its host half ended three times" },
      }),
    ],
    added: [] as PluginInfo[],
  }
}

describe("the plugins page in admin", () => {
  test("lists each plugin with its state and problem, and starts a failed one", async () => {
    const plugins = state()
    const fake = fakeRookery(plugins)
    const api = createFleetApi(fake.rookery, () => ({ id: "u-ada", name: "Ada", admin: true }))

    const dispose = render(
      () => <AdminView view={view("plugins")} rookery={fake.rookery} api={api} />,
      document.body,
    )
    cleanup.push(dispose)

    await waitFor(() => document.body.querySelector("[data-plugin='shell']") !== null, "the plugins")

    const shell = document.body.querySelector("[data-plugin='shell']")!
    expect(shell.textContent).toContain("Crow")
    expect(shell.textContent).toContain("0.1.0")
    expect(shell.textContent).toContain("Running")

    const fleet = document.body.querySelector("[data-plugin='fleet']")!
    expect(fleet.textContent).toContain("Failed")
    expect(fleet.textContent).toContain("its host half ended three times")
    expect(fleet.textContent).toContain("/home/ops/.config/rookery/plugins/crow/fleet")
    // A plugin that runs needs no starting.
    expect(shell.querySelector("[data-part='activate-plugin']")).toBeNull()

    fleet.querySelector<HTMLButtonElement>("[data-part='activate-plugin']")!.click()
    await waitFor(
      () => fake.calls.some((one) => one.method === "plugins.activate" && one.params.id === "fleet"),
      "plugins.activate",
    )
    await waitFor(
      () => (document.body.querySelector("[data-plugin='fleet']")?.textContent ?? "").includes("Running"),
      "the new state",
    )
  })

  test("installs a package of the registries and removes a plugin", async () => {
    const plugins = state()
    const fake = fakeRookery(plugins)
    const api = createFleetApi(fake.rookery, () => ({ id: "u-ada", name: "Ada", admin: true }))

    const dispose = render(
      () => <AdminView view={view("plugins")} rookery={fake.rookery} api={api} />,
      document.body,
    )
    cleanup.push(dispose)

    await waitFor(() => document.body.querySelector("[data-part='add-plugin']") !== null, "the button")
    document.body.querySelector<HTMLButtonElement>("[data-part='add-plugin']")!.click()
    await waitFor(() => document.body.querySelector("#plugin-spec") !== null, "the form")

    const spec = document.body.querySelector<HTMLInputElement>("#plugin-spec")!
    spec.value = "crow/hello"
    spec.dispatchEvent(new Event("input", { bubbles: true }))
    document.body.querySelector<HTMLButtonElement>("[data-part='install-plugin']")!.click()

    await waitFor(
      () =>
        fake.calls.some(
          (one) =>
            one.method === "plugins.add" && one.params.spec === "crow/hello" && one.params.git === undefined,
        ),
      "plugins.add",
    )
    await waitFor(() => document.body.querySelector("[data-plugin='hello']") !== null, "the installed plugin")

    // Removing one asks first.
    document.querySelector<HTMLButtonElement>("[data-plugin='fleet'] [data-part='remove-plugin']")!.click()
    await waitFor(
      () => document.body.querySelector("[data-part='confirm-remove-plugin']") !== null,
      "the confirm",
    )
    document.body.querySelector<HTMLButtonElement>("[data-part='confirm-remove-plugin']")!.click()
    await waitFor(
      () => fake.calls.some((one) => one.method === "plugins.remove" && one.params.id === "fleet"),
      "plugins.remove",
    )
    await waitFor(() => document.body.querySelector("[data-plugin='fleet']") === null, "the row gone")
  })

  test("shows the registries and what the registries offer as newer", async () => {
    const plugins = state()
    const fake = fakeRookery(plugins)
    const api = createFleetApi(fake.rookery, () => ({ id: "u-ada", name: "Ada", admin: true }))

    const dispose = render(
      () => <AdminView view={view("plugins")} rookery={fake.rookery} api={api} />,
      document.body,
    )
    cleanup.push(dispose)

    await waitFor(
      () =>
        document.body.querySelector("[data-plugin-registry='https://github.com/aiviarium/crow.git']") !==
        null,
      "the registries",
    )
    expect(document.body.querySelector("[data-part='plugin-registries']")!.textContent).toContain("built in")

    document.body.querySelector<HTMLButtonElement>("[data-part='check-plugins']")!.click()
    await waitFor(
      () => document.body.querySelector("[data-plugin-update='shell']") !== null,
      "the newer version",
    )
    expect(document.body.querySelector("[data-plugin-update='shell']")!.textContent).toContain("0.2.0")
    // A plugin at its newest version is not listed.
    expect(document.body.querySelector("[data-plugin-update='fleet']")).toBeNull()

    document.body
      .querySelector<HTMLButtonElement>("[data-plugin-update='shell'] [data-part='update-plugin']")!
      .click()
    await waitFor(
      () => fake.calls.some((one) => one.method === "plugins.update" && one.params.id === "shell"),
      "plugins.update",
    )
  })
})
