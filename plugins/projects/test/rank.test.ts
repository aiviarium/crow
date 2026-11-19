import { expect, test } from "bun:test"
import { between, compareRank, midpoint, type Ranked, rankFor, sequence, validRank } from "../src/lib/rank"

// A seeded generator, so a failing run can be repeated.
function rng(seed: number) {
  let s = seed >>> 0
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0
    return s / 2 ** 32
  }
}

test("midpoint lies strictly between and never ends in zero", () => {
  const cases: Array<[string, string | null]> = [
    ["", null],
    ["", "1"],
    ["1", "2"],
    ["1", "11"],
    ["a", "b"],
    ["az", "b"],
    ["zz", null],
    ["0001", "0002"],
    ["5", "51"],
  ]
  for (const [a, b] of cases) {
    const m = midpoint(a, b)
    expect(m > a).toBe(true)
    if (b !== null) expect(m < b).toBe(true)
    expect(validRank(m)).toBe(true)
  }
  expect(() => midpoint("b", "a")).toThrow()
})

test("between adds a random tail and stays inside the gap", () => {
  const r = rng(7)
  for (let i = 0; i < 2000; i++) {
    const a = between(null, null, r)
    const b = between(a, null, r)
    const c = between(a, b, r)
    expect(a < c && c < b).toBe(true)
    expect(validRank(c)).toBe(true)
  }
})

test("repeated inserts into the same gap keep finding room", () => {
  let lo = between(null, null)
  const hi = between(lo, null)
  for (let i = 0; i < 500; i++) {
    const k = between(lo, hi)
    expect(k > lo && k < hi).toBe(true)
    lo = k
  }
  // Keys grow slowly: about one digit per halving.
  expect(lo.length).toBeLessThan(600)
})

test("a list growing at either end keeps short keys", () => {
  const r = rng(11)
  let last: string | null = null
  for (let i = 0; i < 2000; i++) {
    const k = between(last, null, r)
    if (last !== null) expect(k > last).toBe(true)
    expect(validRank(k)).toBe(true)
    last = k
  }
  expect(last!.length).toBeLessThan(80)
  let first: string | null = "m"
  for (let i = 0; i < 500; i++) {
    const k = between(null, first, r)
    expect(k < first!).toBe(true)
    expect(validRank(k)).toBe(true)
    first = k
  }
  expect(first!.length).toBeLessThan(40)
})

test("sequence makes ascending keys for imports", () => {
  const keys = sequence(1000)
  for (let i = 1; i < keys.length; i++) expect(keys[i]! > keys[i - 1]!).toBe(true)
  expect(keys.every(validRank)).toBe(true)
  expect(Math.max(...keys.map((k) => k.length))).toBeLessThan(60)
  const inside = sequence(50, "a", "b")
  expect(inside.every((k) => k > "a" && k < "b")).toBe(true)
})

/** The server's side of a move: it reads the neighbours as they are now, as host.ts does. */
function serverMove(
  rows: Map<string, string>,
  id: string,
  aboveId: string | null,
  belowId: string | null,
  random: () => number,
) {
  const ordered = [...rows.entries()]
    .map(([i, rank]) => ({ id: i, rank }))
    .sort(compareRank)
    .filter((r) => r.id !== id)
  const above = aboveId ? (ordered.find((r) => r.id === aboveId) ?? null) : null
  const below = belowId ? (ordered.find((r) => r.id === belowId) ?? null) : null
  const ceiling = above ? (ordered.find((x) => x.rank > above.rank) ?? null) : null
  const r = rankFor(above, below, ceiling, random)
  rows.set(id, r.rank)
  if (r.below && belowId) rows.set(belowId, r.below)
}

const order = (rows: Map<string, string>) =>
  [...rows.entries()]
    .map(([id, rank]) => ({ id, rank }))
    .sort(compareRank)
    .map((r) => r.id)

