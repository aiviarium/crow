// The parts of GitHub's REST payloads the plugin reads. Fields are as the API names them (snake_case); the
// plugin's own rows are in mapping.ts. Only what is used is typed, so a field GitHub adds changes nothing.

export interface GhUser {
  login: string
  id: number
  avatar_url?: string
  html_url?: string
  type?: string
  name?: string | null
  email?: string | null
}

export interface GhLabel {
  name: string
  color?: string
  description?: string | null
}

export interface GhRepo {
  id: number
  name: string
  full_name: string
  owner: GhUser
  private: boolean
  archived?: boolean
  description: string | null
  html_url: string
  default_branch: string
  permissions?: { admin?: boolean; maintain?: boolean; push?: boolean; triage?: boolean; pull?: boolean }
  allow_merge_commit?: boolean
  allow_squash_merge?: boolean
  allow_rebase_merge?: boolean
  has_issues?: boolean
  open_issues_count?: number
}

export interface GhRef {
  ref: string
  sha: string
  repo: { full_name: string; id?: number } | null
}

export interface GhPullListItem {
  id: number
  number: number
  state: "open" | "closed"
  draft?: boolean
  title: string
  body: string | null
  user: GhUser | null
  labels: GhLabel[]
  assignees?: GhUser[]
  requested_reviewers?: GhUser[]
  requested_teams?: Array<{ slug: string; name?: string }>
  milestone?: { title: string } | null
  head: GhRef
  base: GhRef
  html_url: string
  created_at: string
  updated_at: string
  closed_at: string | null
  merged_at: string | null
  merge_commit_sha?: string | null
}

export interface GhPull extends GhPullListItem {
  merged?: boolean
  mergeable?: boolean | null
  mergeable_state?: string
  merged_by?: GhUser | null
  comments?: number
  review_comments?: number
  commits?: number
  additions?: number
  deletions?: number
  changed_files?: number
}

export interface GhIssue {
  id: number
  number: number
  state: "open" | "closed"
  state_reason?: string | null
  title: string
  body: string | null
  user: GhUser | null
  labels: Array<GhLabel | string>
  assignees?: GhUser[]
  milestone?: { title: string } | null
  comments: number
  html_url: string
  created_at: string
  updated_at: string
  closed_at: string | null
  /** Present on pull requests, which the issues API lists too. */
  pull_request?: { url: string }
}

export interface GhComment {
  id: number
  user: GhUser | null
  body: string
  html_url: string
  created_at: string
  updated_at: string
  /** Issue comments. */
  issue_url?: string
  /** Review comments. */
  pull_request_url?: string
  path?: string
  line?: number | null
  original_line?: number | null
  side?: string
  commit_id?: string
  in_reply_to_id?: number
  pull_request_review_id?: number | null
}

export interface GhReview {
  id: number
  user: GhUser | null
  body: string | null
  state: "APPROVED" | "CHANGES_REQUESTED" | "COMMENTED" | "DISMISSED" | "PENDING"
  submitted_at?: string | null
  html_url: string
  commit_id?: string
}

export interface GhCheckRun {
  id: number
  name: string
  status: "queued" | "in_progress" | "completed"
  conclusion:
    | "success"
    | "failure"
    | "neutral"
    | "cancelled"
    | "skipped"
    | "timed_out"
    | "action_required"
    | "stale"
    | null
  html_url?: string | null
  details_url?: string | null
  started_at?: string | null
  completed_at?: string | null
  app?: { slug?: string; name?: string } | null
  output?: { title?: string | null; summary?: string | null; annotations_count?: number }
}

export interface GhCombinedStatus {
  state: "failure" | "pending" | "success" | "error"
  statuses: Array<{
    context: string
    state: "error" | "failure" | "pending" | "success"
    target_url?: string | null
  }>
  total_count?: number
}

export interface GhFile {
  filename: string
  status: string
  additions: number
  deletions: number
  changes: number
  patch?: string
  previous_filename?: string
  blob_url?: string
}

export interface GhCommit {
  sha: string
  html_url?: string
  commit: { message: string; author: { name: string; email: string; date: string } | null }
  author: GhUser | null
}

export interface GhTimelineEvent {
  id?: number
  event: string
  created_at?: string
  actor?: GhUser | null
  label?: { name: string; color?: string }
  assignee?: GhUser
  requested_reviewer?: GhUser
  review_requester?: GhUser
  commit_id?: string | null
  state?: string
  body?: string
  user?: GhUser
  submitted_at?: string
  rename?: { from: string; to: string }
  source?: { issue?: { number: number; title: string; html_url?: string } }
  message?: string
  sha?: string
  author?: { name: string; date?: string }
}

export interface GhInstallationToken {
  token: string
  expires_at: string
}

export interface GhRateLimit {
  resources: Record<string, { limit: number; remaining: number; reset: number; used?: number }>
  rate?: { limit: number; remaining: number; reset: number }
}

/** A webhook delivery body, as far as the plugin reads it. */
export interface GhEvent {
  action?: string
  repository?: GhRepo
  sender?: GhUser
  pull_request?: GhPull
  issue?: GhIssue
  comment?: GhComment
  review?: GhReview
  check_run?: GhCheckRun & { head_sha?: string; pull_requests?: Array<{ number: number }> }
  check_suite?: { head_sha?: string; pull_requests?: Array<{ number: number }> }
  status?: { sha?: string; state?: string; context?: string }
  label?: GhLabel
  changes?: { repository?: { name?: { from: string } }; owner?: { from?: unknown } } & Record<string, unknown>
  installation?: { id: number }
  requested_reviewer?: GhUser
  hook_id?: number
}
