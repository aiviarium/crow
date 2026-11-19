// Markdown between GitHub and Crow. Bodies go through as GitHub-flavoured Markdown (the kernel's converter
// turns them into the editor's document and back); what differs is how people and Crow entities are named:
//   in   `@ada` becomes a mention of the Crow user ada is (`[@ada](user://<id>)`), when the login is mapped;
//   out  a mention of a Crow user becomes `@login` when they have one, else their name; a link to another Crow
//        entity (`issue://…`) becomes its text, since GitHub cannot open it.
// Code (fenced blocks and inline spans) is left as it is.
import { mentionedLogins } from "./notifier"

const UUID = "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}"

/** Runs `fn` on the parts of `md` that are not code. */
function outsideCode(md: string, fn: (text: string) => string): string {
  const out: string[] = []
  // Fenced blocks first, then inline spans in what is left.
  const fences = md.split(/(^```[^\n]*\n[\s\S]*?^```[ \t]*$)/m)
  for (const [i, part] of fences.entries()) {
    if (i % 2 === 1) {
      out.push(part)
      continue
    }
    const spans = part.split(/(`+[^`\n]*`+)/)
    out.push(spans.map((s, j) => (j % 2 === 1 ? s : fn(s))).join(""))
  }
  return out.join("")
}

/** The logins `@mentioned` in a GitHub body, outside code. */
export function loginsIn(md: string | null | undefined): string[] {
  const parts: string[] = []
  outsideCode(md ?? "", (t) => {
    parts.push(t)
    return t
  })
  return mentionedLogins(parts.join("\n"))
}

/** GitHub's Markdown for Crow: mapped `@login`s become mentions of their Crow users. */
export function toCrow(md: string | null | undefined, users: Map<string, string>): string {
  if (!md) return ""
  if (!users.size) return md
  return outsideCode(md, (t) =>
    t.replace(/(?<![\w@/.[-])@([A-Za-z0-9](?:[A-Za-z0-9-]{0,38}))(?![\w-])/g, (all, login: string) => {
      const user = users.get(login.toLowerCase())
      return user ? `[@${login}](user://${user})` : all
    }),
  )
}

/** The Crow users a Crow body mentions. */
export function usersIn(md: string | null | undefined): string[] {
  const out: string[] = []
  for (const m of (md ?? "").matchAll(new RegExp(`\\]\\(user://(${UUID})\\)`, "gi")))
    if (!out.includes(m[1]!.toLowerCase())) out.push(m[1]!.toLowerCase())
  return out
}

/** Crow's Markdown for GitHub: mentions of people as `@login` (or their name), other entity links as text. */
export function toGitHub(md: string | null | undefined, logins: Map<string, string>): string {
  if (!md) return ""
  return outsideCode(md, (t) =>
    t.replace(
      new RegExp(`\\[([^\\]\\n]*)\\]\\(([a-z][a-z0-9-]*):\\/\\/(${UUID})\\)`, "gi"),
      (all, label: string, scheme: string, id: string) => {
        const s = scheme.toLowerCase()
        if (s === "http" || s === "https") return all
        if (s === "user") {
          const login = logins.get(id.toLowerCase())
          if (login) return `@${login}`
          return label.replace(/^@/, "")
        }
        return label
      },
    ),
  )
}
