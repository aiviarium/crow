// Fuzzy matching of file paths for "open file by name": the query's characters in order, preferring the
// file name over the folders, consecutive runs, and starts of words. Fast enough for tens of thousands of
// paths per keystroke.

export interface FuzzyHit {
  path: string
  score: number
  /** Indexes into `path` of the matched characters, for highlighting. */
  positions: number[]
}

const SEP = new Set(["/", "-", "_", ".", " "])

/** Scores one path; null if the query's characters do not all occur in order. */
export function score(path: string, query: string): FuzzyHit | null {
  if (!query) return { path, score: 0, positions: [] }
  const q = query.toLowerCase().replace(/\s+/g, "")
  const p = path.toLowerCase()
  const nameStart = path.lastIndexOf("/") + 1
  // Quick reject: every query character in order.
  let at = 0
  for (const ch of q) {
    at = p.indexOf(ch, at)
    if (at < 0) return null
    at++
  }
  // Candidate alignments: the query as a run inside the file name, in order inside the file name, in
  // order across the path preferring starts of words. The best scoring one counts.
  const candidates: number[][] = []
  const name0 = p.slice(nameStart)
  const run = name0.indexOf(q)
  if (run >= 0) candidates.push(Array.from({ length: q.length }, (_, k) => nameStart + run + k))
  const inName = align(p, q, nameStart, false)
  if (inName) candidates.push(inName)
  const words = align(p, q, 0, true, path)
  if (words) candidates.push(words)
  const plain = align(p, q, 0, false)
  if (plain) candidates.push(plain)
  let best = -Infinity
  let positions: number[] = []
  for (const c of candidates) {
    let s = 0
    let last = -1
    for (const i of c) {
      s += 1
      if (i >= nameStart) s += 2
      if (i === 0 || SEP.has(path[i - 1]!)) s += 3
      else if (path[i] !== p[i] && path[i - 1] === p[i - 1]) s += 2 // camelCase hump
      if (last >= 0 && i === last + 1) s += 4
      last = i
    }
    if (s > best) {
      best = s
      positions = c
    }
  }
  if (!positions.length) return null
  let s = best
  // The whole file name typed, or its start.
  const name = p.slice(nameStart)
  if (name.startsWith(q)) s += 10
  if (name === q || name.replace(/\.[^.]+$/, "") === q) s += 10
  // Shorter paths win ties.
  s -= path.length / 200
  return { path, score: s, positions }
}

/**
 * The query's characters in order in `p` from `from`. With `words`, a character that also occurs at the
 * start of a word further on (before the next query character is needed) is taken there.
 */
function align(p: string, q: string, from: number, words: boolean, original?: string): number[] | null {
  const out: number[] = []
  let at = from
  for (const ch of q) {
    let i = p.indexOf(ch, at)
    if (i < 0) return null
    if (words && original) {
      let j = i
      while (
        j >= 0 &&
        !(j === 0 || SEP.has(original[j - 1]!) || (original[j] !== p[j] && original[j - 1] === p[j - 1]))
      ) {
        j = p.indexOf(ch, j + 1)
      }
      if (j >= 0) i = j
    }
    out.push(i)
    at = i + 1
  }
  return out
}

/** The best `limit` matches, best first. */
export function fuzzyFilter(paths: readonly string[], query: string, limit = 200): FuzzyHit[] {
  if (!query.trim()) return paths.slice(0, limit).map((path) => ({ path, score: 0, positions: [] }))
  const hits: FuzzyHit[] = []
  for (const path of paths) {
    const h = score(path, query)
    if (h) hits.push(h)
  }
  hits.sort((a, b) => b.score - a.score || a.path.length - b.path.length)
  return hits.slice(0, limit)
}
