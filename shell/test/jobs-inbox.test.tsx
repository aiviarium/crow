// Tests for Crow shell's Jobs view (`/jobs`, `/jobs/:id`) and Notifications Inbox (`/inbox`,
// `/inbox/:id`) including live `jobs.follow` cursor resume, cancel/retry, unread badge chrome,
// `notify.read`/`unread`/`readAll`/`archive`/`answer`, and live server push updates.
import { afterEach, describe, expect, test } from "bun:test"
import type { JobInfo, NotificationInfo } from "@rookery/client"
import { render } from "solid-js/web"
import { App } from "../src/app/App"
import { createShellApp } from "../src/app/state"
import { makeJob, startFakeRookery } from "./fakeRookery"

const cleanup: Array<() => void> = []
afterEach(() => {
  while (cleanup.length) cleanup.pop()!()
  document.body.innerHTML = ""
  document.title = "Crow"
})

async function waitFor(fn: () => boolean, label = "condition", timeoutMs = 3000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (fn()) return
    await Bun.sleep(10)
  }
  throw new Error(`timed out waiting for: ${label}`)
}

function clickRow(root: HTMLElement, selector: string): void {
  const row = root.querySelector(selector) as HTMLElement | null
  if (!row) throw new Error(`row not found: ${selector}`)
  const trigger = (row.querySelector("button, a") as HTMLElement | null) ?? row
  trigger.click()
}

describe("@crow/shell Jobs view", () => {
  test("lists jobs with state filter, follows live log with cursor resume on reconnect, cancels and retries", async () => {
    const now = new Date().toISOString()
    const runningJob: JobInfo = makeJob({
      id: "job-run-1",
      plugin: "hosts",
      name: "studio.apply",
      params: { host: "studio" },
      state: "running",
      createdAt: now,
      startedAt: now,
    })
    const failedJob: JobInfo = makeJob({
      id: "job-fail-1",
      plugin: "hosts",
      name: "forge.apply",
      params: { host: "forge" },
      state: "failed",
      maxAttempts: 2,
      createdAt: now,
      startedAt: now,
      finishedAt: now,
      error: "SSH timeout to 192.0.2.20",
    })

    const fake = startFakeRookery({
      jobs: [runningJob, failedJob],
      jobLogs: {
        "job-run-1": [
          { seq: 1, at: now, payload: { type: "output", level: "info", text: "Line one from studio" } },
          { seq: 2, at: now, payload: { type: "output", level: "info", text: "Line two from studio" } },
        ],
        "job-fail-1": [
          { seq: 1, at: now, payload: { type: "output", level: "error", text: "Connection timed out" } },
        ],
      },
    })
    cleanup.push(() => fake.stop())

    const app = createShellApp({
      baseUrl: fake.baseUrl,
      wsUrl: fake.wsUrl,
      initialUrl: "/jobs",
      reconnect: false,
      includeBuiltins: false,
    })
    cleanup.push(() => app.dispose())

    const root = document.createElement("div")
    document.body.appendChild(root)
    cleanup.push(render(() => <App app={app} />, root))

    await app.boot()
    await waitFor(() => root.querySelector("[data-job-row='job-run-1']") !== null, "job-run-1 row")
    await waitFor(
      () => root.querySelector("[data-part='jobs-active-count']")?.textContent === "1",
      "jobs active count",
    )

    // Select running job and verify initial stream items arrive.
    clickRow(root, "[data-job-row='job-run-1']")
    await waitFor(() => (root.textContent ?? "").includes("Line two from studio"), "initial log lines")
    expect(fake.followRequests[0]).toEqual({ id: "job-run-1", after: 0 })

    // Drop the WebSocket while the job is running, add a new line on the server, and reconnect.
    // JobLog must resume from cursor `after: 2` without duplicating lines 1-2.
    fake.closeSockets()
    await waitFor(() => app.conn.state() === "closed", "socket closed")
    fake.pushJobLog("job-run-1", {
      seq: 3,
      at: now,
      payload: { type: "output", level: "info", text: "Line three after reconnect" },
    })
    app.conn.connect()

    await waitFor(() => (root.textContent ?? "").includes("Line three after reconnect"), "resumed log line 3")
    const resumed = fake.followRequests.find((r) => r.id === "job-run-1" && r.after === 2)
    expect(resumed).toBeDefined()
    const matches = (root.textContent ?? "").match(/Line one from studio/g) ?? []
    expect(matches).toHaveLength(1)

    // Cancel running job (ViewHeader icon button uses aria-label).
    const cancelBtn = Array.from(root.querySelectorAll("button")).find(
      (b) => (b.textContent ?? "").trim() === "Cancel" || b.getAttribute("aria-label") === "Cancel",
    ) as HTMLButtonElement | undefined
    expect(cancelBtn).toBeDefined()
    cancelBtn!.click()
    await waitFor(
      () => fake.calls.some((c) => c.method === "jobs.cancel" && c.params.id === "job-run-1"),
      "jobs.cancel call",
    )

    // Filter list to Failed jobs and retry `job-fail-1`.
    const failedTab = Array.from(root.querySelectorAll("button[role='tab']")).find((b) =>
      (b.textContent ?? "").includes("Failed"),
    ) as HTMLButtonElement | undefined
    expect(failedTab).toBeDefined()
    failedTab!.click()
    await waitFor(
      () =>
        root.querySelector("[data-job-row='job-fail-1']") !== null &&
        root.querySelector("[data-job-row='job-run-1']") === null,
      "failed tab filter",
    )

    clickRow(root, "[data-job-row='job-fail-1']")
    await waitFor(() => (root.textContent ?? "").includes("SSH timeout to 192.0.2.20"), "failed job detail")

    const retryBtn = Array.from(root.querySelectorAll("button")).find(
      (b) => (b.textContent ?? "").trim() === "Retry" || b.getAttribute("aria-label") === "Retry",
    ) as HTMLButtonElement | undefined
    expect(retryBtn).toBeDefined()
    retryBtn!.click()
    await waitFor(
      () => fake.calls.some((c) => c.method === "jobs.retry" && c.params.id === "job-fail-1"),
      "jobs.retry call",
    )
    await waitFor(() => (root.textContent ?? "").includes("Retrying forge.apply"), "retried job log")
  })
})

