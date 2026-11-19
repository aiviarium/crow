// The GitHub plugin's host half. It wires the pieces in lib/ to the plugin API: connection tests, the sync
// job and the webhook job, the rpc methods the views call, commands (including the workbench's pull request
// provider), the service `github` (with the push Projects calls for issues), `entities.text` for repositories
// and pull requests, and the agent tools.
import { type Ctx, definePlugin, type Rookery, RookeryError, z } from "@rookery/sdk"
import { Accounts } from "./lib/accounts"
import { createPullRequest, read, write } from "./lib/actions"
import { appComplete, appManifest, testConnection } from "./lib/connect"
import { PROVIDER, projects } from "./lib/issues"
import { Linker } from "./lib/linker"
import { Notifier } from "./lib/notifier"
import { APP, Pool, TOKEN } from "./lib/pool"
import { apiBaseFor, attach, detach, parseRepo, remember, scheduleName, setPoll } from "./lib/repos"
import { gh, ghSpace, type RepoRow, type Rows } from "./lib/rows"
import {
  type ConnectionView,
  connectionView,
  entitiesOf,
  extrasOf,
  jobCtx,
  lookupEntity,
  requireLevel,
} from "./lib/sdk"
import { itemText, makeService, repoText, tools } from "./lib/service"
import { type Services, syncRepo } from "./lib/sync"
import { handleDelivery } from "./lib/webhook"

const Uri = z.object({ uri: z.string() })
const Names = z.array(z.string()).optional()

/** A connection a connection test is handed: the prototype's shape, or one this plugin reads itself. */
const viewOfConnection = async (
  rookery: Rookery,
  c: ConnectionView | { id: string },
): Promise<ConnectionView> =>
  "values" in c && c.values ? (c as ConnectionView) : connectionView(rookery, c.id)

