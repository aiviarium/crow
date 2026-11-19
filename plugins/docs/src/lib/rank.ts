// Order among siblings: fractional keys that sort as plain strings (by code point), so moving a page between
// two others writes one row. A key is an integer part, whose first character says how long it is ("a0"
// is the first, "a1" the next, then "b10" ...), and a fraction that never ends in "0". Appending increments
// the integer part, so keys stay short for long lists; inserting between two neighbours extends the
// fraction. This is the scheme of David Greenspan's "Implementing Fractional Indexing".
//
// Compare keys with `<` (code points), never with `localeCompare`: collation would mix upper and lower case.

const DIGITS = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz"
const SMALLEST_INTEGER = `A${"0".repeat(26)}`

function integerLength(head: string): number {
  if (head >= "a" && head <= "z") return head.charCodeAt(0) - 97 + 2
  if (head >= "A" && head <= "Z") return 90 - head.charCodeAt(0) + 2
  throw new Error(`invalid order key head: ${head}`)
}

function integerPart(key: string): string {
  const n = integerLength(key[0]!)
  if (n > key.length) throw new Error(`invalid order key: ${key}`)
  return key.slice(0, n)
}

/** True when `key` is a key this module could have made. */
export function isRank(key: unknown): key is string {
  if (typeof key !== "string" || !key || key === SMALLEST_INTEGER) return false
  try {
    const i = integerPart(key)
    const f = key.slice(i.length)
    return ![...key].some((c) => !DIGITS.includes(c)) && !f.endsWith("0")
  } catch {
    return false
  }
}

function check(key: string) {
  if (!isRank(key)) throw new Error(`invalid order key: ${key}`)
}

/** A fraction between `a` and `b` (`b` null: anything above), both without trailing zeros. */
function midpoint(a: string, b: string | null): string {
  if (b !== null && a >= b) throw new Error(`${a} >= ${b}`)
  if (b) {
    let n = 0
    while ((a[n] ?? "0") === b[n]) n++
    if (n > 0) return b.slice(0, n) + midpoint(a.slice(n), b.slice(n))
  }
  const da = a ? DIGITS.indexOf(a[0]!) : 0
  const db = b !== null ? DIGITS.indexOf(b[0]!) : DIGITS.length
  if (db - da > 1) return DIGITS[Math.round((da + db) / 2)]!
  if (b && b.length > 1) return b.slice(0, 1)
  return DIGITS[da]! + midpoint(a.slice(1), null)
}

function increment(x: string): string | null {
  const [head, ...digs] = x.split("") as [string, ...string[]]
  let carry = true
  for (let i = digs.length - 1; carry && i >= 0; i--) {
    const d = DIGITS.indexOf(digs[i]!) + 1
    if (d === DIGITS.length) digs[i] = "0"
    else {
      digs[i] = DIGITS[d]!
      carry = false
    }
  }
  if (!carry) return head + digs.join("")
  if (head === "Z") return "a0"
  if (head === "z") return null
  const h = String.fromCharCode(head.charCodeAt(0) + 1)
  if (h > "a") digs.push("0")
  else digs.pop()
  return h + digs.join("")
}

function decrement(x: string): string | null {
  const [head, ...digs] = x.split("") as [string, ...string[]]
  let borrow = true
  for (let i = digs.length - 1; borrow && i >= 0; i--) {
    const d = DIGITS.indexOf(digs[i]!) - 1
    if (d === -1) digs[i] = DIGITS[DIGITS.length - 1]!
    else {
      digs[i] = DIGITS[d]!
      borrow = false
    }
  }
  if (!borrow) return head + digs.join("")
  if (head === "a") return `Z${DIGITS[DIGITS.length - 1]}`
  if (head === "A") return null
  const h = String.fromCharCode(head.charCodeAt(0) - 1)
  if (h < "Z") digs.push(DIGITS[DIGITS.length - 1]!)
  else digs.pop()
  return h + digs.join("")
}

/** A key that sorts after `a` and before `b`; either may be null for "the start" or "the end". */
export function between(a: string | null | undefined, b: string | null | undefined): string {
  const lo = a ?? null
  const hi = b ?? null
  if (lo !== null) check(lo)
  if (hi !== null) check(hi)
  if (lo !== null && hi !== null && lo >= hi) throw new Error(`${lo} is not before ${hi}`)
  if (lo === null) {
    if (hi === null) return "a0"
    const ib = integerPart(hi)
    const fb = hi.slice(ib.length)
    if (ib === SMALLEST_INTEGER) return ib + midpoint("", fb)
    if (ib < hi) return ib
    const r = decrement(ib)
    if (r === null) throw new Error("no key before the first one")
    return r
  }
  if (hi === null) {
    const ia = integerPart(lo)
    const fa = lo.slice(ia.length)
    const i = increment(ia)
    return i === null ? ia + midpoint(fa, null) : i
  }
  const ia = integerPart(lo)
  const fa = lo.slice(ia.length)
  const ib = integerPart(hi)
  const fb = hi.slice(ib.length)
  if (ia === ib) return ia + midpoint(fa, fb)
  const i = increment(ia)
  if (i === null) throw new Error("no key after the last one")
  if (i < hi) return i
  return ia + midpoint(fa, null)
}

/** `n` keys in order between `a` and `b`. */
export function keysBetween(a: string | null | undefined, b: string | null | undefined, n: number): string[] {
  const out: string[] = []
  let prev = a ?? null
  if (b == null) {
    for (let i = 0; i < n; i++) {
      prev = between(prev, null)
      out.push(prev)
    }
    return out
  }
  // Split in halves so a long run between two close keys stays short.
  if (n === 0) return out
  if (n === 1) return [between(a, b)]
  const mid = between(a, b)
  const left = keysBetween(a, mid, Math.floor((n - 1) / 2))
  const right = keysBetween(mid, b, n - 1 - left.length)
  return [...left, mid, ...right]
}

/** Sorts by rank (code points), then by id so equal or missing ranks still have a stable order. */
export function byRank<T extends { rank?: unknown; id: string }>(a: T, b: T): number {
  const ra = typeof a.rank === "string" ? a.rank : ""
  const rb = typeof b.rank === "string" ? b.rank : ""
  if (ra !== rb) return ra < rb ? -1 : 1
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0
}
