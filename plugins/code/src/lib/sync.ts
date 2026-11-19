// Incremental sync of one repository. A run reads what changed since the cursors the last run left:
//   pull requests  the list sorted by update time, newest first, until it reaches the cursor; for each one that
//                  changed, its detail, reviews and checks
//   issues         `since` the cursor (the issues endpoint lists pull requests too; those are skipped); they
//                  are Projects issues, written through the projects service into the project the repository
//                  is linked to
//   comments       the repository-wide lists of issue comments and of review comments, `since` the cursor; those
//                  on issues go to Projects too
// then compares each result with the stored row and writes only what differs, so an idle repository costs
// conditional requests that answer 304 and are not counted against GitHub's rate limit. A full resync drops
// the ETags and cursors, reads everything and checks the stored items GitHub no longer lists (deleted or
// transferred). Whatever goes wrong is recorded on the repository row (status, error, fix, next run); the job
// itself succeeds, because a failing job would put a notification in the inbox every minute.
import type { Ctx, Rookery } from "@rookery/sdk"
import type { Accounts } from "./accounts"
import { summariseChecks } from "./api"
import { explain, type Whose } from "./errors"
import { GitHubError } from "./http"
import { ensureProject, PROVIDER, projects, sourceComment, sourceIssue } from "./issues"
import type { Linker } from "./linker"
import { commentNumber, type Fields, mapComment, mapPull } from "./mapping"
import { type Notifier, type Planned, planComment, planItem } from "./notifier"
import type { Gh, Pool } from "./pool"
import { type GhCollections, gh, ghGlobal, type RepoRow, type Rows } from "./rows"
import type { RookeryExtras } from "./sdk"
import { existing, isRunning, mapLimit, upsertMany, withLock } from "./store"
import type { GhComment, GhIssue, GhPull, GhPullListItem, GhReview } from "./types"

/** Issues and comments written to Projects in one call. */
const CHUNK = 50

export interface Services {
  rookery: Rookery
  pool: Pool
  accounts: Accounts
  linker: Linker
  notifier: Notifier
  env: NonNullable<RookeryExtras["env"]>
}

export interface SyncParams {
  repo: string
  space: string
  /** Drop ETags and cursors and read everything. */
  full?: boolean
  /** Run now even if the repository is not due. */
  force?: boolean
}

export interface SyncStats {
  pulls: number
  issues: number
  comments: number
  requests: number
  notModified: number
  removed: number
}

export interface SyncResult {
  ok: boolean
  skipped?: "detached" | "not due" | "running"
  stats?: SyncStats
  error?: { reason: string; message: string; fix?: string }
}

/** How far back the first sync reads (a full resync reads everything). */
export const INITIAL_DAYS = 90
const DAY = 86_400_000

export const repoUri = (id: string) => `gh-repo://${id}`

export interface Cursors {
  pulls?: string
  issues?: string
  comments?: string
  reviewComments?: string
  full?: string
}

const ts = (v: unknown) => (v ? Date.parse(String(v)) : 0)
const later = (a: string | undefined, b: string) => (a && ts(a) > ts(b) ? a : b)

/** The effective poll interval: webhooks reaching the server turn polling into a reconciliation. */
export function intervalSecs(repo: Rows, now = Date.now()): number {
  const hooked = repo.lastWebhookAt && now - ts(repo.lastWebhookAt) < DAY
  return Math.max(15, hooked ? Math.max(repo.pollSecs ?? 60, 900) : (repo.pollSecs ?? 60))
}

export async function patchRepo(data: GhCollections, repo: Rows, patch: Fields) {
  const keys = Object.keys(patch).filter(
    (k) => JSON.stringify(patch[k]) !== JSON.stringify(repo[k] ?? null) && patch[k] !== repo[k],
  )
  if (keys.length === 0) return repo
  const next = await data.repos.update(repo.id, Object.fromEntries(keys.map((k) => [k, patch[k]])) as never)
  Object.assign(repo, next)
  return repo
}

