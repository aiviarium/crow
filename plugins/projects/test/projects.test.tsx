import { afterEach, describe, expect, test } from "bun:test"
import type { ClientRookery, SpaceInfo, ViewComponent, ViewHandle } from "@rookery/sdk/client"
import { createRoot, createSignal } from "solid-js"
import { render } from "solid-js/web"
import manifest from "../rookery/plugin.json"
import projectsClient from "../src/client"
import { disposeAll } from "../src/ui/store"

const cleanups: Array<() => void> = []
afterEach(() => {
  while (cleanups.length) cleanups.pop()!()
  disposeAll()
  document.body.innerHTML = ""
})

const flush = () => new Promise<void>((r) => setTimeout(r, 20))

function createLiveAccessor<T>(initial: T[]) {
  const [rows] = createSignal<T[]>(initial)
  return Object.assign(() => rows(), {
    loading: false,
    error: undefined as Error | undefined,
    stale: false,
    refetch: () => {},
  })
}

function createFakeClient() {
  const views = new Map<string, ViewComponent>()
  const commands = new Map<string, { title?: string; run: (params: Record<string, unknown>) => unknown }>()
  const navSections = new Map<string, unknown>()
  const statusItems = new Map<string, unknown>()
  const registeredWidgets = new Map<string, unknown>()
  const registeredBlocks = new Map<string, unknown>()
  const openedViews: Array<{ id: string; opts?: Record<string, unknown> }> = []
  const toasts: Array<{ title: string; body?: string; kind?: string }> = []

  const projectSpace: SpaceInfo = {
    id: "space-crow",
    kind: "projects.project",
    name: "Crow",
    slug: "crow",
    personal: false,
    level: null,
    owner: "user://u1",
  }

  const projectRow = {
    id: "proj-1",
    spaceId: "space-crow",
    key: "CROW",
    name: "Crow",
    summary: "Crow issue tracker",
    icon: "board",
    lead: "user://u1",
    archived: false,
  }

  const makeData = (): any =>
    new Proxy(
      {
        refs: { from: async () => [], to: async () => [] },
        space: () => makeData(),
        projects: {
          find: async () => ({ rows: [projectRow], next: null, total: 1 }),
          live: () => createLiveAccessor([projectRow]),
        },
        views: {
          find: async () => ({ rows: [], next: null, total: 0 }),
          live: () => createLiveAccessor([]),
        },
      },
      {
        get(target, prop) {
          if (typeof prop === "string" && !(prop in target)) {
            return {
              find: async () => ({ rows: [], next: null, total: 0 }),
              get: async () => null,
              live: () => createLiveAccessor([]),
            }
          }
          return (target as Record<PropertyKey, unknown>)[prop]
        },
      },
    )

  const rookery = {
    id: "projects",
    manifest,
    views: {
      register(id: string, component: ViewComponent) {
        views.set(id, component)
        return { dispose() {} }
      },
      href: () => null,
    },
    commands: {
      register(id: string, def: { title?: string; run: (params: Record<string, unknown>) => unknown }) {
        commands.set(id, def)
        return { dispose() {} }
      },
      run: async () => undefined,
      list: async () => [],
    },
    nav: {
      section(id: string, sec: unknown) {
        navSections.set(id, sec)
        return { dispose() {} }
      },
      badge: () => ({ dispose() {} }),
    },
    workbench: {
      openView(id: string, opts?: Record<string, unknown>) {
        openedViews.push({ id, opts })
      },
      href: () => null,
      toast(t: { title: string; body?: string; kind?: string }) {
        toasts.push(t)
      },
      statusItem(id: string, comp: unknown) {
        statusItems.set(id, comp)
        return { dispose() {} }
      },
    },
    spaces: {
      current: () => projectSpace,
      list: async () => [projectSpace],
      get: async () => projectSpace,
    },
    data: makeData(),
    rpc: {
      call: async (method: string) => {
        if (method === "auth.me") return { user: { id: "u1", name: "Ada", admin: true } }
        if (method === "entities.resolveMany") return [{ uri: "user://u1", id: "u1", title: "Ada" }]
        return null
      },
    },
    host: {
      call: async () => ({}),
    },
    storage: {
      get: async () => null,
      set: async () => {},
      delete: async () => {},
      list: async () => [],
    },
    plugins: {
      call: async () => ({ tasks: [] }),
    },
    widgets: {
      register(id: string, component: unknown) {
        registeredWidgets.set(id, component)
        return { dispose: () => registeredWidgets.delete(id) }
      },
    },
    blocks: {
      register(id: string, component: unknown) {
        registeredBlocks.set(id, component)
        return { dispose: () => registeredBlocks.delete(id) }
      },
    },
    env: {
      list: async () => [],
    },
  } as unknown as ClientRookery

  return {
    rookery,
    views,
    commands,
    navSections,
    statusItems,
    registeredWidgets,
    registeredBlocks,
    openedViews,
    toasts,
    projectSpace,
  }
}

describe("projects client half", () => {
  test("registers all views, commands, sidebar section, overlays, and dashboard widgets", async () => {
    const f = createFakeClient()
    createRoot((dispose) => {
      cleanups.push(dispose)
      projectsClient.activate(f.rookery)
    })

    for (const viewId of [
      "projects.home",
      "projects.issues",
      "projects.issue",
      "projects.overview",
      "projects.settings",
      "projects.cycles",
      "projects.cycle",
      "projects.mine",
      "projects.import",
      "projects.label",
      "projects.comment",
    ]) {
      expect(f.views.has(viewId)).toBe(true)
    }

    for (const cmdId of [
      "projects.newIssue",
      "projects.newProject",
      "projects.open",
      "projects.myIssues",
      "projects.shortcuts",
      "projects.import",
      "projects.currentCycle",
    ]) {
      expect(f.commands.has(cmdId)).toBe(true)
    }

    expect(f.navSections.has("projects.sidebar")).toBe(true)
    expect(f.statusItems.has("projects.overlays")).toBe(true)

    // Commands route to views
    await f.commands.get("projects.open")!.run({})
    await f.commands.get("projects.myIssues")!.run({})
    expect(f.openedViews.map((v) => v.id)).toEqual(["projects.home", "projects.mine"])

    // Dashboard widgets and editor blocks are registered via rookery.widgets / rookery.blocks
    expect([...f.registeredWidgets.keys()]).toEqual(["projects.myIssues", "projects.cycle"])
    expect([...f.registeredBlocks.keys()]).toEqual(["projects.issues"])
  })

  test("renders projects.home and opens a project overview on click", async () => {
    const f = createFakeClient()
    createRoot((dispose) => {
      cleanups.push(dispose)
      projectsClient.activate(f.rookery)
    })

    const host = document.createElement("div")
    document.body.appendChild(host)
    let title = ""
    const view: ViewHandle = {
      id: "projects.home",
      plugin: "projects",
      path: "",
      params: {},
      setTitle: (t) => {
        title = t
      },
      setDirty: () => {},
      setLoading: () => {},
    }

    const Home = f.views.get("projects.home")!
    const dispose = render(() => Home({ view }), host)
    cleanups.push(dispose)
    await flush()

    expect(title).toBe("Projects")
    expect(host.textContent).toContain("Crow")
    expect(host.textContent).toContain("Crow issue tracker")

    const card = host.querySelector(".projects__project-card") as HTMLButtonElement | null
    expect(card).not.toBeNull()
    card!.click()
    expect(f.openedViews).toContainEqual({ id: "projects.overview", opts: { path: "proj-1" } })
  })
})
