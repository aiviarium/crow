// Tests for Crow shell's Jobs view (`/jobs`, `/jobs/:id`) and Notifications Inbox (`/inbox`,
// `/inbox/:id`): live `jobs.follow` cursor resume, cancel/retry, unread badge chrome,
// `notify.read` and `notify.answer`, and live server push updates.
import { afterEach, describe, expect, test } from "bun:test"
import type { NotificationInfo } from "@rookery/client"
import { render } from "solid-js/web"
import { App } from "../src/app/App"
import { createShellApp } from "../src/app/state"
import { errorBody, makeJob, makeLogItem, startFakeRookery } from "./fakeRookery"

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

function clickRow(root: HTMLElement, selector: string): void {
  const row = root.querySelector(selector) as HTMLElement | null
  if (!row) throw new Error(`row not found: ${selector}`)
  const trigger = (row.querySelector("button, a") as HTMLElement | null) ?? row
  trigger.click()
}

describe("@crow/shell Jobs view", () => {
  test("lists jobs by kind and subject, follows live log with cursor resume on reconnect, cancels and retries", async () => {
    const now = new Date().toISOString()
    const runningJob = makeJob({
      id: "job-run-1",
      kind: "host.apply",
      subject: "host://studio",
      params: { host: "studio" },
      state: "running",
      createdAt: now,
      startedAt: now,
    })
    const failedJob = makeJob({
      id: "job-fail-1",
      kind: "host.apply",
      subject: "host://forge",
      params: { host: "forge" },
      state: "failed",
      maxAttempts: 2,
      createdAt: now,
      startedAt: now,
      finishedAt: now,
      error: errorBody("SSH timeout to 192.0.2.20", "UNAVAILABLE"),
    })

    const fake = startFakeRookery({
      jobs: [runningJob, failedJob],
      jobLogs: {
        "job-run-1": [
          makeLogItem({ seq: 1, at: now, text: "Line one from studio" }),
          makeLogItem({ seq: 2, at: now, text: "Line two from studio" }),
        ],
        "job-fail-1": [makeLogItem({ seq: 1, at: now, level: "error", text: "Connection timed out" })],
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

    // The list row names the job by its kind and subject, not a removed `name`.
    const row = root.querySelector("[data-job-row='job-run-1']")
    expect(row?.textContent).toContain("host.apply")
    expect(row?.textContent).toContain("host://studio")

    // Select running job and verify initial stream items arrive.
    clickRow(root, "[data-job-row='job-run-1']")
    await waitFor(() => (root.textContent ?? "").includes("Line two from studio"), "initial log lines")
    expect(fake.followRequests[0]).toEqual({ id: "job-run-1", after: 0 })

    // Drop the WebSocket while the job is running, add a new line on the server, and reconnect.
    // JobLog must resume from cursor `after: 2` without duplicating lines 1-2.
    fake.closeSockets()
    await waitFor(() => app.conn.state() === "closed", "socket closed")
    fake.pushJobLog("job-run-1", makeLogItem({ seq: 3, at: now, text: "Line three after reconnect" }))
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
    await waitFor(() => (root.textContent ?? "").includes("Retrying host.apply"), "retried job log")
  })
})

describe("@crow/shell Notifications Inbox", () => {
  test("tracks unread chrome count, filters, marks read/all-read, answers actions, and receives live pushes", async () => {
    const now = new Date().toISOString()
    const approval: NotificationInfo = {
      id: "n-approve-1",
      kind: "approval",
      title: "Approve applying profile changes to forge",
      body: "Approve applying profile changes to forge (192.0.2.20)?",
      data: { host: "forge" },
      actions: ["approve", "deny"],
      answer: null,
      createdAt: now,
      readAt: null,
    }
    const failure: NotificationInfo = {
      id: "n-fail-1",
      kind: "job_failure",
      title: "Job host.apply failed",
      body: "Job host.apply failed on attempt 1",
      data: {},
      actions: [],
      answer: null,
      createdAt: new Date(Date.now() - 60_000).toISOString(),
      readAt: null,
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

    // Answer the actionable notification (`notify.answer` takes the action id as `answer`).
    const approveBtn = root.querySelector(
      "[data-part='inbox-action-btn'][data-action-id='approve']",
    ) as HTMLButtonElement
    expect(approveBtn).not.toBeNull()
    expect(approveBtn.textContent).toBe("Approve")
    approveBtn.click()

    await waitFor(() => fake.calls.some((c) => c.method === "notify.answer"), "notify.answer call")
    const answerCall = fake.calls.find((c) => c.method === "notify.answer")
    expect(answerCall?.params).toEqual({ id: "n-approve-1", answer: "approve" })
    await waitFor(() => root.querySelector("[data-part='inbox-answered']") !== null, "inbox-answered callout")

    // Push a live `notify.new` event from server and verify unread count increments to 2.
    fake.pushNotification({
      id: "n-live-1",
      kind: "mention",
      title: "Check studio disk space",
      body: "Studio is above 90% disk use.",
      data: {},
      actions: [],
      answer: null,
      createdAt: new Date(Date.now() + 1000).toISOString(),
      readAt: null,
    })
    await waitFor(
      () => root.querySelector("[data-notification-row='n-live-1']") !== null,
      "live notification row",
    )
    await waitFor(
      () => root.querySelector("[data-part='inbox-unread-count']")?.textContent === "2",
      "unread count 2 after live push",
    )

    // Mark all read (`notify.read` with no ids) clears the unread count badge.
    const markAllBtn = Array.from(root.querySelectorAll("button")).find(
      (b) =>
        (b.textContent ?? "").includes("Mark all read") ||
        (b.getAttribute("aria-label") ?? "").includes("Mark all read"),
    ) as HTMLButtonElement | undefined
    expect(markAllBtn).toBeDefined()
    markAllBtn!.click()
    await waitFor(
      () => fake.calls.some((c) => c.method === "notify.read" && c.params.ids === undefined),
      "mark all read call",
    )
    await waitFor(
      () => root.querySelector("[data-part='inbox-unread-count']") === null,
      "unread count cleared",
    )
  })
})