export function syncRepo(sv: Services, ctx: Ctx, p: SyncParams): Promise<SyncResult> {
  if (isRunning(`repo:${p.repo}`) && !p.force && !p.full)
    return Promise.resolve({ ok: true, skipped: "running" })
  return withLock(`repo:${p.repo}`, () => run(sv, ctx, p))
}

async function run(sv: Services, ctx: Ctx, p: SyncParams): Promise<SyncResult> {
  const data = gh(ctx).space(p.space)
  const repo = (await data.repos.get(p.repo)) as RepoRow | null
  if (!repo) return { ok: true, skipped: "detached" }
  if (!p.force && !p.full && repo.nextSyncAt && ts(repo.nextSyncAt) - Date.now() > 5000)
    return { ok: true, skipped: "not due" }

  const started = Date.now()
  const prior = { status: repo.status as string, errorCode: repo.errorCode as string }
  const stats: SyncStats = { pulls: 0, issues: 0, comments: 0, requests: 0, notModified: 0, removed: 0 }
  let ghClient: Gh | null = null
  try {
    ghClient = await sv.pool.forRepo(ctx, repo)
    const before = { requests: ghClient.http.stats.requests, notModified: ghClient.http.stats.notModified }
    if (repo.status !== "syncing") await patchRepo(data, repo, { status: "syncing" })
    if (p.full) ghClient.http.forget()
    const cursors: Cursors = p.full ? {} : { ...(repo.cursors ?? {}) }
    const initial = !repo.lastSyncAt
    const events: Array<{ entity: string; planned: Planned[] }> = []

    const meta = await ghClient.guard(`the repository ${repo.fullName}`, () =>
      ghClient!.api.repo(repo.fullName),
    )
    const metaPatch: Fields = { ...(await renamedFields(sv, p, repo, meta.data, ghClient)) }

    const ctxRepo = { ...repo, ...metaPatch } as Rows
    const since = p.full
      ? undefined
      : (cursors.pulls ?? new Date(Date.now() - INITIAL_DAYS * DAY).toISOString())
    const work = new Work(sv, ctx, ghClient, data, ctxRepo, initial, events)
    // The repository's issues live in a project: link one (creating it, as the person this sync runs for).
    await work.project()

    await ghClient.guard("pull requests", () => work.pulls(since, p.full ?? false, cursors, stats))
    await ghClient.guard("issues", () =>
      work.issues(p.full ? undefined : (cursors.issues ?? since), cursors, stats),
    )
    await ghClient.guard("comments", () =>
      work.comments(p.full ? undefined : (cursors.comments ?? since), cursors, stats),
    )
    await ghClient.guard("comment counts", () => work.verifyCounts())
    if (p.full) stats.removed = await ghClient.guard("deleted items", () => work.removed())

    for (const e of events)
      await sv.notifier.deliver(ctx, String(repo.host), e.entity, e.planned, ghClient.api)

    stats.requests = ghClient.http.stats.requests - before.requests
    stats.notModified = ghClient.http.stats.notModified - before.notModified
    const now = Date.now()
    const rate = ghClient.http.rate
    await patchRepo(data, repo, {
      ...metaPatch,
      status: "ok",
      errorCode: "",
      lastError: "",
      errorFix: "",
      lastSyncAt: new Date(now).toISOString(),
      lastSyncMs: now - started,
      lastSyncStats: stats,
      nextSyncAt: new Date(now + intervalSecs(repo, now) * 1000).toISOString(),
      cursors: { ...cursors, ...(p.full ? { full: new Date(now).toISOString() } : {}) },
      rateLimit: rate
        ? {
            limit: rate.limit,
            remaining: rate.remaining,
            resetAt: new Date(rate.reset * 1000).toISOString(),
            at: new Date(rate.at).toISOString(),
          }
        : null,
      openPulls: await data.prs.count({ where: { repo: repoUri(repo.id), state: "open" } as never }),
    })
    return { ok: true, stats }
  } catch (e) {
    return recordFailure(
      sv,
      ctx,
      data,
      repo,
      prior,
      e,
      ghClient?.who ?? { name: "the connection", kind: "token" },
    )
  }
}

