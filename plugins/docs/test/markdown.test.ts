import { describe, expect, test } from "bun:test"
import { parseFrontMatter, stringifyFrontMatter } from "../src/lib/frontmatter"
import {
  exportTree,
  fileName,
  normalize,
  outsideCode,
  planImport,
  relative,
  rewriteLinks,
} from "../src/lib/mdio"
import {
  defsFromFrontMatter,
  display,
  inferType,
  linksOf,
  type PropDef,
  propsFromFrontMatter,
  setProps,
  toFrontMatter,
} from "../src/lib/props"
import { text, unzip, zip } from "../src/lib/zip"

const status: PropDef = {
  id: "s",
  name: "Status",
  type: "select",
  options: [
    { id: "o1", name: "In review", hue: "sky" },
    { id: "o2", name: "Done", hue: "mint" },
  ],
}
const defs: PropDef[] = [
  status,
  {
    id: "t",
    name: "Tags",
    type: "multi",
    options: [
      { id: "t1", name: "runbook" },
      { id: "t2", name: "ops" },
    ],
  },
  { id: "d", name: "Review", type: "date" },
  { id: "o", name: "Owner", type: "person" },
  { id: "h", name: "Host", type: "relation" },
  { id: "n", name: "Version", type: "number" },
  { id: "c", name: "Checked", type: "checkbox" },
]

describe("properties", () => {
  test("values are normalised to their type, and empty ones unset", () => {
    const p = setProps(
      defs,
      {},
      {
        s: "o1",
        t: ["t2", "t2", "nope"],
        d: "2026-12-04T10:00:00Z",
        o: "user://ann",
        h: "env://build-01",
        n: "1,280",
        c: "true",
      },
    )
    expect(p).toEqual({
      s: "o1",
      t: ["t2"],
      d: "2026-12-04",
      o: "user://ann",
      h: ["env://build-01"],
      n: 1280,
      c: true,
    })
    expect(setProps(defs, p, { s: "", n: "abc" })).not.toHaveProperty("s")
    expect(linksOf(defs, p)).toEqual(["user://ann", "env://build-01"])
    expect(display(defs[0]!, "o1")).toBe("In review")
    expect(display(defs[2]!, "2026-12-04")).toBe("Dec 4, 2026")
    expect(display(defs[5]!, 1280)).toBe("1,280")
  })

  test("front matter round-trips through names, and new names get a fitting type", () => {
    const fm = toFrontMatter(defs, { s: "o2", t: ["t1", "t2"], n: 3 })
    expect(fm).toEqual({ Status: "Done", Tags: ["runbook", "ops"], Version: 3 })
    expect(propsFromFrontMatter(defs, fm)).toEqual({ s: "o2", t: ["t1", "t2"], n: 3 })
    expect(inferType([true, false])).toBe("checkbox")
    expect(inferType(["2026-01-02"])).toBe("date")
    expect(inferType(["https://x.y"])).toBe("url")
    expect(inferType([["a", "b"]])).toBe("multi")
    expect(inferType(["Open", "Open", "Closed", "Open"])).toBe("select")
    expect(inferType(["env://build-01"])).toBe("relation")
    const made = defsFromFrontMatter(
      [status],
      [
        { Status: "Blocked", Priority: 2 },
        { Status: "Done", Priority: 3 },
      ],
    )
    expect(made.find((d) => d.name === "Status")!.options!.map((o) => o.name)).toEqual([
      "In review",
      "Done",
      "Blocked",
    ])
    expect(made.find((d) => d.name === "Priority")!.type).toBe("number")
  })
})

describe("front matter", () => {
  test("reads the subset notes use, and writes what it reads", () => {
    const src = `---
title: "Host setup: runbook"
tags: [runbook, "ops, infra"]
aliases:
  - Setup
  - Hosts
draft: true
order: 3
review: 2026-12-04
empty:
---
# Body
`
    const { data, body } = parseFrontMatter(src)
    expect(data).toEqual({
      title: "Host setup: runbook",
      tags: ["runbook", "ops, infra"],
      aliases: ["Setup", "Hosts"],
      draft: true,
      order: 3,
      review: "2026-12-04",
      empty: null,
    })
    expect(body).toBe("# Body\n")
    const again = parseFrontMatter(`${stringifyFrontMatter(data)}# Body\n`)
    expect(again.data).toEqual(data)
    expect(parseFrontMatter("no front matter").data).toEqual({})
    expect(stringifyFrontMatter({})).toBe("")
  })
})

