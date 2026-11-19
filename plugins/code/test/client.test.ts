// The client half alone: it registers the plugin's views, widgets and the commands that open them, against a
// minimal client runtime. No shell, no server.
import { describe, expect, test } from "bun:test"
import { type ClientRuntime, createClientApi } from "@rookery/sdk/runtime/client"
import manifest from "../rookery/plugin.json"
import client from "../src/client"

function fakeRuntime() {
  const views = new Map<string, unknown>()
  const commands = new Map<string, unknown>()
  const opened: Array<{ id: string; opts?: Record<string, unknown> }> = []
  const toasts: Array<Record<string, unknown>> = []
  const rt: ClientRuntime = {
    call: async () => ({ logins: [], admin: false }),
    stream: async () => {
      throw new Error("no streams in this test")
    },
    onNotification: () => ({ dispose() {} }),
    onReconnect: () => ({ dispose() {} }),
    subscribe: async () => ({ dispose() {} }),
    registerView: (_plugin, id, component) => {
      views.set(id, component)
      return { dispose() {} }
    },
    registerCommand: (_plugin, id, def) => {
      commands.set(id, def)
      return { dispose() {} }
    },
    runCommand: async (id) => {
      const def = commands.get(id) as { run(p: Record<string, unknown>): unknown } | undefined
      return def?.run({})
    },
    openView: (id, opts) => void opened.push({ id, opts: opts as Record<string, unknown> }),
    href: (id) => `/github/${id.split(".")[1]}`,
    toast: (t) => void toasts.push(t as unknown as Record<string, unknown>),
    space: () => null,
    manifests: () => [manifest as never],
  }
  return { rt, views, commands, opened, toasts }
}

describe("the GitHub client half", () => {
  test("registers every declared view and the three widgets", () => {
    const { rt, views } = fakeRuntime()
    const { rookery } = createClientApi(rt, "code", manifest as never)
    ;(client as unknown as { activate(r: unknown): void }).activate(rookery)
    for (const view of manifest.contributes.views) expect(views.has(view.id)).toBe(true)
    const registry = (globalThis as Record<PropertyKey, unknown>)[Symbol.for("crow.widgets.registry")] as {
      components: Map<string, unknown>
    }
    expect(registry.components.has("code.myPulls")).toBe(true)
    expect(registry.components.has("code.reviewRequests")).toBe(true)
    expect(registry.components.has("code.failingChecks")).toBe(true)
  })

  test("its commands open the views", async () => {
    const { rt, opened } = fakeRuntime()
    const { rookery } = createClientApi(rt, "code", manifest as never)
    ;(client as unknown as { activate(r: unknown): void }).activate(rookery)
    await rookery.commands.run("code.pulls")
    await rookery.commands.run("code.issues")
    await rookery.commands.run("code.repos")
    expect(opened.map((o) => o.id)).toEqual(["code.pulls", "code.issues", "code.repos"])
  })
})
