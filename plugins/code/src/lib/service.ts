// The plugin's service `github` (interface.ts) and the tools agents get. The tools are plain functions here;
// host.ts registers them with the agents bridge where the kernel has it and always leaves them reachable as
// rpc methods and service methods, so the plugin works the same before and after tools land.
import { type Ctx, RookeryError, z } from "@rookery/sdk"
import { createPullRequest, read, target, write } from "./actions"
import { PROVIDER, projects } from "./issues"
import { type PushIn, pushIssue } from "./push"
import { parseRepo } from "./repos"
import { ghGlobal, ghSpace, type PullRow, type RepoRow, type Rows } from "./rows"
import { lookupEntity, requireLevel, visibleSpaces } from "./sdk"
import type { Services } from "./sync"
import { renderPull, renderRepo } from "./text"

export interface PullRequestRef {
  uri: string
  repo: string
  number: number | null
  title: string
  state: "open" | "closed" | "merged"
  url: string | null
  head: string | null
  headSha: string | null
}

const ref = (repo: Rows, pr: Rows): PullRequestRef => ({
  uri: `gh-pr://${pr.id}`,
  repo: String(repo.fullName),
  number: pr.number,
  title: String(pr.title),
  state: pr.state,
  url: pr.htmlUrl ?? null,
  head: pr.head ?? null,
  headSha: pr.headSha ?? null,
})

