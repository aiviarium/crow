// GitHub's payloads as the plugin's rows (the collections of plugin.json), and the small derivations the
// lists need: the review state from the reviews and requests, a one-line subtitle, which fields changed.
import type { CheckSummary } from "./api"
import type { GhComment, GhLabel, GhPull, GhPullListItem, GhRepo, GhReview } from "./types"

export type Fields = Record<string, unknown>

export interface Label {
  name: string
  color: string
}

export interface ReviewEntry {
  login: string
  state: "approved" | "changes_requested" | "commented" | "dismissed"
  at: string | null
  url?: string
}

export type ReviewState = "none" | "pending" | "approved" | "changes_requested" | "commented"

export const labelsOf = (labels: Array<GhLabel | string> | undefined): Label[] =>
  (labels ?? []).map((l) =>
    typeof l === "string" ? { name: l, color: "" } : { name: l.name, color: l.color ?? "" },
  )

/** The latest review of each person, in the order they submitted: a comment does not undo an approval. */
export function latestReviews(reviews: GhReview[]): ReviewEntry[] {
  const byLogin = new Map<string, ReviewEntry>()
  const sorted = [...reviews].sort(
    (a, b) => Date.parse(a.submitted_at ?? "") - Date.parse(b.submitted_at ?? ""),
  )
  for (const r of sorted) {
    const login = r.user?.login
    if (!login || r.state === "PENDING") continue
    const state = r.state.toLowerCase() as ReviewEntry["state"]
    const before = byLogin.get(login)
    // A plain comment keeps an earlier approval or request for changes; a dismissal clears it.
    if (
      state === "commented" &&
      before &&
      (before.state === "approved" || before.state === "changes_requested")
    )
      continue
    byLogin.set(login, { login, state, at: r.submitted_at ?? null, url: r.html_url })
  }
  return [...byLogin.values()].filter((r) => r.state !== "dismissed")
}

export function reviewState(reviews: ReviewEntry[], requested: string[]): ReviewState {
  if (reviews.some((r) => r.state === "changes_requested")) return "changes_requested"
  if (reviews.some((r) => r.state === "approved")) return "approved"
  if (requested.length > 0) return "pending"
  if (reviews.some((r) => r.state === "commented")) return "commented"
  return "none"
}

export function mapRepo(r: GhRepo): Fields {
  return {
    owner: r.owner.login,
    name: r.name,
    fullName: r.full_name,
    githubId: r.id,
    description: r.description ?? "",
    defaultBranch: r.default_branch,
    private: !!r.private,
    archived: !!r.archived,
    htmlUrl: r.html_url,
    permissions: r.permissions ?? null,
    mergeMethods: {
      merge: r.allow_merge_commit !== false,
      squash: r.allow_squash_merge !== false,
      rebase: r.allow_rebase_merge !== false,
    },
  }
}

const subtitle = (full: string, n: number, state: string, author: string | undefined) =>
  `${full}#${n} · ${state}${author ? ` · ${author}` : ""}`

export interface PullExtras {
  reviews?: GhReview[]
  checks?: CheckSummary
}

export function mapPull(
  repoUri: string,
  full: string,
  p: GhPull | GhPullListItem,
  x: PullExtras = {},
): Fields {
  const detail = p as GhPull
  const merged = !!(p.merged_at || detail.merged)
  const state = merged ? "merged" : p.state
  const requested = [
    ...(p.requested_reviewers ?? []).map((u) => u.login),
    ...(p.requested_teams ?? []).map((t) => `team:${t.slug}`),
  ]
  const f: Fields = {
    repo: repoUri,
    number: p.number,
    githubId: p.id,
    title: p.title,
    subtitle: subtitle(full, p.number, p.draft && state === "open" ? "draft" : state, p.user?.login),
    body: p.body ?? "",
    author: p.user?.login ?? "ghost",
    authorName: p.user?.name ?? "",
    assignees: (p.assignees ?? []).map((u) => u.login),
    labels: labelsOf(p.labels),
    milestone: p.milestone?.title ?? "",
    state,
    draft: !!p.draft,
    reviewers: requested,
    head: p.head.ref,
    base: p.base.ref,
    headSha: p.head.sha,
    headRepo: p.head.repo?.full_name ?? "",
    ghCreatedAt: p.created_at,
    ghUpdatedAt: p.updated_at,
    closedAt: p.closed_at,
    mergedAt: p.merged_at,
    htmlUrl: p.html_url,
  }
  if (detail.merged_by !== undefined) f.mergedBy = detail.merged_by?.login ?? ""
  if (detail.mergeable !== undefined) {
    f.mergeable = detail.mergeable === null ? "unknown" : detail.mergeable ? "mergeable" : "conflicting"
    f.mergeableState = detail.mergeable_state ?? ""
  }
  if (detail.additions !== undefined) {
    f.additions = detail.additions
    f.deletions = detail.deletions ?? 0
    f.changedFiles = detail.changed_files ?? 0
    f.commits = detail.commits ?? 0
    f.commentCount = (detail.comments ?? 0) + (detail.review_comments ?? 0)
  }
  if (x.reviews) {
    const latest = latestReviews(x.reviews)
    f.reviews = latest
    f.reviewState = reviewState(latest, requested)
  } else {
    f.reviewState = undefined
  }
  if (x.checks) {
    f.checksState = x.checks.state
    f.checks = {
      total: x.checks.total,
      passed: x.checks.passed,
      failed: x.checks.failed,
      pending: x.checks.pending,
      items: x.checks.items.slice(0, 20),
    }
  }
  for (const k of Object.keys(f)) if (f[k] === undefined) delete f[k]
  return f
}

