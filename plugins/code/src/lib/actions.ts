// What a person does to a pull request or an issue from Crow, and what the views read on demand.
// Writes go to GitHub first, as the person when they have their own token (else as the app), and then the
// item is read back, so the stored row, every open view and the inbox follow what GitHub now says.
// Reads of big or short-lived things (files, commits, the timeline, check logs) are not stored: they are
// fetched here when a view asks, through the same ETag cache.
import { type Ctx, RookeryError } from "@rookery/sdk"
import type { MergeMethod, ReviewEvent } from "./api"
import { rookeryError } from "./errors"
import { GitHubError } from "./http"
import type { Planned } from "./notifier"
import type { Gh } from "./pool"
import { apiBaseFor, parseRepo } from "./repos"
import { ghGlobal, ghSpace, type RepoRow, type Rows } from "./rows"
import { lookupEntity, requireLevel } from "./sdk"
import { withLock } from "./store"
import { type Services, Work } from "./sync"
import { needUser } from "./user"

export interface Target {
  kind: "pr" | "issue"
  uri: string
  row: Rows
  repo: Rows
  space: string
  gh: Gh
}

/** The item behind a `gh-pr://` URI, checked against the caller's access. */
export async function target(
  sv: Services,
  ctx: Ctx,
  uri: string,
  level: "view" | "use",
  opts: { read?: boolean } = {},
): Promise<Target> {
  const m = /^gh-(pr):\/\/(.+)$/.exec(uri)
  if (!m) throw new RookeryError("INVALID", `${uri} is not a pull request of this plugin.`)
  const kind = m[1] as "pr"
  const info = await lookupEntity(sv.rookery, ctx, uri)
  if (!info?.spaceId) throw new RookeryError("NOT_FOUND", "No such pull request, or you cannot see it.")
  await requireLevel(ctx, uri, level)
  const sdata = ghSpace(sv.rookery, info.spaceId)
  const row = (await sdata.prs.get(m[2]!)) as Rows | null
  if (!row) throw new RookeryError("NOT_FOUND", "No such pull request.")
  const repo = (await sdata.repos.get(String(row.repo).replace("gh-repo://", ""))) as Rows | null
  if (!repo) throw new RookeryError("NOT_FOUND", "Its repository is no longer attached.")
  const ghClient = opts.read
    ? await sv.pool.forRepo(ctx, repo).catch(() => sv.pool.forAction(ctx, repo))
    : await sv.pool.forAction(ctx, repo)
  return { kind, uri, row, repo, space: info.spaceId, gh: ghClient }
}

/** Reads the item again from GitHub into its row (and its comments), and tells whoever should hear of it. */
export async function refresh(sv: Services, ctx: Ctx, t: Target): Promise<Rows | null> {
  return withLock(`repo:${t.repo.id}`, async () => {
    const events: Array<{ entity: string; planned: Planned[] }> = []
    const work = new Work(sv, ctx, t.gh, ghSpace(sv.rookery, t.space), t.repo, false, events)
    const after = (await work.refreshPull(t.row.number))?.after ?? null
    for (const e of events) await sv.notifier.deliver(ctx, String(t.repo.host), e.entity, e.planned, t.gh.api)
    return after
  })
}

const trim = (s: unknown, max: number) => {
  const t = String(s ?? "")
  return t.length > max ? `${t.slice(0, max)}\n… (${t.length - max} more characters)` : t
}

const METHODS: MergeMethod[] = ["merge", "squash", "rebase"]