test("two people dragging in one column converge on one order, with each drop where it was made", () => {
  for (let seed = 1; seed <= 40; seed++) {
    const r = rng(seed)
    const ids = Array.from({ length: 12 }, (_, i) => `i${String(i).padStart(2, "0")}`)
    const keys = sequence(ids.length)
    const server = new Map(ids.map((id, i) => [id, keys[i]!]))
    // Each person works from the order they last saw, which lags the server.
    for (let round = 0; round < 60; round++) {
      const seenA = order(server)
      const seenB = order(server)
      const pick = (seen: string[]) => {
        const id = seen[Math.floor(r() * seen.length)]!
        const rest = seen.filter((x) => x !== id)
        const at = Math.floor(r() * (rest.length + 1))
        return { id, above: rest[at - 1] ?? null, below: rest[at] ?? null }
      }
      const a = pick(seenA)
      const b = pick(seenB)
      // The two writes arrive in either order.
      const first = r() < 0.5 ? [a, b] : [b, a]
      for (const m of first) serverMove(server, m.id, m.above, m.below, r)
      const last = first[1]!
      const now = order(server)
      // The later drop lands between the neighbours its person saw (the other drop may share the gap), and
      // right next to them when the other drop went elsewhere.
      const i = now.indexOf(last.id)
      const other = first[0]!.id
      const sharesGap = (() => {
        const j = now.indexOf(other)
        const lo = last.above ? now.indexOf(last.above) : -1
        const hi = last.below ? now.indexOf(last.below) : now.length
        return j > lo && j < hi
      })()
      // When the other drop moved one of these neighbours, the item follows the one above (see rankFor).
      const moved = last.above === other || last.below === other || last.id === other
      if (last.above && !moved) {
        expect(now.indexOf(last.above)).toBeLessThan(i)
        if (!sharesGap) expect(now[i - 1]).toBe(last.above)
      }
      if (last.below && !moved) {
        expect(now.indexOf(last.below)).toBeGreaterThan(i)
        if (!sharesGap) expect(now[i + 1]).toBe(last.below)
      }
      // Every key stays valid and every viewer computes the same order from the same rows.
      expect([...server.values()].every(validRank)).toBe(true)
      const shuffled = new Map([...server.entries()].sort(() => r() - 0.5))
      expect(order(shuffled)).toEqual(now)
    }
  }
})

test("two drops into one gap computed by stale clients both land in the gap", () => {
  const p: Ranked = { id: "p", rank: "a" }
  const q: Ranked = { id: "q", rank: "b" }
  const x = between(p.rank!, q.rank!, rng(1))
  const y = between(p.rank!, q.rank!, rng(2))
  expect(x).not.toBe(y)
  for (const k of [x, y]) expect(k > "a" && k < "b").toBe(true)
})

test("equal neighbour keys are repaired by moving the lower neighbour", () => {
  const above: Ranked = { id: "a", rank: "m" }
  const below: Ranked = { id: "b", rank: "m" }
  const next: Ranked = { id: "c", rank: "n" }
  const r = rankFor(above, below, next, rng(3))
  // Out of order (one of them moved meanwhile): right after the one above, the other left alone.
  const inverted = rankFor({ id: "a", rank: "p" }, { id: "b", rank: "m" }, { id: "c", rank: "q" }, rng(4))
  expect(inverted.below).toBeUndefined()
  expect(inverted.rank > "p" && inverted.rank < "q").toBe(true)
  expect(r.below).toBeDefined()
  expect(r.rank > "m").toBe(true)
  expect(r.below! > r.rank).toBe(true)
  expect(r.below! < "n").toBe(true)
})

test("compareRank puts unranked rows last and breaks ties by id", () => {
  const rows: Ranked[] = [
    { id: "b", rank: "5" },
    { id: "a", rank: "5" },
    { id: "z", rank: null },
    { id: "c", rank: "1" },
  ]
  expect(rows.sort(compareRank).map((r) => r.id)).toEqual(["c", "a", "b", "z"])
})
