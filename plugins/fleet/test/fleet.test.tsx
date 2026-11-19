// Tests for the Fleet plugin views (`fleet.hosts`, `fleet.host`, `fleet.job`) loaded through
// @rookery/client's plugin loader against a fake Rookery server implementing `plugins/fleet/src/api.ts`.
import { afterEach, describe, expect, test } from "bun:test"
import type { JobInfo } from "@rookery/client"
import { render } from "solid-js/web"
import { App } from "../../../shell/src/app/App"
import { createShellApp } from "../../../shell/src/app/state"
import { makeJob, makeLogItem, startFakeRookery } from "../../../shell/test/fakeRookery"
import type { Action, HostInfo, HostProfile } from "../src/api"

const cleanup: Array<() => void> = []
afterEach(() => {
  while (cleanup.length) cleanup.pop()!()
  document.body.innerHTML = ""
  document.title = "Crow"
})

async function waitFor(fn: () => boolean, label = "condition", timeoutMs = 10000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (fn()) return
    await Bun.sleep(10)
  }
  throw new Error(`timed out waiting for: ${label}`)
}

function seedHosts(): {
  hosts: HostInfo[]
  profiles: Record<string, HostProfile>
  actions: Record<string, Action[]>
  jobs: JobInfo[]
} {
  const now = new Date().toISOString()
  const hosts: HostInfo[] = [
    {
      id: "host-studio",
      name: "studio",
      address: "192.0.2.10",
      reachable: true,
      version: "0.9.1",
      api: 1,
      error: null,
      applied: now,
      behind: null,
      type: "workstation",
      seen: "workstation",
      rotating: false,
      power: { start: false, stop: true, state: "running" },
      machine: null,
    },
    {
      id: "host-forge",
      name: "forge",
      address: "192.0.2.20",
      reachable: true,
      version: "0.9.0",
      api: 1,
      error: null,
      applied: now,
      behind: {
        changes: [
          { id: "packages", from: "1.0", to: "1.1" },
          { id: "sshd.config", from: "old", to: "hardened" },
        ],
      },
      type: "managed",
      seen: "managed",
      rotating: false,
      power: { start: true, stop: true, state: "running" },
      machine: null,
    },
  ]

  const profiles: Record<string, HostProfile> = {
    studio: {
      type: "workstation",
      access: { address: "192.0.2.10", user: "ops", port: 22, auth: "key" },
      features: { desktop: true, nix: true },
    },
    forge: {
      type: "managed",
      access: { address: "192.0.2.20", user: "root", port: 2222, auth: "agent" },
      features: { docker: true, builder: true },
    },
  }

  const actions: Record<string, Action[]> = {
    forge: [
      {
        name: "apply",
        label: "Apply configuration",
        help: "Reconcile host profile and packages.",
        group: "Lifecycle",
        arguments: [],
        confirm: null,
        runs: "rookery",
        terminal: false,
        changes: true,
        role: "operate",
        available: true,
      },
      {
        name: "restart-service",
        label: "Restart service",
        help: "Restart a systemd unit on the host.",
        group: "Maintenance",
        arguments: [
          {
            name: "unit",
            label: "Unit name",
            required: true,
            default: "docker.service",
            help: "Systemd unit to restart.",
          },
        ],
        confirm: "Restarting a service briefly interrupts active workloads.",
        runs: "host",
        terminal: false,
        changes: true,
        role: "operate",
        available: true,
      },
      {
        name: "ssh-shell",
        label: "Interactive shell",
        help: "Open an interactive SSH session (M3).",
        group: "Access",
        arguments: [],
        confirm: null,
        runs: "host",
        terminal: true,
        changes: false,
        role: "operate",
        available: true,
      },
    ],
  }

  const jobs: JobInfo[] = [
    makeJob({
      id: "job-prev-1",
      kind: "host.apply",
      subject: "host://forge",
      params: { host: "forge", action: "apply" },
      state: "succeeded",
      createdAt: now,
      startedAt: now,
      finishedAt: now,
    }),
  ]

  return { hosts, profiles, actions, jobs }
}