export const read = {
  async files(sv: Services, ctx: Ctx, p: { uri: string }) {
    const t = await target(sv, ctx, p.uri, "view", { read: true })
    const files = await t.gh.guard("the files of this pull request", () =>
      t.gh.api.files(t.repo.fullName, t.row.number),
    )
    return files
      .slice(0, 300)
      .map((f) => ({ ...f, patch: f.patch === undefined ? undefined : trim(f.patch, 120_000) }))
  },
  async commits(sv: Services, ctx: Ctx, p: { uri: string }) {
    const t = await target(sv, ctx, p.uri, "view", { read: true })
    return (
      await t.gh.guard("the commits of this pull request", () =>
        t.gh.api.commits(t.repo.fullName, t.row.number),
      )
    ).map((c) => ({
      sha: c.sha,
      message: c.commit.message,
      author: c.author?.login ?? c.commit.author?.name ?? "",
      date: c.commit.author?.date ?? "",
      url: c.html_url ?? "",
    }))
  },
  async timeline(sv: Services, ctx: Ctx, p: { uri: string }) {
    const t = await target(sv, ctx, p.uri, "view", { read: true })
    const events = await t.gh.guard("the timeline", () => t.gh.api.timeline(t.repo.fullName, t.row.number))
    // Comments and reviews come from the stored rows (live); the timeline adds what happened around them.
    return events
      .filter(
        (e) =>
          ![
            "commented",
            "reviewed",
            "line-commented",
            "cross-referenced",
            "subscribed",
            "mentioned",
          ].includes(e.event) || e.event === "committed",
      )
      .map((e) => ({
        id: e.id ?? null,
        event: e.event,
        at: e.created_at ?? e.submitted_at ?? e.author?.date ?? "",
        actor: e.actor?.login ?? e.user?.login ?? e.author?.name ?? "",
        label: e.label?.name ?? "",
        target: e.assignee?.login ?? e.requested_reviewer?.login ?? "",
        message: e.message ?? "",
        sha: e.sha ?? e.commit_id ?? "",
      }))
  },
  /** The check runs of the head commit with what GitHub says about each, from GitHub now. */
  async checks(sv: Services, ctx: Ctx, p: { uri: string }) {
    const t = await target(sv, ctx, p.uri, "view", { read: true })
    const sha = String(t.row.headSha ?? "")
    if (!sha) return { sha, runs: [], summary: null }
    const [runs, summary] = await t.gh.guard(
      "the checks",
      async () =>
        [
          await t.gh.api.checkRuns(t.repo.fullName, sha),
          await t.gh.api.checks(t.repo.fullName, sha),
        ] as const,
    )
    return {
      sha,
      runs: runs.data.check_runs.map((r) => ({
        id: r.id,
        name: r.name,
        status: r.status,
        conclusion: r.conclusion,
        url: r.html_url ?? r.details_url ?? "",
        startedAt: r.started_at ?? null,
        completedAt: r.completed_at ?? null,
        app: r.app?.name ?? "",
        summary: r.output?.title ?? "",
      })),
      summary,
    }
  },
  async checkLog(sv: Services, ctx: Ctx, p: { uri: string; run: number }) {
    const t = await target(sv, ctx, p.uri, "view", { read: true })
    try {
      return { log: await t.gh.api.jobLog(t.repo.fullName, p.run) }
    } catch (e) {
      if (e instanceof GitHubError && (e.kind === "not_found" || e.kind === "gone")) {
        return {
          log: "",
          unavailable:
            "GitHub has no log for this check (it is not a GitHub Actions job, or the log has expired).",
        }
      }
      throw rookeryError(e, t.gh.who, "the log of this check")
    }
  },
  async mergeInfo(sv: Services, ctx: Ctx, p: { uri: string }) {
    const t = await target(sv, ctx, p.uri, "view")
    const row = t.row
    const methods = (t.repo.mergeMethods ?? { merge: true, squash: true, rebase: true }) as Record<
      MergeMethod,
      boolean
    >
    const blockers: string[] = []
    if (row.state !== "open")
      blockers.push(row.state === "merged" ? "It is already merged." : "It is closed.")
    if (row.draft) blockers.push("It is a draft.")
    if (row.mergeable === "conflicting") blockers.push("It has conflicts with the base branch.")
    if (row.reviewState === "changes_requested") blockers.push("Changes were requested.")
    if (row.checksState === "failure") blockers.push("Checks are failing.")
    if (row.checksState === "pending") blockers.push("Checks are still running.")
    const canWrite = t.repo.permissions ? !!(t.repo.permissions as { push?: boolean }).push : true
    return {
      methods,
      allowed: METHODS.filter((m) => methods[m]),
      blockers,
      canWrite,
      headSha: row.headSha,
      title: row.title,
      number: row.number,
    }
  },
  async labels(sv: Services, ctx: Ctx, p: { uri: string }) {
    const t = await target(sv, ctx, p.uri, "view", { read: true })
    const [labels, people] = await t.gh.guard(
      "the repository's labels",
      async () =>
        [await t.gh.api.labels(t.repo.fullName), await t.gh.api.assignable(t.repo.fullName)] as const,
    )
    return {
      labels: labels.map((l) => ({ name: l.name, color: l.color ?? "" })),
      people: people.map((u) => u.login),
    }
  },
}