describe("paths", () => {
  test("file names, relative paths and code are handled", () => {
    expect(fileName("a/b: c?")).toBe("a b c")
    expect(fileName("  ")).toBe("Untitled")
    expect(normalize("a/./b/../c")).toBe("a/c")
    expect(relative("a/b", "a/c/d.md")).toBe("../c/d.md")
    expect(relative("", "x.md")).toBe("x.md")
    expect(relative("a", "a.md")).toBe("../a.md")
    const md = "see [x](y)\n```\n[x](y)\n```\nand `[x](y)` [x](y)"
    expect(outsideCode(md, (t) => t.replaceAll("(y)", "(z)"))).toBe(
      "see [x](z)\n```\n[x](y)\n```\nand `[x](y)` [x](z)",
    )
  })
})

describe("export and import", () => {
  const pages = [
    {
      id: "11111111-aaaa",
      title: "Engineering",
      parent: null,
      markdown: "Start at [Runbooks](doc://22222222-bbbb).\n",
      meta: { title: "Engineering" },
    },
    {
      id: "22222222-bbbb",
      title: "Runbooks",
      parent: "11111111-aaaa",
      markdown: "Back to [Engineering](doc://11111111-aaaa), see [Ann](user://ann).\n\n![chart](/blobs/b1)\n",
      meta: { title: "Runbooks", Status: "Done", Tags: ["ops"] },
    },
    {
      id: "33333333-cccc",
      title: "Host setup",
      parent: "22222222-bbbb",
      markdown: "Up: [Runbooks](doc://22222222-bbbb)\n",
      meta: { title: "Host setup" },
    },
    {
      id: "44444444-dddd",
      title: "Host setup",
      parent: "22222222-bbbb",
      markdown: "A second page of the same name.\n",
      meta: { title: "Host setup" },
    },
  ]

  test("a tree becomes folders beside their pages, with relative links and attachments", () => {
    const out = exportTree(pages, () => "chart.png")
    expect(out.files.map((f) => f.path)).toEqual([
      "Engineering.md",
      "Engineering/Runbooks.md",
      "Engineering/Runbooks/Host setup.md",
      "Engineering/Runbooks/Host setup 2.md",
    ])
    expect(out.files[0]!.text).toContain("[Runbooks](Engineering/Runbooks.md)")
    expect(out.files[1]!.text).toContain("[Engineering](../Engineering.md)")
    expect(out.files[1]!.text).toContain("[Ann](user://ann)")
    expect(out.files[1]!.text).toContain("![chart](../_attachments/chart.png)")
    expect(out.files[1]!.text.startsWith("---\ntitle: Runbooks\nStatus: Done\nTags:\n  - ops\n---\n")).toBe(
      true,
    )
    expect(out.files[2]!.text).toContain("[Runbooks](../Runbooks.md)")
    expect(out.attachments).toEqual([{ path: "_attachments/chart.png", blob: "b1" }])
  })

  test("importing the export gives the same tree and links between the new pages", () => {
    const out = exportTree(pages, () => "chart.png")
    const plan = planImport(out.files)
    expect(plan.map((p) => [p.title, p.parent])).toEqual([
      ["Engineering", null],
      ["Runbooks", "Engineering.md"],
      ["Host setup", "Engineering/Runbooks.md"],
      ["Host setup", "Engineering/Runbooks.md"],
    ])
    expect(plan[1]!.props).toEqual({ Status: "Done", Tags: ["ops"] })
    const ids = new Map(plan.map((p, i) => [p.key, `new-${i}`]))
    const bodies = plan.map((p) =>
      rewriteLinks(
        p,
        (k) => ids.get(k),
        () => undefined,
        (path) => (path === "_attachments/chart.png" ? "/blobs/b9" : undefined),
      ),
    )
    expect(bodies[0]).toContain("[Runbooks](doc://new-1)")
    expect(bodies[1]).toContain("[Engineering](doc://new-0)")
    expect(bodies[1]).toContain("[Ann](user://ann)")
    expect(bodies[1]).toContain("![chart](/blobs/b9)")
    expect(bodies[2]).toContain("[Runbooks](doc://new-1)")
  })

  test("folders without notes get pages, folder notes stand for their folder, wiki links resolve", () => {
    const plan = planImport([
      {
        path: "vault/Projects/README.md",
        text: "# Projects\n\nAll of them. [[Crow|the app]] and [[Missing]].\n",
      },
      {
        path: "vault/Projects/Crow.md",
        text: "---\nstatus: active\n---\nSee ![[diagram.png]] and [up](README.md)\n",
      },
      { path: "vault/Daily/2026-11-14.md", text: "Today.\n" },
      { path: "vault/.obsidian/workspace.md", text: "hidden" },
      { path: "vault/notes.txt", text: "not markdown" },
    ])
    expect(plan.map((p) => [p.key, p.title, p.parent])).toEqual([
      ["vault", "vault", null],
      ["vault/Daily", "Daily", "vault"],
      ["vault/Daily/2026-11-14.md", "2026-11-14", "vault/Daily"],
      ["vault/Projects/README.md", "Projects", "vault"],
      ["vault/Projects/Crow.md", "Crow", "vault/Projects/README.md"],
    ])
    const ids = new Map(plan.map((p, i) => [p.key, `id${i}`]))
    const byTitle = (t: string) => {
      const i = plan.findIndex((p) => p.title.toLowerCase() === t.toLowerCase())
      return i >= 0 ? `id${i}` : undefined
    }
    const readme = plan[3]!
    expect(readme.body).toBe("All of them. [[Crow|the app]] and [[Missing]].\n")
    expect(
      rewriteLinks(
        readme,
        (k) => ids.get(k),
        byTitle,
        () => undefined,
      ),
    ).toBe("All of them. [the app](doc://id4) and Missing.\n")
    const crow = plan[4]!
    expect(crow.props).toEqual({ status: "active" })
    expect(
      rewriteLinks(
        crow,
        (k) => ids.get(k),
        byTitle,
        (p) => (p.endsWith("diagram.png") ? "/blobs/x" : undefined),
      ),
    ).toBe("See ![diagram.png](/blobs/x) and [up](doc://id3)\n")
  })

  test("docs folder plans into one page per file with relative links and fragments resolved", () => {
    const files = [
      { path: "docs/data.md", text: "# Data\n\nCollections and refs.\n" },
      { path: "docs/architecture.md", text: "# Architecture\n\n## Permissions\n" },
      {
        path: "docs/plugins.md",
        text: "# Plugins\n\nSee [Data](data.md) and [Permissions](architecture.md#permissions).\n",
      },
    ]
    const plan = planImport(files)
    expect(plan[0]!.key).toBe("docs")
    expect(plan.length).toBe(files.length + 1)
    const data = plan.find((p) => p.key === "docs/data.md")!
    expect(data.title).toBe("Data")
    const ids = new Map(plan.map((p, i) => [p.key, `id${i}`]))
    const body = rewriteLinks(
      plan.find((p) => p.key === "docs/plugins.md")!,
      (k) => ids.get(k),
      () => undefined,
      () => undefined,
    )
    expect(body).toContain(`(doc://${ids.get("docs/data.md")})`)
    expect(body).toContain(`(doc://${ids.get("docs/architecture.md")})`)
    expect(body).not.toContain("](data.md)")
  })
})

