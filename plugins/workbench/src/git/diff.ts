// Unified diffs as git writes them (`git diff --no-color --no-ext-diff`, with core.quotePath off), and
// patches built back from a selection of their lines, for staging, unstaging and reverting by hunk or by
// line with `git apply`.

export interface DiffLine {
  type: " " | "+" | "-"
  text: string
  /** Line number in the old file (context and removed lines). */
  old?: number
  /** Line number in the new file (context and added lines). */
  new?: number
  /** Followed by "\ No newline at end of file". */
  noNewline?: boolean
}

export interface Hunk {
  oldStart: number
  oldLines: number
  newStart: number
  newLines: number
  /** The text after the second `@@`, often the enclosing function. */
  section: string
  lines: DiffLine[]
}

export interface FileDiff {
  oldPath: string | null
  newPath: string | null
  status: "modified" | "added" | "deleted" | "renamed" | "copied"
  binary: boolean
  oldMode?: string
  newMode?: string
  similarity?: number
  /** The header lines before the hunks (`diff --git`, modes, `index`, `---`, `+++`), as git wrote them. */
  header: string[]
  hunks: Hunk[]
}

/** Undoes git's C-style quoting of a path (`"a\tb"`), used when core.quotePath does not cover it. */
export function unquote(s: string): string {
  if (!s.startsWith('"') || !s.endsWith('"')) return s
  const body = s.slice(1, -1)
  const bytes: number[] = []
  const enc = new TextEncoder()
  for (let i = 0; i < body.length; i++) {
    const c = body[i]!
    if (c !== "\\") {
      bytes.push(...enc.encode(c))
      continue
    }
    const n = body[++i]!
    const map: Record<string, number> = { n: 10, t: 9, r: 13, '"': 34, "\\": 92, a: 7, b: 8, f: 12, v: 11 }
    if (n in map) bytes.push(map[n]!)
    else if (/[0-7]/.test(n)) {
      bytes.push(Number.parseInt(body.slice(i, i + 3), 8))
      i += 2
    } else bytes.push(...enc.encode(n))
  }
  return new TextDecoder().decode(new Uint8Array(bytes))
}

