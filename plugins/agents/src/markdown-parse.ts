// Markdown parsing for the chat (markdown.tsx renders it), following CommonMark where agents' answers need it:
// paragraphs, headings, nested lists (with code and paragraphs inside items), quotes, rules, fenced code,
// GFM tables, inline code, emphasis by CommonMark's delimiter rules (so `CROW_PUBLIC_URL` and `a_b_c` stay
// as written: an underscore inside a word is not emphasis), links and Crow mentions (`@[Title](scheme://id)`).
// Text that is still streaming parses as it grows: an unclosed fence is a code block so far.

export type Align = "left" | "center" | "right" | null

export type Block =
  | { t: "p"; text: string }
  | { t: "h"; level: number; text: string }
  | { t: "code"; lang: string; code: string }
  | { t: "list"; ordered: boolean; start: number; tight: boolean; items: Block[][] }
  | { t: "quote"; blocks: Block[] }
  | { t: "hr" }
  | { t: "table"; align: Align[]; head: string[]; rows: string[][] }

const FENCE = /^( {0,3})(`{3,}|~{3,})\s*([^\s`]*)/
const HEADING = /^ {0,3}(#{1,6})(?:\s+(.*?))?\s*#*\s*$/
const RULE = /^ {0,3}([-*_])(?:\s*\1){2,}\s*$/
const ITEM = /^( {0,3})([-*+]|\d{1,9}[.)])( +|$)(.*)$/
const QUOTE = /^ {0,3}> ?(.*)$/
const TABLE_SEP = /^\s*\|?\s*:?-+:?\s*(\|\s*:?-+:?\s*)*\|?\s*$/

/** Leading spaces, with a tab as four. */
function indentOf(line: string): number {
  let n = 0
  for (const c of line) {
    if (c === " ") n++
    else if (c === "\t") n += 4 - (n % 4)
    else break
  }
  return n
}

/** The line without its first `n` columns of indentation. */
function dedent(line: string, n: number): string {
  let col = 0
  let i = 0
  while (i < line.length && col < n && (line[i] === " " || line[i] === "\t")) {
    col += line[i] === "\t" ? 4 - (col % 4) : 1
    i++
  }
  return line.slice(i)
}

function cells(row: string): string[] {
  let r = row.trim()
  if (r.startsWith("|")) r = r.slice(1)
  if (r.endsWith("|") && !r.endsWith("\\|")) r = r.slice(0, -1)
  const out: string[] = []
  let cur = ""
  let code = false
  for (let i = 0; i < r.length; i++) {
    const c = r[i]!
    if (c === "\\" && r[i + 1] === "|") {
      cur += "|"
      i++
    } else if (c === "`") {
      code = !code
      cur += c
    } else if (c === "|" && !code) {
      out.push(cur.trim())
      cur = ""
    } else cur += c
  }
  out.push(cur.trim())
  return out
}

/** Whether a line starts a block other than a paragraph (it ends a paragraph or a lazy list line). */
function interrupts(line: string): boolean {
  return FENCE.test(line) || HEADING.test(line) || RULE.test(line) || QUOTE.test(line) || ITEM.test(line)
}

export function parseBlocks(src: string): Block[] {
  return blocks(src.replace(/\r\n?/g, "\n").split("\n"))
}