/** A repository that was renamed or transferred answers its old name with a redirect: follow it. */
async function renamedFields(
  sv: Services,
  p: SyncParams,
  repo: Rows,
  meta: { full_name: string; default_branch: string } & Rows,
  ghClient: Gh,
): Promise<Fields> {
  const f: Fields = {}
  if (meta.full_name && meta.full_name !== repo.fullName) {
    f.fullName = meta.full_name
    f.owner = meta.owner?.login
    f.name = meta.name
    f.htmlUrl = meta.html_url
    const key = (full: string) => `${new URL(ghClient.web).host}/${full}`.toLowerCase()
    const routes = await ghGlobal(sv.rookery).routes.find({
      where: { repoKey: key(repo.fullName), inSpace: p.space } as never,
      limit: 1,
    })
    if (routes.rows[0])
      await ghGlobal(sv.rookery).routes.update(routes.rows[0].id, {
        repoKey: key(meta.full_name),
      } as never)
    sv.rookery.log.info(`${repo.fullName} is now ${meta.full_name}`)
  }
  Object.assign(f, {
    githubId: meta.id,
    description: meta.description ?? "",
    defaultBranch: meta.default_branch,
    private: !!meta.private,
    archived: !!meta.archived,
    permissions: meta.permissions ?? null,
    mergeMethods: {
      merge: meta.allow_merge_commit !== false,
      squash: meta.allow_squash_merge !== false,
      rebase: meta.allow_rebase_merge !== false,
    },
  })
  return f
}

async function recordFailure(
  sv: Services,
  ctx: Ctx,
  data: GhCollections,
  repo: Rows,
  prior: { status: string; errorCode: string },
  e: unknown,
  who: Whose,
): Promise<SyncResult> {
  const x = explain(
    e instanceof Error && "code" in e && !(e instanceof GitHubError) ? (e as unknown as GitHubError) : e,
    who,
    `the repository ${repo.fullName}`,
  )
  const gone =
    e instanceof GitHubError
      ? e.kind === "not_found"
      : (e as { details?: { reason?: string } }).details?.reason === "github_not_found"
  const reason = (e as { details?: { reason?: string } }).details?.reason ?? x.reason
  const message = e instanceof GitHubError ? x.message : ((e as Error).message ?? x.message)
  const fix = (e as { details?: { fix?: string } }).details?.fix ?? x.fix
  const retryAt =
    x.retryAt ??
    Date.parse(String((e as { details?: { retryAt?: string } }).details?.retryAt ?? "")) ??
    undefined
  const now = Date.now()
  const credentials = /token_rejected|forbidden|sso|no_connection/.test(reason)
  const wait =
    retryAt && Number.isFinite(retryAt)
      ? Math.max(30_000, retryAt - now)
      : (credentials || gone ? 900 : Math.max(120, repo.pollSecs ?? 60)) * 1000
  // Told once per kind of trouble: not again while it lasts.
  const firstTime = (prior.status !== "error" && prior.status !== "gone") || prior.errorCode !== reason
  sv.rookery.log.warn(`sync of ${repo.fullName} failed: ${reason}: ${message}`)
  await patchRepo(data, repo, {
    status: gone ? "gone" : "error",
    errorCode: reason,
    lastError: message,
    errorFix: fix ?? "",
    lastSyncMs: null,
    nextSyncAt: new Date(now + wait).toISOString(),
  }).catch(() => {})
  if (
    firstTime &&
    repo.syncedBy &&
    reason !== "github_rate_limited" &&
    reason !== "github_secondary_limit" &&
    reason !== "github_unreachable"
  ) {
    try {
      if (await sv.notifier.wants(ctx, repo.syncedBy, "checks_failed", repoUri(repo.id)).catch(() => false)) {
        await sv.notifier.send(
          repo.syncedBy,
          "sync_failed",
          `${repo.fullName} stopped syncing: ${message}${fix ? ` ${fix}` : ""}`,
          repoUri(repo.id),
        )
      }
    } catch (err) {
      sv.rookery.log.warn(
        `could not tell ${repo.syncedBy} that ${repo.fullName} stopped syncing: ${(err as Error).message}`,
      )
    }
  }
  return { ok: false, error: { reason, message, fix } }
}

