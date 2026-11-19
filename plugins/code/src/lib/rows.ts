// The rows the plugin keeps, as `@rookery/sdk`'s collections return them: typed here because Crow's plugins
// do not generate `rookery-env.d.ts` yet (the manifest declares the same fields; see `plugin.json`).
import type { Collection, Ctx, Rookery } from "@rookery/sdk"

export type Rows = Record<string, any>

export interface RepoRow {
  id: string
  spaceId?: string | null
  host?: string
  apiBase?: string
  owner?: string
  name?: string
  fullName: string
  githubId?: number
  description?: string
  defaultBranch?: string
  private?: boolean
  archived?: boolean
  htmlUrl?: string
  connection?: string
  mergeMethods?: Record<string, boolean>
  permissions?: Record<string, boolean>
  status?: string
  errorCode?: string
  lastError?: string
  errorFix?: string
  lastSyncAt?: string
  lastSyncMs?: number
  lastSyncStats?: Record<string, number> | null
  nextSyncAt?: string
  pollSecs?: number
  lastWebhookAt?: string
  cursors?: Record<string, string>
  rateLimit?: { limit: number; remaining: number; resetAt: string; at: string } | null
  openPulls?: number
  openIssues?: number
  syncedBy?: string
  repository?: string
  project?: string | null
  projectLink?: string | null
  [key: string]: unknown
}

export interface Label {
  name: string
  color: string
}

export interface PullRow {
  id: string
  spaceId?: string | null
  repo: string
  number: number
  githubId?: number
  title: string
  subtitle?: string
  body?: string
  author?: string
  authorName?: string
  assignees?: string[]
  labels?: Label[]
  milestone?: string
  commentCount?: number
  ghCreatedAt?: string
  ghUpdatedAt?: string
  closedAt?: string | null
  htmlUrl?: string
  removed?: string | null
  links?: string[]
  state: string
  draft?: boolean
  reviewers?: string[]
  reviews?: Array<{ login: string; state: string; at: string | null; url?: string }>
  reviewState?: string
  checksState?: string
  checks?: {
    total?: number
    passed?: number
    failed?: number
    pending?: number
    items?: Array<{ name: string; conclusion: string | null; status?: string; url?: string | null }>
    at?: string
  } | null
  head?: string
  base?: string
  headSha?: string
  headRepo?: string
  mergeable?: string
  mergeableState?: string
  additions?: number
  deletions?: number
  changedFiles?: number
  commits?: number
  mergedAt?: string | null
  mergedBy?: string
  sessions?: string[]
  [key: string]: unknown
}

export interface CommentRow {
  id: string
  spaceId?: string | null
  repo: string
  number: number
  onKind: "pr" | "issue"
  kind: "comment" | "review" | "review_comment"
  ghId: number
  author?: string
  body?: string
  reviewState?: string
  path?: string
  line?: number | null
  side?: string
  commitSha?: string
  inReplyTo?: number | null
  ghCreatedAt?: string
  ghUpdatedAt?: string
  htmlUrl?: string
  [key: string]: unknown
}

export interface BranchLinkRow {
  id: string
  spaceId?: string | null
  session: string
  branch: string
  headSha?: string
  repo?: string
  [key: string]: unknown
}

export interface RouteRow {
  id: string
  repoKey: string
  inSpace: string
  repoId: string
  [key: string]: unknown
}

export interface AccountRow {
  id: string
  key: string
  login: string
  host?: string
  user?: string | null
  email?: string | null
  avatar?: string
  source?: "token" | "email" | "manual"
  [key: string]: unknown
}

export interface GhCollections {
  repos: Collection<RepoRow>
  prs: Collection<PullRow>
  comments: Collection<CommentRow>
  branchLinks: Collection<BranchLinkRow>
  routes: Collection<RouteRow>
  accounts: Collection<AccountRow>
  space(id: string): GhCollections
}

/** The caller's collections, space-scoped where the manifest says so. */
export const gh = (ctx: Ctx): GhCollections => ctx.data as unknown as GhCollections

/** The plugin's own collections (no user): what a job or a start-time task writes. */
export const ghGlobal = (rookery: Rookery): GhCollections => rookery.data as unknown as GhCollections

/** The collections of one space, as the plugin reads them from outside a call. */
export const ghSpace = (rookery: Rookery, space: string): GhCollections =>
  rookery.data.space(space) as unknown as GhCollections
