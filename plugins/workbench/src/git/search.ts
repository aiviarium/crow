// Search across a workspace with ripgrep (`rg --json`) or, where it is missing, `git grep -z`, and
// replace with the same matcher. Both tools' output is machine-readable; columns here are UTF-16 offsets
// into the line, as an editor counts them.

export interface SearchQuery {
  query: string
  regex?: boolean
  caseSensitive?: boolean
  wholeWord?: boolean
  /** Globs of files to search, relative to the workspace (`src/**`, `*.ts`). */
  include?: string[]
  /** Globs of files to leave out. */
  exclude?: string[]
  /** Stop after this many matches. */
  maxResults?: number
}

export interface Match {
  /** 1-based. */
  line: number
  /** 0-based UTF-16 column of the match's start. */
  col: number
  /** Length in UTF-16 code units. */
  length: number
}

export interface FileMatches {
  path: string
  /** The text of each line with a match, by line number. */
  lines: Record<number, string>
  matches: Match[]
}

/** The command line for ripgrep. Paths in its output are relative to the workspace (run with cwd there). */
export function rgCommand(q: SearchQuery): string[] {
  const cmd = ["rg", "--json", "--no-config", "--hidden", "-g", "!.git"]
  if (!q.regex) cmd.push("--fixed-strings")
  cmd.push(q.caseSensitive ? "--case-sensitive" : "--ignore-case")
  if (q.wholeWord) cmd.push("--word-regexp")
  for (const g of q.include ?? []) if (g.trim()) cmd.push("-g", g.trim())
  for (const g of q.exclude ?? []) if (g.trim()) cmd.push("-g", `!${g.trim()}`)
  cmd.push("-e", q.query, "--", ".")
  return cmd
}

/** The command line for `git grep` (tracked and untracked files, respecting .gitignore). */
export function gitGrepCommand(q: SearchQuery): string[] {
  const cmd = [
    "git",
    "-c",
    "core.quotePath=false",
    "grep",
    "-n",
    "-z",
    "--column",
    "-I",
    "--untracked",
    "--no-color",
  ]
  cmd.push(q.regex ? "-E" : "-F")
  if (!q.caseSensitive) cmd.push("-i")
  if (q.wholeWord) cmd.push("-w")
  cmd.push("-e", q.query, "--")
  const inc = (q.include ?? []).map((g) => g.trim()).filter(Boolean)
  const exc = (q.exclude ?? []).map((g) => g.trim()).filter(Boolean)
  if (inc.length) for (const g of inc) cmd.push(`:(glob)${g.includes("/") ? g : `**/${g}`}`)
  else cmd.push(".")
  for (const g of exc) cmd.push(`:(exclude,glob)${g.includes("/") ? g : `**/${g}`}`)
  return cmd
}

/** The UTF-16 column of a UTF-8 byte offset into `text`. */
export function byteToCol(text: string, byte: number): number {
  let bytes = 0
  for (let i = 0; i < text.length; i++) {
    if (bytes >= byte) return i
    const c = text.codePointAt(i)!
    bytes += c < 0x80 ? 1 : c < 0x800 ? 2 : c < 0x10000 ? 3 : 4
    if (c >= 0x10000) i++
  }
  return text.length
}

/**
 * Feeds ripgrep's JSON lines and yields a file's matches once the file is done (`end`), so results can
 * stream to the client one file at a time.
 */
export class RgParser {
  private current: FileMatches | null = null
  private buffer = ""