export function makeService(sv: Services) {
  const spaceOf = (ctx: Ctx, space?: string) => {
    const s = space ?? ctx.space
    if (!s) throw new RookeryError("INVALID", "Name a space: this works on the repositories attached to one.")
    return s
  }

  /** Recomputes which sessions a branch's pull requests link to. */
  const relink = async (ctx: Ctx, space: string, branch: string): Promise<PullRequestRef[]> => {
    const data = ghSpace(sv.rookery, space)
    const prs = (await data.prs.find({ where: { head: branch } as never, limit: 50 })).rows as Rows[]
    const out: PullRequestRef[] = []
    for (const pr of prs) {
      const repo = (await data.repos.get(String(pr.repo).replace("gh-repo://", ""))) as RepoRow | null
      if (!repo) continue
      const sessions = await sv.linker.sessionsFor(data, repo.fullName, pr.head, pr.headSha, async () => {
        const ghClient = await sv.pool.forRepo(ctx, repo)
        return (await ghClient.api.commits(repo.fullName, pr.number)).map((c) => c.sha)
      })
      if (JSON.stringify(sessions) !== JSON.stringify(pr.sessions ?? []))
        await data.prs.update(pr.id, { sessions } as never)
      out.push(ref(repo, pr))
    }
    return out
  }

  return {
    createPullRequest: (ctx: Ctx, p: Parameters<typeof createPullRequest>[2]) =>
      createPullRequest(sv, ctx, p),

    // ── The contribution to projects.issueSources ───────────────────────────────────────────────────

    /** Writes a change made in Crow to the GitHub issue, as the caller. */
    pushIssue: (ctx: Ctx, p: PushIn) => pushIssue(sv, ctx, p),

    /** The attached repositories the caller can see, for linking a project to one. */
    async linkableRepositories(ctx: Ctx, _p?: { space?: string }) {
      const routes = (await ghGlobal(sv.rookery).routes.find({ limit: 1000 })).rows as Rows[]
      const linked = (await projects(sv)["sources.projects"](ctx, { provider: PROVIDER })) as Array<{
        repository: string
        repoSpace: string
        space: string
        key: string | null
      }>
      const out = []
      for (const r of routes) {
        const info = await lookupEntity(sv.rookery, ctx, `gh-repo://${r.repoId}`)
        if (!info) continue
        const repo = (await ghSpace(sv.rookery, String(r.inSpace)).repos.get(
          String(r.repoId),
        )) as RepoRow | null
        if (!repo) continue
        const l = linked.find((x) => x.repository === `gh-repo://${repo.id}` && x.repoSpace === r.inSpace)
        out.push({
          repository: `gh-repo://${repo.id}`,
          name: repo.fullName,
          url: repo.htmlUrl,
          repoSpace: r.inSpace,
          connection: repo.connection,
          linked: l ? { space: l.space, key: l.key } : null,
        })
      }
      return { repositories: out }
    },

    /** A project was linked to one of its repositories from the project: sync its issues there now. */
    async projectLinked(
      ctx: Ctx,
      p: { link: { id: string; space: string; repository: string; repoSpace?: string | null } },
    ) {
      const id = p.link.repository.replace(/^gh-repo:\/\//, "")
      const data = ghSpace(sv.rookery, String(p.link.repoSpace))
      const repo = (await data.repos.get(id)) as RepoRow | null
      if (!repo) return { ok: false }
      await data.repos.update(id, {
        project: p.link.space,
        projectLink: p.link.id,
      } as never)
      await sv.rookery.jobs.enqueue(
        "code.sync",
        { repo: id, space: p.link.repoSpace, force: true },
        { dedupeKey: `sync:${id}` },
      )
      void ctx
      return { ok: true }
    },

    async projectUnlinked(ctx: Ctx, p: { link: { repository: string; repoSpace?: string | null } }) {
      const id = p.link.repository.replace(/^gh-repo:\/\//, "")
      const data = ghSpace(sv.rookery, String(p.link.repoSpace))
      if (await data.repos.get(id)) await data.repos.update(id, { project: null, projectLink: null } as never)
      void ctx
      return { ok: true }
    },

    async linkSession(
      ctx: Ctx,
      p: { session: string; branch: string; headSha?: string; repo?: string; space?: string },
    ) {
      const space = spaceOf(ctx, p.space)
      await requireLevel(ctx, `space://${space}`, "use")
      if (!/^session:\/\/.+/.test(p.session))
        throw new RookeryError("INVALID", "session is the session's URI: session://<id>")
      const data = ghSpace(sv.rookery, space)
      const found = await data.branchLinks.find({
        where: { session: p.session, branch: p.branch } as never,
        limit: 1,
      })
      const values = { session: p.session, branch: p.branch, headSha: p.headSha ?? "", repo: p.repo ?? "" }
      if (found.rows[0]) await data.branchLinks.update(found.rows[0].id, values as never)
      else await data.branchLinks.insert(values as never)
      return { pulls: await relink(ctx, space, p.branch) }
    },

    async unlinkSession(ctx: Ctx, p: { session: string; branch?: string; space?: string }) {
      const space = spaceOf(ctx, p.space)
      await requireLevel(ctx, `space://${space}`, "use")
      const data = ghSpace(sv.rookery, space)
      const rows = (
        await data.branchLinks.find({
          where: { session: p.session, ...(p.branch ? { branch: p.branch } : {}) } as never,
          limit: 200,
        })
      ).rows as Rows[]
      for (const r of rows) await data.branchLinks.delete(r.id)
      for (const b of new Set(rows.map((r) => r.branch))) await relink(ctx, space, b)
      return { removed: rows.length }
    },

    async pullRequestsFor(ctx: Ctx, p: { branch: string; repo?: string; headSha?: string; space?: string }) {
      const space = spaceOf(ctx, p.space)
      await requireLevel(ctx, `space://${space}`, "view")
      const data = ghSpace(sv.rookery, space)
      const prs = (
        await data.prs.find({
          where: { head: p.branch } as never,
          orderBy: [["ghUpdatedAt", "desc"]],
          limit: 20,
        } as never)
      ).rows as PullRow[]
      const out: PullRequestRef[] = []
      for (const pr of prs) {
        const repo = (await data.repos.get(String(pr.repo).replace("gh-repo://", ""))) as RepoRow | null
        if (
          !repo ||
          (p.repo && repo.fullName.toLowerCase() !== (parseRepo(p.repo)?.fullName ?? p.repo).toLowerCase())
        )
          continue
        if (p.headSha && pr.headSha !== p.headSha && !String(pr.headSha).startsWith(p.headSha)) continue
        out.push(ref(repo, pr))
      }
      return out
    },
  }
}

// ── Tools ──────────────────────────────────────────────────────────────────────────────────────────

const ItemRef = z.object({
  uri: z.string().optional().describe("gh-pr://… or issue://… (as given by a mention or a search)"),
  repo: z.string().optional().describe("owner/name of an attached repository, with number"),
  number: z.number().int().optional().describe("The pull request or issue number, with repo"),
})

type ItemParams = z.infer<typeof ItemRef>

/**
 * The item for a URI, or for owner/name and a number in the current space: a pull request's `gh-pr://`, or the
 * `issue://` of the Projects issue a GitHub issue is.
 */
export async function resolveItem(sv: Services, ctx: Ctx, p: ItemParams): Promise<string> {
  if (p.uri) return p.uri
  if (!p.repo || !p.number) throw new RookeryError("INVALID", "Give a uri, or a repo and a number.")
  const parsed = parseRepo(p.repo)
  if (!parsed) throw new RookeryError("INVALID", `“${p.repo}” is not owner/name.`)
  const spaces = ctx.space ? [ctx.space] : (await visibleSpaces(sv.rookery, ctx)).map((s) => s.id)
  for (const space of spaces) {
    const data = ghSpace(sv.rookery, space)
    const repo = (await data.repos.find({ where: { fullName: parsed.fullName } as never, limit: 1 })).rows[0]
    if (!repo) continue
    const uri = `gh-repo://${repo.id}`
    const pr = (await data.prs.find({ where: { repo: uri, number: p.number } as never, limit: 1 })).rows[0]
    if (pr) return `gh-pr://${pr.id}`
    const issue = (await projects(sv)["sources.find"](ctx, {
      provider: PROVIDER,
      repository: uri,
      repoSpace: space,
      number: p.number,
    })) as { uri: string } | null
    if (issue) return issue.uri
  }
  throw new RookeryError(
    "NOT_FOUND",
    `${parsed.fullName}#${p.number} is not in the repositories attached to this space.`,
  )
}

export async function itemText(
  sv: Services,
  ctx: Ctx,
  uri: string,
): Promise<{ title: string; text: string }> {
  const t = await target(sv, ctx, uri, "view")
  const data = ghSpace(sv.rookery, t.space)
  const comments = (
    await data.comments.find({
      where: { repo: `gh-repo://${t.repo.id}`, onKind: t.kind, number: t.row.number } as never,
      orderBy: [["ghCreatedAt", "asc"]],
      limit: 200,
    } as never)
  ).rows as Rows[]
  return {
    title: `${t.repo.fullName}#${t.row.number} ${t.row.title}`,
    text: renderPull(t.repo, t.row, comments),
  }
}

export async function repoText(
  sv: Services,
  ctx: Ctx,
  id: string,
): Promise<{ title: string; text: string } | null> {
  const info = await lookupEntity(sv.rookery, ctx, `gh-repo://${id}`)
  if (!info?.spaceId) return null
  const data = ghSpace(sv.rookery, info.spaceId)
  const repo = (await data.repos.get(id)) as RepoRow | null
  if (!repo) return null
  const open = (
    await data.prs.find({
      where: { repo: `gh-repo://${id}`, state: "open" } as never,
      orderBy: [["ghUpdatedAt", "desc"]],
      limit: 15,
    } as never)
  ).rows as Rows[]
  return { title: repo.fullName, text: renderRepo(repo, open) }
}

export interface Tool {
  id: string
  description: string
  confirm?: boolean
  params: z.ZodType
  run(ctx: Ctx, p: any): Promise<unknown>
}

export function tools(sv: Services): Tool[] {
  return [
    {
      id: "code.read",
      description:
        "Reads a GitHub pull request or issue: description, state, labels, reviews, checks and the conversation.",
      params: ItemRef,
      run: async (ctx: Ctx, p: ItemParams) => {
        const uri = await resolveItem(sv, ctx, p)
        if (uri.startsWith("issue://")) {
          const r = (await projects(sv).issueText(ctx, { issue: uri })) as {
            title: string
            text: string
          } | null
          if (!r) throw new RookeryError("NOT_FOUND", `${uri} is not an issue you can see`)
          return r
        }
        return itemText(sv, ctx, uri)
      },
    },
    {
      id: "code.search",
      description: "Searches the pull requests and issues of the repositories attached to the current space.",
      params: z.object({
        query: z.string().optional().describe("Words from the title or description"),
        kind: z.enum(["pr", "issue", "any"]).default("any"),
        state: z.enum(["open", "closed", "merged", "any"]).default("open"),
        author: z.string().optional().describe("GitHub login"),
        label: z.string().optional(),
        limit: z.number().int().min(1).max(50).default(15),
      }),
      run: async (
        ctx: Ctx,
        p: {
          query?: string
          kind: "pr" | "issue" | "any"
          state: string
          author?: string
          label?: string
          limit: number
        },
      ) => {
        const space = ctx.space
        if (!space)
          throw new RookeryError(
            "INVALID",
            "Open a space first: this searches the repositories attached to it.",
          )
        const data = ghSpace(sv.rookery, space)
        const repos = new Map(
          ((await data.repos.find({ limit: 200 })).rows as RepoRow[]).map((r) => [`gh-repo://${r.id}`, r]),
        )
        const out: Array<Record<string, unknown>> = []
        // Issues are Projects issues: search the projects the space's repositories are linked to.
        if (p.kind !== "pr") {
          const keys = new Set<string>()
          for (const r of repos.values())
            for (const l of (await projects(sv)["sources.projects"](ctx, {
              provider: PROVIDER,
              repository: `gh-repo://${r.id}`,
              repoSpace: space,
            })) as Array<{ key: string | null }>)
              if (l.key) keys.add(l.key)
          const state =
            p.state === "open"
              ? "is:backlog,unstarted,started "
              : p.state === "closed" || p.state === "merged"
                ? "is:completed,cancelled "
                : ""
          for (const key of keys) {
            const found = (await projects(sv).searchIssues(ctx, {
              project: key,
              query: `${state}${p.label ? `label:${p.label} ` : ""}${p.query ?? ""}`.trim(),
              limit: p.limit,
            })) as { issues: Array<Record<string, unknown>> }
            for (const i of found.issues ?? []) out.push({ kind: "issue", ...i })
          }
        }
        if (p.kind !== "issue") {
          const where: Record<string, unknown> = {}
          if (p.state !== "any") where.state = p.state
          if (p.author) where.author = p.author
          const page = p.query
            ? await data.prs.search(p.query, { where: where as never, limit: p.limit })
            : await data.prs.find({
                where: where as never,
                orderBy: [["ghUpdatedAt", "desc"]],
                limit: p.limit,
              } as never)
          for (const r of page.rows as PullRow[]) {
            if (
              p.label &&
              !((r.labels ?? []) as Array<{ name: string }>).some(
                (l) => l.name.toLowerCase() === p.label!.toLowerCase(),
              )
            )
              continue
            out.push({
              uri: `gh-pr://${r.id}`,
              repo: repos.get(r.repo)?.fullName,
              number: r.number,
              title: r.title,
              state: r.state,
              author: r.author,
              checks: r.checksState,
              reviews: r.reviewState,
              url: r.htmlUrl,
            })
          }
        }
        return { results: out.slice(0, p.limit) }
      },
    },
    {
      id: "code.comment",
      description: "Adds a comment to a GitHub pull request or issue.",
      confirm: true,
      params: ItemRef.extend({ body: z.string().min(1).describe("The comment, in Markdown") }),
      run: async (ctx: Ctx, p: ItemParams & { body: string }) => {
        const uri = await resolveItem(sv, ctx, p)
        // An issue's comment is a Projects comment: Projects writes it to GitHub as the caller.
        if (uri.startsWith("issue://")) return projects(sv).comment(ctx, { issue: uri, body: p.body })
        return write.comment(sv, ctx, { uri, body: p.body })
      },
    },
    {
      id: "code.openPullRequest",
      description: "Opens a pull request from a branch that is already pushed to GitHub.",
      confirm: true,
      params: z.object({
        repo: z.string().describe("owner/name"),
        head: z.string().describe("The branch with the changes"),
        base: z.string().optional().describe("The branch to merge into; the repository's default"),
        title: z.string().min(1),
        body: z.string().optional(),
        draft: z.boolean().default(false),
        reviewers: z.array(z.string()).optional().describe("GitHub logins"),
      }),
      run: (ctx: Ctx, p: Parameters<typeof createPullRequest>[2]) => createPullRequest(sv, ctx, p),
    },
    {
      id: "code.checks",
      description:
        "Reads the check results of a pull request: each check's conclusion and, for a failed one, the end of its log.",
      params: ItemRef,
      run: async (ctx: Ctx, p: ItemParams) => {
        const uri = await resolveItem(sv, ctx, p)
        const c = await read.checks(sv, ctx, { uri })
        const failed = c.runs
          .filter(
            (r) =>
              r.conclusion && ["failure", "timed_out", "cancelled", "action_required"].includes(r.conclusion),
          )
          .slice(0, 3)
        const logs = []
        for (const r of failed)
          logs.push({ name: r.name, ...(await read.checkLog(sv, ctx, { uri, run: r.id })) })
        return {
          sha: c.sha,
          state: c.summary?.state ?? "none",
          checks: c.runs.map((r) => ({
            name: r.name,
            status: r.status,
            conclusion: r.conclusion,
            url: r.url,
          })),
          failedLogs: logs,
        }
      },
    },
  ]
}
