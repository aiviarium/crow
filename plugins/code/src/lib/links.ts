// Links from GitHub items to Crow entities. Three sources, all ending as URIs in the item's `links` field
// (which the reference index turns into backlinks on the entity):
//   1. Crow entity URLs pasted in a title or description: `https://crow.example/e/issue/0192…`, or the raw
//      `issue://0192…`.
//   2. Issue keys (`ENG-123`) in the title, description or branch name, resolved by a plugin that
//      contributes to the extension point `github.linkPatterns` (the projects plugin says how its keys look).
//   3. Agent sessions that worked on the branch (sessions.ts).
// Everything here is pure; resolving keys is the host's job (it calls the contributing plugin's service).

export interface LinkPattern {
  id: string
  /** A regular expression with one capture group: the key. */
  pattern: string
  flags?: string
  service: string
  method: string
  /** Also look in branch names. Default true. */
  branches?: boolean
}

const UUID = "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}"
const URL_RE = new RegExp(`https?://[^\\s)\\]>"']+/e/([a-z][a-z0-9-]{0,30})/(${UUID})`, "gi")
const URI_RE = new RegExp(`(?<![a-z0-9-])([a-z][a-z0-9-]{0,30})://(${UUID})`, "gi")

/** Schemes that are not Crow entities, so a pasted `https://…` is not read as one. */
const NOT_ENTITIES = new Set(["http", "https", "ftp", "ssh", "git", "file", "ws", "wss", "mailto"])

/** Entity URIs named in the text, as URLs of the shell or raw URIs, in order of appearance, once each. */
export function entityUris(text: string | null | undefined): string[] {
  const out: string[] = []
  const add = (scheme: string, id: string) => {
    const uri = `${scheme.toLowerCase()}://${id.toLowerCase()}`
    if (!NOT_ENTITIES.has(scheme.toLowerCase()) && !out.includes(uri)) out.push(uri)
  }
  const s = text ?? ""
  for (const m of s.matchAll(URL_RE)) add(m[1]!, m[2]!)
  for (const m of s.matchAll(URI_RE)) add(m[1]!, m[2]!)
  return out
}

/** Keys a pattern finds in the text, upper-cased as written, once each. */
export function keysIn(text: string | null | undefined, p: LinkPattern): string[] {
  let re: RegExp
  try {
    re = new RegExp(p.pattern, `${(p.flags ?? "i").replace(/[gy]/g, "")}g`)
  } catch {
    return []
  }
  const out: string[] = []
  for (const m of (text ?? "").matchAll(re)) {
    const key = (m[1] ?? m[0]).trim()
    if (key && !out.includes(key)) out.push(key)
  }
  return out
}

export interface Candidate {
  pattern: LinkPattern
  key: string
}

/** The keys an item names in its title, description and (when the pattern asks) branch. */
export function candidates(
  item: { title?: string; body?: string; head?: string },
  patterns: LinkPattern[],
): Candidate[] {
  const out: Candidate[] = []
  for (const p of patterns) {
    const texts = [item.title, item.body, p.branches === false ? undefined : item.head]
    for (const t of texts)
      for (const key of keysIn(t, p))
        if (!out.some((c) => c.pattern.id === p.id && c.key === key)) out.push({ pattern: p, key })
  }
  return out
}

/** Whether `@login` appears in the text, as GitHub reads a mention (not inside an e-mail address or word). */
export function mentionsLogin(text: string | null | undefined, login: string): boolean {
  if (!text || !login) return false
  const esc = login.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
  return new RegExp(`(?<![\\w@/.-])@${esc}(?![\\w-])`, "i").test(text)
}
