// GitHub's REST API as the plugin uses it: one method per endpoint, typed with the payloads in types.ts.
// Everything goes through GitHubHttp, so ETags, pagination and rate limits behave the same everywhere.
// REST only: GraphQL needs a token even for public data, so it could not be checked against the real API
// without one, and every datum the plugin shows is in REST.
import type { GitHubHttp, Response } from "./http"
import type {
  GhCheckRun,
  GhCombinedStatus,
  GhComment,
  GhCommit,
  GhFile,
  GhInstallationToken,
  GhIssue,
  GhLabel,
  GhPull,
  GhPullListItem,
  GhRateLimit,
  GhRepo,
  GhReview,
  GhTimelineEvent,
  GhUser,
} from "./types"

const enc = encodeURIComponent
const repoPath = (full: string) => `/repos/${full.split("/").map(enc).join("/")}`

export type MergeMethod = "merge" | "squash" | "rebase"
export type ReviewEvent = "APPROVE" | "REQUEST_CHANGES" | "COMMENT"

export interface CheckSummary {
  state: "none" | "pending" | "success" | "failure"
  total: number
  passed: number
  failed: number
  pending: number
  /** Failed and pending checks, for the list and for notifications. */
  items: Array<{
    id?: number
    name: string
    status: string
    conclusion: string | null
    url?: string | null
    source: "check" | "status"
  }>
}

const FAILING = new Set(["failure", "timed_out", "cancelled", "action_required"])

/** Check runs and legacy commit statuses of one commit, as one summary. */
export function summariseChecks(runs: GhCheckRun[], status: GhCombinedStatus | null): CheckSummary {
  const items: CheckSummary["items"] = []
  let passed = 0
  let failed = 0
  let pending = 0
  for (const r of runs) {
    if (r.status !== "completed") {
      pending++
      items.push({
        id: r.id,
        name: r.name,
        status: r.status,
        conclusion: null,
        url: r.html_url ?? r.details_url,
        source: "check",
      })
    } else if (r.conclusion && FAILING.has(r.conclusion)) {
      failed++
      items.push({
        id: r.id,
        name: r.name,
        status: r.status,
        conclusion: r.conclusion,
        url: r.html_url ?? r.details_url,
        source: "check",
      })
    } else passed++
  }
  for (const s of status?.statuses ?? []) {
    if (s.state === "pending") {
      pending++
      items.push({
        name: s.context,
        status: "pending",
        conclusion: null,
        url: s.target_url,
        source: "status",
      })
    } else if (s.state === "success") passed++
    else {
      failed++
      items.push({
        name: s.context,
        status: "completed",
        conclusion: s.state,
        url: s.target_url,
        source: "status",
      })
    }
  }
  const total = passed + failed + pending
  const state = total === 0 ? "none" : failed > 0 ? "failure" : pending > 0 ? "pending" : "success"
  return { state, total, passed, failed, pending, items }
}

export class GitHubApi {
  constructor(readonly http: GitHubHttp) {}

  // ── Identity and reach ───────────────────────────────────────────────────────────────────────────

  user() {
    return this.http.get<GhUser>("/user", { etag: false })
  }

  /** The repositories an installation token can reach (one page of 100, and the total). */
  async installationRepos(): Promise<{ total: number; repos: GhRepo[] }> {
    const r = await this.http.get<{ total_count: number; repositories: GhRepo[] }>(
      "/installation/repositories",
      {
        query: { per_page: 100 },
      },
    )
    return { total: r.data.total_count, repos: r.data.repositories }
  }

  /** The repositories a user token can reach: the first page, and a count read from the last page's link. */
  async userRepos(): Promise<{ total: number; repos: GhRepo[] }> {
    const r = await this.http.get<GhRepo[]>("/user/repos", {
      query: { per_page: 100, sort: "pushed", affiliation: "owner,collaborator,organization_member" },
    })
    let total = r.data.length
    if (r.last) {
      const n = Number(new URL(r.last).searchParams.get("page"))
      if (n > 1) total = (n - 1) * 100 + r.data.length // a lower bound: the last page is not fetched
    }
    return { total, repos: r.data }
  }