/** One run's state, so the steps share the repository, the connection and the notifications they collect. */
export class Work {
  private touched: Array<{ kind: "pr"; row: Rows }> = []
  /** What a full pass listed, to find what GitHub no longer has. */
  private seen = { pr: new Set<number>(), issue: new Set<number>() }
  private pullsByNumber = new Map<number, Rows>()
  /** Issues this run wrote to Projects, by number: their id on GitHub and how many comments GitHub has. */
  private issuesByNumber = new Map<number, { external: string; comments: number }>()
  private link: { space: string; link: string } | null | undefined

  constructor(
    private readonly sv: Services,
    private readonly ctx: Ctx,
    private readonly gh: Gh,
    private readonly data: GhCollections,
    private readonly repo: Rows,
    private readonly initial: boolean,
    private readonly events: Array<{ entity: string; planned: Planned[] }>,
  ) {}

  private get uri() {
    return repoUri(this.repo.id)
  }

  private get host() {
    return String(this.repo.host ?? new URL(this.gh.web).host)
  }

  /** The project the repository's issues go to; null while it has none (no person to create it yet). */
  async project() {
    if (this.link === undefined)
      this.link = await ensureProject(this.sv, this.ctx, this.repo).catch((e) => {
        this.sv.rookery.log.warn(`linking ${this.repo.fullName} to a project failed: ${(e as Error).message}`)
        return null
      })
    return this.link
  }

  get linked() {
    return !!this.link
  }

  private target() {
    return { provider: PROVIDER, repository: this.uri, repoSpace: this.repo.spaceId }
  }

  /** Writes GitHub issues to Projects. Returns how many changed. */
  async writeIssues(items: GhIssue[]): Promise<number> {
    if (!items.length || !(await this.project())) return 0
    const mapped = await mapLimit(items, 4, (i) => sourceIssue(this.sv, this.host, this.repo, i, this.gh.api))
    let changed = 0
    for (let at = 0; at < mapped.length; at += CHUNK) {
      const r = (await projects(this.sv)["issues.upsertFromSource"]!(this.ctx, {
        ...this.target(),
        items: mapped.slice(at, at + CHUNK),
        quiet: this.initial,
      })) as { issues: Array<{ external: string; changed: boolean }> }
      for (const x of r.issues ?? []) if (x.changed) changed++
      for (const m of mapped.slice(at, at + CHUNK))
        this.issuesByNumber.set(m.number as number, {
          external: String(m.external),
          comments: Number(m.comments ?? 0),
        })
    }
    return changed
  }

  /** Writes one issue's comments to Projects; `complete` when they are all it has on GitHub. */
  async writeComments(n: number, comments: GhComment[], complete = false): Promise<number> {
    if (!(await this.project())) return 0
    const mapped = await mapLimit(comments, 4, (c) => sourceComment(this.sv, this.host, c, this.gh.api))
    const r = (await projects(this.sv)["comments.upsertFromSource"]!(this.ctx, {
      ...this.target(),
      number: n,
      comments: mapped,
      complete,
      quiet: this.initial,
    })) as { created?: number; updated?: number; removed?: number }
    return (r.created ?? 0) + (r.updated ?? 0) + (r.removed ?? 0)
  }

  // ── Pull requests ────────────────────────────────────────────────────────────────────────────────

