// Tests for the dashboards plugin and the dashboard widgets contribution layer (`WidgetArea`,
// widget registry, picker grouping, defaults/limits, and dashboards client views against fakes).
import { afterEach, describe, expect, test } from "bun:test"
import type { ClientRookery, Disposable, ViewHandle } from "@rookery/sdk/client"
import { createSignal, type JSX } from "solid-js"
import { render } from "solid-js/web"
import dashboardsClient from "../src/client"
import {
  clearWidgetRegistry,
  defineBuiltinWidget,
  groupForPicker,
  limits,
  registerManifestWidgets,
  registerWidget,
  settingsWithDefaults,
  WidgetArea,
  type WidgetInstance,
  type WidgetType,
} from "../src/widgets"

const cleanups: Array<() => void> = []
afterEach(() => {
  while (cleanups.length) cleanups.pop()!()
  clearWidgetRegistry()
  document.body.innerHTML = ""
})

const flush = () => new Promise<void>((r) => setTimeout(r, 20))

describe("widget settings & picker helpers", () => {
  test("settingsWithDefaults fills schema defaults and preserves overrides", () => {
    const type: Pick<WidgetType, "settings"> = {
      settings: {
        type: "object",
        properties: {
          limit: { type: "integer", default: 10 },
          title: { type: "string", default: "Issues" },
          empty: { type: "string" },
        },
      },
    }
    expect(settingsWithDefaults(type, undefined)).toEqual({ limit: 10, title: "Issues" })
    expect(settingsWithDefaults(type, { limit: 25 })).toEqual({ limit: 25, title: "Issues" })
  })

  test("limits extracts grid bounds from WidgetSizes", () => {
    expect(
      limits({
        sizes: {
          default: { w: 4, h: 3 },
          min: { w: 2, h: 2 },
          max: { w: 8, h: 6 },
        },
      }),
    ).toEqual({ minW: 2, minH: 2, maxW: 8, maxH: 6 })
    expect(limits(undefined)).toEqual({ minW: undefined, minH: undefined, maxW: undefined, maxH: undefined })
  })

  test("groupForPicker filters by area and search query and sorts categories", () => {
    const types: WidgetType[] = [
      {
        id: "projects.myIssues",
        plugin: "projects",
        title: "My issues",
        description: "Open work assigned to you",
        category: "Projects",
        areas: ["dashboard", "home"],
        sizes: { default: { w: 4, h: 4 } },
      },
      {
        id: "crow.clock",
        plugin: "crow",
        title: "Clock",
        areas: ["home"],
        sizes: { default: { w: 2, h: 2 } },
      },
      {
        id: "alpha.kpi",
        plugin: "alpha",
        title: "KPI",
        description: "Key metrics",
        sizes: { default: { w: 3, h: 2 } },
      },
    ]

    const dashGroups = groupForPicker(types, "dashboard", "")
    expect(dashGroups.map(([g]) => g)).toEqual(["Alpha", "Projects"])
    expect(dashGroups[1]![1].map((t) => t.id)).toEqual(["projects.myIssues"])

    const filtered = groupForPicker(types, "dashboard", "assigned")
    expect(filtered).toHaveLength(1)
    expect(filtered[0]![1][0]!.id).toBe("projects.myIssues")

    const homeGroups = groupForPicker(types, "home", "")
    expect(homeGroups.map(([g]) => g)).toEqual(["Alpha", "General", "Projects"])
  })
})

