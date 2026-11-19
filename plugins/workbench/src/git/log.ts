// History, refs, stashes and blame, from git's formats with explicit separators (NUL between fields, RS
// between records), never from its human output.

/** `git log --format=` for `parseLog`: fields NUL-separated, each record ends with RS (0x1e). */
export const LOG_FORMAT = "%H%x00%P%x00%an%x00%ae%x00%at%x00%cn%x00%ct%x00%D%x00%s%x1e"

export interface Commit {
  sha: string
  parents: string[]
  author: string
  email: string
  /** Author time, unix seconds. */
  time: number
  committer: string
  commitTime: number
  /** Ref names pointing here, as `%D` gives them (`HEAD -> main`, `origin/main`, `tag: v1`). */
  refs: string[]
  subject: string
}

export function parseLog(out: string): Commit[] {
  const commits: Commit[] = []
  for (const rec of out.split("\x1e")) {
    const r = rec.replace(/^\n+/, "")
    if (!r) continue
    const f = r.split("\0")
    if (f.length < 9) continue
    commits.push({
      sha: f[0]!,
      parents: f[1] ? f[1].split(" ") : [],
      author: f[2]!,
      email: f[3]!,
      time: Number(f[4]),
      committer: f[5]!,
      commitTime: Number(f[6]),
      refs: f[7] ? f[7].split(", ").filter(Boolean) : [],
      subject: f.slice(8).join("\0"),
    })
  }
  return commits
}

/** `git show -s --format=` for one commit with its whole message. */
export const COMMIT_FORMAT = "%H%x00%P%x00%an%x00%ae%x00%at%x00%cn%x00%ce%x00%ct%x00%D%x00%B"

export interface CommitDetail extends Commit {
  committerEmail: string
  message: string
}

export function parseCommit(out: string): CommitDetail | null {
  const f = out.split("\0")
  if (f.length < 10) return null
  const message = f.slice(9).join("\0").replace(/\n+$/, "")
  return {
    sha: f[0]!.replace(/^\n+/, ""),
    parents: f[1] ? f[1].split(" ") : [],
    author: f[2]!,
    email: f[3]!,
    time: Number(f[4]),
    committer: f[5]!,
    committerEmail: f[6]!,
    commitTime: Number(f[7]),
    refs: f[8] ? f[8].split(", ").filter(Boolean) : [],
    subject: message.split("\n")[0] ?? "",
    message,
  }
}

/** `git for-each-ref --format=` for `parseRefs`; one ref per line, fields NUL-separated. */
export const REF_FORMAT =
  "%(refname)%00%(objectname)%00%(upstream)%00%(upstream:track,nobracket)%00%(HEAD)%00%(creatordate:unix)%00%(contents:subject)"

export interface Ref {
  /** Full name: `refs/heads/main`, `refs/remotes/origin/main`, `refs/tags/v1`. */
  ref: string
  /** Short name: `main`, `origin/main`, `v1`. */
  name: string
  kind: "branch" | "remote" | "tag"
  sha: string
  /** The upstream's short name, for a branch that has one. */
  upstream?: string
  ahead: number
  behind: number
  /** The upstream is configured but gone. */
  gone?: boolean
  current: boolean
  time: number
  subject: string
}