  async pulls(since: string | undefined, full: boolean, cursors: Cursors, stats: SyncStats) {
    const changed: GhPullListItem[] = []
    let max = cursors.pulls ?? ""
    outer: for await (const page of this.gh.api.pulls(this.repo.fullName)) {
      if (page.notModified && page.page === 1 && !full) break
      for (const pr of page.items) {
        if (since && ts(pr.updated_at) < ts(since)) break outer
        changed.push(pr)
        this.seen.pr.add(pr.number)
        max = later(max, pr.updated_at)
      }
    }
    const rows = await existing(
      this.data.prs,
      "number",
      this.uri,
      changed.map((c) => c.number),
    )
    const needs = changed.filter(
      (c) =>
        full ||
        !rows.get(c.number) ||
        ts(rows.get(c.number)!.ghUpdatedAt) !== ts(c.updated_at) ||
        rows.get(c.number)!.additions == null,
    )
    // Open pull requests whose checks have not settled are looked at again, whether or not the pull request
    // changed.
    const open = (
      await this.data.prs.find({ where: { repo: this.uri, state: "open" } as never, limit: 1000 })
    ).rows as Rows[]
    const recheck = open.filter(
      (r) =>
        !needs.some((n) => n.number === r.number) &&
        (r.checksState === "pending" || r.checksState === "none" || ts(r.checks?.at) < Date.now() - 600_000),
    )
    const fresh = (await mapLimit(needs, 4, (n) => this.buildPull(n, rows.get(n.number) ?? null))).filter(
      Boolean,
    ) as Fields[]
    const rechecked = (await mapLimit(recheck, 4, async (r) => ({ ...(await this.checksOnly(r)) }))).filter(
      (f) => f.number,
    ) as Fields[]
    const res = await upsertMany(this.data, "prs", this.uri, "number", [...fresh, ...rechecked])
    this.afterItems("pr", res)
    stats.pulls += res.created.length + res.updated.length
    if (max) cursors.pulls = max
    for (const r of [...res.created, ...res.updated.map((u) => u.after), ...res.unchanged])
      this.pullsByNumber.set(r.number, r)
    for (const r of rows.values()) if (!this.pullsByNumber.has(r.number)) this.pullsByNumber.set(r.number, r)
  }

  /** Everything about one pull request, from GitHub. */
  async buildPull(item: GhPullListItem | GhPull, before: Rows | null): Promise<Fields> {
    const full = this.repo.fullName
    const detail =
      "additions" in item && (item as GhPull).additions !== undefined
        ? (item as GhPull)
        : (await this.gh.api.pull(full, item.number)).data
    const [reviews, checks] = await Promise.all([
      this.gh.api.reviews(full, item.number),
      detail.state === "open" ? this.gh.api.checks(full, detail.head.sha) : Promise.resolve(undefined),
    ])
    const f = mapPull(this.uri, full, detail, { reviews, checks })
    if (!checks && before?.checks) delete f.checks
    if (checks) f.checks = { ...(f.checks as object), at: new Date().toISOString() }
    f.links = await this.sv.linker.linksFor(this.ctx, this.repo.spaceId ?? this.ctx.space ?? "", {
      title: detail.title,
      body: detail.body ?? "",
      head: detail.head.ref,
    })
    f.sessions = await this.sv.linker.sessionsFor(
      this.data,
      full,
      detail.head.ref,
      detail.head.sha,
      async () => (await this.gh.api.commits(full, item.number)).map((c) => c.sha),
    )
    await this.reviewRows(item.number, reviews)
    return f
  }

  private async checksOnly(row: Rows): Promise<Fields> {
    const checks = await this.gh.api.checks(this.repo.fullName, row.headSha)
    return {
      number: row.number,
      checksState: checks.state,
      checks: {
        total: checks.total,
        passed: checks.passed,
        failed: checks.failed,
        pending: checks.pending,
        items: checks.items.slice(0, 20),
        at: new Date().toISOString(),
      },
    }
  }

