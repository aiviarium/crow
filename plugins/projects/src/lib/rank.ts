// Manual order: every issue has a `rank`, a string that sorts the issues of a project. A list or a board
// column sorts by (rank, id), so everyone who sees the same rows sees the same order, whatever order their
// changes arrived in. Moving an issue writes only that issue: a key strictly between its new neighbours'.
//
// Keys are strings of [0-9a-z], compared as plain strings (lower case only, so Postgres's collation and
// JavaScript agree). A key is an integer part and a fraction: the first letter says how many digits the
// integer has (a = 1, b = 2, …), the integer's digits are 1-9a-z (never 0), and the fraction is base-36
// digits that never end in 0. Adding at either end steps the integer (`ci12` -> `ci13`), so a list that
// grows one issue at a time keeps keys of four or five characters; a key between two others is their
// midpoint, which goes into the fraction. Two people dropping two issues into the same gap at the same
// moment would compute the same key; a short random tail makes them differ, so both land in the gap in a
// stable order and later drops still find room.
//
// This is the construction of "fractional indexing" (Evan Wallace; rocicorp's fractional-indexing), with
// an integer alphabet without 0 so that no key ends in 0.

export const DIGITS = "0123456789abcdefghijklmnopqrstuvwxyz"
const BASE = DIGITS.length

function digit(c: string | undefined): number {
  if (c === undefined) return 0
  const d = DIGITS.indexOf(c)
  if (d < 0) throw new Error(`bad rank digit ${JSON.stringify(c)}`)
  return d
}

/** A key is valid when it is made of base-36 digits and does not end in "0" (empty means "the start"). */
export function validRank(key: string): boolean {
  return /^[0-9a-z]*$/.test(key) && !key.endsWith("0")
}

/**
 * A key strictly between `a` and `b`, where `a < b`. `a` may be "" (before everything) and `b` null (after
 * everything).
 */
export function midpoint(a: string, b: string | null): string {
  if (b !== null && a >= b) throw new Error(`midpoint needs ${JSON.stringify(a)} < ${JSON.stringify(b)}`)
  if (b !== null) {
    // The common prefix (a padded with zeros) stays.
    let n = 0
    while ((a[n] ?? "0") === b[n]) n++
    if (n > 0) return b.slice(0, n) + midpoint(a.slice(n), b.slice(n))
  }
  const da = a ? digit(a[0]) : 0
  const db = b !== null ? digit(b[0]) : BASE
  if (db - da > 1) return DIGITS[Math.round((da + db) / 2)]!
  // The first digits are adjacent.
  if (b !== null && b.length > 1) return b.slice(0, 1)
  return DIGITS[da]! + midpoint(a.slice(1), null)
}

/** A random tail of `n` digits that does not end in "0". */
export function jitter(n = 3, random: () => number = Math.random): string {
  let s = ""
  for (let i = 0; i < n; i++) {
    const last = i === n - 1
    const d = last ? 1 + Math.floor(random() * (BASE - 1)) : Math.floor(random() * BASE)
    s += DIGITS[Math.min(d, BASE - 1)]
  }
  return s
}

/** Digits of the integer part: no 0, so a key never ends in 0. */
const INT = DIGITS.slice(1)
/** The first key: three integer digits (35^3 keys before the integer needs a fourth), from the middle. */
export const START = "ci11"

const isHead = (c: string | undefined) => !!c && c >= "a" && c <= "z"

/** The head and integer digits of a key, or null for a key without a well-formed integer part. */
function intPart(key: string): { head: string; int: string } | null {
  if (!isHead(key[0])) return null
  const len = key.charCodeAt(0) - 96
  const int = key.slice(1, 1 + len)
  if (int.length < len || int.includes("0")) return null
  return { head: key[0]!, int }
}

/** The next integer key after `key`'s integer, or null when the integer cannot grow. */
function nextInt(key: string): string | null {
  const p = intPart(key)
  if (!p) return null
  const d = [...p.int].map((c) => INT.indexOf(c))
  for (let i = d.length - 1; i >= 0; i--) {
    if (d[i]! < INT.length - 1) {
      d[i]!++
      return p.head + d.map((x) => INT[x]).join("")
    }
    d[i] = 0
  }
  // Every digit was the largest: one digit more.
  if (p.head === "z") return null
  return String.fromCharCode(p.head.charCodeAt(0) + 1) + INT[0]!.repeat(p.int.length + 1)
}

/** The integer key before `key`'s integer, or null when there is none. */
function prevInt(key: string): string | null {
  const p = intPart(key)
  if (!p) return null
  const d = [...p.int].map((c) => INT.indexOf(c))
  for (let i = d.length - 1; i >= 0; i--) {
    if (d[i]! > 0) {
      d[i]!--
      return p.head + d.map((x) => INT[x]).join("")
    }
    d[i] = INT.length - 1
  }
  if (p.head === "a" || p.int.length === 1) return null
  return String.fromCharCode(p.head.charCodeAt(0) - 1) + INT[INT.length - 1]!.repeat(p.int.length - 1)
}