describe("@crow/plugin-fleet M1 views", () => {
  test("loads built-in fleet via @rookery/client loader, lists/filters hosts, and runs quick apply", async () => {
    const seed = seedHosts()
    const fake = startFakeRookery(seed)
    cleanup.push(() => fake.stop())

    const app = createShellApp({
      baseUrl: fake.baseUrl,
      wsUrl: fake.wsUrl,
      initialUrl: "/",
      reconnect: false,
    })
    cleanup.push(() => app.dispose())

    const root = document.createElement("div")
    document.body.appendChild(root)
    cleanup.push(render(() => <App app={app} />, root))

    await app.boot()
    await app.loader.clientsSettled(4000)

    // Built-in fleet plugin registers `/fleet/hosts` nav entry and shows badge for 1 host needing attention (`forge`).
    const fleetLink = Array.from(root.querySelectorAll("a[data-part='nav-item']")).find(
      (el) => el.getAttribute("href") === "/fleet/hosts",
    ) as HTMLAnchorElement | undefined
    expect(fleetLink).toBeDefined()
    await waitFor(() => (fleetLink?.textContent ?? "").includes("1"))

    // Navigate to Fleet host list.
    fleetLink!.click()
    await waitFor(() => root.querySelector("[data-part='fleet-hosts']") !== null)
    await waitFor(
      () => (root.textContent ?? "").includes("studio") && (root.textContent ?? "").includes("forge"),
    )

    // Search filters the host table to `studio`.
    const searchInput = root.querySelector("[data-part='fleet-hosts'] input") as HTMLInputElement
    searchInput.value = "192.0.2.10"
    searchInput.dispatchEvent(new Event("input", { bubbles: true }))
    await waitFor(
      () => (root.textContent ?? "").includes("studio") && !(root.textContent ?? "").includes("forge"),
    )

    // Clear search and filter by Behind tab.
    searchInput.value = ""
    searchInput.dispatchEvent(new Event("input", { bubbles: true }))
    await waitFor(() => (root.textContent ?? "").includes("forge"))
    const behindTab = Array.from(root.querySelectorAll("button[role='tab']")).find((b) =>
      (b.textContent ?? "").includes("Behind"),
    ) as HTMLButtonElement | undefined
    expect(behindTab).toBeDefined()
    behindTab!.click()
    await waitFor(
      () => (root.textContent ?? "").includes("forge") && !(root.textContent ?? "").includes("studio"),
    )

    // Quick Apply on `forge` calls `hosts.act` and navigates to the job view.
    const quickApply = root.querySelector(
      "[data-part='host-quick-apply'][data-host='forge']",
    ) as HTMLButtonElement
    expect(quickApply).not.toBeNull()
    quickApply.click()

    await waitFor(() => root.querySelector("[data-part='fleet-job']") !== null)
    const actCall = fake.calls.find((c) => c.method === "hosts.act")
    expect(actCall?.params).toEqual({ host: "forge", action: "apply" })
    await waitFor(() => (root.textContent ?? "").includes("Starting apply on forge"))
  })

  test("adds an existing host (`hosts.save`) with optional first contact (`trust-key`)", async () => {
    const seed = seedHosts()
    const fake = startFakeRookery(seed)
    cleanup.push(() => fake.stop())

    const app = createShellApp({
      baseUrl: fake.baseUrl,
      wsUrl: fake.wsUrl,
      initialUrl: "/fleet/hosts",
      reconnect: false,
    })
    cleanup.push(() => app.dispose())

    const root = document.createElement("div")
    document.body.appendChild(root)
    cleanup.push(render(() => <App app={app} />, root))

    await app.boot()
    await app.loader.clientsSettled(4000)
    await waitFor(() => root.querySelector("[data-part='fleet-hosts']") !== null)

    // Open Add Host dialog from ViewHeader action button.
    const addBtn = Array.from(root.querySelectorAll("button")).find((b) =>
      (b.textContent ?? "").includes("Add host"),
    ) as HTMLButtonElement | undefined
    expect(addBtn).toBeDefined()
    addBtn!.click()
    await waitFor(() => document.body.querySelector("[data-part='add-host-form']") !== null)

    const nameInput = document.body.querySelector("#fleet-add-name") as HTMLInputElement
    const addrInput = document.body.querySelector("#fleet-add-address") as HTMLInputElement
    const userInput = document.body.querySelector("#fleet-add-user") as HTMLInputElement
    const portInput = document.body.querySelector("#fleet-add-port") as HTMLInputElement

    // Validation rejects invalid hostname before calling `hosts.save`.
    nameInput.value = "Bad Host!"
    nameInput.dispatchEvent(new Event("input", { bubbles: true }))
    addrInput.value = "192.0.2.55"
    addrInput.dispatchEvent(new Event("input", { bubbles: true }))
    const submitBtn = document.body.querySelector("[data-part='add-host-submit']") as HTMLButtonElement
    submitBtn.click()
    await waitFor(() =>
      (document.body.querySelector("[data-part='add-host-form']")?.textContent ?? "").includes("lowercase"),
    )
    expect(fake.calls.filter((c) => c.method === "hosts.save")).toHaveLength(0)

    // Valid machine entry + default first contact saves host and triggers `trust-key`.
    nameInput.value = "relay"
    nameInput.dispatchEvent(new Event("input", { bubbles: true }))
    userInput.value = "deploy"
    userInput.dispatchEvent(new Event("input", { bubbles: true }))
    portInput.value = "2202"
    portInput.dispatchEvent(new Event("input", { bubbles: true }))
    submitBtn.click()

    await waitFor(() => root.querySelector("[data-part='fleet-job']") !== null)
    const saveCall = fake.calls.find((c) => c.method === "hosts.save")
    expect(saveCall?.params).toEqual({
      host: "relay",
      profile: {
        builder: {},
        access: { address: "192.0.2.55", user: "deploy", port: 2202, auth: "key" },
      },
    })
    const trustCall = fake.calls.find((c) => c.method === "hosts.act")
    expect(trustCall?.params).toEqual({ host: "relay", action: "trust-key" })
    expect(fake.getHosts().some((h) => h.name === "relay")).toBe(true)
  })

  test("host detail page shows profile, hides terminal actions, runs parameterized action, and removes host", async () => {
    const seed = seedHosts()
    const fake = startFakeRookery(seed)
    cleanup.push(() => fake.stop())

    const app = createShellApp({
      baseUrl: fake.baseUrl,
      wsUrl: fake.wsUrl,
      initialUrl: "/fleet/hosts/forge",
      reconnect: false,
    })
    cleanup.push(() => app.dispose())

    const root = document.createElement("div")
    document.body.appendChild(root)
    cleanup.push(render(() => <App app={app} />, root))

    await app.boot()
    await app.loader.clientsSettled(4000)
    await waitFor(() => root.querySelector("[data-part='host-profile']") !== null)
    await waitFor(() => root.querySelector("[data-part='host-actions']") !== null)

    // Profile summary, behind callout, and recent jobs render.
    const profileText = root.querySelector("[data-part='host-profile']")?.textContent ?? ""
    expect(profileText).toContain("192.0.2.20")
    expect(profileText).toContain("2222")
    expect(profileText).toContain("builder")
    expect(profileText).toContain("docker")
    expect(root.querySelector("[data-part='host-behind']")?.textContent).toContain("packages")
    expect(root.querySelector("[data-part='host-jobs']")?.textContent).toContain("host.apply")

    // M1 scope: terminal action `ssh-shell` is filtered out while non-terminal actions show.
    const actionsCard = root.querySelector("[data-part='host-actions']")!
    expect(actionsCard.textContent).toContain("Restart service")
    expect(actionsCard.textContent).not.toContain("Interactive shell")

    // Run parameterized & confirmed action `restart-service`.
    const runRestart = root.querySelector(
      "[data-part='run-host-action'][data-action-name='restart-service']",
    ) as HTMLButtonElement
    expect(runRestart).not.toBeNull()
    runRestart.click()

    await waitFor(() => document.body.querySelector("[data-part='action-dialog-form']") !== null)
    expect(document.body.querySelector("[data-part='action-dialog-confirm']")?.textContent).toContain(
      "interrupts active workloads",
    )
    const argInput = document.body.querySelector("#action-arg-unit") as HTMLInputElement
    argInput.value = "caddy.service"
    argInput.dispatchEvent(new Event("input", { bubbles: true }))
    const submitAction = document.body.querySelector(
      "[data-part='action-dialog-submit']",
    ) as HTMLButtonElement
    submitAction.click()

    await waitFor(() => root.querySelector("[data-part='fleet-job']") !== null)
    const actCall = fake.calls.find((c) => c.method === "hosts.act" && c.params.action === "restart-service")
    expect(actCall?.params).toEqual({
      host: "forge",
      action: "restart-service",
      arguments: { unit: "caddy.service" },
    })

    // Navigate back to `forge` and remove it via the ViewHeader overflow menu.
    app.navigate("/fleet/hosts/forge")
    await waitFor(
      () => root.querySelector("[data-part='fleet-host'][data-host='forge']") !== null,
      "host page",
    )
    await waitFor(() => root.querySelector("[data-part='host-overview']") !== null, "host overview loaded")
    const overflowBtn = root.querySelector(
      "[data-part='view-actions'] button[aria-haspopup='menu']",
    ) as HTMLButtonElement | null
    expect(overflowBtn).not.toBeNull()
    overflowBtn!.click()
    await waitFor(
      () =>
        Array.from(document.body.querySelectorAll("[role='menuitem']")).some((m) =>
          (m.textContent ?? "").includes("Remove host"),
        ),
      "Remove host menuitem",
    )
    const removeItem = Array.from(document.body.querySelectorAll("[role='menuitem']")).find((m) =>
      (m.textContent ?? "").includes("Remove host"),
    ) as HTMLElement
    removeItem.click()
    await waitFor(
      () => document.body.querySelector("[data-part='confirm-remove-host']") !== null,
      "confirm remove dialog",
    )
    ;(document.body.querySelector("[data-part='confirm-remove-host']") as HTMLButtonElement).click()

    await waitFor(() => root.querySelector("[data-part='fleet-hosts']") !== null, "returned to host list")
    expect(fake.calls.some((c) => c.method === "hosts.remove" && c.params.host === "forge")).toBe(true)
    expect(fake.getHosts().some((h) => h.name === "forge")).toBe(false)
  })

  test("fleet job view streams live output via jobs.follow, displays progress, cancels, and retries", async () => {
    const now = new Date().toISOString()
    const liveJob: JobInfo = makeJob({
      id: "job-live-1",
      kind: "host.apply",
      subject: "host://studio",
      params: { host: "studio", action: "apply" },
      state: "running",
      maxAttempts: 2,
      progress: { done: 2, total: 4, message: "Syncing packages" },
      createdAt: now,
      startedAt: now,
    })
    const fake = startFakeRookery({
      ...seedHosts(),
      jobs: [liveJob],
      jobLogs: {
        "job-live-1": [makeLogItem({ seq: 1, at: now, text: "Connecting to 192.0.2.10" })],
      },
    })
    cleanup.push(() => fake.stop())

    const app = createShellApp({
      baseUrl: fake.baseUrl,
      wsUrl: fake.wsUrl,
      initialUrl: "/fleet/jobs/job-live-1?host=studio",
      reconnect: false,
    })
    cleanup.push(() => app.dispose())

    const root = document.createElement("div")
    document.body.appendChild(root)
    cleanup.push(render(() => <App app={app} />, root))

    await app.boot()
    await app.loader.clientsSettled(4000)
    await waitFor(() => root.querySelector("[data-part='fleet-job']") !== null, "fleet-job mounted")
    await waitFor(() => (root.textContent ?? "").includes("Connecting to 192.0.2.10"), "initial job log")

    // Push a live output chunk over the binary `jobs.follow` stream.
    fake.pushJobLog("job-live-1", makeLogItem({ seq: 2, at: now, level: "warn", text: "Reloading daemon" }))

    await waitFor(() => (root.textContent ?? "").includes("Reloading daemon"), "live log line 2")
    await waitFor(() => root.querySelector("[data-part='job-progress']") !== null, "job progress bar")
    expect(root.querySelector("[data-part='job-progress']")?.textContent).toContain("2 / 4")

    // Cancel the running job via `jobs.cancel` (rendered as ViewHeader icon button with aria-label).
    const cancelBtn = Array.from(root.querySelectorAll("button")).find(
      (b) => (b.textContent ?? "").trim() === "Cancel" || b.getAttribute("aria-label") === "Cancel",
    ) as HTMLButtonElement | undefined
    expect(cancelBtn).toBeDefined()
    cancelBtn!.click()

    await waitFor(
      () => fake.calls.some((c) => c.method === "jobs.cancel" && c.params.id === "job-live-1"),
      "jobs.cancel call",
    )
    await waitFor(() => (root.textContent ?? "").includes("Cancelled"), "Cancelled state")

    // Cancelled job exposes Retry, which calls `jobs.retry` and navigates to the new job.
    await waitFor(
      () =>
        Array.from(root.querySelectorAll("button")).some(
          (b) => (b.textContent ?? "").trim() === "Retry" || b.getAttribute("aria-label") === "Retry",
        ),
      "Retry button visible",
    )
    const retryBtn = Array.from(root.querySelectorAll("button")).find(
      (b) => (b.textContent ?? "").trim() === "Retry" || b.getAttribute("aria-label") === "Retry",
    ) as HTMLButtonElement | undefined
    expect(retryBtn).toBeDefined()
    retryBtn!.click()

    await waitFor(
      () => fake.calls.some((c) => c.method === "jobs.retry" && c.params.id === "job-live-1"),
      "jobs.retry call",
    )
    await waitFor(() => (root.textContent ?? "").includes("Retrying host.apply"), "retried job log")
  })
})