export const write = {
  async comment(sv: Services, ctx: Ctx, p: { uri: string; body: string }) {
    needUser(ctx)
    const body = p.body.trim()
    if (!body) throw new RookeryError("INVALID", "A comment cannot be empty.")
    const t = await target(sv, ctx, p.uri, "use")
    const c = await t.gh.guard("comment", () => t.gh.api.comment(t.repo.fullName, t.row.number, body))
    // The comment is stored at once, so every open view shows it before the next sync or webhook.
    await withLock(`repo:${t.repo.id}`, async () => {
      const work = new Work(sv, ctx, t.gh, ghSpace(sv.rookery, t.space), t.repo, true, [])
      await work.storeComments([c.data], "comment")
    })
    return { id: c.data.id, url: c.data.html_url }
  },

  async review(sv: Services, ctx: Ctx, p: { uri: string; event: ReviewEvent; body?: string }) {
    needUser(ctx)
    const t = await target(sv, ctx, p.uri, "use")
    if (t.kind !== "pr") throw new RookeryError("INVALID", "Only pull requests are reviewed.")
    if (p.event !== "APPROVE" && !p.body?.trim())
      throw new RookeryError(
        "INVALID",
        p.event === "REQUEST_CHANGES"
          ? "Say what should change when you request changes."
          : "A review comment cannot be empty.",
      )
    await t.gh.guard("review this pull request", () =>
      t.gh.api.review(t.repo.fullName, t.row.number, p.event, p.body?.trim() ?? "", String(t.row.headSha)),
    )
    return refresh(sv, ctx, t)
  },

  async merge(
    sv: Services,
    ctx: Ctx,
    p: { uri: string; method: MergeMethod; title?: string; message?: string },
  ) {
    needUser(ctx)
    const t = await target(sv, ctx, p.uri, "use")
    if (t.kind !== "pr") throw new RookeryError("INVALID", "Only pull requests are merged.")
    const methods = (t.repo.mergeMethods ?? { merge: true, squash: true, rebase: true }) as Record<
      MergeMethod,
      boolean
    >
    if (!methods[p.method]) {
      const ok = METHODS.filter((m) => methods[m])
      throw new RookeryError(
        "INVALID",
        `${p.method} merges are not allowed on ${t.repo.fullName}${ok.length ? ` (allowed: ${ok.join(", ")})` : ""}.`,
      )
    }
    // Merging the commit the person saw: if the branch moved meanwhile GitHub answers 409 and nothing merges.
    await t.gh.guard("merge this pull request", () =>
      t.gh.api.merge(t.repo.fullName, t.row.number, {
        method: p.method,
        title: p.title,
        message: p.message,
        sha: String(t.row.headSha),
      }),
    )
    return refresh(sv, ctx, t)
  },

  async setState(sv: Services, ctx: Ctx, p: { uri: string; state: "open" | "closed" }) {
    needUser(ctx)
    const t = await target(sv, ctx, p.uri, "use")
    await t.gh.guard(p.state === "closed" ? "close this" : "reopen this", () =>
      t.gh.api.setState(t.repo.fullName, t.row.number, p.state, true),
    )
    return refresh(sv, ctx, t)
  },

  async setLabels(sv: Services, ctx: Ctx, p: { uri: string; labels: string[] }) {
    needUser(ctx)
    const t = await target(sv, ctx, p.uri, "use")
    await t.gh.guard("change the labels", () => t.gh.api.setLabels(t.repo.fullName, t.row.number, p.labels))
    return refresh(sv, ctx, t)
  },

  async assign(sv: Services, ctx: Ctx, p: { uri: string; add?: string[]; remove?: string[] }) {
    needUser(ctx)
    const t = await target(sv, ctx, p.uri, "use")
    if (p.add?.length)
      await t.gh.guard("assign people", () => t.gh.api.addAssignees(t.repo.fullName, t.row.number, p.add!))
    if (p.remove?.length)
      await t.gh.guard("unassign people", () =>
        t.gh.api.removeAssignees(t.repo.fullName, t.row.number, p.remove!),
      )
    return refresh(sv, ctx, t)
  },

  async reviewers(sv: Services, ctx: Ctx, p: { uri: string; add?: string[]; remove?: string[] }) {
    needUser(ctx)
    const t = await target(sv, ctx, p.uri, "use")
    if (t.kind !== "pr") throw new RookeryError("INVALID", "Only pull requests have reviewers.")
    if (p.add?.length)
      await t.gh.guard("request reviews", () =>
        t.gh.api.requestReviewers(t.repo.fullName, t.row.number, p.add!),
      )
    if (p.remove?.length)
      await t.gh.guard("cancel review requests", () =>
        t.gh.api.removeReviewers(t.repo.fullName, t.row.number, p.remove!),
      )
    return refresh(sv, ctx, t)
  },

  async refresh(sv: Services, ctx: Ctx, p: { uri: string }) {
    const t = await target(sv, ctx, p.uri, "view", { read: true })
    return refresh(sv, ctx, t)
  },
}