  private async reviewRows(n: number, reviews: GhReview[]) {
    const rows = reviews
      .filter((r) => r.state !== "PENDING" && (r.body || r.state !== "COMMENTED"))
      .map((r) => mapComment(this.uri, "review", "pr", n, r))
    if (rows.length === 0) return
    const res = await upsertMany(this.data, "comments", this.uri, "ghId", rows, { kind: "review" })
    if (!this.initial) {
      const item = this.pullsByNumber.get(n) ?? null
      for (const c of res.created)
        this.plan(`gh-pr://${item?.id ?? ""}`, item ? planComment(this.repo.fullName, item, c) : [], !!item)
    }
  }

  // ── Issues ───────────────────────────────────────────────────────────────────────────────────────

  async issues(since: string | undefined, cursors: Cursors, stats: SyncStats) {
    const items: GhIssue[] = []
    let max = cursors.issues ?? ""
    for await (const page of this.gh.api.issues(this.repo.fullName, since)) {
      if (page.notModified && page.page === 1 && since && !items.length && cursors.issues) break
      for (const i of page.items) {
        max = later(max, i.updated_at)
        if (!i.pull_request) {
          items.push(i)
          this.seen.issue.add(i.number)
        }
      }
    }
    // Without a project yet the cursor stays, so the issues come in once there is one.
    if (items.length && !(await this.project())) return
    stats.issues += await this.writeIssues(items)
    if (max) cursors.issues = max
  }

  // ── Comments ─────────────────────────────────────────────────────────────────────────────────────

  async comments(since: string | undefined, cursors: Cursors, stats: SyncStats) {
    for (const [list, field, kind] of [
      [this.gh.api.issueComments(this.repo.fullName, since), "comments", "comment"],
      [this.gh.api.reviewComments(this.repo.fullName, since), "reviewComments", "review_comment"],
    ] as const) {
      const got: GhComment[] = []
      let max = (cursors as Record<string, string | undefined>)[field] ?? ""
      for await (const page of list) {
        if (
          page.notModified &&
          page.page === 1 &&
          since &&
          (cursors as Record<string, string | undefined>)[field]
        )
          break
        for (const c of page.items) {
          got.push(c)
          max = later(max, c.updated_at)
        }
      }
      stats.comments += await this.storeComments(got, kind)
      if (max) (cursors as Record<string, string>)[field] = max
    }
  }

  /** Stores comments of known items; returns how many were new or changed. Issue comments go to Projects. */
  async storeComments(got: GhComment[], kind: "comment" | "review_comment"): Promise<number> {
    if (got.length === 0) return 0
    const numbers = [...new Set(got.map(commentNumber).filter((n): n is number => n !== null))]
    const missingPr = numbers.filter((n) => !this.pullsByNumber.has(n))
    if (missingPr.length)
      for (const [n, r] of await existing(this.data.prs, "number", this.uri, missingPr))
        this.pullsByNumber.set(n as number, r)
    const mapped: Fields[] = []
    const onIssues = new Map<number, GhComment[]>()
    for (const c of got) {
      const n = commentNumber(c)
      if (n === null) continue
      if (this.pullsByNumber.has(n)) mapped.push(mapComment(this.uri, kind, "pr", n, c))
      else if (kind === "comment") onIssues.set(n, [...(onIssues.get(n) ?? []), c])
    }
    let changed = 0
    for (const [n, list] of onIssues) changed += await this.writeComments(n, list)
    const res = await upsertMany(this.data, "comments", this.uri, "ghId", mapped, { kind })
    if (!this.initial) {
      for (const c of res.created) {
        const item = this.pullsByNumber.get(c.number)
        if (item) this.plan(`gh-pr://${item.id}`, planComment(this.repo.fullName, item, c), true)
      }
    }
    // Comments GitHub has since deleted are not in a `since` list: when an item has fewer comments than we
    // hold, read its comments again and drop the extras.
    const changedItems = new Set(res.created.concat(res.updated.map((u) => u.after)).map((c) => c.number))
    for (const num of changedItems) {
      const item = this.pullsByNumber.get(Number(num))
      if (item) await this.reconcileComments(item, "pr", kind)
    }
    return changed + res.created.length + res.updated.length
  }