  /** Returns the files completed by this chunk of output. */
  push(chunk: string): FileMatches[] {
    this.buffer += chunk
    const done: FileMatches[] = []
    let nl = this.buffer.indexOf("\n")
    while (nl >= 0) {
      const line = this.buffer.slice(0, nl)
      this.buffer = this.buffer.slice(nl + 1)
      nl = this.buffer.indexOf("\n")
      if (!line.trim()) continue
      let msg: any
      try {
        msg = JSON.parse(line)
      } catch {
        continue
      }
      const path = (p: any) => (typeof p?.text === "string" ? p.text : p?.bytes ? atob(p.bytes) : "")
      if (msg.type === "begin") {
        this.current = { path: path(msg.data.path).replace(/^\.\//, ""), lines: {}, matches: [] }
      } else if (msg.type === "match" && this.current) {
        const text: string = (msg.data.lines?.text ?? "").replace(/\r?\n$/, "")
        const ln: number = msg.data.line_number
        this.current.lines[ln] = text
        for (const s of msg.data.submatches ?? []) {
          const col = byteToCol(text, s.start)
          const end = byteToCol(text, s.end)
          this.current.matches.push({ line: ln, col, length: Math.max(0, end - col) })
        }
      } else if (msg.type === "end" && this.current) {
        if (this.current.matches.length) done.push(this.current)
        this.current = null
      }
    }
    return done
  }
}

/** A JavaScript RegExp that matches what the query asks for, for `git grep` columns and for replacing. */
export function matcher(q: SearchQuery): RegExp {
  let src = q.regex ? q.query : q.query.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
  if (q.wholeWord) src = `\\b(?:${src})\\b`
  return new RegExp(src, q.caseSensitive ? "gu" : "giu")
}

/** Every match of `re` in a line, as columns. Empty matches are skipped. */
export function matchesIn(text: string, line: number, re: RegExp): Match[] {
  const out: Match[] = []
  re.lastIndex = 0
  for (let m = re.exec(text); m; m = re.exec(text)) {
    if (m[0].length === 0) {
      re.lastIndex++
      continue
    }
    out.push({ line, col: m.index, length: m[0].length })
  }
  return out
}

/**
 * Feeds `git grep -n -z --column` output (`path NUL line NUL column NUL text NL`) and yields a file's
 * matches when the next file starts or at the end. git reports one column per line; the others are found
 * with the same pattern in JavaScript.
 */
export class GitGrepParser {
  private current: FileMatches | null = null
  private buffer = ""
  constructor(private readonly re: RegExp) {}

  push(chunk: string): FileMatches[] {
    this.buffer += chunk
    const done: FileMatches[] = []
    let nl = this.buffer.indexOf("\n")
    while (nl >= 0) {
      const rec = this.buffer.slice(0, nl)
      this.buffer = this.buffer.slice(nl + 1)
      nl = this.buffer.indexOf("\n")
      const f = rec.split("\0")
      if (f.length < 4) continue
      const path = f[0]!
      const ln = Number(f[1])
      const col = Number(f[2]) - 1
      const text = f.slice(3).join("\0").replace(/\r$/, "")
      if (this.current && this.current.path !== path) {
        done.push(this.current)
        this.current = null
      }
      this.current ??= { path, lines: {}, matches: [] }
      this.current.lines[ln] = text
      const found = matchesIn(text, ln, this.re)
      // git found a match even if JavaScript's regex dialect does not: keep git's column.
      this.current.matches.push(...(found.length ? found : [{ line: ln, col: Math.max(0, col), length: 1 }]))
    }
    return done
  }

  end(): FileMatches[] {
    const rest = this.push("\n")
    if (this.current) rest.push(this.current)
    this.current = null
    return rest
  }
}

/**
 * Replaces matches in a file's text. `only` limits it to these matches (by line and column, as found);
 * otherwise every match of the query is replaced. `$1` style groups work for regex queries.
 */
export function replaceIn(
  text: string,
  q: SearchQuery,
  replacement: string,
  only?: Match[],
): { text: string; count: number } {
  const re = matcher(q)
  const keep = only ? new Set(only.map((m) => `${m.line}:${m.col}`)) : null
  let count = 0
  const lines = text.split("\n")
  const out = lines.map((line, i) => {
    re.lastIndex = 0
    return line.replace(re, (...args) => {
      const m = args[0] as string
      const offset = args.find((a, k) => k > 0 && typeof a === "number") as number
      if (keep && !keep.has(`${i + 1}:${offset}`)) return m
      count++
      if (!q.regex) return replacement
      // Expand $1, $& and named groups with a regex replace of just this match.
      return m.replace(new RegExp(re.source, re.flags.replace("g", "")), replacement)
    })
  })
  return { text: out.join("\n"), count }
}