export type CommentKind = "comment" | "review" | "review_comment"

/** The number of the issue or pull request an issue comment or review comment belongs to. */
export function commentNumber(c: GhComment): number | null {
  const url = c.issue_url ?? c.pull_request_url
  const m = /\/(\d+)$/.exec(url ?? "")
  return m ? Number(m[1]) : null
}

export function mapComment(
  repoUri: string,
  kind: CommentKind,
  onKind: "pr" | "issue",
  number: number,
  c: GhComment | GhReview,
): Fields {
  if (kind === "review") {
    const r = c as GhReview
    return {
      repo: repoUri,
      number,
      onKind,
      kind,
      ghId: r.id,
      author: r.user?.login ?? "ghost",
      body: r.body ?? "",
      reviewState: r.state.toLowerCase(),
      commitSha: r.commit_id ?? "",
      ghCreatedAt: r.submitted_at ?? undefined,
      ghUpdatedAt: r.submitted_at ?? undefined,
      htmlUrl: r.html_url,
    }
  }
  const x = c as GhComment
  const f: Fields = {
    repo: repoUri,
    number,
    onKind,
    kind,
    ghId: x.id,
    author: x.user?.login ?? "ghost",
    body: x.body ?? "",
    ghCreatedAt: x.created_at,
    ghUpdatedAt: x.updated_at,
    htmlUrl: x.html_url,
  }
  if (kind === "review_comment") {
    f.path = x.path ?? ""
    f.line = x.line ?? x.original_line ?? null
    f.side = x.side ?? ""
    f.commitSha = x.commit_id ?? ""
    f.inReplyTo = x.in_reply_to_id ?? null
  }
  return f
}

const same = (a: unknown, b: unknown): boolean => {
  if (a === b) return true
  if (a == null && b == null) return true
  if (typeof a === "string" && typeof b === "string") {
    // Datetimes come back from the store as RFC 3339 with an offset.
    const ta = Date.parse(a)
    const tb = Date.parse(b)
    return Number.isFinite(ta) &&
      Number.isFinite(tb) &&
      /^\d{4}-\d\d-\d\dT/.test(a) &&
      /^\d{4}-\d\d-\d\dT/.test(b)
      ? ta === tb
      : false
  }
  if (typeof a === "object" && typeof b === "object" && a && b) {
    if (Array.isArray(a) !== Array.isArray(b)) return false
    const ka = Object.keys(a as object)
    const kb = Object.keys(b as object)
    if (ka.length !== kb.length) return false
    return ka.every((k) => same((a as Fields)[k], (b as Fields)[k]))
  }
  return false
}

/** The fields of `next` that differ from the stored row. An empty patch means nothing needs writing. */
export function changedFields(existing: Fields | null | undefined, next: Fields): Fields {
  const patch: Fields = {}
  for (const [k, v] of Object.entries(next)) {
    if (!existing) patch[k] = v
    else if (k === "checks" ? !sameChecks(existing[k], v) : !same(existing[k], v)) patch[k] = v
  }
  return patch
}

/** The checks summary is the same when only `at` (when it was read) differs: reading the checks again
 * and finding them unchanged writes nothing. (Every read wrote the row, and an open pull request page,
 * which reads it again when its row changes, wrote it again and again.) */
function sameChecks(a: unknown, b: unknown): boolean {
  if (!a || !b || typeof a !== "object" || typeof b !== "object") return same(a, b)
  const { at: _a, ...x } = a as Record<string, unknown>
  const { at: _b, ...y } = b as Record<string, unknown>
  return same(x, y)
}
