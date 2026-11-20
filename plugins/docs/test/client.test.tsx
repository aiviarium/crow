// Integration tests for the Docs client plugin (`docs.home`, `docs.page`, `docs.comment`)
// mounted inside the real shell via `crow/shell/src/app/builtins.ts` and `startFakeRookery`.
import { afterEach, describe, expect, test } from "bun:test"
import { render } from "solid-js/web"
import { App } from "../../../shell/src/app/App"
import { sharedBlockStore } from "../../../shell/src/app/editor"
import { createShellApp } from "../../../shell/src/app/state"
import { startFakeRookery } from "../../../shell/test/fakeRookery"

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

async function mountDocsShell(initialUrl: string) {
  const fake = startFakeRookery({ plugins: [] })
  cleanup.push(() => fake.stop())

  const app = createShellApp({
    baseUrl: fake.baseUrl,
    wsUrl: fake.wsUrl,
    initialUrl,
    reconnect: false,
  })
  cleanup.push(() => app.dispose())

  const root = document.createElement("div")
  document.body.append(root)
  cleanup.push(render(() => <App app={app} />, root))

  await app.boot()
  await app.loader.clientsSettled(4000)
  return { fake, app, root }
}

describe("docs plugin in shell", () => {
  test("registers built-in docs nav item and renders docs.home cleanly without M2b", async () => {
    const { root } = await mountDocsShell("/docs")

    await waitFor(() => !!root.querySelector('[data-part="docs-root"]'), "docs root rendered")
    await waitFor(() => !!root.querySelector('[data-part="tree"]'), "docs sidebar tree rendered")
    await waitFor(() => !!root.querySelector('[data-part="docs-home"]'), "docs home rendered")

    const navLink = Array.from(root.querySelectorAll("a[data-part='nav-item']")).find(
      (el) => el.getAttribute("href") === "/docs/home",
    )
    expect(navLink).toBeDefined()
    expect(root.querySelector('[data-part="templates-link"]')?.textContent).toContain("Templates")
    expect(root.querySelector('[data-part="trash-link"]')?.textContent).toContain("Trash")

    ;(root.querySelector('[data-part="templates-link"]') as HTMLButtonElement).click()
    await waitFor(() => (root.textContent ?? "").includes("Templates"), "templates section rendered")
  })

  test("registers its blocks and widgets where the shell and dashboards find them", async () => {
    await mountDocsShell("/docs")

    const blocks = sharedBlockStore().components
    expect([...blocks.keys()]).toEqual(
      expect.arrayContaining(["docs.database", "docs.page", "docs.item", "docs.toc", "docs.synced"]),
    )
    const widgets = (globalThis as Record<PropertyKey, unknown>)[Symbol.for("crow.widgets.registry")] as {
      components: Map<string, unknown>
    }
    expect([...widgets.components.keys()]).toEqual(expect.arrayContaining(["docs.recent", "docs.embed"]))
  })

  test("renders docs.page and gracefully handles missing M2b spaces/documents", async () => {
    const { root } = await mountDocsShell("/docs/page-123")

    await waitFor(() => !!root.querySelector('[data-part="docs-root"]'), "docs root rendered")
    await waitFor(() => !!root.querySelector('[data-part="tree"]'), "docs sidebar tree rendered")
    await waitFor(
      () => !!root.querySelector('[data-part="page"], [data-part="page-unavailable"]'),
      "docs page or M2b fallback rendered",
    )
  })
})
