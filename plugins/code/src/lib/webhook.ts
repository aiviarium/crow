// Webhook deliveries. The kernel has already checked the signature and refused replays by delivery id
// (`github` scheme, secret from the app connection) and answered 202; this is the job it enqueued.
// A delivery is a hint, not a source of truth: for each repository it names, the plugin reads the item it is
// about from the API again, so deliveries that arrive late, twice or out of order leave the same rows. That is
// also why a delivery from an app can be handled for a repository that was attached with another connection.
import type { Ctx } from "@rookery/sdk"
import { repoKey } from "./http"
import { PROVIDER, projects } from "./issues"
import type { Planned } from "./notifier"
import { type GhCollections, ghGlobal, ghSpace, type Rows } from "./rows"
import { withLock } from "./store"
import { patchRepo, type Services, Work } from "./sync"
import type { GhEvent } from "./types"

export interface Delivery {
  webhook?: string
  deliveryId?: string
  receivedAt?: string
  headers?: Record<string, string>
  body?: unknown
  text?: string
}

export interface Handled {
  event: string
  action?: string
  repositories: number
  handled?: string
}

const ts = (v: unknown) => (v ? Date.parse(String(v)) : 0)

export async function handleDelivery(sv: Services, ctx: Ctx, d: Delivery): Promise<Handled> {
  const headers = Object.fromEntries(
    Object.entries(d.headers ?? {}).map(([k, v]) => [k.toLowerCase(), String(v)]),
  )
  const event = headers["x-github-event"] ?? "unknown"
  const body = (typeof d.body === "object" && d.body ? d.body : d.text ? JSON.parse(d.text) : {}) as GhEvent
  const out: Handled = { event, action: body.action, repositories: 0 }
  if (event === "ping") return { ...out, handled: "ping" }
  const r = body.repository
  if (!r?.full_name || !r.html_url) return { ...out, handled: "no repository" }

  const key = `${new URL(r.html_url).host}/${r.full_name}`.toLowerCase()
  const routes = (await ghGlobal(sv.rookery).routes.find({ where: { repoKey: key } as never, limit: 50 }))
    .rows as Rows[]
  // A rename arrives under the new name; the old routing entry still has the old one.
  if (event === "repository" && body.changes?.repository?.name?.from) {
    const from =
      `${new URL(r.html_url).host}/${r.owner.login}/${body.changes.repository.name.from}`.toLowerCase()
    routes.push(
      ...((await ghGlobal(sv.rookery).routes.find({ where: { repoKey: from } as never, limit: 50 }))
        .rows as Rows[]),
    )
  }
  for (const route of routes) {
    const data = ghSpace(sv.rookery, String(route.inSpace))
    const repo = (await data.repos.get(String(route.repoId))) as Rows | null
    if (!repo) continue
    out.repositories++
    await withLock(`repo:${repo.id}`, async () => {
      const events: Array<{ entity: string; planned: Planned[] }> = []
      const ghClient = await sv.pool.forRepo(ctx, repo)
      const work = new Work(sv, ctx, ghClient, data, repo, false, events)
      await apply(sv, ctx, work, data, repo, event, body, key, route)
      if (!repo.lastWebhookAt || Date.now() - ts(repo.lastWebhookAt) > 60_000)
        await patchRepo(data, repo, { lastWebhookAt: new Date().toISOString() })
      for (const e of events)
        await sv.notifier.deliver(ctx, String(repo.host), e.entity, e.planned, ghClient.api)
    })
  }
  return out
}

async function apply(
  sv: Services,
  ctx: Ctx,
  work: Work,
  data: GhCollections,
  repo: Rows,
  event: string,
  b: GhEvent,
  key: string,
  route: Rows,
) {
  switch (event) {
    case "pull_request":
    case "pull_request_review":
    case "pull_request_review_comment":
      if (b.pull_request) await work.refreshPull(b.pull_request.number)
      return
    case "issues":
      if (!b.issue) return
      if (b.action === "deleted" || b.action === "transferred") {
        await projects(sv)["issues.removedAtSource"](ctx, {
          provider: PROVIDER,
          repository: `gh-repo://${repo.id}`,
          repoSpace: repo.spaceId,
          external: String(b.issue.id),
          removed: b.action === "deleted" ? "deleted" : "transferred",
        })
        return
      }
      await work.refreshIssue(b.issue.number)
      return
    case "issue_comment":
      if (!b.issue) return
      if (b.action === "deleted" && b.comment && b.issue.pull_request) {
        const row = (
          await data.comments.find({
            where: { repo: `gh-repo://${repo.id}`, kind: "comment", ghId: b.comment.id } as never,
            limit: 1,
          })
        ).rows[0]
        if (row) await data.comments.delete(row.id)
      }
      // An issue's comments are read again whole, so a deleted one goes from Projects too.
      if (b.issue.pull_request) await work.refreshPull(b.issue.number)
      else await work.refreshIssue(b.issue.number)
      return
    case "check_run": {
      const sha = b.check_run?.head_sha
      if (sha)
        await work.refreshChecks(
          sha,
          (b.check_run?.pull_requests ?? []).map((p) => p.number),
        )
      return
    }
    case "check_suite": {
      const sha = b.check_suite?.head_sha
      if (sha)
        await work.refreshChecks(
          sha,
          (b.check_suite?.pull_requests ?? []).map((p) => p.number),
        )
      return
    }
    case "status":
      if (b.status?.sha) await work.refreshChecks(b.status.sha)
      return
    case "repository": {
      const r = b.repository!
      if (b.action === "deleted") {
        await patchRepo(data, repo, {
          status: "gone",
          errorCode: "github_gone",
          lastError: `${repo.fullName} was deleted on GitHub.`,
          errorFix: "Detach it, or restore it on GitHub and use “Sync now”.",
        })
        return
      }
      if (b.action === "renamed" || b.action === "transferred") {
        await patchRepo(data, repo, {
          fullName: r.full_name,
          owner: r.owner.login,
          name: r.name,
          htmlUrl: r.html_url,
        })
        const newKey = repoKey(String(repo.apiBase), r.full_name)
        if (route.repoKey !== newKey)
          await ghGlobal(sv.rookery).routes.update(route.id, { repoKey: newKey } as never)
        return
      }
      await patchRepo(data, repo, {
        archived: !!r.archived,
        description: r.description ?? "",
        defaultBranch: r.default_branch,
        private: !!r.private,
      })
      return
    }
    default:
      void ctx
      void key
  }
}
