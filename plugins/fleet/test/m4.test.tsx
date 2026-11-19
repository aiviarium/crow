// M4 with fakes: making a machine from the catalogue, following its job, the provisioners' page (register,
// settings, actions, remove), the admin page (settings round-trip, write-only secrets, registries), and the
// machine a host has (apply, start, delete). Nothing here opens a socket or reaches a provisioner.
import { afterEach, describe, expect, test } from "bun:test"
import type { ClientRookery, ViewHandle } from "@rookery/sdk/client"
import { render } from "solid-js/web"
import { AdminView } from "../src/AdminView"
import type { Action, HostInfo, HostProfile } from "../src/api"
import { createFleetApi } from "../src/fleetApi"
import { HostView } from "../src/HostView"
import { NewMachineDialog } from "../src/NewMachineDialog"
import { ProvisionersPage } from "../src/ProvisionersPage"
import type { ProvisionerInfo, Registry, Resource, Setting } from "../src/types"

const cleanup: Array<() => void> = []
afterEach(() => {
  while (cleanup.length) cleanup.pop()!()
  document.body.innerHTML = ""
  localStorage.clear()
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

export interface Call {
  method: string
  params: Record<string, unknown>
}

interface JobEnd {
  state: "succeeded" | "failed" | "cancelled"
  error?: { code: string; message: string } | null
  result?: unknown
}

interface FakeState {
  admin: boolean
  hosts: HostInfo[]
  profiles: Record<string, HostProfile>
  hostActions: Record<string, Action[]>
  jobs: Array<Record<string, unknown> & { id: string; state: string }>
  jobLogs: Record<
    string,
    Array<{ seq: number; at: string; attempt: number; level: string; text: string; data: null }>
  >
  jobEnds: Record<string, JobEnd>
  provisioners: ProvisionerInfo[]
  types: ProvisionerInfo[]
  provisionerActions: Action[]
  resources: Resource[]
  resourceActions: Record<string, Action[]>
  settings: Setting[]
  secrets: { names: string[]; secrets: Array<{ id: string; name: string }> }
  registries: Record<string, Registry>
  installationActions: Action[]
  catalogue: {
    template: Record<string, unknown>
    features: Array<{ key: string; label: string; group: string; help: string; types: string[] }>
    machines: Array<{
      provisioner: string
      kind: string
      label: string
      description: string
      catalogue: {
        sizes?: Array<{ id: string; label: string; default?: boolean; values: Record<string, string> }>
        images?: Array<{ id: string; label: string; default?: boolean; values: Record<string, string> }>
        regions?: Array<{ id: string; label: string; default?: boolean; values: Record<string, string> }>
      }
    }>
  }
  /** Makes the next `resources.create` job end badly, as a provisioner with no room does. */
  failCreate?: boolean
}

function now(): string {
  return new Date().toISOString()
}

function makeJob(id: string, kind: string, state: string, params: Record<string, unknown> = {}) {
  return {
    id,
    kind,
    state,
    params,
    subject: null,
    attempts: 1,
    maxAttempts: 1,
    cancelRequested: false,
    progress: null,
    result: null,
    error: null,
    enqueuedBy: "u-ada",
    createdAt: now(),
    startedAt: now(),
    finishedAt: null,
  }
}

function action(over: Partial<Action> & Pick<Action, "name">): Action {
  return {
    label: over.name,
    help: "",
    group: "",
    arguments: [],
    runs: "rookery",
    terminal: false,
    changes: true,
    role: "admin",
    available: true,
    ...over,
  } as Action
}

function provisioner(over: Partial<ProvisionerInfo> = {}): ProvisionerInfo {
  return {
    id: "incus/vm",
    name: "lab-incus",
    type: "incus/vm",
    label: "Incus machine",
    description: "A virtual machine on an Incus server.",
    setup: "seed",
    verbs: ["start", "stop"],
    secrets: [],
    arguments: [
      { name: "server", label: "Incus server", required: true, default: "" },
      { name: "cpus", label: "vCPUs", required: false, default: "2", kind: "resource" },
      { name: "memory", label: "Memory", required: false, default: "2GiB", kind: "resource" },
    ],
    own: ["server"],
    settings: { server: "incus.example.test" },
    ...over,
  }
}

class FakeStream {
  id = 1
  onData: (chunk: Uint8Array) => void = () => {}
  onEnd: (error?: { code: string; message: string }) => void = () => {}
  write = async () => {}
  eof = () => {}
  close = () => {}
}

function fakeRookery(state: FakeState) {
  const calls: Call[] = []
  const opened: string[] = []
  const toasts: Array<{ kind?: string; title: string; body?: string }> = []
  const enc = new TextEncoder()

  const call = async (method: string, params: Record<string, unknown> = {}): Promise<unknown> => {
    calls.push({ method, params: structuredClone(params) })
    switch (method) {
      case "auth.me":
        return {
          user: { id: "u-ada", name: "Ada", email: "ada@example.test" },
          principal: { kind: "user", id: "u-ada" },
          admin: state.admin,
          auth: "local",
          version: "0.4.0",
          apiVersion: 1,
        }
      case "hosts.list":
        return { hosts: structuredClone(state.hosts) }
      case "hosts.get": {
        const host = state.hosts.find((one) => one.name === params.host)
        if (!host) throw Object.assign(new Error(`No host ${params.host}`), { code: "NOT_FOUND" })
        return host
      }
      case "hosts.save": {
        const name = String(params.host)
        const profile = params.profile as HostProfile
        state.profiles[name] = profile
        const existing = state.hosts.find((one) => one.name === name)
        if (existing) existing.address = profile.access?.address ?? existing.address
        else
          state.hosts.push({
            id: `host-${name}`,
            name,
            address: profile.access?.address ?? "192.0.2.99",
            reachable: true,
            agents: false,
            version: null,
            api: null,
            error: null,
            applied: null,
            behind: null,
            type: (profile.type as HostInfo["type"]) ?? "workstation",
            seen: null,
            rotating: false,
            power: { start: false, stop: false, state: "running" },
            machine: null,
          })
        return { host: state.hosts.find((one) => one.name === name)! }
      }
      case "hosts.remove": {
        state.hosts = state.hosts.filter((one) => one.name !== params.host)
        return {}
      }
      case "hosts.profile":
        return { profile: state.profiles[String(params.host)] ?? {} }
      case "hosts.check":
        return { allowed: true, refusal: null }
      case "hosts.actions":
        return { actions: state.hostActions[String(params.host)] ?? [] }
      case "hosts.act": {
        const id = `job-${state.jobs.length + 1}`
        state.jobs.push(
          makeJob(id, `host.${params.action}`, "running", {
            host: params.host,
            action: params.action,
          }),
        )
        state.jobLogs[id] = [
          { seq: 1, at: now(), attempt: 1, level: "info", text: `starting ${params.action}`, data: null },
        ]
        state.jobEnds[id] = { state: "succeeded" }
        return { job: id, state: "running" }
      }
      case "jobs.list":
        return { jobs: state.jobs }
      case "jobs.get": {
        const job = state.jobs.find((one) => one.id === params.id)
        if (!job) throw new Error(`No job ${params.id}`)
        return job
      }
      case "provisioners.list":
        return structuredClone(state.provisioners)
      case "provisioners.types":
        return structuredClone(state.types)
      case "provisioners.get": {
        const found = state.provisioners.find((one) => (one.name || one.id) === params.name)
        if (!found) throw new Error(`No provisioner ${params.name}`)
        return { provisioner: found, state: "ready", resources: [] }
      }
      case "provisioners.save": {
        const save = params as unknown as { name: string; type: string; settings?: Record<string, string> }
        const known = state.types.find((one) => (one.type || one.id) === save.type) ?? state.types[0]!
        const saved: ProvisionerInfo = {
          ...known,
          id: `saved-${save.name}`,
          name: save.name,
          settings: save.settings ?? {},
        }
        const at = state.provisioners.findIndex((one) => (one.name || one.id) === save.name)
        if (at >= 0) state.provisioners[at] = saved
        else state.provisioners.push(saved)
        return saved
      }
      case "provisioners.remove":
        state.provisioners = state.provisioners.filter((one) => (one.name || one.id) !== params.name)
        return {}
      case "provisioners.actions":
        return { actions: state.provisionerActions }
      case "provisioners.act": {
        const asked = state.provisionerActions.find((one) => one.name === params.action)
        if (!asked?.changes) return { job: null, state: null, info: null, session: null, result: "✓ listed" }
        const id = `job-${state.jobs.length + 1}`
        state.jobs.push(makeJob(id, `provisioner.${params.action}`, "running", { name: params.name }))
        state.jobLogs[id] = [{ seq: 1, at: now(), attempt: 1, level: "info", text: "pruning", data: null }]
        state.jobEnds[id] = { state: "succeeded" }
        return { job: id, state: "running", info: null, session: null, result: null }
      }
      case "resources.create": {
        const asked = params as unknown as {
          provisioner: string
          kind: string
          name: string
          host?: string
          arguments: Record<string, string>
        }
        const resource: Resource = {
          id: "res-1",
          provisioner: asked.provisioner,
          kind: asked.kind || "machine",
          name: asked.name,
          state: "creating",
          external_id: "",
          host: asked.host ?? null,
          arguments: asked.arguments,
          created: now(),
          verbs: ["start", "stop"],
        }
        state.resources.push(resource)
        const id = `job-${state.jobs.length + 1}`
        state.jobs.push(makeJob(id, "resource.create", "running", { resource: resource.id }))
        state.jobLogs[id] = [
          {
            seq: 1,
            at: now(),
            attempt: 1,
            level: "info",
            text: "Creating the machine with lab-incus",
            data: null,
          },
          {
            seq: 2,
            at: now(),
            attempt: 1,
            level: "info",
            text: "The machine answers at 192.0.2.80",
            data: null,
          },
        ]
        state.jobEnds[id] = state.failCreate
          ? { state: "failed", error: { code: "INTERNAL", message: "No room on the pool" } }
          : { state: "succeeded" }
        return { resource, job: makeJob(id, "resource.create", "running", { resource: resource.id }) }
      }
      case "resources.list":
        return state.resources.filter((one) => !params.host || one.host === params.host)
      case "resources.get": {
        const resource = state.resources.find((one) => one.id === params.id)
        if (!resource) throw new Error(`No resource ${params.id}`)
        return resource
      }
      case "resources.actions":
        return { actions: state.resourceActions[String(params.id)] ?? [] }
      case "resources.act":
        return { job: "job-resource-act", state: "running", info: null, session: null, result: null }
      case "resources.remove": {
        const id = `job-${state.jobs.length + 1}`
        state.jobs.push(makeJob(id, "resource.remove", "running", { id: params.id }))
        state.jobLogs[id] = [
          { seq: 1, at: now(), attempt: 1, level: "info", text: "Deleting the machine", data: null },
        ]
        state.jobEnds[id] = { state: "succeeded" }
        return { job: id, state: "running", info: null, session: null, result: null }
      }
      case "setup.catalogue":
        return state.catalogue
      case "installation.settings.list":
        return structuredClone(state.settings)
      case "installation.settings.set": {
        const key = String(params.name)
        const found = state.settings.find((one) => one.key === key)
        if (found) found.value = String(params.value ?? "")
        return {}
      }
      case "installation.secrets.list":
        return structuredClone(state.secrets)
      case "installation.secrets.set": {
        const name = String(params.name)
        if (!state.secrets.secrets.some((one) => one.name === name)) {
          state.secrets.secrets.push({ id: `sec-${state.secrets.secrets.length + 1}`, name })
          state.secrets.names.push(name)
        }
        return {}
      }
      case "installation.secrets.rename": {
        const from = String(params.name)
        const to = String(params.value)
        const found = state.secrets.secrets.find((one) => one.name === from)
        if (found) found.name = to
        state.secrets.names = state.secrets.names.map((name) => (name === from ? to : name))
        return {}
      }
      case "installation.secrets.remove": {
        const name = String(params.name)
        state.secrets.secrets = state.secrets.secrets.filter((one) => one.name !== name)
        state.secrets.names = state.secrets.names.filter((one) => one !== name)
        return {}
      }
      case "installation.actions":
        return { actions: state.installationActions }
      case "installation.act": {
        const id = `job-${state.jobs.length + 1}`
        state.jobs.push(makeJob(id, "installation.upgrade", "running"))
        state.jobLogs[id] = [{ seq: 1, at: now(), attempt: 1, level: "info", text: "Upgrading", data: null }]
        state.jobEnds[id] = { state: "succeeded" }
        return { job: id, state: "running", info: null, session: null, result: null }
      }
      case "registries.list":
        return { registries: structuredClone(state.registries) }
      case "registries.save": {
        const name = String(params.name)
        state.registries[name] = { ...(state.registries[name] ?? {}), ...(params.value as Registry) }
        return {}
      }
      case "registries.check":
        return { lines: ["✓ answers", "! its login was not tested"] }
      case "registries.rename": {
        const from = String(params.name)
        const to = String(params.value)
        const found = state.registries[from]
        delete state.registries[from]
        if (found) state.registries[to] = found
        return {}
      }
      case "registries.remove":
        delete state.registries[String(params.name)]
        return {}
      case "access.level":
        return { level: "manage" }
      case "access.grants":
        return { resource: params.resource, owner: null, grants: [] }
      case "jobs.cancel":
        return {}
      case "env.get":
        throw Object.assign(new Error("no env"), { code: "NOT_FOUND" })
      case "env.presence":
        return { users: [] }
      default:
        throw Object.assign(new Error(`unknown method ${method}`), { code: "NOT_FOUND" })
    }
  }

  const rookery = {
    rpc: { call },
    env: {
      list: async () => [],
      get: async () => {
        throw Object.assign(new Error("no env"), { code: "NOT_FOUND" })
      },
      presence: async () => ({ users: [] }),
      readFile: async () => {
        throw Object.assign(new Error("no env"), { code: "NOT_FOUND" })
      },
      writeFile: async () => {
        throw Object.assign(new Error("no env"), { code: "NOT_FOUND" })
      },
      portUrl: async () => {
        throw Object.assign(new Error("no env"), { code: "NOT_FOUND" })
      },
    },
    streams: {
      open: async (_method: string, params: Record<string, unknown>) => {
        const stream = new FakeStream()
        const id = String(params.id ?? "")
        // The lines first, then how it ended: a follower sees the log before the end, as it does live.
        setTimeout(() => {
          const lines = state.jobLogs[id] ?? []
          const text = `${lines.map((line) => JSON.stringify(line)).join("\n")}\n`
          stream.onData(enc.encode(text))
        }, 10)
        setTimeout(() => {
          const end = state.jobEnds[id] ?? { state: "succeeded" }
          stream.onData(enc.encode(`${JSON.stringify(end)}\n`))
        }, 200)
        return stream
      },
    },
    views: { href: (id: string, opts?: { path?: string }) => `/${id}/${opts?.path ?? ""}` },
    workbench: {
      openView: (id: string, opts?: { path?: string; params?: Record<string, string> }) =>
        opened.push(`${id}:${opts?.params?.id ?? opts?.path ?? ""}`),
      toast: (toast: { kind?: string; title: string; body?: string }) => toasts.push(toast),
      href: () => null,
    },
    events: { subscribe: async () => ({ dispose() {} }) },
  } as unknown as ClientRookery

  return { rookery, calls, opened, toasts }
}

function view(path: string): ViewHandle {
  return {
    id: "fleet.admin",
    plugin: "fleet",
    path,
    params: {},
    setTitle() {},
    setDirty() {},
    setLoading() {},
  } as ViewHandle
}

function baseState(over: Partial<FakeState> = {}): FakeState {
  return {
    admin: true,
    hosts: [],
    profiles: {},
    hostActions: {},
    jobs: [],
    jobLogs: {},
    jobEnds: {},
    provisioners: [provisioner()],
    types: [provisioner({ id: "incus/vm", name: "incus/vm" })],
    provisionerActions: [],
    resources: [],
    resourceActions: {},
    settings: [
      {
        key: "server.public_url",
        value: "https://crow.example.test",
        meaning: "The address in sign-in links.",
        open: true,
      },
      { key: "server.secret_key_file", value: "", meaning: "Where the server's key is kept.", open: false },
    ],
    secrets: { names: ["tailnet_api_key"], secrets: [{ id: "sec-1", name: "tailnet_api_key" }] },
    registries: {
      packages: { id: "reg-1", type: "raw", url: "https://packages.example.test", username: "ops" },
    },
    installationActions: [
      action({ name: "upgrade", label: "Upgrade the server", help: "Build and restart it." }),
    ],
    catalogue: {
      template: { target: "laptop", hostname: "", operator_username: "ops", ansible_vars: {} },
      machines: [],
      features: [
        {
          key: "incus/incus",
          label: "Incus",
          group: "Machines",
          help: "The Incus server.",
          types: ["workstation"],
        },
        {
          key: "docker/docker",
          label: "Docker",
          group: "Containers",
          help: "The Docker engine.",
          types: ["workstation"],
        },
      ],
    },
    ...over,
  }
}

function fakeViewWithParams(path: string, params: Record<string, string> = {}): ViewHandle {
  return { ...view(path), params } as ViewHandle
}

describe("a new machine", () => {
  test("picks a provisioner, saves the host from the catalogue, creates the resource and follows its job", async () => {
    const state = baseState()
    const fake = fakeRookery(state)
    const api = createFleetApi(fake.rookery, () => ({ id: "u-ada", name: "Ada", admin: true }))
    const created: Array<{ host: string; jobId: string }> = []

    const dispose = render(
      () => (
        <NewMachineDialog
          open
          api={api}
          onClose={() => {}}
          onCreated={(result) => created.push(result)}
          onOpenProvisioners={() => {}}
        />
      ),
      document.body,
    )
    cleanup.push(dispose)

    await waitFor(() => document.body.querySelector("#new-machine-name") !== null, "the form")

    // The host name, then the provisioner from its choice.
    const name = document.body.querySelector<HTMLInputElement>("#new-machine-name")!
    name.value = "build-02"
    name.dispatchEvent(new Event("input", { bubbles: true }))

    const select = document.body.querySelector<HTMLButtonElement>(
      "[data-part='new-machine-form'] button[aria-haspopup='listbox']",
    )!
    select.click()
    await settle()
    const choice = Array.from(
      document.body.querySelectorAll<HTMLElement>("[role='menuitemradio'], [role='menuitem']"),
    ).find((item) => (item.textContent ?? "").includes("lab-incus"))
    expect(choice).toBeDefined()
    choice!.click()
    await settle()

    // Its own argument starts from the provisioner's settings.
    const server = document.body.querySelector<HTMLInputElement>("#new-machine-argument-server")!
    expect(server.value).toBe("incus.example.test")
    server.value = "incus2.example.test"
    server.dispatchEvent(new Event("input", { bubbles: true }))

    // A catalogue feature to install.
    const feature = document.body.querySelector<HTMLButtonElement>("[data-feature='docker/docker']")!
    feature.click()

    document.body.querySelector<HTMLButtonElement>("[data-part='new-machine-submit']")!.click()

    await waitFor(() => state.resources.length === 1, "the resource asked for")
    // One call takes the host's profile and the machine: there is no separate `hosts.save`.
    expect(fake.calls.some((one) => one.method === "hosts.save")).toBe(false)
    const create = fake.calls.find((one) => one.method === "resources.create")
    expect(create?.params).toMatchObject({
      provisioner: "lab-incus",
      kind: "machine",
      name: "build-02",
      host: "build-02",
      arguments: { server: "incus2.example.test", cpus: "2", memory: "2GiB" },
    })
    const savedProfile = (create?.params.profile ?? {}) as {
      hostname?: string
      ansible_vars?: { rookery_plugin_features?: string[] }
    }
    expect(savedProfile.hostname).toBe("build-02")
    expect(savedProfile?.ansible_vars?.rookery_plugin_features ?? []).toEqual(["docker/docker"])

    // The job's log shows as it comes, and the dialog lands on the host when it ends.
    await waitFor(
      () => (document.body.textContent ?? "").includes("The machine answers at 192.0.2.80"),
      "the job's log",
    )
    await waitFor(() => created.length === 1, "the host reached")
    expect(created[0]?.host).toBe("build-02")
  })

  test("a job that ends badly says why and offers the job", async () => {
    const state = baseState({ failCreate: true })
    const jobs = fakeRookery(state)
    const api = createFleetApi(jobs.rookery, () => ({ id: "u-ada", name: "Ada", admin: true }))
    const created: Array<{ host: string; jobId: string }> = []
    const openedJobs: string[] = []

    const dispose = render(
      () => (
        <NewMachineDialog
          open
          api={api}
          onClose={() => {}}
          onCreated={(result) => created.push(result)}
          onOpenJob={(jobId) => openedJobs.push(jobId)}
        />
      ),
      document.body,
    )
    cleanup.push(dispose)

    await waitFor(() => document.body.querySelector("#new-machine-name") !== null, "the form")
    const name = document.body.querySelector<HTMLInputElement>("#new-machine-name")!
    name.value = "build-03"
    name.dispatchEvent(new Event("input", { bubbles: true }))
    document.body
      .querySelector<HTMLButtonElement>("[data-part='new-machine-form'] button[aria-haspopup='listbox']")!
      .click()
    await settle()
    Array.from(document.body.querySelectorAll<HTMLElement>("[role='menuitemradio'], [role='menuitem']"))
      .find((item) => (item.textContent ?? "").includes("lab-incus"))!
      .click()
    await settle()
    const server = document.body.querySelector<HTMLInputElement>("#new-machine-argument-server")!
    server.value = "incus.example.test"
    server.dispatchEvent(new Event("input", { bubbles: true }))
    document.body.querySelector<HTMLButtonElement>("[data-part='new-machine-submit']")!.click()

    await waitFor(() => (document.body.textContent ?? "").includes("No room on the pool"), "the job's error")
    expect(created).toHaveLength(0)
    const openJob = document.body.querySelector<HTMLButtonElement>("[data-part='new-machine-open-job']")!
    expect(openJob).not.toBeNull()
    openJob.click()
    expect(openedJobs).toHaveLength(1)
  })
})

describe("the provisioners page", () => {
  const provisionerActions = [
    action({ name: "prune", label: "Prune", help: "Remove what nothing holds.", changes: true }),
    action({ name: "images", label: "List images", help: "What it can make machines from.", changes: false }),
  ]

  test("lists them, registers one with its settings, runs an action, and removes it", async () => {
    const state = baseState()
    state.provisionerActions = provisionerActions
    const fake = fakeRookery(state)
    const api = createFleetApi(fake.rookery, () => ({ id: "u-ada", name: "Ada", admin: true }))

    const dispose = render(
      () => <ProvisionersPage view={view("")} rookery={fake.rookery} api={api} />,
      document.body,
    )
    cleanup.push(dispose)

    await waitFor(() => document.body.querySelector("[data-part='fleet-provisioners']") !== null, "the page")
    await waitFor(() => (document.body.textContent ?? "").includes("lab-incus"), "the registered one")

    // Register another: the type offers its own fields as settings.
    const register = Array.from(document.body.querySelectorAll<HTMLButtonElement>("button")).find((button) =>
      (button.textContent ?? "").includes("Register provisioner"),
    )!
    register.click()
    await waitFor(() => document.body.querySelector("#provisioner-name") !== null, "the register dialog")
    const name = document.body.querySelector<HTMLInputElement>("#provisioner-name")!
    name.value = "second-incus"
    name.dispatchEvent(new Event("input", { bubbles: true }))
    const server = document.body.querySelector<HTMLInputElement>("#provisioner-setting-server")!
    expect(server.value).toBe("")
    server.value = "incus2.example.test"
    server.dispatchEvent(new Event("input", { bubbles: true }))
    document.body.querySelector<HTMLButtonElement>("[data-part='save-provisioner']")!.click()

    await waitFor(
      () =>
        fake.calls.some((one) => one.method === "provisioners.save" && one.params.name === "second-incus"),
      "provisioners.save",
    )
    const save = fake.calls.find((one) => one.method === "provisioners.save")!
    expect(save.params.type).toBe("incus/vm")
    expect(save.params.settings).toEqual({ server: "incus2.example.test" })
    await waitFor(
      () => document.body.querySelector("[data-provisioner='second-incus']") !== null,
      "the new row",
    )

    // Its actions: a changing one opens a job.
    const edit = document.body.querySelector<HTMLButtonElement>(
      "[data-provisioner='second-incus'] [data-part='edit-provisioner']",
    )!
    edit.click()
    await waitFor(
      () => document.body.querySelector("[data-provisioner-action='prune']") !== null,
      "its actions",
    )
    document.body.querySelector<HTMLButtonElement>("[data-provisioner-action='prune'] button")!.click()
    await waitFor(
      () => document.body.querySelector("[data-part='run-action-form']") !== null,
      "the action form",
    )
    document.body.querySelector<HTMLButtonElement>("[data-part='run-action-submit']")!.click()
    await waitFor(() => fake.opened.some((one) => one.startsWith("fleet.job:")), "the job's view")
    const acted = fake.calls.find((one) => one.method === "provisioners.act")!
    expect(acted.params).toMatchObject({ name: "second-incus", action: "prune" })

    // Removing it.
    const remove = document.body.querySelector<HTMLButtonElement>(
      "[data-provisioner='second-incus'] [data-part='remove-provisioner']",
    )!
    remove.click()
    await waitFor(
      () => document.body.querySelector("[data-part='confirm-remove-provisioner']") !== null,
      "the confirm",
    )
    document.body.querySelector<HTMLButtonElement>("[data-part='confirm-remove-provisioner']")!.click()
    await waitFor(
      () =>
        fake.calls.some((one) => one.method === "provisioners.remove" && one.params.name === "second-incus"),
      "provisioners.remove",
    )
  })
})

describe("admin", () => {
  test("changes a server setting and reads it back", async () => {
    const state = baseState()
    const fake = fakeRookery(state)
    const api = createFleetApi(fake.rookery, () => ({ id: "u-ada", name: "Ada", admin: true }))

    const dispose = render(
      () => <AdminView view={view("settings")} rookery={fake.rookery} api={api} />,
      document.body,
    )
    cleanup.push(dispose)

    await waitFor(
      () => document.body.querySelector("[data-setting='server.public_url']") !== null,
      "the setting",
    )
    const row = document.body.querySelector("[data-setting='server.public_url']")!
    const input = row.querySelector<HTMLInputElement>("input")!
    expect(input.value).toBe("https://crow.example.test")
    input.value = "https://crow2.example.test"
    input.dispatchEvent(new Event("input", { bubbles: true }))
    row.querySelector<HTMLButtonElement>("[data-part='save-setting']")!.click()

    await waitFor(
      () =>
        fake.calls.some(
          (one) =>
            one.method === "installation.settings.set" &&
            one.params.name === "server.public_url" &&
            one.params.value === "https://crow2.example.test",
        ),
      "installation.settings.set",
    )

    // Read back: the list the server answers now carries the value that was set.
    await waitFor(
      () =>
        document.body.querySelector<HTMLInputElement>("[data-setting='server.public_url'] input")?.value ===
        "https://crow2.example.test",
      "the setting's new value",
    )

    // A setting kept on the server says so, and has no field.
    const fixed = document.body.querySelector("[data-setting='server.secret_key_file']")!
    expect(fixed.textContent).toContain("Set on the server")
    expect(fixed.querySelector("input")).toBeNull()
  })

  test("secrets are names only: a value set is never shown again", async () => {
    const state = baseState()
    const fake = fakeRookery(state)
    const api = createFleetApi(fake.rookery, () => ({ id: "u-ada", name: "Ada", admin: true }))

    const dispose = render(
      () => <AdminView view={view("secrets")} rookery={fake.rookery} api={api} />,
      document.body,
    )
    cleanup.push(dispose)

    await waitFor(() => document.body.querySelector("[data-part='admin-secrets']") !== null, "the secrets")
    await waitFor(() => (document.body.textContent ?? "").includes("tailnet_api_key"), "the kept name")

    const name = document.body.querySelector<HTMLInputElement>("#secret-name")!
    name.value = "incus_token"
    name.dispatchEvent(new Event("input", { bubbles: true }))
    const value = document.body.querySelector<HTMLInputElement>("#secret-value")!
    value.value = "s3cret-value"
    value.dispatchEvent(new Event("input", { bubbles: true }))
    document.body.querySelector<HTMLButtonElement>("[data-part='save-secret']")!.click()

    await waitFor(
      () => fake.calls.some((one) => one.method === "installation.secrets.set"),
      "installation.secrets.set",
    )
    const set = fake.calls.find((one) => one.method === "installation.secrets.set")!
    expect(set.params).toEqual({ name: "incus_token", value: "s3cret-value" })

    // The page shows the name, and the form is empty again; the value is nowhere in it.
    await waitFor(() => (document.body.textContent ?? "").includes("incus_token"), "the new name")
    expect((document.body.textContent ?? "").includes("s3cret-value")).toBe(false)
    expect(document.body.querySelector<HTMLInputElement>("#secret-value")!.value).toBe("")

    // Renaming and removing go by name.
    document.body
      .querySelector<HTMLButtonElement>("[data-secret='incus_token'] [data-part='rename-secret']")!
      .click()
    await waitFor(() => document.body.querySelector("#secret-rename-to") !== null, "the rename")
    const to = document.body.querySelector<HTMLInputElement>("#secret-rename-to")!
    to.value = "incus_token_2"
    to.dispatchEvent(new Event("input", { bubbles: true }))
    document.body.querySelector<HTMLButtonElement>("[data-part='confirm-rename-secret']")!.click()
    await waitFor(
      () =>
        fake.calls.some(
          (one) => one.method === "installation.secrets.rename" && one.params.value === "incus_token_2",
        ),
      "installation.secrets.rename",
    )

    await waitFor(
      () => document.body.querySelector("[data-secret='incus_token_2']") !== null,
      "the renamed secret",
    )
    document.body
      .querySelector<HTMLButtonElement>("[data-secret='incus_token_2'] [data-part='remove-secret']")!
      .click()
    await waitFor(
      () => document.body.querySelector("[data-part='confirm-remove-secret']") !== null,
      "the confirm",
    )
    document.body.querySelector<HTMLButtonElement>("[data-part='confirm-remove-secret']")!.click()
    await waitFor(
      () =>
        fake.calls.some(
          (one) => one.method === "installation.secrets.remove" && one.params.name === "incus_token_2",
        ),
      "installation.secrets.remove",
    )
  })

  test("checks a registry, renames it, and removes it", async () => {
    const state = baseState()
    const fake = fakeRookery(state)
    const api = createFleetApi(fake.rookery, () => ({ id: "u-ada", name: "Ada", admin: true }))

    const dispose = render(
      () => <AdminView view={view("registries")} rookery={fake.rookery} api={api} />,
      document.body,
    )
    cleanup.push(dispose)

    await waitFor(() => document.body.querySelector("[data-part='registry-list']") !== null, "the registries")
    await waitFor(() => (document.body.textContent ?? "").includes("packages"), "the one there is")

    document.body.querySelector<HTMLButtonElement>("[data-part='check-registry']")!.click()
    await waitFor(
      () => document.body.querySelector("[data-part='registry-check-lines']") !== null,
      "the check",
    )
    expect(document.body.querySelector("[data-part='registry-check-lines']")!.textContent).toContain(
      "✓ answers",
    )
    expect(
      fake.calls.some((one) => one.method === "registries.check" && one.params.name === "packages"),
    ).toBe(true)

    // The dialog closes before the next one opens.
    Array.from(document.body.querySelectorAll<HTMLButtonElement>("button"))
      .find((button) => (button.textContent ?? "").trim() === "Close")!
      .click()
    await settle()

    document.body.querySelector<HTMLButtonElement>("[data-part='rename-registry']")!.click()
    await waitFor(() => document.body.querySelector("#registry-rename-to") !== null, "the rename")
    const to = document.body.querySelector<HTMLInputElement>("#registry-rename-to")!
    to.value = "packages2"
    to.dispatchEvent(new Event("input", { bubbles: true }))
    document.body.querySelector<HTMLButtonElement>("[data-part='confirm-rename-registry']")!.click()
    await waitFor(
      () => fake.calls.some((one) => one.method === "registries.rename" && one.params.value === "packages2"),
      "registries.rename",
    )

    await waitFor(
      () => document.body.querySelector("[data-part='remove-registry']") !== null,
      "the row again",
    )
    document.body.querySelector<HTMLButtonElement>("[data-part='remove-registry']")!.click()
    await waitFor(
      () => document.body.querySelector("[data-part='confirm-remove-registry']") !== null,
      "the confirm",
    )
    document.body.querySelector<HTMLButtonElement>("[data-part='confirm-remove-registry']")!.click()
    await waitFor(() => fake.calls.some((one) => one.method === "registries.remove"), "registries.remove")
  })

  test("says so to someone who is not an admin", async () => {
    const state = baseState({ admin: false })
    const fake = fakeRookery(state)
    const api = createFleetApi(fake.rookery, () => ({ id: "u-eve", name: "Eve", admin: false }))

    const dispose = render(
      () => <AdminView view={view("settings")} rookery={fake.rookery} api={api} />,
      document.body,
    )
    cleanup.push(dispose)
    await settle()
    expect(document.body.querySelector("[data-part='admin-denied']")?.textContent).toContain("403")
    expect(fake.calls.some((one) => one.method === "installation.settings.list")).toBe(false)
  })
})

describe("a host's machine", () => {
  const machineHost = (): HostInfo => ({
    id: "host-build-02",
    name: "build-02",
    address: "192.0.2.80",
    reachable: true,
    agents: false,
    version: null,
    api: null,
    error: null,
    applied: null,
    behind: null,
    type: "workstation",
    seen: null,
    rotating: false,
    power: { start: false, stop: true, state: "running" },
    machine: { resource: "res-1", provisioner: "lab-incus", external_id: "abc123", state: "running" },
  })

  test("applies the host, and deletes its machine with the provisioner", async () => {
    const state = baseState({
      hosts: [machineHost()],
      profiles: { "build-02": { type: "workstation", access: { address: "192.0.2.80", auth: "key" } } },
      hostActions: {
        "build-02": [action({ name: "apply", label: "Apply", help: "Apply its profile.", role: "operate" })],
      },
      resourceActions: {
        "res-1": [
          action({ name: "start", label: "Start", group: "Power", role: "operate" }),
          action({ name: "remove", label: "Delete the machine", changes: true, confirm: "Delete build-02?" }),
        ],
      },
    })
    const fake = fakeRookery(state)
    const api = createFleetApi(fake.rookery, () => ({ id: "u-ada", name: "Ada", admin: true }))
    const store = {
      hosts: () => state.hosts,
      loading: () => false,
      error: () => null,
      addOpen: () => false,
      machineOpen: () => false,
      setAddOpen() {},
      setMachineOpen() {},
      refresh: async () => {},
    }

    const dispose = render(
      () => (
        <HostView
          view={fakeViewWithParams("build-02", { name: "build-02" })}
          rookery={fake.rookery}
          api={api}
          store={store}
        />
      ),
      document.body,
    )
    cleanup.push(dispose)

    await waitFor(
      () => document.body.querySelector("[data-part='host-machine']") !== null,
      "the machine card",
    )
    expect(document.body.querySelector("[data-part='host-machine']")!.textContent).toContain("abc123")

    // Apply is a job of the host.
    document.body
      .querySelector<HTMLButtonElement>("[data-part='run-host-action'][data-action-name='apply']")!
      .click()
    await waitFor(
      () => fake.calls.some((one) => one.method === "hosts.act" && one.params.action === "apply"),
      "hosts.act apply",
    )

    // Delete machine asks, then removes the resource and follows its job.
    document.body.querySelector<HTMLButtonElement>("[data-part='destroy-machine']")!.click()
    await waitFor(
      () => document.body.querySelector("[data-part='confirm-destroy-machine']") !== null,
      "the confirm",
    )
    document.body.querySelector<HTMLButtonElement>("[data-part='confirm-destroy-machine']")!.click()
    await waitFor(
      () => fake.calls.some((one) => one.method === "resources.remove" && one.params.id === "res-1"),
      "resources.remove",
    )
    await waitFor(() => fake.opened.some((one) => one.startsWith("fleet.job:")), "the job's view")
  })
})