function stripPrefix(p: string): string | null {
  const u = unquote(p.trim())
  if (u === "/dev/null") return null
  return u.replace(/^[ab]\//, "")
}

export function parseDiff(text: string): FileDiff[] {
  const files: FileDiff[] = []
  let file: FileDiff | null = null
  let hunk: Hunk | null = null
  let oldNo = 0
  let newNo = 0
  const lines = text.split("\n")
  if (lines[lines.length - 1] === "") lines.pop()
  for (const line of lines) {
    if (line.startsWith("diff --git ")) {
      const m = /^diff --git ("(?:[^"\\]|\\.)*"|\S+) ("(?:[^"\\]|\\.)*"|\S+)$/.exec(line)
      file = {
        oldPath: m ? stripPrefix(m[1]!) : null,
        newPath: m ? stripPrefix(m[2]!) : null,
        status: "modified",
        binary: false,
        header: [line],
        hunks: [],
      }
      if (!m) {
        // Paths with spaces and no quoting: split in the middle at " b/".
        const rest = line.slice(11)
        const at = rest.indexOf(" b/")
        file.oldPath = rest.slice(0, at).replace(/^a\//, "")
        file.newPath = rest.slice(at + 3)
      }
      files.push(file)
      hunk = null
      continue
    }
    if (!file) continue
    const h = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@ ?(.*)$/.exec(line)
    if (h) {
      hunk = {
        oldStart: Number(h[1]),
        oldLines: h[2] === undefined ? 1 : Number(h[2]),
        newStart: Number(h[3]),
        newLines: h[4] === undefined ? 1 : Number(h[4]),
        section: h[5] ?? "",
        lines: [],
      }
      oldNo = hunk.oldStart
      newNo = hunk.newStart
      file.hunks.push(hunk)
      continue
    }
    if (!hunk) {
      file.header.push(line)
      if (line.startsWith("new file mode ")) {
        file.status = "added"
        file.newMode = line.slice(14)
      } else if (line.startsWith("deleted file mode ")) {
        file.status = "deleted"
        file.oldMode = line.slice(18)
      } else if (line.startsWith("old mode ")) file.oldMode = line.slice(9)
      else if (line.startsWith("new mode ")) file.newMode = line.slice(9)
      else if (line.startsWith("rename from ")) {
        file.status = "renamed"
        file.oldPath = unquote(line.slice(12))
      } else if (line.startsWith("rename to ")) file.newPath = unquote(line.slice(10))
      else if (line.startsWith("copy from ")) {
        file.status = "copied"
        file.oldPath = unquote(line.slice(10))
      } else if (line.startsWith("copy to ")) file.newPath = unquote(line.slice(8))
      else if (line.startsWith("similarity index ")) file.similarity = Number.parseInt(line.slice(17), 10)
      else if (line.startsWith("Binary files ") || line === "GIT binary patch") file.binary = true
      else if (line.startsWith("--- ")) {
        const p = stripPrefix(line.slice(4))
        if (p === null) file.status = "added"
        file.oldPath = p ?? file.oldPath
        if (p === null) file.oldPath = null
      } else if (line.startsWith("+++ ")) {
        const p = stripPrefix(line.slice(4))
        if (p === null) {
          file.status = "deleted"
          file.newPath = null
        } else file.newPath = p
      }
      continue
    }
    const c = line[0]
    if (c === "\\") {
      const last = hunk.lines[hunk.lines.length - 1]
      if (last) last.noNewline = true
    } else if (c === "+") hunk.lines.push({ type: "+", text: line.slice(1), new: newNo++ })
    else if (c === "-") hunk.lines.push({ type: "-", text: line.slice(1), old: oldNo++ })
    else if (c === " " || line === "")
      hunk.lines.push({ type: " ", text: line.slice(1), old: oldNo++, new: newNo++ })
  }
  if (files.length) {
    for (const f of files) {
      if (f.status === "added") f.oldPath = null
      if (f.status === "deleted") f.newPath = null
    }
  }
  return files
}

export const filePath = (f: FileDiff) => f.newPath ?? f.oldPath ?? ""

export function countChanges(f: FileDiff): { added: number; removed: number } {
  let added = 0
  let removed = 0
  for (const h of f.hunks)
    for (const l of h.lines) {
      if (l.type === "+") added++
      else if (l.type === "-") removed++
    }
  return { added, removed }
}

/** A line of a file diff by hunk index and line index within the hunk. */
export interface LineRef {
  hunk: number
  line: number
}

const key = (r: LineRef) => `${r.hunk}:${r.line}`

/**
 * A patch with only the selected changed lines of a file diff, for `git apply`. Unselected changes are
 * left as they are in the target: applied forwards (stage, or revert with `reverse` built from the same
 * diff and `git apply -R`), an unselected removal stays as context and an unselected addition is dropped;
 * applied in reverse it is the other way round. `selected` undefined takes every change. Returns null if
 * nothing is selected.
 */
export function buildPatch(
  f: FileDiff,
  selected?: LineRef[],
  opts: { reverse?: boolean } = {},
): string | null {
  const pick = selected ? new Set(selected.map(key)) : null
  const reverse = !!opts.reverse
  const out: string[] = []
  const oldPath = f.oldPath ?? f.newPath!
  const newPath = f.newPath ?? f.oldPath!
  out.push(`diff --git a/${oldPath} b/${newPath}`)
  if (f.status === "added") out.push(`new file mode ${f.newMode ?? "100644"}`)
  if (f.status === "deleted") out.push(`deleted file mode ${f.oldMode ?? "100644"}`)
  out.push(f.oldPath ? `--- a/${oldPath}` : "--- /dev/null")
  out.push(f.newPath ? `+++ b/${newPath}` : "+++ /dev/null")
  let any = false
  // Applied forwards, an earlier hunk that drops lines shifts where later hunks start in the new file.
  let shift = 0
  f.hunks.forEach((h, hi) => {
    const body: string[] = []
    let oldCount = 0
    let newCount = 0
    let changed = false
    h.lines.forEach((l, li) => {
      const chosen = !pick || pick.has(key({ hunk: hi, line: li }))
      const nl = l.noNewline ? ["\\ No newline at end of file"] : []
      if (l.type === " ") {
        body.push(` ${l.text}`, ...nl)
        oldCount++
        newCount++
      } else if (chosen) {
        body.push(`${l.type}${l.text}`, ...nl)
        changed = true
        if (l.type === "-") oldCount++
        else newCount++
      } else if ((l.type === "-") !== reverse) {
        // Forwards: an unselected removal stays (as context). Reverse: an unselected addition stays.
        body.push(` ${l.text}`, ...nl)
        oldCount++
        newCount++
      }
      // Otherwise the line is left out: it is not in the patch's view of the file at all.
    })
    // A hunk with nothing chosen is left out; the target keeps those lines as they are.
    if (!changed) return
    any = true
    // git's counts: a side with no lines names the line before (0 for an empty or new file).
    const newStart = reverse ? h.newStart : h.oldStart + shift
    const newHead = newCount === 0 ? Math.max(0, newStart - 1) : Math.max(1, newStart)
    out.push(`@@ -${h.oldStart},${oldCount} +${newHead},${newCount} @@${h.section ? ` ${h.section}` : ""}`)
    out.push(...body)
    shift += newCount - oldCount
  })
  if (!any) return null
  return `${out.join("\n")}\n`
}

/** The hunk containing a line of the new file (or the old one for removals), for "stage hunk at cursor". */
export function hunkAt(f: FileDiff, line: number, side: "new" | "old" = "new"): number {
  return f.hunks.findIndex((h) => {
    const start = side === "new" ? h.newStart : h.oldStart
    const count = side === "new" ? h.newLines : h.oldLines
    return line >= start && line < start + Math.max(count, 1)
  })
}

/** The changed lines of a diff whose new (or old, for removals) line number is within [from, to]. */
export function linesInRange(f: FileDiff, from: number, to: number): LineRef[] {
  const out: LineRef[] = []
  f.hunks.forEach((h, hi) => {
    // A removal sits between the new lines around it; it counts as at the next new line.
    let nextNew = h.newStart
    h.lines.forEach((l, li) => {
      if (l.type === "+") {
        if (l.new! >= from && l.new! <= to) out.push({ hunk: hi, line: li })
        nextNew = l.new! + 1
      } else if (l.type === "-") {
        if (nextNew >= from && nextNew <= to) out.push({ hunk: hi, line: li })
      } else nextNew = l.new! + 1
    })
  })
  return out
}