export default definePlugin((rookery) => {
  const pool = new Pool(rookery)
  const accounts = new Accounts(rookery)
  const sv: Services = {
    rookery,
    pool,
    accounts,
    linker: new Linker(rookery),
    notifier: new Notifier(rookery, accounts),
    env: extrasOf(rookery).env,
  }

  // ── Connections ──────────────────────────────────────────────────────────────────────────────────

  const connections = extrasOf(rookery).connections
  for (const type of [APP, TOKEN])
    connections.test?.(type, async (ctx, c) => testConnection(sv, ctx, await viewOfConnection(rookery, c)))

  rookery.rpc.handle("me", {
    level: "own",
    async run(ctx) {
      const logins: Array<{ host: string; login: string }> = []
      if (ctx.user) {
        for (const c of await rookery.connections.list({ type: TOKEN })) {
          if (c.scope !== "user") continue
          const ghClient = await pool.open(ctx, c)
          const me = await remember(sv, ctx, ghClient)
          if (me) logins.push({ host: new URL(ghClient.web).host, login: me.login })
        }
        const known = (
          await gh(ctx).accounts.find({ where: { user: `user://${ctx.user.id}` } as never, limit: 20 })
        ).rows as Rows[]
        for (const a of known)
          if (!logins.some((l) => l.login === a.login && l.host === a.host))
            logins.push({ host: String(a.host), login: String(a.login) })
      }
      return { logins, admin: !!ctx.user?.admin }
    },
  })

  rookery.rpc.handle("connections", {
    level: "own",
    async run(ctx) {
      const list = await pool.available(ctx)
      const rates = new Map(pool.rates().map((r) => [r.connection, r.rate]))
      return {
        connections: list.map((c) => ({
          id: c.id,
          name: c.name,
          type: c.type,
          scope: c.scope,
          baseUrl: String(c.values.baseUrl ?? "https://api.github.com"),
          canManage: c.canManage,
          webhooks: c.type === APP && c.secretsSet.includes("webhookSecret"),
          rate: rates.get(c.id)
            ? {
                limit: rates.get(c.id)!.limit,
                remaining: rates.get(c.id)!.remaining,
                resetAt: new Date(rates.get(c.id)!.reset * 1000).toISOString(),
              }
            : null,
        })),
      }
    },
  })

  rookery.rpc.handle("app.manifest", {
    level: "own",
    params: z.object({
      origin: z.string(),
      apiBase: z.string().optional(),
      org: z.string().optional(),
      name: z.string().optional(),
    }),
    run: (ctx, p) => appManifest(sv, ctx, p),
  })
  rookery.rpc.handle("app.complete", {
    level: "own",
    params: z.object({ code: z.string(), state: z.string() }),
    run: (ctx, p) => appComplete(sv, ctx, p),
  })

  // ── Repositories ─────────────────────────────────────────────────────────────────────────────────

  rookery.rpc.handle("candidates", {
    level: "own",
    params: z.object({ connection: z.string() }),
    async run(_ctx, { connection }) {
      const ghClient = pool.fromConnection(await connectionView(rookery, connection))
      const found = await ghClient.guard("the repositories", () =>
        ghClient.connection.type === APP ? ghClient.api.installationRepos() : ghClient.api.userRepos(),
      )
      return {
        total: found.total,
        repositories: found.repos.map((r) => ({
          fullName: r.full_name,
          private: r.private,
        })),
      }
    },
  })

  const AttachParams = z.object({
    repo: z.string().describe("owner/name, or the repository's URL"),
    connection: z.string().optional().describe("The GitHub connection to use; the nearest by default"),
    space: z.string().optional(),
    pollSecs: z.number().int().optional(),
  })
  rookery.rpc.handle("attach", {
    level: "own",
    params: AttachParams.extend({
      project: z
        .string()
        .nullable()
        .optional()
        .describe("A project (its space) for the issues; a new one by default"),
    }),
    run: (ctx, p) => attach(sv, ctx, p),
  })
  rookery.commands.register("code.attach", {
    params: AttachParams.omit({ space: true, pollSecs: true }),
    run: (ctx, p) => attach(sv, ctx, p),
  })
  rookery.rpc.handle("detach", {
    level: "own",
    params: z.object({ repo: z.string(), space: z.string().optional() }),
    run: (ctx, p) => detach(sv, ctx, p),
  })
  rookery.rpc.handle("setPoll", {
    level: "own",
    params: z.object({ repo: z.string(), space: z.string().optional(), pollSecs: z.number() }),
    run: (ctx, p) => setPoll(sv, ctx, p),
  })

  rookery.rpc.handle("schedule", {
    level: "own",
    params: z.object({ repo: z.string() }),
    async run(_ctx, { repo }) {
      const s = (await rookery.schedules.list()).find((x) => x.name === scheduleName(repo))
      return s
        ? {
            nextRunAt: s.nextRunAt ?? null,
            lastRunAt: s.lastRunAt ?? null,
            everySecs: s.everySecs ?? null,
            enabled: s.enabled,
          }
        : null
    },
  })

  rookery.commands.register("code.sync", {
    async run(ctx) {
      if (!ctx.space) throw new RookeryError("INVALID", "Open a space first.")
      const repos = (await gh(ctx).repos.find({ limit: 200 })).rows as RepoRow[]
      for (const r of repos)
        await rookery.jobs.enqueue(
          "code/sync",
          { repo: r.id, space: ctx.space, force: true },
          { dedupeKey: `sync:${r.id}` },
        )
      return { repositories: repos.length }
    },
  })

  // ── Background work ──────────────────────────────────────────────────────────────────────────────

  rookery.jobs.handle("code.sync", {
    params: z.object({
      repo: z.string(),
      space: z.string(),
      full: z.boolean().optional(),
      force: z.boolean().optional(),
    }),
    async run(job, p) {
      const ctx = jobCtx(rookery, job)
      const r = await syncRepo(sv, ctx, p)
      if (r.stats)
        await job.log(
          `${r.stats.pulls} pull requests, ${r.stats.issues} issues, ${r.stats.comments} comments changed; ${r.stats.requests} requests (${r.stats.notModified} unchanged)`,
        )
      if (r.error) await job.log(`${r.error.message}${r.error.fix ? ` ${r.error.fix}` : ""}`, "warn")
      if (r.skipped) await job.log(`skipped: ${r.skipped}`)
      return r
    },
  })

  rookery.jobs.handle("code.delivery", {
    async run(job, d) {
      const ctx = jobCtx(rookery, job)
      const r = await handleDelivery(sv, ctx, d as never)
      await job.log(
        `${r.event}${r.action ? `.${r.action}` : ""}: ${r.handled ?? `${r.repositories} repositories`}`,
      )
      return r
    },
  })

  // ── What the views ask for ───────────────────────────────────────────────────────────────────────

  const rpc = <S extends z.ZodType>(name: string, params: S, run: (ctx: Ctx, p: z.infer<S>) => unknown) =>
    rookery.rpc.handle(name, { level: "own", params: params as never, run: run as never })
  rpc("pr.files", Uri, (ctx, p) => read.files(sv, ctx, p))
  rpc("pr.commits", Uri, (ctx, p) => read.commits(sv, ctx, p))
  rpc("item.timeline", Uri, (ctx, p) => read.timeline(sv, ctx, p))
  rpc("pr.checks", Uri, (ctx, p) => read.checks(sv, ctx, p))
  rpc("pr.checkLog", Uri.extend({ run: z.number() }), (ctx, p) => read.checkLog(sv, ctx, p))
  rpc("pr.mergeInfo", Uri, (ctx, p) => read.mergeInfo(sv, ctx, p))
  rpc("item.labels", Uri, (ctx, p) => read.labels(sv, ctx, p))
  rpc("item.refresh", Uri, (ctx, p) => write.refresh(sv, ctx, p))
  rpc("item.comment", Uri.extend({ body: z.string() }), (ctx, p) => write.comment(sv, ctx, p))
  rpc(
    "pr.review",
    Uri.extend({ event: z.enum(["APPROVE", "REQUEST_CHANGES", "COMMENT"]), body: z.string().optional() }),
    (ctx, p) => write.review(sv, ctx, p),
  )
  rpc(
    "pr.merge",
    Uri.extend({
      method: z.enum(["merge", "squash", "rebase"]),
      title: z.string().optional(),
      message: z.string().optional(),
    }),
    (ctx, p) => write.merge(sv, ctx, p),
  )
  rpc("item.setState", Uri.extend({ state: z.enum(["open", "closed"]) }), (ctx, p) =>
    write.setState(sv, ctx, p),
  )
  rpc("item.setLabels", Uri.extend({ labels: z.array(z.string()) }), (ctx, p) => write.setLabels(sv, ctx, p))
  rpc("item.assign", Uri.extend({ add: Names, remove: Names }), (ctx, p) => write.assign(sv, ctx, p))
  rpc("pr.reviewers", Uri.extend({ add: Names, remove: Names }), (ctx, p) => write.reviewers(sv, ctx, p))

  // ── Pull requests from the workbench ─────────────────────────────────────────────────────────────

  /** `owner/name` and the API URL of a checkout's remote. */
  const remoteOf = async (ctx: Ctx, envName: string, path: string, remote: string) => {
    const env = envName.startsWith("env://") ? envName : `env://${envName}`
    const r = await rookery.env.exec(ctx, env, ["git", "remote", "get-url", remote], {
      cwd: path,
      timeoutMs: 10_000,
    })
    if (r.exitCode !== 0) throw new RookeryError("INVALID", `The checkout has no remote called “${remote}”.`)
    const parsed = parseRepo(r.stdout.trim())
    if (!parsed) throw new RookeryError("INVALID", `“${r.stdout.trim()}” is not a GitHub remote.`)
    return parsed
  }

  const Provider = z.object({ env: z.string(), path: z.string(), remote: z.string().default("origin") })
  rookery.commands.register("code.canOpenPullRequest", {
    params: Provider,
    async run(ctx, p) {
      try {
        const r = await remoteOf(ctx, p.env, p.path, p.remote)
        const c = (await pool.available(ctx)).find(
          (x) =>
            !r.host ||
            String(x.values.baseUrl ?? "https://api.github.com").replace(/\/+$/, "") ===
              apiBaseFor(r.host, r.scheme),
        )
        if (!c)
          return {
            available: false,
            reason: `No GitHub connection reaches ${r.host ?? "github.com"}. Connect one in GitHub › Connect.`,
          }
        const ghClient = pool.fromConnection(c)
        await ghClient.api.repo(r.fullName)
        return { available: true }
      } catch (e) {
        return { available: false, reason: (e as Error).message }
      }
    },
  })

  rookery.commands.register("code.openPullRequest", {
    params: Provider.extend({
      branch: z.string(),
      base: z.string().optional(),
      title: z.string().default(""),
      body: z.string().default(""),
      draft: z.boolean().default(false),
      reviewers: z.array(z.string()).optional(),
    }),
    async run(ctx, p) {
      const r = await remoteOf(ctx, p.env, p.path, p.remote)
      const pr = await createPullRequest(sv, ctx, {
        repo: r.host ? `${r.scheme ?? "https"}://${r.host}/${r.fullName}` : r.fullName,
        head: p.branch,
        base: p.base,
        title: p.title || p.branch,
        body: p.body,
        draft: p.draft,
        reviewers: p.reviewers,
      })
      return {
        ...pr,
        message: pr.existing
          ? `Pull request #${pr.number} was already open: ${pr.url}`
          : `Opened pull request #${pr.number}: ${pr.url}`,
      }
    },
  })

  // ── Service, entity text, tools ──────────────────────────────────────────────────────────────────

  rookery.services.provide("github", makeService(sv))

  const entities = entitiesOf(rookery)
  entities?.text?.("gh-pr", (ctx, { id }) => itemText(sv, ctx, `gh-pr://${id}`))
  entities?.text?.("gh-repo", (ctx, { id }) => repoText(sv, ctx, id))

  // ── Issues are Projects issues ───────────────────────────────────────────────────────────────────

  rookery.rpc.handle("projects", {
    level: "own",
    params: z.object({ space: z.string().optional(), repo: z.string().optional() }),
    async run(ctx, p) {
      const space = p.space ?? ctx.space
      if (!space) return { projects: [] }
      await requireLevel(ctx, `space://${space}`, "view")
      const links = (await projects(sv)["sources.projects"](ctx, {
        provider: PROVIDER,
        ...(p.repo ? { repository: `gh-repo://${p.repo}` } : {}),
        repoSpace: space,
      })) as Array<{ space: string; key: string | null; name: string; repository: string }>
      const out = []
      for (const l of links) {
        const s = await rookery.spaces.get(ctx, l.space).catch(() => null)
        if (s)
          out.push({
            space: s.id,
            slug: s.slug,
            name: s.name,
            key: l.key,
            repository: l.repository,
            repo: l.name,
          })
      }
      return { projects: out }
    },
  })

  // What `#<number>` in a pull request of a repository names: its pull request, or the Projects issue.
  rookery.rpc.handle("resolveNumber", {
    level: "own",
    params: z.object({ repo: z.string(), number: z.number().int() }),
    async run(ctx, p) {
      const repo = await lookupEntity(rookery, ctx, `gh-repo://${p.repo}`)
      const space = repo?.spaceId ?? ctx.space
      if (!space) return null
      const inSpace = ghSpace(rookery, space)
      const pr = (
        await inSpace.prs.find({
          where: { repo: `gh-repo://${p.repo}`, number: p.number } as never,
          limit: 1,
        })
      ).rows[0]
      if (pr) return { uri: `gh-pr://${pr.id}` }
      const issue = (await projects(sv)["sources.find"](ctx, {
        provider: PROVIDER,
        repository: `gh-repo://${p.repo}`,
        repoSpace: space,
        number: p.number,
      })) as { uri: string; key?: string; space?: string } | null
      if (!issue) return null
      const proj = issue.space ? await rookery.spaces.get(ctx, issue.space).catch(() => null) : null
      return { uri: issue.uri, key: issue.key ?? null, slug: proj?.slug ?? null }
    },
  })

  // ── Agent tools ─────────────────────────────────────────────────────────────────────────────────

  const agentTools = extrasOf(rookery).agents?.tool
  if (typeof agentTools === "function") {
    for (const t of tools(sv)) {
      try {
        agentTools(t.id, {
          params: t.params as never,
          confirm: t.confirm,
          run: (ctx: Ctx, p: unknown) => t.run(ctx, p),
        })
      } catch (e) {
        // A kernel without agent tools: the same functions stay reachable as rpc methods and service methods.
        rookery.log.debug(`tool ${t.id} is not registered with agents: ${String(e)}`)
      }
    }
  }
  rookery.rpc.handle("tool", {
    level: "own",
    params: z.object({ id: z.string(), params: z.record(z.string(), z.unknown()).default({}) }),
    async run(ctx, { id, params }) {
      const t = tools(sv).find((x) => x.id === id)
      if (!t) throw new RookeryError("NOT_FOUND", `no tool ${id}`)
      return t.run(ctx, t.params.parse(params))
    },
  })
})
