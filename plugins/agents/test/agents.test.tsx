// Focused end-to-end tests for Crow's `agents` plugin on Parrot, loaded through `@rookery/client`'s
// plugin loader against the in-process fake Parrot runtime over Rookery's `agents.connect` stream.
// Covers M5's "You can": pick a host, start a session with a driver, chat, see tool steps and diffs,
// answer approvals and questions, stop a session, and list & re-open existing sessions on a host.
import { afterEach, describe, expect, test } from "bun:test"
import { render } from "solid-js/web"
import { App } from "../../../shell/src/app/App"
import { createShellApp } from "../../../shell/src/app/state"
import { makeSessionRecord, startFakeAgentsRookery } from "./fakeParrot"

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

async function mountShell(fake: { baseUrl: string; wsUrl: string }, initialPath = "/agents") {
  const app = createShellApp({
    baseUrl: fake.baseUrl,
    wsUrl: fake.wsUrl,
    initialUrl: initialPath,
    reconnect: false,
  })
  const root = document.createElement("div")
  document.body.appendChild(root)
  const dispose = render(() => <App app={app} />, root)
  cleanup.push(() => {
    dispose()
    app.dispose()
  })
  await app.boot()
  await app.loader.clientsSettled(4000)
  return { root, app }
}

function typeInComposer(root: HTMLElement, text: string) {
  const editor = root.querySelector<HTMLElement>('[data-part="composer"] [contenteditable="true"]')
  expect(editor).not.toBeNull()
  editor!.focus()
  editor!.textContent = text
  editor!.dispatchEvent(new Event("input", { bubbles: true }))
}

function clickSend(root: HTMLElement) {
  const sendBtn = root.querySelector<HTMLButtonElement>('[data-part="composer"] button[aria-label="Send"]')
  expect(sendBtn).not.toBeNull()
  expect(sendBtn!.disabled).toBe(false)
  sendBtn!.click()
}