describe("WidgetArea", () => {
  test("renders registered widget, allows adding via picker, configuring, and removing", async () => {
    registerManifestWidgets("projects", [
      {
        id: "projects.summary",
        title: "Summary",
        description: "Project summary",
        category: "Projects",
        icon: "check",
        areas: ["dashboard"],
        sizes: { default: { w: 4, h: 3 }, min: { w: 2, h: 2 } },
        settings: {
          type: "object",
          properties: {
            heading: { type: "string", title: "Heading", default: "Default heading" },
          },
        },
      },
    ])
    registerWidget("projects", "projects.summary", (props) => (
      <div data-testid="summary-widget">{String(props.widget.settings.heading)}</div>
    ))

    const [instances, setInstances] = createSignal<WidgetInstance[]>([])
    const host = document.createElement("div")
    document.body.appendChild(host)
    cleanups.push(
      render(
        () => <WidgetArea area="dashboard" instances={instances()} editing={true} onChange={setInstances} />,
        host,
      ),
    )

    expect(host.textContent).toContain("No widgets yet")

    // Open picker and add widget.
    const addBtn = host.querySelector<HTMLButtonElement>('[data-part="add-widget"]')
    expect(addBtn).toBeTruthy()
    addBtn!.click()
    await flush()

    const item = document.querySelector<HTMLButtonElement>('[data-widget-type="projects.summary"]')
    expect(item).toBeTruthy()
    item!.click()
    await flush()

    expect(instances()).toHaveLength(1)
    expect(instances()[0]!.type).toBe("projects.summary")
    expect(instances()[0]!.settings).toEqual({ heading: "Default heading" })
    expect(host.querySelector('[data-testid="summary-widget"]')?.textContent).toBe("Default heading")

    // Remove via keyboard Delete on focused widget wrapper.
    const widgetEl = host.querySelector<HTMLElement>('[data-part="widget"]')
    expect(widgetEl).toBeTruthy()
    widgetEl!.dispatchEvent(new KeyboardEvent("keydown", { key: "Delete", bubbles: true }))
    await flush()
    expect(instances()).toHaveLength(0)
  })

  test("collapses blank widgets outside editing and shows placeholder while editing", async () => {
    defineBuiltinWidget(
      {
        id: "crow.empty",
        title: "Quiet widget",
        sizes: { default: { w: 3, h: 2 } },
      },
      () => null,
    )

    const [editing, setEditing] = createSignal(false)
    const initial: WidgetInstance[] = [{ id: "w1", type: "crow.empty", x: 0, y: 0, w: 3, h: 2 }]
    const host = document.createElement("div")
    document.body.appendChild(host)
    cleanups.push(
      render(
        () => <WidgetArea area="dashboard" instances={initial} editing={editing()} onChange={() => {}} />,
        host,
      ),
    )
    await flush()

    expect(host.querySelector('[data-part="widgets-quiet"]')).toBeTruthy()
    setEditing(true)
    await flush()
    expect(host.querySelector('[data-part="widget-placeholder"]')).toBeTruthy()
  })
})

