// Search output from real ripgrep and git grep, columns in UTF-16, and replacing with the same matcher.
import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  byteToCol,
  type FileMatches,
  GitGrepParser,
  gitGrepCommand,
  matcher,
  RgParser,
  replaceIn,
  rgCommand,
  type SearchQuery,
} from "../src/git/search"

let repo = ""
const hasRg = Bun.which("rg") !== null

beforeAll(() => {
  repo = mkdtempSync(join(tmpdir(), "wb-search-"))
  const w = (p: string, t: string) => {
    mkdirSync(join(repo, p, ".."), { recursive: true })
    writeFileSync(join(repo, p), t)
  }
  w("src/a.ts", "const fooBar = 1\n// übér foo here, foo again\n")
  w("src/b.md", "Foo in markdown\n")
  w("dist/out.js", "foo built\n")
  w(".gitignore", "dist/\n")
  Bun.spawnSync(["git", "init", "-q"], { cwd: repo })
})

afterAll(() => rmSync(repo, { recursive: true, force: true }))

function run(cmd: string[]): string {
  return Bun.spawnSync(cmd, { cwd: repo }).stdout.toString()
}

function byPath(files: FileMatches[]) {
  return Object.fromEntries(files.map((f) => [f.path, f]))
}

describe("ripgrep", () => {
  test.skipIf(!hasRg)("streams files with UTF-16 columns, ignoring .gitignore'd files", () => {
    const q: SearchQuery = { query: "foo" }
    const p = new RgParser()
    const out = run(rgCommand(q))
    // Feed in odd pieces, as a stream would.
    const files: FileMatches[] = []
    for (let i = 0; i < out.length; i += 7) files.push(...p.push(out.slice(i, i + 7)))
    const by = byPath(files)
    expect(Object.keys(by).sort()).toEqual(["src/a.ts", "src/b.md"])
    expect(by["src/a.ts"]!.matches).toEqual([
      { line: 1, col: 6, length: 3 },
      { line: 2, col: 8, length: 3 },
      { line: 2, col: 18, length: 3 },
    ])
    expect(by["src/a.ts"]!.lines[2]).toBe("// übér foo here, foo again")
  })

  test.skipIf(!hasRg)("case, words, regex and globs", () => {
    const get = (q: SearchQuery) => {
      const p = new RgParser()
      return byPath(p.push(run(rgCommand(q))))
    }
    expect(Object.keys(get({ query: "foo", caseSensitive: true }))).not.toContain("src/b.md")
    expect(get({ query: "foo", wholeWord: true })["src/a.ts"]!.matches).toHaveLength(2)
    expect(get({ query: "fo+B", regex: true, caseSensitive: true })["src/a.ts"]!.matches).toHaveLength(1)
    expect(Object.keys(get({ query: "foo", include: ["*.md"] }))).toEqual(["src/b.md"])
    expect(Object.keys(get({ query: "foo", exclude: ["*.md"] }))).toEqual(["src/a.ts"])
  })
})

describe("git grep", () => {
  test("columns from git and the rest from the same pattern, globs as pathspecs", () => {
    const q: SearchQuery = { query: "foo" }
    const p = new GitGrepParser(matcher(q))
    const files = [...p.push(run(gitGrepCommand(q))), ...p.end()]
    const by = byPath(files)
    expect(Object.keys(by).sort()).toEqual(["src/a.ts", "src/b.md"])
    expect(by["src/a.ts"]!.matches).toEqual([
      { line: 1, col: 6, length: 3 },
      { line: 2, col: 8, length: 3 },
      { line: 2, col: 18, length: 3 },
    ])
    const md = new GitGrepParser(matcher({ query: "foo" }))
    const only = [...md.push(run(gitGrepCommand({ query: "foo", include: ["*.md"] }))), ...md.end()]
    expect(only.map((f) => f.path)).toEqual(["src/b.md"])
  })
})

describe("replace", () => {
  test("all matches, selected matches, and regex groups", () => {
    const text = "const fooBar = 1\n// foo here, foo again\n"
    expect(replaceIn(text, { query: "foo" }, "qux")).toEqual({
      text: "const quxBar = 1\n// qux here, qux again\n",
      count: 3,
    })
    expect(replaceIn(text, { query: "foo", wholeWord: true }, "qux").count).toBe(2)
    const one = replaceIn(text, { query: "foo" }, "qux", [{ line: 2, col: 13, length: 3 }])
    expect(one.text).toBe("const fooBar = 1\n// foo here, qux again\n")
    expect(replaceIn("a1 b22", { query: "([a-z])(\\d+)", regex: true }, "$2$1").text).toBe("1a 22b")
    expect(replaceIn("Foo foo", { query: "foo", caseSensitive: true }, "x").text).toBe("Foo x")
  })

  test("byte offsets to UTF-16 columns", () => {
    expect(byteToCol("übér x", 7)).toBe(5)
    expect(byteToCol("😀a", 4)).toBe(2)
  })
})