// ── Opening a pull request ──────────────────────────────────────────────────────────────────────────

export interface OpenPullRequest {
  /** `owner/name` or a git URL of the repository (the head branch is in it). */
  repo: string
  head: string
  base?: string
  title: string
  body?: string
  draft?: boolean
  reviewers?: string[]
  /** The space whose attached repository to use; the caller's current one by default. */
  space?: string
}

export interface Opened {
  number: number
  url: string
  title: string
  existing: boolean
  /** The stored pull request (`gh-pr://…`), when the repository is attached to a space. */
  uri?: string
}

/** Opens a pull request from a branch that is already on GitHub, with reviewers. */
export async function createPullRequest(sv: Services, ctx: Ctx, p: OpenPullRequest): Promise<Opened> {
  needUser(ctx)
  const parsed = parseRepo(p.repo)
  if (!parsed)
    throw new RookeryError(
      "INVALID",
      `“${p.repo}” is not a repository. Write it as owner/name, or give its URL.`,
    )
  const apiBase = parsed.host ? apiBaseFor(parsed.host, parsed.scheme) : null
  const attached = await attachedRepo(sv, ctx, parsed.fullName, apiBase, p.space)
  const ghClient = attached ? await sv.pool.forAction(ctx, attached) : await anyConnection(sv, ctx, apiBase)
  const full = attached?.fullName ?? parsed.fullName
  const meta = attached
    ? null
    : (await ghClient.guard(`the repository ${full}`, () => ghClient.api.repo(full))).data
  const base = p.base?.trim() || attached?.defaultBranch || meta?.default_branch || "main"
  const head = p.head.trim().replace(/^refs\/heads\//, "")
  try {
    await ghClient.api.branch(full, head)
  } catch (e) {
    if (e instanceof GitHubError && e.kind === "not_found") {
      throw new RookeryError("INVALID", `The branch “${head}” is not on GitHub yet.`, {
        reason: "github_branch_not_pushed",
        fix: "Push the branch first (git push -u origin HEAD), then open the pull request.",
      })
    }
    throw rookeryError(e, ghClient.who, "the branch")
  }
  let pr: { number: number; html_url: string; title: string }
  let existing = false
  try {
    pr = (
      await ghClient.guard("open a pull request", () =>
        ghClient.api.createPull(full, {
          title: p.title.trim() || head,
          head,
          base,
          body: p.body,
          draft: p.draft,
        }),
      )
    ).data
  } catch (e) {
    const found =
      e instanceof RookeryError && /already exists/i.test(e.message)
        ? await ghClient.api.findPull(full, full.split("/")[0]!, head)
        : null
    if (!found) throw e
    pr = found
    existing = true
  }
  if (p.reviewers?.length && !existing) {
    try {
      await ghClient.api.requestReviewers(full, pr.number, p.reviewers)
    } catch (e) {
      sv.rookery.log.warn(`the pull request is open but the reviewers were refused: ${(e as Error).message}`)
    }
  }
  let uri: string | undefined
  if (attached) uri = await findStored(sv, ctx, attached, pr.number)
  return { number: pr.number, url: pr.html_url, title: pr.title, existing, uri }
}

async function anyConnection(sv: Services, ctx: Ctx, apiBase: string | null): Promise<Gh> {
  const own = await sv.pool.tokenFor(ctx, apiBase ?? "https://api.github.com")
  if (own) return own
  for (const c of await sv.pool.available(ctx)) {
    if (
      !apiBase ||
      (c.values.baseUrl ? String(c.values.baseUrl).replace(/\/+$/, "") : "https://api.github.com") === apiBase
    )
      return sv.pool.fromConnection(c)
  }
  throw new RookeryError("NOT_FOUND", "There is no GitHub connection you can use yet.", {
    reason: "github_no_connection",
    fix: "Connect GitHub first: GitHub › Connect, or Settings › Connections.",
  })
}

/** The attached repository row for `owner/name`, in the given space or any space the caller can see. */
async function attachedRepo(
  sv: Services,
  ctx: Ctx,
  fullName: string,
  apiBase: string | null,
  space?: string,
): Promise<RepoRow | null> {
  const host = apiBase
    ? new URL(apiBase.replace(/\/api\/v3$/, "").replace("api.github.com", "github.com")).host
    : null
  const routes = (
    await ghGlobal(sv.rookery).routes.find({
      where: { repoKey: host ? `${host}/${fullName}`.toLowerCase() : undefined } as never,
      limit: 100,
    })
  ).rows as Rows[]
  const wanted = host
    ? routes
    : routes.filter((r) => String(r.repoKey).endsWith(`/${fullName.toLowerCase()}`))
  const candidates = space
    ? wanted.filter((r) => r.inSpace === space)
    : [...wanted.filter((r) => r.inSpace === ctx.space), ...wanted.filter((r) => r.inSpace !== ctx.space)]
  for (const r of candidates) {
    const info = await lookupEntity(sv.rookery, ctx, `gh-repo://${r.repoId}`)
    if (info)
      return (await ghSpace(sv.rookery, String(r.inSpace)).repos.get(String(r.repoId))) as RepoRow | null
  }
  return null
}

async function findStored(sv: Services, ctx: Ctx, repo: Rows, number: number): Promise<string | undefined> {
  const ghClient = await sv.pool.forAction(ctx, repo)
  const space = String(repo.spaceId)
  const data = ghSpace(sv.rookery, space)
  const events: Array<{ entity: string; planned: Planned[] }> = []
  const work = new Work(sv, ctx, ghClient, data, repo, false, events)
  const r = await withLock(`repo:${repo.id}`, () => work.refreshPull(number))
  for (const e of events) await sv.notifier.deliver(ctx, String(repo.host), e.entity, e.planned, ghClient.api)
  return r ? `gh-pr://${r.after.id}` : undefined
}