describe("dashboards client plugin", () => {
  function makeFakeRookery() {
    type Row = {
      id: string
      title: string
      description: string | null
      layout: WidgetInstance[]
      rev: number
      updatedAt: string
    }
    const [rows, setRows] = createSignal<Row[]>([
      {
        id: "d-1",
        title: "Ops overview",
        description: "Team dashboard",
        layout: [],
        rev: 1,
        updatedAt: "2026-01-01T00:00:00.000Z",
      },
    ])
    const views = new Map<string, (props: { view: ViewHandle }) => JSX.Element>()
    const commands = new Map<string, () => unknown>()
    const opened: Array<{ id: string; opts?: unknown }> = []
    const toasts: Array<{ title: string; kind?: string }> = []
    const updates: Array<{ id: string; patch: Record<string, unknown> }> = []

    const noopDisposable: Disposable = { dispose() {} }
    const collection = {
      live(q?: { where?: { id?: string } }) {
        const fn = () => {
          const all = rows()
          return q?.where?.id ? all.filter((r) => r.id === q.where!.id) : all
        }
        return Object.assign(fn, { loading: false, error: () => null, refresh: () => {} })
      },
      async insert(data: Partial<Row>) {
        const next: Row = {
          id: `d-${rows().length + 1}`,
          title: data.title ?? "Untitled dashboard",
          description: data.description ?? null,
          layout: data.layout ?? [],
          rev: 1,
          updatedAt: new Date().toISOString(),
        }
        setRows((prev) => [next, ...prev])
        return next
      },
      async update(id: string, patch: Record<string, unknown>) {
        updates.push({ id, patch })
        let updated: Row | undefined
        setRows((prev) =>
          prev.map((r) => {
            if (r.id !== id) return r
            updated = { ...r, ...patch, rev: r.rev + 1 }
            return updated
          }),
        )
        return updated!
      },
    }

    const rookery = {
      views: {
        register(id: string, component: (props: { view: ViewHandle }) => JSX.Element) {
          views.set(id, component)
          return noopDisposable
        },
      },
      commands: {
        register(id: string, def: { run: () => unknown }) {
          commands.set(id, def.run)
          return noopDisposable
        },
      },
      workbench: {
        openView(id: string, opts?: unknown) {
          opened.push({ id, opts })
        },
        toast(t: { title: string; kind?: string }) {
          toasts.push(t)
        },
      },
      spaces: {
        current: () => ({
          id: "sp-team",
          kind: "team",
          name: "Engineering",
          slug: "eng",
          personal: false,
          level: "manage",
          owner: null,
        }),
      },
      rpc: {
        async call(method: string) {
          if (method === "plugins.list") return { plugins: [] }
          return {}
        },
      },
      data: {
        dashboards: collection,
      },
    } as unknown as ClientRookery

    return { rookery, views, commands, opened, toasts, updates, rows }
  }

  test("lists dashboards, creates new dashboard via command, and edits/saves title", async () => {
    const fake = makeFakeRookery()
    await dashboardsClient.activate(fake.rookery)

    expect(fake.views.has("dashboards.list")).toBe(true)
    expect(fake.views.has("dashboards.dashboard")).toBe(true)
    expect(fake.commands.has("dashboards.create")).toBe(true)

    // Render list view
    const listHost = document.createElement("div")
    document.body.appendChild(listHost)
    const titles: string[] = []
    const listView = fake.views.get("dashboards.list")!
    cleanups.push(
      render(
        () =>
          listView({
            view: {
              id: "dashboards.list",
              plugin: "dashboards",
              path: "",
              params: {},
              setTitle: (t) => titles.push(t),
              setDirty: () => {},
              setLoading: () => {},
            },
          }),
        listHost,
      ),
    )

    expect(listHost.textContent).toContain("Ops overview")
    expect(titles).toContain("Dashboards")

    // Run create command
    await fake.commands.get("dashboards.create")!()
    expect(fake.rows()).toHaveLength(2)
    expect(fake.opened[0]).toEqual({
      id: "dashboards.dashboard",
      opts: { path: "d-2", params: { edit: "1" } },
    })

    // Render dashboard view in edit mode and save
    const dashHost = document.createElement("div")
    document.body.appendChild(dashHost)
    const dashView = fake.views.get("dashboards.dashboard")!
    cleanups.push(
      render(
        () =>
          dashView({
            view: {
              id: "dashboards.dashboard",
              plugin: "dashboards",
              path: "d-1",
              params: { edit: "1" },
              setTitle: () => {},
              setDirty: () => {},
              setLoading: () => {},
            },
          }),
        dashHost,
      ),
    )

    const titleInput = dashHost.querySelector<HTMLInputElement>('[data-testid="dashboard-title"]')
    expect(titleInput).toBeTruthy()
    titleInput!.value = "Weekly Ops"
    titleInput!.dispatchEvent(new Event("input", { bubbles: true }))

    const doneBtn = dashHost.querySelector<HTMLButtonElement>('[data-testid="done-dashboard"]')
    expect(doneBtn).toBeTruthy()
    doneBtn!.click()
    await flush()

    expect(fake.updates).toEqual([{ id: "d-1", patch: { title: "Weekly Ops" } }])
  })
})