  async rateLimit(): Promise<GhRateLimit> {
    return (await this.http.get<GhRateLimit>("/rate_limit", { etag: false })).data
  }

  // ── Repositories ─────────────────────────────────────────────────────────────────────────────────

  repo(full: string) {
    return this.http.get<GhRepo>(repoPath(full))
  }

  labels(full: string) {
    return this.http.all<GhLabel>(`${repoPath(full)}/labels`)
  }

  assignable(full: string) {
    return this.http.all<GhUser>(`${repoPath(full)}/assignees`)
  }

  branch(full: string, name: string) {
    return this.http.get<{ name: string; commit: { sha: string } }>(
      `${repoPath(full)}/branches/${name.split("/").map(enc).join("/")}`,
      { etag: false },
    )
  }

  // ── Reading ──────────────────────────────────────────────────────────────────────────────────────

  /** Pull requests, most recently updated first, pages as they come. */
  pulls(full: string) {
    return this.http.pages<GhPullListItem>(`${repoPath(full)}/pulls`, {
      query: { state: "all", sort: "updated", direction: "desc" },
    })
  }

  pull(full: string, n: number) {
    return this.http.get<GhPull>(`${repoPath(full)}/pulls/${n}`)
  }

  reviews(full: string, n: number) {
    return this.http.all<GhReview>(`${repoPath(full)}/pulls/${n}/reviews`)
  }

  files(full: string, n: number) {
    return this.http.all<GhFile>(`${repoPath(full)}/pulls/${n}/files`, { maxPages: 30 })
  }

  commits(full: string, n: number) {
    return this.http.all<GhCommit>(`${repoPath(full)}/pulls/${n}/commits`, { maxPages: 10 })
  }

  timeline(full: string, n: number) {
    return this.http.all<GhTimelineEvent>(`${repoPath(full)}/issues/${n}/timeline`, { maxPages: 10 })
  }

  /** Issues (and pull requests, which this endpoint lists too) changed since a time, oldest first. */
  issues(full: string, since?: string) {
    return this.http.pages<GhIssue>(`${repoPath(full)}/issues`, {
      query: { state: "all", sort: "updated", direction: "asc", since },
    })
  }

  issue(full: string, n: number) {
    return this.http.get<GhIssue>(`${repoPath(full)}/issues/${n}`)
  }

  /** Comments on issues and pull requests of a repository since a time, oldest first. */
  issueComments(full: string, since?: string) {
    return this.http.pages<GhComment>(`${repoPath(full)}/issues/comments`, {
      query: { sort: "updated", direction: "asc", since },
    })
  }

  /** Inline review comments on the pull requests of a repository since a time, oldest first. */
  reviewComments(full: string, since?: string) {
    return this.http.pages<GhComment>(`${repoPath(full)}/pulls/comments`, {
      query: { sort: "updated", direction: "asc", since },
    })
  }

  commentsOf(full: string, n: number) {
    return this.http.all<GhComment>(`${repoPath(full)}/issues/${n}/comments`)
  }

  reviewCommentsOf(full: string, n: number) {
    return this.http.all<GhComment>(`${repoPath(full)}/pulls/${n}/comments`)
  }

  /** Check runs and statuses of a commit, summarised. */
  async checks(full: string, sha: string): Promise<CheckSummary> {
    const runs = await this.http.get<{ check_runs: GhCheckRun[] }>(
      `${repoPath(full)}/commits/${enc(sha)}/check-runs`,
      {
        query: { per_page: 100 },
      },
    )
    const status = await this.http
      .get<GhCombinedStatus>(`${repoPath(full)}/commits/${enc(sha)}/status`, { query: { per_page: 100 } })
      .catch(() => null)
    return summariseChecks(runs.data.check_runs ?? [], status?.data ?? null)
  }

  checkRuns(full: string, sha: string) {
    return this.http.get<{ check_runs: GhCheckRun[] }>(`${repoPath(full)}/commits/${enc(sha)}/check-runs`, {
      query: { per_page: 100 },
    })
  }

