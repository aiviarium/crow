// The editor services the shell provides: the block types of the active plugins' manifests, and the
// components their client halves register for them via `rookery.blocks.register` (`app.loader.blocks()`).
import { afterEach, describe, expect, test } from "bun:test"
import { useEditorServices } from "@aiviarium/nocturne"
import type { BlockEntry, PluginInfo } from "@rookery/client"
import { createSignal, For, type JSX } from "solid-js"
import { render } from "solid-js/web"
import { blockTypes, CrowEditorServices, defaultsOf } from "../src/app/editor"
import type { ShellApp } from "../src/app/state"

const cleanup: Array<() => void> = []
afterEach(() => {
  while (cleanup.length) cleanup.pop()!()
  document.body.innerHTML = ""
})

const manifest = {
  id: "docs",
  version: "0.1.0",
  apiVersion: "1",
  name: "Docs",
  contributes: {
    blocks: [
      {
        id: "docs.page",
        title: "Link to page",
        description: "A page as a card",
        icon: "file",
        attrs: {
          type: "object",
          properties: {
            uri: { type: "string", default: "" },
            title: { type: "string", default: "" },
          },
        },
      },
    ],
  },
} as unknown as NonNullable<PluginInfo["manifest"]>

function Probe(): JSX.Element {
  const services = useEditorServices()
  return (
    <ul data-part="blocks">
      <For each={services.blocks?.() ?? []}>
        {(b) => (
          <li data-id={b.id} data-available={b.available ? "yes" : "no"}>
            {b.title}
          </li>
        )}
      </For>
    </ul>
  )
}

describe("the shell's editor services", () => {
  test("a block's defaults are the manifest's schema defaults", () => {
    expect(defaultsOf(manifest.contributes.blocks![0]!.attrs)).toEqual({ uri: "", title: "" })
  })

  test("a declared block is listed before its component registers, and available after", async () => {
    const [blocks, setBlocks] = createSignal<Record<string, BlockEntry>>({})
    const app = {
      loader: {
        plugins: { docs: { id: "docs", manifest } },
        blocks,
      },
    } as unknown as ShellApp

    const root = document.createElement("div")
    document.body.appendChild(root)
    cleanup.push(
      render(
        () => (
          <CrowEditorServices app={app}>
            <Probe />
          </CrowEditorServices>
        ),
        root,
      ),
    )

    const first = () => document.querySelector('[data-id="docs.page"]')
    expect(first()?.textContent).toBe("Link to page")
    expect(first()?.getAttribute("data-available")).toBe("no")

    setBlocks({
      "docs.page": {
        plugin: "docs",
        id: "docs.page",
        component: () => <span>card</span>,
        options: {},
        version: 1,
      },
    })

    const deadline = Date.now() + 5000
    while (first()?.getAttribute("data-available") !== "yes" && Date.now() < deadline) await Bun.sleep(10)
    expect(first()?.getAttribute("data-available")).toBe("yes")

    setBlocks({})
    while (first()?.getAttribute("data-available") !== "no" && Date.now() < deadline) await Bun.sleep(10)
    expect(first()?.getAttribute("data-available")).toBe("no")
  })

  test("a plugin's blocks are the ones its manifest declares", () => {
    const types = blockTypes({ docs: { id: "docs", manifest } } as unknown as Record<string, PluginInfo>)
    expect(types.map((b) => b.id)).toEqual(["docs.page"])
    expect(types[0]?.plugin).toBe("docs")
  })
})