function blocks(lines: string[]): Block[] {
  const out: Block[] = []
  let para: string[] = []
  const flush = () => {
    if (para.length) out.push({ t: "p", text: para.join("\n") })
    para = []
  }
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!
    if (!line.trim()) {
      flush()
      continue
    }
    const fence = line.match(FENCE)
    if (fence) {
      flush()
      const indent = fence[1]!.length
      const mark = fence[2]!
      const code: string[] = []
      i++
      while (i < lines.length) {
        const l = lines[i]!
        const close = l.match(/^ {0,3}(`{3,}|~{3,})\s*$/)
        if (close && close[1]![0] === mark[0] && close[1]!.length >= mark.length) break
        code.push(dedent(l, indent))
        i++
      }
      out.push({ t: "code", lang: fence[3] ?? "", code: code.join("\n") })
      continue
    }
    const h = line.match(HEADING)
    if (h) {
      flush()
      out.push({ t: "h", level: h[1]!.length, text: h[2] ?? "" })
      continue
    }
    if (RULE.test(line) && !(para.length && /^ {0,3}-+\s*$/.test(line))) {
      flush()
      out.push({ t: "hr" })
      continue
    }
    if (
      line.includes("|") &&
      i + 1 < lines.length &&
      TABLE_SEP.test(lines[i + 1]!) &&
      lines[i + 1]!.includes("-")
    ) {
      const head = cells(line)
      const align = cells(lines[i + 1]!).map((c): Align => {
        const l = c.startsWith(":")
        const r = c.endsWith(":")
        return l && r ? "center" : r ? "right" : l ? "left" : null
      })
      if (align.length === head.length) {
        flush()
        i += 2
        const rows: string[][] = []
        while (i < lines.length && lines[i]!.trim() && lines[i]!.includes("|")) {
          const r = cells(lines[i]!)
          rows.push(head.map((_, k) => r[k] ?? ""))
          i++
        }
        i--
        out.push({ t: "table", align, head, rows })
        continue
      }
    }
    if (QUOTE.test(line)) {
      flush()
      const inner: string[] = []
      while (i < lines.length) {
        const q = lines[i]!.match(QUOTE)
        if (q) inner.push(q[1]!)
        else if (
          lines[i]!.trim() &&
          !interrupts(lines[i]!) &&
          inner.length &&
          inner[inner.length - 1]!.trim()
        )
          inner.push(lines[i]!) // a lazy continuation of the quote's paragraph
        else break
        i++
      }
      i--
      out.push({ t: "quote", blocks: blocks(inner) })
      continue
    }
    const li = line.match(ITEM)
    // An ordered list interrupts a paragraph only when it starts at 1, as in CommonMark.
    if (li && !(para.length && /^\d/.test(li[2]!) && !/^1[.)]/.test(li[2]!))) {
      flush()
      i = list(lines, i, out)
      continue
    }
    para.push(line.replace(/^ {0,3}/, ""))
  }
  flush()
  return out
}

/** A list from line `i`; pushes it to `out` and returns the index of its last line. */
function list(lines: string[], i: number, out: Block[]): number {
  const first = lines[i]!.match(ITEM)!
  const ordered = /^\d/.test(first[2]!)
  const delim = ordered ? first[2]!.slice(-1) : first[2]!
  const start = ordered ? Number(first[2]!.slice(0, -1)) : 1
  const items: Block[][] = []
  let tight = true
  let blankBetween = false
  while (i < lines.length) {
    const m = lines[i]!.match(ITEM)
    if (!m) break
    const sameKind = ordered ? /^\d/.test(m[2]!) && m[2]!.endsWith(delim) : m[2] === delim
    if (!sameKind || indentOf(m[1]!) > 3) break
    if (blankBetween) tight = false
    // Where the item's content starts: after the marker and its spaces (one, if it has five or more).
    const spaces = m[3]!.length
    const width = m[1]!.length + m[2]!.length + (spaces >= 5 || !m[4] ? 1 : spaces)
    const body: string[] = [spaces >= 5 ? `${" ".repeat(spaces - 1)}${m[4]}` : m[4]!]
    i++
    let blank = false
    while (i < lines.length) {
      const l = lines[i]!
      if (!l.trim()) {
        blank = true
        body.push("")
        i++
        continue
      }
      if (indentOf(l) >= width) {
        if (blank) tight = tight && !hasParagraphBreak(body)
        body.push(dedent(l, width))
        blank = false
        i++
        continue
      }
      // A lazy continuation of the item's last paragraph.
      if (!blank && !interrupts(l) && body[body.length - 1]?.trim()) {
        body.push(l.trim())
        i++
        continue
      }
      break
    }
    // Blank lines at the end belong between items, not in this one.
    while (body.length && !body[body.length - 1]!.trim()) body.pop()
    blankBetween = blank
    const parsed = blocks(body)
    if (parsed.filter((b) => b.t === "p").length > 1 && body.some((l) => !l.trim())) tight = false
    items.push(parsed)
  }
  out.push({ t: "list", ordered, start, tight, items })
  return i - 1
}

function hasParagraphBreak(body: string[]): boolean {
  return body.some((l, k) => !l.trim() && k > 0 && !!body[k - 1]!.trim())
}

// ── inline ──

export type Inline =
  | { t: "text"; v: string }
  | { t: "code"; v: string }
  | { t: "b"; v: Inline[] }
  | { t: "i"; v: Inline[] }
  | { t: "a"; href: string; v: Inline[] }
  | { t: "mention"; uri: string; v: string }
  | { t: "br" }

const PUNCT = /[\p{P}\p{S}]/u
const SPACE = /\s/u

/** Code spans, mentions, links and breaks first; what is left is text, where emphasis is resolved. */
const TOKENS =
  /(`+)([^`]|[^`][\s\S]*?[^`])\1(?!`)|@\[([^\]\n]*)\]\(([a-z][a-z0-9+.-]*:\/\/[^)\s]+)\)|\[([^\]\n]+)\]\(([^)\s]+)\)|<(https?:\/\/[^>\s]+)>|\\([\\`*_[\]()#+\-.!|<>~])|\n/g

export function parseInline(src: string): Inline[] {
  // Pass 1: atoms, with text runs between them.
  const atoms: Array<Inline | { t: "raw"; v: string }> = []
  let last = 0
  for (const m of src.matchAll(TOKENS)) {
    if (m.index! > last) atoms.push({ t: "raw", v: src.slice(last, m.index) })
    last = m.index! + m[0].length
    if (m[1])
      atoms.push({ t: "code", v: m[2]!.length > 2 && /^ .* $/.test(m[2]!) ? m[2]!.slice(1, -1) : m[2]! })
    else if (m[4]) atoms.push({ t: "mention", uri: m[4], v: m[3] ?? m[4] })
    else if (m[6]) atoms.push({ t: "a", href: m[6], v: parseInline(m[5]!) })
    else if (m[7]) atoms.push({ t: "a", href: m[7], v: [{ t: "text", v: m[7] }] })
    else if (m[8]) atoms.push({ t: "text", v: m[8] })
    else atoms.push({ t: "br" })
  }
  if (last < src.length) atoms.push({ t: "raw", v: src.slice(last) })
  return emphasis(atoms)
}

interface Delim {
  char: "*" | "_"
  count: number
  open: boolean
  close: boolean
  /** Index in `nodes` of the text node holding the run. */
  at: number
}

/** CommonMark's delimiter runs: `*` and `_` open and close by flanking, an `_` inside a word never does. */
function emphasis(atoms: Array<Inline | { t: "raw"; v: string }>): Inline[] {
  const nodes: Inline[] = []
  const delims: Delim[] = []
  const charAt = (k: number, side: "before" | "after", text: string, i: number, len: number): string => {
    if (side === "before") {
      if (i > 0) return text[i - 1]!
      const prev = atoms[k - 1]
      return prev && prev.t !== "br"
        ? prev.t === "raw" || prev.t === "text"
          ? (prev.v.at(-1) ?? " ")
          : "a"
        : " "
    }
    if (i + len < text.length) return text[i + len]!
    const next = atoms[k + 1]
    return next && next.t !== "br" ? (next.t === "raw" || next.t === "text" ? (next.v[0] ?? " ") : "a") : " "
  }
  atoms.forEach((a, k) => {
    if (a.t !== "raw") {
      nodes.push(a)
      return
    }
    const text = a.v
    let buf = ""
    for (let i = 0; i < text.length; ) {
      const c = text[i]!
      if (c !== "*" && c !== "_") {
        buf += c
        i++
        continue
      }
      let len = 1
      while (text[i + len] === c) len++
      const before = charAt(k, "before", text, i, len)
      const after = charAt(k, "after", text, i, len)
      const left = !SPACE.test(after) && (!PUNCT.test(after) || SPACE.test(before) || PUNCT.test(before))
      const right = !SPACE.test(before) && (!PUNCT.test(before) || SPACE.test(after) || PUNCT.test(after))
      const open = c === "*" ? left : left && (!right || PUNCT.test(before))
      const close = c === "*" ? right : right && (!left || PUNCT.test(after))
      if (buf) nodes.push({ t: "text", v: buf })
      buf = ""
      nodes.push({ t: "text", v: text.slice(i, i + len) })
      if (open || close) delims.push({ char: c, count: len, open, close, at: nodes.length - 1 })
      i += len
    }
    if (buf) nodes.push({ t: "text", v: buf })
  })
  return resolve(nodes, delims)
}

/** Pairs closers with the nearest opener of their kind and wraps what is between. */
function resolve(nodes: Inline[], delims: Delim[]): Inline[] {
  for (let c = 0; c < delims.length; c++) {
    const closer = delims[c]!
    if (!closer.close || closer.count === 0) continue
    for (let o = c - 1; o >= 0; o--) {
      const opener = delims[o]!
      if (!opener.open || opener.char !== closer.char || opener.count === 0) continue
      // The rule of 3: a run that can both open and close does not pair with one whose lengths add to a
      // multiple of 3, unless both are.
      if (
        (opener.close || closer.open) &&
        (opener.count + closer.count) % 3 === 0 &&
        (opener.count % 3 || closer.count % 3)
      )
        continue
      const n = opener.count >= 2 && closer.count >= 2 ? 2 : 1
      const inner = nodes.slice(opener.at + 1, closer.at)
      const wrapped: Inline = { t: n === 2 ? "b" : "i", v: merge(inner) }
      opener.count -= n
      closer.count -= n
      ;(nodes[opener.at] as { v: string }).v = opener.char.repeat(opener.count)
      ;(nodes[closer.at] as { v: string }).v = closer.char.repeat(closer.count)
      // Replace the inner nodes with the wrapped one; indexes after shift.
      const removed = closer.at - opener.at - 1
      nodes.splice(opener.at + 1, removed, wrapped)
      const shift = removed - 1
      for (let k = o + 1; k < delims.length; k++) {
        if (k < c) delims[k]!.count = 0 // delimiters inside the emphasis are spent
        delims[k]!.at -= shift
      }
      if (closer.count > 0) c-- // the rest of the closer may close an earlier opener
      break
    }
  }
  return merge(nodes)
}

function merge(nodes: Inline[]): Inline[] {
  const out: Inline[] = []
  for (const n of nodes) {
    if (n.t === "text" && !n.v) continue
    const prev = out[out.length - 1]
    if (n.t === "text" && prev?.t === "text") prev.v += n.v
    else out.push(n)
  }
  return out
}