describe("@crow/shell Notifications Inbox", () => {
  test("tracks unread chrome count, filters, marks read/all-read/archived, answers actions, and receives live pushes", async () => {
    const now = new Date().toISOString()
    const approval: NotificationInfo = {
      id: "n-approve-1",
      kind: "approval",
      entity: "host:forge",
      text: "Approve applying profile changes to forge (192.0.2.20)?",
      actor: "u-ops",
      actorName: "Rookery",
      plugin: "hosts",
      data: { host: "forge" },
      createdAt: now,
      actions: [
        { id: "approve", label: "Approve", style: "primary", input: "Optional note" },
        { id: "deny", label: "Deny", style: "danger" },
      ],
    }
    const failure: NotificationInfo = {
      id: "n-fail-1",
      kind: "job.failed",
      entity: "job:job-fail-1",
      text: "Job forge.apply failed on attempt 1",
      plugin: "hosts",
      data: {},
      createdAt: new Date(Date.now() - 60_000).toISOString(),
      actions: [],
    }

    const fake = startFakeRookery({
      notifications: [approval, failure],
    })
    cleanup.push(() => fake.stop())

    const app = createShellApp({
      baseUrl: fake.baseUrl,
      wsUrl: fake.wsUrl,
      initialUrl: "/inbox",
      reconnect: false,
      includeBuiltins: false,
    })
    cleanup.push(() => app.dispose())

    const root = document.createElement("div")
    document.body.appendChild(root)
    cleanup.push(render(() => <App app={app} />, root))

    await app.boot()
    await waitFor(
      () => root.querySelector("[data-notification-row='n-approve-1']") !== null,
      "n-approve-1 row",
    )

    // Unread count surfaces in sidebar, topbar, and document title.
    await waitFor(
      () => root.querySelector("[data-part='inbox-unread-count']")?.textContent === "2",
      "sidebar unread count 2",
    )
    expect(root.querySelector("[data-part='topbar-inbox-count']")?.textContent).toBe("2")
    expect(document.title).toContain("(2)")

    // Selecting `n-approve-1` marks it read (`notify.read`), dropping unread count to 1.
    clickRow(root, "[data-notification-row='n-approve-1']")
    await waitFor(() => root.querySelector("[data-part='inbox-actions']") !== null, "inbox-actions visible")
    await waitFor(
      () =>
        fake.calls.some(
          (c) =>
            c.method === "notify.read" && Array.isArray(c.params.ids) && c.params.ids.includes("n-approve-1"),
        ),
      "notify.read call",
    )
    await waitFor(
      () => root.querySelector("[data-part='inbox-unread-count']")?.textContent === "1",
      "unread count 1",
    )

    // Answer the actionable notification with a reply note (`notify.answer`).
    const replyInput = root.querySelector("#inbox-answer-input") as HTMLInputElement
    expect(replyInput).not.toBeNull()
    replyInput.value = "Looks good, go ahead"
    replyInput.dispatchEvent(new Event("input", { bubbles: true }))

    const approveBtn = root.querySelector(
      "[data-part='inbox-action-btn'][data-action-id='approve']",
    ) as HTMLButtonElement
    approveBtn.click()

    await waitFor(() => fake.calls.some((c) => c.method === "notify.answer"), "notify.answer call")
    const answerCall = fake.calls.find((c) => c.method === "notify.answer")
    expect(answerCall?.params).toEqual({
      id: "n-approve-1",
      action: "approve",
      text: "Looks good, go ahead",
    })
    await waitFor(() => root.querySelector("[data-part='inbox-answered']") !== null, "inbox-answered callout")
    expect(root.querySelector("[data-part='inbox-answered']")?.textContent).toContain("Looks good, go ahead")

    // Push a live `notify.new` event from server and verify unread count increments to 2.
    fake.pushNotification({
      id: "n-live-1",
      kind: "mention",
      text: "Check studio disk space",
      actor: "u-bo",
      actorName: "Bo",
      plugin: "fleet",
      data: {},
      createdAt: new Date(Date.now() + 1000).toISOString(),
      actions: [],
    })
    await waitFor(
      () => root.querySelector("[data-notification-row='n-live-1']") !== null,
      "live notification row",
    )
    await waitFor(
      () => root.querySelector("[data-part='inbox-unread-count']")?.textContent === "2",
      "unread count 2 after live push",
    )

    // Archive the currently selected notification (`notify.archive`).
    const archiveBtn = root.querySelector("[data-part='inbox-archive']") as HTMLButtonElement
    archiveBtn.click()
    await waitFor(
      () =>
        fake.calls.some(
          (c) =>
            c.method === "notify.archive" &&
            Array.isArray(c.params.ids) &&
            c.params.ids.includes("n-approve-1"),
        ),
      "notify.archive call",
    )
    await waitFor(
      () => root.querySelector("[data-notification-row='n-approve-1']") === null,
      "archived row removed",
    )

    // Mark all read (`notify.readAll`) clears the unread count badge.
    const markAllBtn = Array.from(root.querySelectorAll("button")).find(
      (b) =>
        (b.textContent ?? "").includes("Mark all read") ||
        (b.getAttribute("aria-label") ?? "").includes("Mark all read"),
    ) as HTMLButtonElement | undefined
    expect(markAllBtn).toBeDefined()
    markAllBtn!.click()
    await waitFor(() => fake.calls.some((c) => c.method === "notify.readAll"), "notify.readAll call")
    await waitFor(
      () => root.querySelector("[data-part='inbox-unread-count']") === null,
      "unread count cleared",
    )
  })
})