  /** The log of a GitHub Actions job (a check run's id is its job's), the end of it. */
  async jobLog(full: string, jobId: number, tailBytes = 12_000): Promise<string> {
    const r = await this.http.get<string>(`${repoPath(full)}/actions/jobs/${jobId}/logs`, {
      text: true,
      etag: false,
    })
    const text = String(r.data ?? "")
    return text.length > tailBytes
      ? `… (${text.length - tailBytes} characters before this left out)\n${text.slice(-tailBytes)}`
      : text
  }

  // ── Writing ──────────────────────────────────────────────────────────────────────────────────────

  comment(full: string, n: number, body: string) {
    return this.http.post<GhComment>(`${repoPath(full)}/issues/${n}/comments`, { body })
  }

  review(full: string, n: number, event: ReviewEvent, body: string, commitId?: string) {
    return this.http.post<GhReview>(`${repoPath(full)}/pulls/${n}/reviews`, {
      event,
      body: body || undefined,
      commit_id: commitId,
    })
  }

  merge(full: string, n: number, o: { method: MergeMethod; title?: string; message?: string; sha?: string }) {
    return this.http.put<{ sha: string; merged: boolean; message: string }>(
      `${repoPath(full)}/pulls/${n}/merge`,
      {
        merge_method: o.method,
        commit_title: o.title || undefined,
        commit_message: o.message || undefined,
        sha: o.sha,
      },
    )
  }

  /** Closes or reopens an issue or pull request. */
  setState(full: string, n: number, state: "open" | "closed", pull: boolean) {
    return this.http.patch<GhIssue>(`${repoPath(full)}/${pull ? "pulls" : "issues"}/${n}`, { state })
  }

  /** Changes an issue's title, body, state (with GitHub's reason), labels or assignees. */
  updateIssue(
    full: string,
    n: number,
    patch: {
      title?: string
      body?: string
      state?: "open" | "closed"
      state_reason?: "completed" | "not_planned" | "reopened" | null
      labels?: string[]
      assignees?: string[]
    },
  ) {
    return this.http.patch<GhIssue>(`${repoPath(full)}/issues/${n}`, patch)
  }

  editComment(full: string, id: number, body: string) {
    return this.http.patch<GhComment>(`${repoPath(full)}/issues/comments/${id}`, { body })
  }

  deleteComment(full: string, id: number) {
    return this.http.delete<unknown>(`${repoPath(full)}/issues/comments/${id}`)
  }

  setLabels(full: string, n: number, labels: string[]) {
    return this.http.put<GhLabel[]>(`${repoPath(full)}/issues/${n}/labels`, { labels })
  }

  addAssignees(full: string, n: number, assignees: string[]) {
    return this.http.post<GhIssue>(`${repoPath(full)}/issues/${n}/assignees`, { assignees })
  }

  removeAssignees(full: string, n: number, assignees: string[]) {
    return this.http.delete<GhIssue>(`${repoPath(full)}/issues/${n}/assignees`, { assignees })
  }

  requestReviewers(full: string, n: number, reviewers: string[], teams: string[] = []) {
    return this.http.post<GhPull>(`${repoPath(full)}/pulls/${n}/requested_reviewers`, {
      reviewers,
      team_reviewers: teams,
    })
  }

  removeReviewers(full: string, n: number, reviewers: string[]) {
    return this.http.delete<GhPull>(`${repoPath(full)}/pulls/${n}/requested_reviewers`, { reviewers })
  }

  createPull(full: string, o: { title: string; head: string; base: string; body?: string; draft?: boolean }) {
    return this.http.post<GhPull>(`${repoPath(full)}/pulls`, {
      title: o.title,
      head: o.head,
      base: o.base,
      body: o.body ?? "",
      draft: !!o.draft,
    })
  }

  createIssue(full: string, o: { title: string; body?: string; labels?: string[]; assignees?: string[] }) {
    return this.http.post<GhIssue>(`${repoPath(full)}/issues`, o)
  }

  /** Looks for an open pull request from a branch (`owner:branch`) into a base. */
  async findPull(full: string, headOwner: string, branch: string): Promise<GhPullListItem | null> {
    const r: Response<GhPullListItem[]> = await this.http.get(`${repoPath(full)}/pulls`, {
      query: { state: "all", head: `${headOwner}:${branch}`, per_page: 5 },
      etag: false,
    })
    return r.data[0] ?? null
  }
}

export type { GhInstallationToken }