  /** Deletes stored comments of an item that GitHub no longer lists. */
  async reconcileComments(item: Rows, onKind: "pr", kind: "comment" | "review_comment") {
    const stored = (
      await this.data.comments.find({
        where: { repo: this.uri, onKind, number: item.number, kind } as never,
        limit: 1000,
      })
    ).rows as Rows[]
    const theirs =
      kind === "comment"
        ? await this.gh.api.commentsOf(this.repo.fullName, item.number)
        : await this.gh.api.reviewCommentsOf(this.repo.fullName, item.number)
    const ids = new Set(theirs.map((c) => c.id))
    const gone = stored.filter((r) => !ids.has(r.ghId))
    for (const r of gone) await this.data.comments.delete(r.id)
  }

  // ── Webhook-style single-item refreshes ──────────────────────────────────────────────────────────

  async refreshPull(n: number): Promise<{ before: Rows | null; after: Rows } | null> {
    const before =
      ((await existing(this.data.prs, "number", this.uri, [n])).get(n) as Rows | undefined) ?? null
    let detail: GhPull
    try {
      detail = (await this.gh.api.pull(this.repo.fullName, n)).data
    } catch (e) {
      if (e instanceof GitHubError && (e.kind === "not_found" || e.kind === "gone")) return null
      throw e
    }
    const f = await this.buildPull(detail, before)
    const res = await upsertMany(this.data, "prs", this.uri, "number", [f])
    this.afterItems("pr", res)
    const after = res.created[0] ?? res.updated[0]?.after ?? res.unchanged[0] ?? before
    if (after) this.pullsByNumber.set(n, after)
    await this.itemComments(n, "pr")
    return after ? { before, after } : null
  }

  /** Reads one issue again from GitHub into its Projects issue, with all of its comments. */
  async refreshIssue(n: number): Promise<{ number: number } | Rows | null> {
    let issue: GhIssue
    try {
      issue = (await this.gh.api.issue(this.repo.fullName, n)).data
    } catch (e) {
      if (e instanceof GitHubError && (e.kind === "not_found" || e.kind === "gone")) return null
      throw e
    }
    if (issue.pull_request) return (await this.refreshPull(n))?.after ?? null
    if (!(await this.project())) return null
    await this.writeIssues([issue])
    await this.itemComments(n, "issue")
    return { number: n }
  }

  /** All comments of one item, and the deletion of those that are gone. */
  async itemComments(n: number, onKind: "pr" | "issue") {
    const comments = await this.gh.api.commentsOf(this.repo.fullName, n)
    if (onKind === "issue") {
      await this.writeComments(n, comments, true)
      return
    }
    await this.storeComments(comments, "comment")
    const item = this.pullsByNumber.get(n)
    if (item) await this.reconcileComments(item, "pr", "comment")
    await this.storeComments(await this.gh.api.reviewCommentsOf(this.repo.fullName, n), "review_comment")
    if (item) await this.reconcileComments(item, "pr", "review_comment")
  }

  /** Refreshes only the checks of pull requests whose head is `sha`. */
  async refreshChecks(sha: string, numbers: number[] = []) {
    const rows = (await this.data.prs.find({ where: { repo: this.uri, headSha: sha } as never, limit: 20 }))
      .rows as Rows[]
    for (const n of numbers)
      if (!rows.some((r) => r.number === n)) {
        const r = (await existing(this.data.prs, "number", this.uri, [n])).get(n)
        if (r) rows.push(r)
      }
    const checks = rows.length ? await this.gh.api.checks(this.repo.fullName, sha) : null
    if (!checks) return
    const fields = rows.map((r) => ({
      number: r.number,
      checksState: checks.state,
      checks: {
        total: checks.total,
        passed: checks.passed,
        failed: checks.failed,
        pending: checks.pending,
        items: checks.items.slice(0, 20),
        at: new Date().toISOString(),
      },
    }))
    const res = await upsertMany(this.data, "prs", this.uri, "number", fields)
    this.afterItems("pr", res)
  }