/** The shortest key above `lo` made by stepping up one digit of a prefix of it ("iabc" -> "j"). */
function above(lo: string): string | null {
  const n = nextInt(lo)
  if (n) return n
  for (let i = 1; i <= lo.length; i++) {
    const d = digit(lo[i - 1])
    if (d < BASE - 1) return lo.slice(0, i - 1) + DIGITS[d + 1]
  }
  return null
}

/** The shortest key below `hi` made by stepping down one digit of a prefix of it ("iabc" -> "h"). */
function below(hi: string): string | null {
  const p = prevInt(hi)
  if (p) return p
  for (let i = 1; i <= hi.length; i++) {
    const d = digit(hi[i - 1])
    // A key may not end in 0.
    if (d > 1) return hi.slice(0, i - 1) + DIGITS[d - 1]
  }
  return null
}

/**
 * A key between `before` (the key above, or null at the start) and `after` (the key below, or null at the
 * end), with a random tail so that two concurrent drops into one gap differ. At either end it steps one
 * digit of a prefix, so a list that grows at the bottom (or the top) keeps short keys. Throws when
 * `before >= after`; callers that cannot rule that out use `rankFor`.
 */
export function between(
  before: string | null,
  after: string | null,
  random: () => number = Math.random,
): string {
  const lo = before ?? ""
  if (before === null && after === null) return START + jitter(2, random)
  if (after === null) {
    const k = above(lo)
    if (k) return k + jitter(2, random)
  }
  if (before === null && after) {
    const k = below(after)
    if (k && k < after) return k + jitter(2, random)
  }
  const mid = midpoint(lo, after)
  // mid + tail is above mid (so above lo). It stays below `after` unless mid is a prefix of `after`.
  const tailed = mid + jitter(3, random)
  if (after === null || tailed < after) return tailed
  // mid is a prefix of after: go between mid and after instead, which has room by construction.
  const inner = midpoint(mid, after)
  const tailed2 = inner + jitter(3, random)
  return tailed2 < after && tailed2 > lo ? tailed2 : inner
}

/** Keys for `n` items in a row after `before` (for appending many at once, as an import does). */
export function sequence(n: number, before: string | null = null, after: string | null = null): string[] {
  const out: string[] = []
  let lo = before
  for (let i = 0; i < n; i++) {
    // Without an upper bound the integer steps; between two keys they share the gap.
    const k = after === null ? (lo === null ? START : (above(lo) ?? spread(lo))) : midpoint(lo ?? "", after)
    out.push(k)
    lo = k
  }
  return out
}

/** The next key after `lo` with a short step, so long runs stay short. */
function spread(lo: string | null): string {
  const key = lo ?? ""
  // Step the last-but-tail digit by one where there is room: "a1" -> "a2" -> … -> "az" -> "az1".
  if (key.length === 0) return "1"
  const last = digit(key[key.length - 1])
  if (last < BASE - 1) return key.slice(0, -1) + DIGITS[last + 1]
  return `${key}1`
}

export interface Ranked {
  id: string
  rank: string | null | undefined
}

/** Sorts by rank, then id: the order everyone sees. Issues without a rank go last. */
export function compareRank(a: Ranked, b: Ranked): number {
  const ra = a.rank || "￿"
  const rb = b.rank || "￿"
  if (ra !== rb) return ra < rb ? -1 : 1
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0
}

/**
 * Where a moved item goes, from the keys of its new neighbours as the server sees them now. `above` and
 * `below` are the items that should end up directly above and below it; `ceiling` is the first item after
 * `above` whose key is greater than `above`'s (what bounds the gap when `below` cannot).
 *
 * - The usual case, `above < below`: a key between them.
 * - `above == below` (two drops collided and their random tails were equal): the item goes right after
 *   `above`, and `below` gets a new key after it, so the drop stays where the person made it.
 * - `above > below` (someone moved one of them meanwhile): the item goes right after `above`.
 */
export function rankFor(
  above: Ranked | null,
  below: Ranked | null,
  ceiling: Ranked | null = null,
  random: () => number = Math.random,
): { rank: string; below?: string } {
  const lo = above?.rank || null
  const hi = below?.rank || null
  if (lo === null || hi === null || lo < hi) return { rank: between(lo, hi, random) }
  const top = ceiling?.rank && ceiling.rank > lo ? ceiling.rank : null
  const mine = between(lo, top, random)
  if (lo === hi) return { rank: mine, below: between(mine, top, random) }
  return { rank: mine }
}
