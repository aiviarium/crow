// `git status --porcelain=v2 -z --branch --show-stash`: the working tree's state, parsed from git's
// machine-readable output (never from the human one). Records end with NUL; a rename's original path is
// the record after it.

export type EntryKind = "changed" | "renamed" | "unmerged" | "untracked" | "ignored"

export interface StatusEntry {
  path: string
  /** The path before a rename or copy. */
  orig?: string
  /** Index state (`.` unchanged, `M`, `A`, `D`, `R`, `C`, `T`, `U`). */
  x: string
  /** Working tree state, same letters. */
  y: string
  kind: EntryKind
  /** A submodule (`S...` in the sub field). */
  submodule?: boolean
}

export interface BranchInfo {
  /** The commit HEAD points at; null before the first commit. */
  oid: string | null
  /** The branch name; null when HEAD is detached. */
  head: string | null
  upstream?: string
  ahead: number
  behind: number
}

export interface Status {
  branch: BranchInfo
  entries: StatusEntry[]
  /** Number of stash entries. */
  stash: number
}

export function parseStatus(out: string): Status {
  const branch: BranchInfo = { oid: null, head: null, ahead: 0, behind: 0 }
  const entries: StatusEntry[] = []
  let stash = 0
  const records = out.split("\0")
  for (let i = 0; i < records.length; i++) {
    const r = records[i]!
    if (!r) continue
    if (r.startsWith("# ")) {
      const [key, ...rest] = r.slice(2).split(" ")
      const value = rest.join(" ")
      if (key === "branch.oid") branch.oid = value === "(initial)" ? null : value
      else if (key === "branch.head") branch.head = value === "(detached)" ? null : value
      else if (key === "branch.upstream") branch.upstream = value
      else if (key === "branch.ab") {
        const m = /^\+(\d+) -(\d+)$/.exec(value)
        if (m) {
          branch.ahead = Number(m[1])
          branch.behind = Number(m[2])
        }
      } else if (key === "stash") stash = Number(value) || 0
      continue
    }
    const type = r[0]
    if (type === "1") {
      // 1 XY sub mH mI mW hH hI path
      const f = fields(r, 8)
      entries.push(entry(f[1]!, f[2]!, f[8]!, "changed"))
    } else if (type === "2") {
      // 2 XY sub mH mI mW hH hI Xscore path, then origPath as the next record
      const f = fields(r, 9)
      const e = entry(f[1]!, f[2]!, f[9]!, "renamed")
      e.orig = records[++i] ?? ""
      entries.push(e)
    } else if (type === "u") {
      // u XY sub m1 m2 m3 mW h1 h2 h3 path
      const f = fields(r, 10)
      entries.push(entry(f[1]!, f[2]!, f[10]!, "unmerged"))
    } else if (type === "?") {
      entries.push({ path: r.slice(2), x: "?", y: "?", kind: "untracked" })
    } else if (type === "!") {
      entries.push({ path: r.slice(2), x: "!", y: "!", kind: "ignored" })
    }
  }
  return { branch, entries, stash }
}

/** The first `n` space-separated fields, and the rest (a path may contain spaces) as field `n`. */
function fields(r: string, n: number): string[] {
  const out: string[] = []
  let at = 0
  for (let k = 0; k < n; k++) {
    const sp = r.indexOf(" ", at)
    out.push(r.slice(at, sp))
    at = sp + 1
  }
  out.push(r.slice(at))
  return out
}

function entry(xy: string, sub: string, path: string, kind: EntryKind): StatusEntry {
  const e: StatusEntry = { path, x: xy[0] ?? ".", y: xy[1] ?? ".", kind }
  if (sub.startsWith("S")) e.submodule = true
  return e
}

/** Changes in the index (to be committed). */
export const isStaged = (e: StatusEntry) => (e.kind === "changed" || e.kind === "renamed") && e.x !== "."
/** Changes in the working tree that are not staged. */
export const isUnstaged = (e: StatusEntry) => (e.kind === "changed" || e.kind === "renamed") && e.y !== "."
export const isConflict = (e: StatusEntry) => e.kind === "unmerged"

/** One letter for a file's decoration in the tree and lists: the working tree's state wins. */
export function decoration(e: StatusEntry): string {
  if (e.kind === "untracked") return "U"
  if (e.kind === "ignored") return ""
  if (e.kind === "unmerged") return "!"
  const c = e.y !== "." ? e.y : e.x
  return c === "T" ? "M" : c
}

/**
 * Decorations for the tree: each changed path's letter, and for each folder above it a dot, so a
 * collapsed folder shows that something inside changed. Ignored paths (with a trailing `/` for folders)
 * are returned separately, to dim them.
 */
export function decorations(entries: StatusEntry[]): {
  files: Map<string, string>
  folders: Set<string>
  ignored: string[]
} {
  const files = new Map<string, string>()
  const folders = new Set<string>()
  const ignored: string[] = []
  for (const e of entries) {
    if (e.kind === "ignored") {
      ignored.push(e.path)
      continue
    }
    const letter = decoration(e)
    // An untracked folder is listed with a trailing slash.
    const path = e.path.replace(/\/$/, "")
    files.set(path, letter)
    let slash = path.lastIndexOf("/")
    while (slash > 0) {
      folders.add(path.slice(0, slash))
      slash = path.lastIndexOf("/", slash - 1)
    }
  }
  return { files, folders, ignored }
}

/** Whether `path` (relative, no trailing slash) is ignored, given the ignored entries of a status. */
export function isIgnored(path: string, ignored: string[]): boolean {
  for (const i of ignored) {
    if (i.endsWith("/") ? path === i.slice(0, -1) || path.startsWith(i) : path === i) return true
  }
  return false
}