  /**
   * GitHub says how many comments an item has; when we hold a different number (a comment was deleted, which a
   * `since` list does not show, or one is missing), read that item's comments again and make them match.
   */
  async verifyCounts(): Promise<number> {
    let fixed = 0
    const seen = new Set<string>()
    for (const { kind, row } of this.touched) {
      const key = `${kind}:${row.number}`
      if (seen.has(key) || (kind === "pr" && row.additions == null)) continue
      seen.add(key)
      const stored = await this.data.comments.count({
        where: {
          repo: this.uri,
          onKind: kind,
          number: row.number,
          kind: { in: ["comment", "review_comment"] },
        } as never,
      })
      if (stored !== (row.commentCount ?? 0)) {
        await this.itemComments(row.number, kind)
        fixed++
      }
    }
    // Issues: Projects says how many synced comments it holds now.
    if (this.issuesByNumber.size && this.linked) {
      const held = (await projects(this.sv)["issues.listFromSource"]!(this.ctx, {
        ...this.target(),
        externals: [...this.issuesByNumber.values()].map((i) => i.external),
        comments: true,
      })) as Array<{ number: number; external: string; comments?: number }>
      const count = new Map(held.map((h) => [h.external, h.comments ?? 0]))
      for (const [n, i] of this.issuesByNumber) {
        if ((count.get(i.external) ?? -1) === i.comments || !count.has(i.external)) continue
        await this.itemComments(n, "issue")
        fixed++
      }
    }
    return fixed
  }

  // ── Removal ──────────────────────────────────────────────────────────────────────────────────────

  /** Marks stored items GitHub no longer has: deleted, or transferred to another repository. */
  async removed(): Promise<number> {
    let count = 0
    const prs = (await this.data.prs.find({ where: { repo: this.uri } as never, limit: 1000 })).rows as Rows[]
    const issues = (await this.project())
      ? ((await projects(this.sv)["issues.listFromSource"]!(this.ctx, this.target())) as Array<{
          number: number
          external: string
          removed?: string | null
        }>)
      : []
    const stale = [
      ...prs
        .filter((r) => !r.removed && !this.seen.pr.has(r.number))
        .map((r) => ({ kind: "pr" as const, r })),
      ...issues
        .filter((r) => !r.removed && !this.seen.issue.has(r.number))
        .map((r) => ({ kind: "issue" as const, r: r as Rows })),
    ].slice(0, 200)
    const checked = await mapLimit(stale, 4, async (x) => {
      try {
        await this.gh.api.issue(this.repo.fullName, x.r.number)
        return null
      } catch (e) {
        if (!(e instanceof GitHubError)) throw e
        if (e.kind === "gone" || e.kind === "not_found")
          return { ...x, removed: "deleted" as const, movedTo: "" }
        if (e.kind === "moved")
          return { ...x, removed: "transferred" as const, movedTo: e.extra.location ?? "" }
        throw e
      }
    })
    for (const x of checked) {
      if (!x) continue
      if (x.kind === "pr") await this.data.prs.update(x.r.id, { removed: x.removed } as never)
      else
        await projects(this.sv)["issues.removedAtSource"]!(this.ctx, {
          ...this.target(),
          external: x.r.external,
          removed: x.removed,
        })
      count++
    }
    return count
  }

  // ── Notifications ────────────────────────────────────────────────────────────────────────────────

  private afterItems(kind: "pr", res: Awaited<ReturnType<typeof upsertMany>>) {
    for (const r of [...res.created, ...res.updated.map((u) => u.after)]) this.touched.push({ kind, row: r })
    if (this.initial) return
    for (const row of res.created)
      this.plan(`gh-pr://${row.id}`, planItem(kind, this.repo.fullName, null, row), true)
    for (const u of res.updated)
      this.plan(`gh-pr://${u.after.id}`, planItem(kind, this.repo.fullName, u.before, u.after), true)
  }

  private plan(entity: string, planned: Planned[], ok: boolean) {
    if (ok && planned.length) this.events.push({ entity, planned })
  }
}

export { summariseChecks }
