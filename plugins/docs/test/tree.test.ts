import { describe, expect, test } from "bun:test"
import { between, byRank, isRank, keysBetween } from "../src/lib/rank"
import {
  buildTree,
  descendants,
  dropTarget,
  type PageRow,
  rankAt,
  uriOf,
  visibleRows,
  wouldCycle,
  zoneAt,
} from "../src/lib/tree"

describe("ranks", () => {
  test("keys sort between their neighbours as plain strings", () => {
    expect(between(null, null)).toBe("a0")
    const a = between(null, null)
    const b = between(a, null)
    const mid = between(a, b)
    expect(a < mid && mid < b).toBe(true)
    const first = between(null, a)
    expect(first < a).toBe(true)
    expect(() => between(b, a)).toThrow()
  })

  test("random inserts keep every key valid, unique, ordered and short", () => {
    let seed = 7
    const rnd = () => {
      seed = (seed * 1103515245 + 12345) % 2 ** 31
      return seed / 2 ** 31
    }
    const keys: string[] = []
    for (let i = 0; i < 3000; i++) {
      const at = Math.floor(rnd() * (keys.length + 1))
      const k = between(keys[at - 1] ?? null, keys[at] ?? null)
      keys.splice(at, 0, k)
    }
    expect(new Set(keys).size).toBe(keys.length)
    expect([...keys].sort()).toEqual(keys)
    expect(keys.every(isRank)).toBe(true)
    expect(Math.max(...keys.map((k) => k.length))).toBeLessThan(40)
  })

  test("appending 2,000 pages keeps keys at a few characters", () => {
    let last: string | null = null
    for (let i = 0; i < 2000; i++) last = between(last, null)
    expect(last!.length).toBeLessThanOrEqual(4)
    const run = keysBetween("a0", "a1", 500)
    expect(run.length).toBe(500)
    expect([...run].sort()).toEqual(run)
    expect(run[0]! > "a0" && run.at(-1)! < "a1").toBe(true)
    expect(Math.max(...run.map((k) => k.length))).toBeLessThan(14)
  })

  test("byRank orders by code points, then by id", () => {
    const rows = [
      { id: "2", rank: "a1" },
      { id: "1", rank: "a1" },
      { id: "3", rank: "Zz" },
      { id: "4", rank: "a0V" },
    ]
    expect(rows.sort(byRank).map((r) => r.id)).toEqual(["3", "4", "1", "2"])
  })
})

const page = (id: string, parent: string | null, rank: string): PageRow => ({
  id,
  title: id,
  parent: parent ? uriOf(parent) : null,
  rank,
})

describe("tree", () => {
  const rows = [
    page("eng", null, "a0"),
    page("design", null, "a1"),
    page("runbooks", "eng", "a0"),
    page("arch", "eng", "a1"),
    page("host", "runbooks", "a0"),
    page("incident", "runbooks", "a1"),
  ]
  const parentOf = (id: string) => {
    const r = rows.find((x) => x.id === id)
    return r?.parent ? r.parent.slice(6) : null
  }

  test("builds a forest in rank order and shows only what is expanded", () => {
    const forest = buildTree(rows)
    expect(forest.map((n) => n.page.id)).toEqual(["eng", "design"])
    expect(forest[0]!.children.map((n) => n.page.id)).toEqual(["runbooks", "arch"])
    const open = new Set(["eng"])
    expect(visibleRows(forest, (id) => open.has(id)).map((n) => [n.page.id, n.depth])).toEqual([
      ["eng", 0],
      ["runbooks", 1],
      ["arch", 1],
      ["design", 0],
    ])
    open.add("runbooks")
    expect(visibleRows(forest, (id) => open.has(id)).length).toBe(6)
  })

  test("a page whose parent is missing (not visible, or trashed) becomes a root", () => {
    const forest = buildTree([page("lost", "gone", "a0"), page("top", null, "a1")])
    expect(forest.map((n) => n.page.id)).toEqual(["lost", "top"])
  })

  test("moves that would put a page inside itself are refused", () => {
    expect(wouldCycle("eng", "host", parentOf)).toBe(true)
    expect(wouldCycle("eng", "eng", parentOf)).toBe(true)
    expect(wouldCycle("host", "design", parentOf)).toBe(false)
    expect(wouldCycle("host", null, parentOf)).toBe(false)
  })

  test("descendants come parents first", () => {
    expect(descendants(rows, "eng").map((r) => r.id)).toEqual(["runbooks", "arch", "host", "incident"])
    expect(descendants(rows, "host")).toEqual([])
  })

  test("drops before, after and inside a row become a parent and an index", () => {
    expect(zoneAt(2, 28)).toBe("before")
    expect(zoneAt(14, 28)).toBe("inside")
    expect(zoneAt(26, 28)).toBe("after")
    const sibs = (p: string | null) =>
      rows.filter((r) => (r.parent ? r.parent.slice(6) : null) === p).sort(byRank)
    const arch = rows.find((r) => r.id === "arch")!
    expect(dropTarget("host", arch, "before", sibs)).toEqual({ parent: "eng", index: 1 })
    expect(dropTarget("host", arch, "after", sibs)).toEqual({ parent: "eng", index: 2 })
    expect(dropTarget("host", arch, "inside", sibs)).toEqual({ parent: "arch", index: 0 })
    // Moving a page down among its own siblings does not count itself.
    const runbooks = rows.find((r) => r.id === "runbooks")!
    expect(dropTarget("runbooks", arch, "after", sibs)).toEqual({ parent: "eng", index: 1 })
    expect(dropTarget("arch", runbooks, "before", sibs)).toEqual({ parent: "eng", index: 0 })
  })

  test("rankAt places between neighbours and copes with rows without ranks", () => {
    const sibs = [{ rank: "a0" }, { rank: "a1" }, { rank: "a2" }]
    const r = rankAt(sibs, 1)
    expect(r > "a0" && r < "a1").toBe(true)
    expect(rankAt(sibs, 0) < "a0").toBe(true)
    expect(rankAt(sibs, 3) > "a2").toBe(true)
    expect(rankAt([], 0)).toBe("a0")
    expect(rankAt([{ rank: "a1" }, { rank: "a1" }], 1) > "a1").toBe(true)
    expect(rankAt([{ rank: null }], 1)).toBe("a0")
  })
})