describe("zip", () => {
  test("what zip writes, unzip reads", async () => {
    const entries = [
      { path: "Engineering.md", data: text("# Eng\n") },
      { path: "Engineering/Runbooks.md", data: text("Grüße ✓\n") },
    ]
    const back = await unzip(zip(entries))
    expect(back.map((e) => e.path)).toEqual(["Engineering.md", "Engineering/Runbooks.md"])
    expect(new TextDecoder().decode(back[1]!.data)).toBe("Grüße ✓\n")
  })

  test("deflated entries are read too", async () => {
    // A ZIP made by Bun's own deflate: one entry, method 8.
    const content = text("hello hello hello hello\n")
    const deflated = Bun.deflateSync(content)
    const name = text("a.md")
    const crcOf = (d: Uint8Array) => {
      let c = 0xffffffff
      for (const b of d) {
        c ^= b
        for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
      }
      return (c ^ 0xffffffff) >>> 0
    }
    const local = new Uint8Array(30 + name.length)
    const lv = new DataView(local.buffer)
    lv.setUint32(0, 0x04034b50, true)
    lv.setUint16(8, 8, true)
    lv.setUint32(14, crcOf(content), true)
    lv.setUint32(18, deflated.length, true)
    lv.setUint32(22, content.length, true)
    lv.setUint16(26, name.length, true)
    local.set(name, 30)
    const central = new Uint8Array(46 + name.length)
    const cv = new DataView(central.buffer)
    cv.setUint32(0, 0x02014b50, true)
    cv.setUint16(10, 8, true)
    cv.setUint32(20, deflated.length, true)
    cv.setUint32(24, content.length, true)
    cv.setUint16(28, name.length, true)
    cv.setUint32(42, 0, true)
    central.set(name, 46)
    const end = new Uint8Array(22)
    const ev = new DataView(end.buffer)
    ev.setUint32(0, 0x06054b50, true)
    ev.setUint16(10, 1, true)
    ev.setUint32(12, central.length, true)
    ev.setUint32(16, local.length + deflated.length, true)
    const buf = new Uint8Array([...local, ...deflated, ...central, ...end])
    const [e] = await unzip(buf)
    expect(new TextDecoder().decode(e!.data)).toBe("hello hello hello hello\n")
  })
})
