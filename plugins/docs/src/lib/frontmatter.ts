// YAML front matter, the subset Markdown notes use (Obsidian, static site generators): `key: value` with
// strings (plain or quoted), numbers, booleans, null, dates as strings, and lists inline (`[a, b]`) or as
// `- item` lines. Nested maps are kept as their raw text. Enough to carry page properties both ways.

export interface Parsed {
  data: Record<string, unknown>
  body: string
}

/** Splits a file into its front matter and the Markdown after it. */
export function parseFrontMatter(text: string): Parsed {
  const src = text.replace(/^﻿/, "")
  const m = /^---[ \t]*\r?\n([\s\S]*?)\r?\n(?:---|\.\.\.)[ \t]*(?:\r?\n|$)/.exec(src)
  if (!m) return { data: {}, body: src }
  return { data: parseYaml(m[1]!), body: src.slice(m[0].length) }
}

function scalar(raw: string): unknown {
  const s = raw.trim()
  if (s === "" || s === "~" || s === "null") return null
  if (s === "true" || s === "True") return true
  if (s === "false" || s === "False") return false
  if (/^-?\d+(\.\d+)?$/.test(s) && !/^0\d/.test(s)) return Number(s)
  if ((s.startsWith('"') && s.endsWith('"')) || (s.startsWith("'") && s.endsWith("'"))) {
    if (s[0] === "'") return s.slice(1, -1).replace(/''/g, "'")
    try {
      return JSON.parse(s)
    } catch {
      return s.slice(1, -1)
    }
  }
  if (s.startsWith("[") && s.endsWith("]")) {
    const inner = s.slice(1, -1).trim()
    if (!inner) return []
    return splitTop(inner).map(scalar)
  }
  return s.replace(/\s+#.*$/, "")
}

/** Splits `a, "b, c", d` at top-level commas. */
function splitTop(s: string): string[] {
  const out: string[] = []
  let cur = ""
  let q: string | null = null
  let depth = 0
  for (const c of s) {
    if (q) {
      cur += c
      if (c === q) q = null
    } else if (c === '"' || c === "'") {
      q = c
      cur += c
    } else if (c === "[") {
      depth++
      cur += c
    } else if (c === "]") {
      depth--
      cur += c
    } else if (c === "," && depth === 0) {
      out.push(cur)
      cur = ""
    } else cur += c
  }
  if (cur.trim()) out.push(cur)
  return out
}

export function parseYaml(src: string): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  const lines = src.split(/\r?\n/)
  let i = 0
  while (i < lines.length) {
    const line = lines[i]!
    if (!line.trim() || line.trimStart().startsWith("#")) {
      i++
      continue
    }
    const m = /^([^\s:#][^:]*?)\s*:(?:\s+(.*))?$/.exec(line)
    if (!m || /^\s/.test(line)) {
      i++
      continue
    }
    const key = m[1]!.replace(/^["']|["']$/g, "")
    const rest = m[2]
    i++
    if (rest !== undefined && rest.trim() !== "" && rest.trim() !== "|" && rest.trim() !== ">") {
      out[key] = scalar(rest)
      continue
    }
    // A block: list items, or indented text (a nested map or a literal block), until the next key.
    const block: string[] = []
    while (i < lines.length && (lines[i]!.trim() === "" || /^\s/.test(lines[i]!) || /^-\s/.test(lines[i]!))) {
      block.push(lines[i]!)
      i++
    }
    const items = block.filter((l) => l.trim())
    if (items.length && items.every((l) => /^\s*-\s/.test(l) || /^\s*-$/.test(l)))
      out[key] = items.map((l) => scalar(l.replace(/^\s*-\s?/, "")))
    else if (rest?.trim() === "|" || rest?.trim() === ">")
      out[key] = items.map((l) => l.trim()).join(rest.trim() === "|" ? "\n" : " ")
    else out[key] = items.length ? items.map((l) => l.trim()).join("\n") : null
  }
  return out
}

const PLAIN = /^[A-Za-z0-9 _./@()+-]*[A-Za-z0-9_./@()+-]$/

function quote(v: string): string {
  if (
    PLAIN.test(v) &&
    !/^(true|false|null|~|yes|no)$/i.test(v) &&
    !/^-?\d/.test(v) &&
    !v.startsWith("-") &&
    !v.includes(": ")
  )
    return v
  return JSON.stringify(v)
}

function value(v: unknown): string {
  if (v === null || v === undefined) return "null"
  if (typeof v === "boolean" || typeof v === "number") return String(v)
  return quote(String(v))
}

/** Front matter for `data`, with the closing `---` and a blank line, or "" when empty. */
export function stringifyFrontMatter(data: Record<string, unknown>): string {
  const keys = Object.keys(data).filter((k) => data[k] !== undefined)
  if (!keys.length) return ""
  const lines = ["---"]
  for (const k of keys) {
    const v = data[k]
    const key = /^[A-Za-z0-9_][A-Za-z0-9 _-]*$/.test(k) ? k : JSON.stringify(k)
    if (Array.isArray(v)) {
      if (!v.length) lines.push(`${key}: []`)
      else {
        lines.push(`${key}:`)
        for (const x of v) lines.push(`  - ${value(x)}`)
      }
    } else lines.push(`${key}: ${value(v)}`)
  }
  lines.push("---", "")
  return `${lines.join("\n")}\n`
}
