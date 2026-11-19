// Issue keys (`CROW-123`), project keys (`CROW`) and the names derived from them: a branch for an agent's
// worktree (`crow-123-short-title`) and the pattern other plugins use to find keys in text.

/** A project key: 2 to 10 capital letters and digits, starting with a letter. */
export const PROJECT_KEY = /^[A-Z][A-Z0-9]{1,9}$/

/** An issue key anywhere in text: a project key, a dash, a number. One capture group: the key. */
export const ISSUE_KEY_SOURCE = "(?<![A-Za-z0-9])([A-Za-z][A-Za-z0-9]{1,9}-[1-9][0-9]{0,8})(?![0-9])"

export function isProjectKey(key: string): boolean {
  return PROJECT_KEY.test(key)
}

/** A project key from a name: "Website redesign" -> "WR", "Crow" -> "CROW". */
export function suggestKey(name: string): string {
  const words = name
    .normalize("NFKD")
    .replace(/[^A-Za-z0-9 ]+/g, " ")
    .trim()
    .split(/\s+/)
    .filter(Boolean)
  if (!words.length) return "PRJ"
  let key =
    words.length === 1
      ? words[0]!.slice(0, 4)
      : words
          .map((w) => w[0])
          .join("")
          .slice(0, 5)
  key = key.toUpperCase()
  if (!/^[A-Z]/.test(key)) key = `P${key}`
  if (key.length < 2) key = (key + (words[0]![1] ?? "X")).toUpperCase()
  return key.slice(0, 10)
}

export interface IssueKey {
  project: string
  number: number
}

/** Parses `CROW-123` (any case, surrounding space allowed). */
export function parseIssueKey(text: string): IssueKey | null {
  const m = /^\s*([A-Za-z][A-Za-z0-9]{1,9})-([1-9][0-9]{0,8})\s*$/.exec(text)
  if (!m) return null
  return { project: m[1]!.toUpperCase(), number: Number(m[2]) }
}

export function formatIssueKey(project: string, number: number): string {
  return `${project.toUpperCase()}-${number}`
}

/**
 * The words search should find an issue key by: Postgres reads `CROW-12` as `crow` and `-12`, so a search
 * for "crow-12" (`crow:* & 12:*`) would miss it. `CROW 12 CROW12` matches either way of typing it.
 */
export function keyWords(key: string): string {
  const k = parseIssueKey(key)
  return k ? `${k.project} ${k.number} ${k.project}${k.number}` : key
}

/** Every distinct issue key in a text, upper-cased, in order of appearance. */
export function findIssueKeys(text: string): string[] {
  const out: string[] = []
  const re = new RegExp(ISSUE_KEY_SOURCE, "g")
  for (const m of text.matchAll(re)) {
    const k = parseIssueKey(m[1]!)
    if (!k) continue
    const s = formatIssueKey(k.project, k.number)
    if (!out.includes(s)) out.push(s)
  }
  return out
}

/** A slug of a title for branch names: lower case ASCII words joined by dashes, at most `max` long. */
const FOLD: Record<string, string> = { ø: "o", æ: "ae", œ: "oe", ß: "ss", đ: "d", ł: "l", þ: "th", ð: "d" }

export function slugify(text: string, max = 40): string {
  const s = text
    .toLowerCase()
    .replace(/[øæœßđłþð]/g, (c) => FOLD[c] ?? c)
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
  if (s.length <= max) return s
  const cut = s.slice(0, max + 1)
  const at = cut.lastIndexOf("-")
  return (at > max / 2 ? cut.slice(0, at) : s.slice(0, max)).replace(/-+$/g, "")
}

/** The branch an agent works on for an issue: `crow-123-short-title`. */
export function branchName(key: string, title: string, max = 60): string {
  const k = key.toLowerCase()
  const rest = slugify(title, Math.max(8, max - k.length - 1))
  return rest ? `${k}-${rest}` : k
}

/** A space slug for a project key: the key in lower case. */
export function slugForKey(key: string): string {
  return key.toLowerCase()
}