export function parseRefs(out: string): Ref[] {
  const refs: Ref[] = []
  for (const line of out.split("\n")) {
    if (!line) continue
    const f = line.split("\0")
    const ref = f[0]!
    let kind: Ref["kind"]
    let name: string
    if (ref.startsWith("refs/heads/")) {
      kind = "branch"
      name = ref.slice(11)
    } else if (ref.startsWith("refs/remotes/")) {
      kind = "remote"
      name = ref.slice(13)
      if (name.endsWith("/HEAD")) continue
    } else if (ref.startsWith("refs/tags/")) {
      kind = "tag"
      name = ref.slice(10)
    } else continue
    const track = f[3] ?? ""
    const ahead = /ahead (\d+)/.exec(track)
    const behind = /behind (\d+)/.exec(track)
    refs.push({
      ref,
      name,
      kind,
      sha: f[1]!,
      ...(f[2] ? { upstream: f[2].replace(/^refs\/(heads|remotes)\//, "") } : {}),
      ahead: ahead ? Number(ahead[1]) : 0,
      behind: behind ? Number(behind[1]) : 0,
      ...(track === "gone" ? { gone: true } : {}),
      current: f[4] === "*",
      time: Number(f[5]) || 0,
      subject: f.slice(6).join("\0"),
    })
  }
  return refs
}

/** `git stash list --format=` for `parseStashes`. */
export const STASH_FORMAT = "%gd%x00%H%x00%at%x00%gs%x1e"

export interface Stash {
  /** `stash@{0}` */
  ref: string
  sha: string
  time: number
  /** `On main: message` or `WIP on main: …` */
  message: string
}

export function parseStashes(out: string): Stash[] {
  return out
    .split("\x1e")
    .map((r) => r.replace(/^\n+/, ""))
    .filter(Boolean)
    .map((r) => {
      const f = r.split("\0")
      return { ref: f[0]!, sha: f[1]!, time: Number(f[2]), message: f.slice(3).join("\0") }
    })
}

export interface BlameCommit {
  sha: string
  author: string
  email: string
  time: number
  summary: string
  /** Not yet committed (all zeros). */
  uncommitted: boolean
}

export interface Blame {
  /** One entry per line of the file, 1-based line `i + 1`. */
  lines: string[]
  commits: Record<string, BlameCommit>
}

/** `git blame --porcelain`: per line the commit that last changed it. */
export function parseBlame(out: string): Blame {
  const lines: string[] = []
  const commits: Record<string, BlameCommit> = {}
  let current: BlameCommit | null = null
  for (const line of out.split("\n")) {
    if (line.startsWith("\t")) {
      if (current) lines.push(current.sha)
      continue
    }
    const head = /^([0-9a-f]{40}|[0-9a-f]{64}) \d+ (\d+)(?: \d+)?$/.exec(line)
    if (head) {
      const sha = head[1]!
      current = commits[sha] ??= {
        sha,
        author: "",
        email: "",
        time: 0,
        summary: "",
        uncommitted: /^0+$/.test(sha),
      }
      continue
    }
    if (!current) continue
    const sp = line.indexOf(" ")
    const key = sp < 0 ? line : line.slice(0, sp)
    const value = sp < 0 ? "" : line.slice(sp + 1)
    if (key === "author") current.author = value
    else if (key === "author-mail") current.email = value.replace(/^<|>$/g, "")
    else if (key === "author-time") current.time = Number(value)
    else if (key === "summary") current.summary = value
  }
  return { lines, commits }
}

/** Runs of consecutive lines from one commit: what a blame gutter labels once. */
export function blameBlocks(b: Blame): Array<{ start: number; end: number; sha: string }> {
  const out: Array<{ start: number; end: number; sha: string }> = []
  b.lines.forEach((sha, i) => {
    const last = out[out.length - 1]
    if (last && last.sha === sha && last.end === i) last.end = i + 1
    else out.push({ start: i + 1, end: i + 1, sha })
  })
  return out
}

/** "3 days ago" style age for a unix time. */
export function age(seconds: number, now = Date.now() / 1000): string {
  const d = Math.max(0, now - seconds)
  const units: Array<[number, string]> = [
    [365 * 86400, "year"],
    [30 * 86400, "month"],
    [7 * 86400, "week"],
    [86400, "day"],
    [3600, "hour"],
    [60, "minute"],
  ]
  for (const [n, u] of units) {
    if (d >= n) {
      const k = Math.floor(d / n)
      return `${k} ${u}${k === 1 ? "" : "s"} ago`
    }
  }
  return "just now"
}