describe("agents plugin on Parrot", () => {
  test("lists sessions on a host, switches hosts, and re-opens an existing session", async () => {
    const existingStudio = makeSessionRecord({
      id: "ses-studio-1",
      host: "studio",
      agent: "claude",
      title: "Fix auth redirect",
      items: [
        {
          id: "u-1",
          kind: "user",
          turn: "t-1",
          text: "Why does /login loop?",
          status: "handled",
        },
        {
          id: "a-1",
          kind: "assistant",
          turn: "t-1",
          text: "The callback checked `CROW_PUBLIC_URL` without a trailing slash.",
        },
      ],
    })
    const existingForge = makeSessionRecord({
      id: "ses-forge-1",
      host: "forge",
      agent: "codex",
      title: "Audit Dockerfile",
      items: [
        {
          id: "u-f1",
          kind: "user",
          turn: "t-1",
          text: "Check image size",
          status: "handled",
        },
        {
          id: "a-f1",
          kind: "assistant",
          turn: "t-1",
          text: "Switching to a multi-stage build cuts 420 MB.",
        },
      ],
    })

    const fake = startFakeAgentsRookery({
      hosts: [
        { name: "studio", sessions: [existingStudio] },
        { name: "forge", sessions: [existingForge] },
      ],
    })
    cleanup.push(() => fake.stop())

    const { root, app } = await mountShell(fake, "/agents")

    // Default online host (`forge` sorts alphabetically before `studio`) connects and lists its session.
    await waitFor(
      () => root.textContent?.includes("Audit Dockerfile") ?? false,
      "forge session row in sidebar",
    )

    // Re-open the existing session from the sidebar.
    const forgeRow = root.querySelector<HTMLElement>('[data-session="ses-forge-1"] .nc-lrow__main')
    expect(forgeRow).not.toBeNull()
    forgeRow!.click()

    await waitFor(
      () => root.textContent?.includes("multi-stage build cuts 420 MB") ?? false,
      "re-opened forge session transcript",
    )

    // Navigate directly to a session on another host (`studio`) and verify its stream opens.
    app.navigate("/agents/studio/ses-studio-1")

    await waitFor(
      () =>
        (root.textContent?.includes("Fix auth redirect") ?? false) &&
        (root.textContent?.includes("CROW_PUBLIC_URL") ?? false),
      "studio session loaded",
    )

    // Verify Rookery's `agents.connect` stream was opened for both hosts.
    const connects = fake.rookeryCalls.filter((c) => c.method === "agents.connect")
    expect(connects.map((c) => c.params.env).sort()).toEqual(["env://forge", "env://studio"])
  })

  test("starts a session, streams reasoning/tools/diffs, answers approval and question, and stops", async () => {
    const fake = startFakeAgentsRookery({
      hosts: [
        {
          name: "studio",
          onPrompt(ctx) {
            queueMicrotask(() => {
              // 1. Stream thinking + a completed Read tool step + a pending Bash command needing approval.
              ctx.emitItem({
                id: "reason-1",
                kind: "reasoning",
                turn: ctx.turnId,
                set: { text: "Inspecting the failing test first." },
                streaming: false,
              })
              ctx.emitItem({
                id: "tool-read-1",
                kind: "tool",
                turn: ctx.turnId,
                set: {
                  tool: "Read",
                  title: "/srv/project/src/auth.ts",
                  input: { path: "/srv/project/src/auth.ts" },
                  status: "ok",
                  caller: "model",
                },
              })
              ctx.emitItem({
                id: "cmd-test-1",
                kind: "command",
                turn: ctx.turnId,
                set: {
                  command: "bun test",
                  cwd: "/srv/project",
                  status: "running",
                },
              })
              ctx.emitRequest({
                id: "req-approve-1",
                session: ctx.record.session.id,
                turn: ctx.turnId,
                item: "cmd-test-1",
                kind: "approval",
                title: "Run test suite",
                subject: { type: "command", command: "bun test", cwd: "/srv/project" },
                level: "host",
                choices: [
                  { id: "allow", label: "Allow", intent: "allow", scope: "once" },
                  { id: "allow_session", label: "Allow for session", intent: "allow", scope: "session" },
                  { id: "deny", label: "Deny", intent: "deny" },
                ],
                blocking: true,
                answerable: "connection",
                notify: "normal",
                status: "open",
              })
              ctx.emitState("requires_action")
            })
          },
          onAnswer(ctx) {
            if (ctx.request.id === "req-approve-1") {
              // Approval granted -> command completes, file diff lands, agent asks a clarifying question.
              ctx.emitState("running")
              ctx.emitItem({
                id: "cmd-test-1",
                set: { status: "ok", output: "2 passed", exit: 0 },
              })
              ctx.emitItem({
                id: "fc-1",
                kind: "file_change",
                turn: ctx.request.turn ?? undefined,
                set: {
                  status: "ok",
                  changes: [
                    {
                      path: "/srv/project/src/auth.ts",
                      op: "modify",
                      diff: "--- a/src/auth.ts\n+++ b/src/auth.ts\n@@ -1,1 +1,1 @@\n-return false\n+return true\n",
                    },
                  ],
                },
              })
              ctx.emitRequest({
                id: "req-q-1",
                session: ctx.record.session.id,
                turn: ctx.request.turn ?? undefined,
                kind: "question",
                title: "Should I also update the README?",
                choices: [
                  { id: "yes", label: "Yes, update README" },
                  { id: "no", label: "No, leave it" },
                ],
                level: "read",
                blocking: true,
                answerable: "connection",
                notify: "normal",
                status: "open",
              })
              ctx.emitState("requires_action")
              return
            }

            if (ctx.request.id === "req-q-1") {
              // Question answered -> stream assistant text and stay running so we can test Stop.
              ctx.emitState("running")
              ctx.emitItem({
                id: "asst-1",
                kind: "assistant",
                turn: ctx.request.turn ?? undefined,
                set: { text: "Updated `src/auth.ts`" },
                streaming: true,
              })
              ctx.emitItem({
                id: "asst-1",
                append: { text: " and kept the README untouched." },
                streaming: false,
              })
              ctx.emitUsage({
                tokens: { input: 1200, output: 350 },
                cost: { amount: 0.0123, currency: "USD" },
                context: { used: 110_000, window: 200_000 },
              })
            }
          },
        },
      ],
    })
    cleanup.push(() => fake.stop())

    const { root } = await mountShell(fake, "/agents")

    // Wait for NewSession to finish connecting to `studio` and load Claude Code / Codex drivers.
    await waitFor(() => {
      const composer = root.querySelector('[data-part="new-session"] [data-part="composer"]')
      const btn = composer?.querySelector<HTMLButtonElement>('button[aria-label="Send"]')
      return Boolean(composer) && root.textContent?.includes("Claude Code") && btn !== null
    }, "new session ready with host drivers")

    // Start a session by typing a prompt and clicking Send.
    typeInComposer(root, "Fix the auth test")
    await waitFor(() => {
      const btn = root.querySelector<HTMLButtonElement>('[data-part="composer"] button[aria-label="Send"]')
      return Boolean(btn && !btn.disabled)
    }, "Send button enabled")
    clickSend(root)

    // Verify tool step (relative path `src/auth.ts`) and open approval card appear.
    await waitFor(
      () =>
        (root.textContent?.includes("Run test suite") ?? false) &&
        (root.textContent?.includes("src/auth.ts") ?? false),
      "approval card and tool step rendered",
    )

    // While approval is open for `cmd-test-1`, the duplicate command step is suppressed.
    expect(root.querySelector('[data-part="approval"][data-status="open"]')).not.toBeNull()

    // Click "Allow" on the approval card.
    const allowBtn = Array.from(
      root.querySelectorAll<HTMLButtonElement>('[data-part="approval"] button'),
    ).find((b) => b.textContent?.trim() === "Allow")
    expect(allowBtn).not.toBeNull()
    allowBtn!.click()

    // Wait for the approval to collapse to Decided, the file change card to render, and the question card to appear.
    await waitFor(
      () =>
        root.querySelector('[data-part="approval-decided"]') !== null &&
        root.querySelector('[data-part="file-change"]') !== null &&
        (root.textContent?.includes("Should I also update the README?") ?? false),
      "decided approval, file change card, and question card",
    )

    // Pick "No, leave it" and click Answer.
    const noOption = Array.from(
      root.querySelectorAll<HTMLButtonElement>('[data-part="question"] .ag-option'),
    ).find((b) => b.textContent?.includes("No, leave it"))
    expect(noOption).not.toBeNull()
    noOption!.click()

    const answerBtn = Array.from(
      root.querySelectorAll<HTMLButtonElement>('[data-part="question"] button'),
    ).find((b) => b.textContent?.trim() === "Answer")
    expect(answerBtn).not.toBeNull()
    answerBtn!.click()

    // Verify streamed assistant response arrives.
    await waitFor(
      () => root.textContent?.includes("and kept the README untouched.") ?? false,
      "streamed assistant answer after question",
    )

    // Stop the running session via the Stop action.
    const stopBtn = Array.from(root.querySelectorAll<HTMLButtonElement>("button")).find(
      (b) => b.textContent?.trim() === "Stop" || b.getAttribute("aria-label") === "Stop",
    )
    expect(stopBtn).not.toBeNull()
    stopBtn!.click()

    await waitFor(
      () => root.textContent?.includes("Turn cancelled.") ?? false,
      "turn cancelled notice after Stop",
    )

    // Verify the Parrot RPC calls made on the host runtime.
    const methods = fake.hosts.get("studio")!.rpcLog.map((e) => e.method)
    expect(methods).toContain("initialize")
    expect(methods).toContain("session/new")
    expect(methods).toContain("session/prompt")
    expect(methods).toContain("request/answer")
    expect(methods).toContain("session/cancel")
  })

  test("falls back to hosts.list when env.list is not implemented on the Rookery server", async () => {
    const fake = startFakeAgentsRookery({
      useLegacyHostsList: true,
      hosts: [
        {
          name: "studio",
          sessions: [makeSessionRecord({ id: "ses-legacy-1", host: "studio", title: "Legacy host session" })],
        },
      ],
    })
    cleanup.push(() => fake.stop())

    const { root } = await mountShell(fake, "/agents")

    await waitFor(
      () => root.textContent?.includes("Legacy host session") ?? false,
      "session loaded via hosts.list fallback",
    )

    const called = fake.rookeryCalls.map((c) => c.method)
    expect(called).toContain("env.list")
    expect(called).toContain("hosts.list")
  })
})
