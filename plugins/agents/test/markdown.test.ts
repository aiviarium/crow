// The chat's Markdown on what agents write: identifiers with underscores, paths, nested lists with code,
// tables, long lines in code blocks, and text that is still streaming.
import { describe, expect, test } from "bun:test"
import { parseBlocks, parseInline } from "../src/markdown-parse"

const text = (s: string) => parseInline(s)

describe("inline", () => {
  test("an underscore inside a word is not emphasis", () => {
    expect(text("Set CROW_PUBLIC_URL to the server's address.")).toEqual([
      { t: "text", v: "Set CROW_PUBLIC_URL to the server's address." },
    ])
    expect(text("snake_case_name, a_b and my_var_")).toEqual([
      { t: "text", v: "snake_case_name, a_b and my_var_" },
    ])
  })

  test("paths and globs stay as written", () => {
    expect(text("Edit /srv/agent/foo_bar/baz_qux.ts now")).toEqual([
      { t: "text", v: "Edit /srv/agent/foo_bar/baz_qux.ts now" },
    ])
    expect(text("Run it on src/**/*.ts files")).toEqual([{ t: "text", v: "Run it on src/**/*.ts files" }])
    expect(text("2 * 3 * 4 is 24")).toEqual([{ t: "text", v: "2 * 3 * 4 is 24" }])
  })

  test("emphasis and strong by CommonMark's rules", () => {
    expect(text("*one* **two** _three_ __four__")).toEqual([
      { t: "i", v: [{ t: "text", v: "one" }] },
      { t: "text", v: " " },
      { t: "b", v: [{ t: "text", v: "two" }] },
      { t: "text", v: " " },
      { t: "i", v: [{ t: "text", v: "three" }] },
      { t: "text", v: " " },
      { t: "b", v: [{ t: "text", v: "four" }] },
    ])
    expect(text("***both***")).toEqual([{ t: "i", v: [{ t: "b", v: [{ t: "text", v: "both" }] }] }])
    expect(text("**bold with *italic* inside**")).toEqual([
      {
        t: "b",
        v: [
          { t: "text", v: "bold with " },
          { t: "i", v: [{ t: "text", v: "italic" }] },
          { t: "text", v: " inside" },
        ],
      },
    ])
    expect(text("un*frigging*believable")).toEqual([
      { t: "text", v: "un" },
      { t: "i", v: [{ t: "text", v: "frigging" }] },
      { t: "text", v: "believable" },
    ])
    expect(text("**unclosed")).toEqual([{ t: "text", v: "**unclosed" }])
  })

  test("code spans keep what is in them, and escapes are literal", () => {
    expect(text("Use `CROW_*_URL` and `a__b__c`")).toEqual([
      { t: "text", v: "Use " },
      { t: "code", v: "CROW_*_URL" },
      { t: "text", v: " and " },
      { t: "code", v: "a__b__c" },
    ])
    expect(text("\\*not italic\\*")).toEqual([{ t: "text", v: "*not italic*" }])
  })

  test("links and mentions", () => {
    expect(text("See [the docs](https://example.com/a_b) and @[Plan](note://01)")).toEqual([
      { t: "text", v: "See " },
      { t: "a", href: "https://example.com/a_b", v: [{ t: "text", v: "the docs" }] },
      { t: "text", v: " and " },
      { t: "mention", uri: "note://01", v: "Plan" },
    ])
  })
})

describe("blocks", () => {
  test("nested lists with code and paragraphs in items", () => {
    const b = parseBlocks(
      [
        "1. Install it:",
        "   ```sh",
        "   bun install",
        "   ```",
        "2. Then:",
        "   - run `bun test`",
        "   - read the output",
        "3. Done",
      ].join("\n"),
    )
    expect(b).toHaveLength(1)
    const list = b[0] as Extract<(typeof b)[0], { t: "list" }>
    expect(list.ordered).toBe(true)
    expect(list.items).toHaveLength(3)
    expect(list.items[0]).toEqual([
      { t: "p", text: "Install it:" },
      { t: "code", lang: "sh", code: "bun install" },
    ])
    expect(list.items[1]![1]).toMatchObject({
      t: "list",
      ordered: false,
      items: [[{ t: "p" }], [{ t: "p" }]],
    })
    expect(list.items[2]).toEqual([{ t: "p", text: "Done" }])
  })

  test("a list item's lazy continuation and a list that starts elsewhere", () => {
    const b = parseBlocks("- one\ncontinued\n- two\n\n7. seven\n8. eight")
    expect(b[0]).toMatchObject({
      t: "list",
      items: [[{ t: "p", text: "one\ncontinued" }], [{ t: "p", text: "two" }]],
    })
    expect(b[1]).toMatchObject({ t: "list", ordered: true, start: 7 })
  })

  test("tables with alignment", () => {
    const b = parseBlocks("| Name | Count | Note |\n|:-----|------:|:----:|\n| a_b | 2 | `x|y` |\n| c | 3 |")
    expect(b).toEqual([
      {
        t: "table",
        align: ["left", "right", "center"],
        head: ["Name", "Count", "Note"],
        rows: [
          ["a_b", "2", "`x|y`"],
          ["c", "3", ""],
        ],
      },
    ])
  })

  test("long lines in code blocks are kept whole", () => {
    const long = `const x = "${"a".repeat(400)}"`
    expect(parseBlocks(`\`\`\`ts\n${long}\n\`\`\``)).toEqual([{ t: "code", lang: "ts", code: long }])
  })

  test("text still streaming: an unclosed fence is code so far", () => {
    expect(parseBlocks("Here:\n```py\nprint(1)")).toEqual([
      { t: "p", text: "Here:" },
      { t: "code", lang: "py", code: "print(1)" },
    ])
  })

  test("headings, quotes and rules", () => {
    expect(parseBlocks("## Plan\n> quoted\n> more\n\n---")).toEqual([
      { t: "h", level: 2, text: "Plan" },
      { t: "quote", blocks: [{ t: "p", text: "quoted\nmore" }] },
      { t: "hr" },
    ])
  })
})
