// Attaching repositories to a space, and what that sets up: the row (an entity, `gh-repo://`), the routing
// entry that lets a webhook delivery find the space, the project its issues live in (a new one named after it,
// or one the person picks), a sync schedule that runs as the person who attached it (so it can
// use their own token), and a record in the environments' repository list, which gives the git URL and the
// connection to checkouts and agents.
import { type Ctx, RookeryError } from "@rookery/sdk"
import { explain } from "./errors"
import { repoKey } from "./http"
import { ensureProject, PROVIDER, projects, repoUri } from "./issues"
import { mapRepo } from "./mapping"
import { APP, type Gh, normalizeBase, TOKEN } from "./pool"
import { gh, ghGlobal, type RepoRow, type Rows } from "./rows"
import {
  connectionView,
  enqueue,
  getSetting,
  putSchedule,
  removeScheduleFor,
  requireLevel,
  scheduleName,
} from "./sdk"
import type { Services } from "./sync"
import type { GhRepo } from "./types"
import { needUser } from "./user"

export { scheduleName }

/** `owner/name` from what people type: a name, a clone URL, a web URL. */
export function parseRepo(input: string): { host?: string; fullName: string; scheme?: "http" } | null {
  const s = input
    .trim()
    .replace(/\.git$/, "")
    .replace(/\/+$/, "")
  // Over HTTP(S) the port is the web server's, so it stays with the host (an Enterprise Server or a test
  // server on another port); a plain-HTTP remote keeps its scheme for the API too.
  let m = /^(https?):\/\/([^/:]+(?::\d+)?)\/([^/]+)\/([^/]+)$/.exec(s)
  if (m)
    return {
      host: m[2]!,
      fullName: `${m[3]}/${m[4]}`,
      ...(m[1] === "http" ? { scheme: "http" as const } : {}),
    }
  m = /^ssh:\/\/(?:[^@/]+@)?([^/:]+)(?::\d+)?\/([^/]+)\/([^/]+)$/.exec(s)
  if (m) return { host: m[1], fullName: `${m[2]}/${m[3]}` }
  m = /^[^@/\s]+@([^:/]+):([^/]+)\/([^/]+)$/.exec(s)
  if (m) return { host: m[1], fullName: `${m[2]}/${m[3]}` }
  m = /^([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)$/.exec(s)
  return m ? { fullName: `${m[1]}/${m[2]}` } : null
}

/** The API URL for a git host: github.com has its own, any other host is an Enterprise Server. */
export const apiBaseFor = (host: string, scheme: "http" | "https" = "https") =>
  /^(www\.)?github\.com$/i.test(host) ? "https://api.github.com" : `${scheme}://${host}/api/v3`

export async function attach(
  sv: Services,
  ctx: Ctx,
  p: { repo: string; connection?: string; space?: string; pollSecs?: number; project?: string | null },
): Promise<Rows> {
  const space = p.space ?? ctx.space
  if (!space)
    throw new RookeryError("INVALID", "Open a space (a project) first: a repository is attached to a space.")
  await requireLevel(ctx, `space://${space}`, "use")
  const parsed = parseRepo(p.repo)
  if (!parsed)
    throw new RookeryError(
      "INVALID",
      `“${p.repo}” is not a repository. Write it as owner/name, or paste its URL.`,
    )

  const ghClient: Gh = p.connection
    ? sv.pool.fromConnection(await connectionView(sv.rookery, p.connection))
    : await chooseConnection(sv, ctx, parsed.host, parsed.scheme)
  const meta = (
    await ghClient.guard(`the repository ${parsed.fullName}`, () => ghClient.api.repo(parsed.fullName))
  ).data as GhRepo
  const host = new URL(ghClient.web).host
  const data = gh(ctx).space(space)
  const dup = await data.repos.find({ where: { host, fullName: meta.full_name } as never, limit: 1 })
  if (dup.rows[0])
    throw new RookeryError("CONFLICT", `${meta.full_name} is already attached to this space.`, {
      id: dup.rows[0].id,
    })
  const pollSecs = p.pollSecs ?? (await getSetting<number>(sv.rookery, "code.pollSecs"))

  // The environments' repository list: the git URL and the connection, for checkouts and agents.
  let repository: string | undefined
  try {
    const env = sv.env
    const url = `${meta.html_url.replace(/\/+$/, "")}.git`
    if (env.repositories && env.addRepository) {
      const known = (await env.repositories(ctx, space)).find(
        (r) => r.url.replace(/\.git$/, "") === url.replace(/\.git$/, ""),
      )
      repository = (
        known ??
        (await env.addRepository(ctx, {
          url,
          name: meta.name,
          connection: ghClient.connection.id,
          space,
        }))
      ).id
    }
  } catch (e) {
    sv.rookery.log.warn(
      `could not record ${meta.full_name} in the space's repositories: ${(e as Error).message}`,
    )
  }

  const row = (await data.repos.insert({
    host,
    apiBase: ghClient.apiBase,
    ...(mapRepo(meta) as object),
    connection: ghClient.connection.id,
    status: "pending",
    pollSecs,
    syncedBy: needUser(ctx).id,
    cursors: {},
    ...(repository ? { repository } : {}),
  } as never)) as unknown as Rows
  await ghGlobal(sv.rookery).routes.insert({
    repoKey: repoKey(ghClient.apiBase, meta.full_name),
    inSpace: space,
    repoId: row.id,
  } as never)
  // Its issues live in a project: a new one by default, or the one the person picked.
  try {
    await ensureProject(sv, ctx, row, { project: p.project && p.project !== "new" ? p.project : null })
  } catch (e) {
    sv.rookery.log.warn(`no project for ${meta.full_name} yet: ${(e as Error).message}`)
    if (p.project && p.project !== "new") throw e
  }
  await putSchedule(sv.rookery, ctx, {
    name: scheduleName(row.id),
    job: "code.sync",
    everySecs: pollSecs,
    title: `Sync ${meta.full_name}`,
    params: { repo: row.id, space },
    missed: "skip",
  })
  await enqueue(sv.rookery, ctx, "code/sync", { repo: row.id, space, force: true }, `sync:${row.id}`)
  await remember(sv, ctx, ghClient)
  return row
}

async function chooseConnection(sv: Services, ctx: Ctx, host?: string, scheme?: "http"): Promise<Gh> {
  const base = host ? apiBaseFor(host, scheme) : null
  const all = await sv.pool.available(ctx)
  const fits = all.filter((c) => !base || normalizeBase(c.values.baseUrl) === base)
  // An app (shared, higher limits) before a personal token; the nearest scope first.
  const rank = (c: { type: string; scope: string }) =>
    (c.type === APP ? 0 : 10) + ({ global: 0, user: 1 } as Record<string, number>)[c.scope]!
  const c = [...fits].sort((a, b) => rank(a) - rank(b))[0]
  if (!c) {
    throw new RookeryError(
      "NOT_FOUND",
      `There is no GitHub connection${host ? ` for ${host}` : ""} you can use yet.`,
      {
        reason: "github_no_connection",
        fix: "Connect GitHub first: GitHub › Connect, or Settings › Connections.",
      },
    )
  }
  return sv.pool.fromConnection(c)
}

/** A person's own token proves who they are on GitHub: remember it, for notifications and "mine". */
export async function remember(sv: Services, ctx: Ctx, ghClient: Gh) {
  if (ghClient.connection.type !== TOKEN || !ctx.user) return null
  try {
    const me = (await ghClient.api.user()).data
    await sv.accounts.remember(new URL(ghClient.web).host, me.login, ctx.user.id, "token", me.email, ctx)
    return me
  } catch (e) {
    sv.rookery.log.warn(`could not tell who ${ghClient.who.name} is: ${explain(e, ghClient.who).message}`)
    return null
  }
}

export async function detach(sv: Services, ctx: Ctx, p: { repo: string; space?: string }) {
  const space = p.space ?? ctx.space
  if (!space) throw new RookeryError("INVALID", "Open a space first.")
  await requireLevel(ctx, `space://${space}`, "use")
  const data = gh(ctx).space(space)
  const sdata = ghGlobal(sv.rookery).space(space)
  const repo = (await data.repos.get(p.repo)) as Rows | null
  if (!repo) throw new RookeryError("NOT_FOUND", "That repository is not attached to this space.")
  await removeScheduleFor(sv.rookery, ctx, repo.id)
  const routes = await ghGlobal(sv.rookery).routes.find({
    where: { repoId: repo.id } as never,
    limit: 5,
  })
  for (const r of routes.rows) await ghGlobal(sv.rookery).routes.delete(r.id)
  // The project keeps its issues; they stop syncing.
  const links = (await projects(sv)["sources.projects"](ctx, {
    provider: PROVIDER,
    repository: repoUri(repo.id),
    repoSpace: space,
  })) as Array<{ id: string }>
  for (const l of links)
    await projects(sv)
      ["sources.unlink"](ctx, { link: l.id })
      .catch((e: Error) =>
        sv.rookery.log.warn(`unlinking ${repo.fullName} from its project failed: ${e.message}`),
      )
  const uri = repoUri(repo.id)
  for (const c of ["comments", "prs"] as const) {
    for (;;) {
      const page = await sdata[c].find({ where: { repo: uri } as never, limit: 200 })
      if (page.rows.length === 0) break
      await sdata[c].batch(page.rows.map((r) => ({ op: "delete" as const, id: r.id })) as never)
    }
  }
  await data.repos.delete(repo.id)
  return { ok: true }
}

/** Changes how often a repository is polled: the schedule is made again for the person who changed it. */
export async function setPoll(sv: Services, ctx: Ctx, p: { repo: string; space?: string; pollSecs: number }) {
  const space = p.space ?? ctx.space
  if (!space) throw new RookeryError("INVALID", "Open a space first.")
  await requireLevel(ctx, `space://${space}`, "use")
  const data = gh(ctx).space(space)
  const repo = (await data.repos.get(p.repo)) as RepoRow | null
  if (!repo) throw new RookeryError("NOT_FOUND", "That repository is not attached to this space.")
  const secs = Math.min(3600, Math.max(15, Math.round(p.pollSecs)))
  await putSchedule(sv.rookery, ctx, {
    name: scheduleName(repo.id),
    job: "code.sync",
    everySecs: secs,
    title: `Sync ${repo.fullName}`,
    params: { repo: repo.id, space },
    missed: "skip",
  })
  return data.repos.update(repo.id, { pollSecs: secs, syncedBy: needUser(ctx).id } as never)
}
