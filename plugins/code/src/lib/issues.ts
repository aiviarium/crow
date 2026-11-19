// GitHub issues are Projects issues (plans/v1.md, "Crow's plugins"). This is the GitHub side of that: an
// issue or a comment from GitHub as what Projects' service takes (`issues.upsertFromSource`,
// `comments.upsertFromSource`), with people mapped to Crow users and `@mentions` to Crow mentions, and the
// link between a repository and the project its issues live in.
import type { Ctx } from "@rookery/sdk"
import type { GitHubApi } from "./api"
import { loginsIn, toCrow } from "./gfm"
import type { RepoRow, Rows } from "./rows"
import { ghSpace } from "./rows"
import { projectsOf } from "./sdk"
import type { Services } from "./sync"
import type { GhComment, GhIssue, GhUser } from "./types"

export const PROVIDER = "github"
export const repoUri = (id: string) => `gh-repo://${id}`

export interface SourcePerson {
  user?: string | null
  login: string
  avatar?: string | null
  url?: string | null
}

/** The projects service, typed from Projects' `interface.ts`. */
export const projects = (sv: Services) => projectsOf(sv.rookery)

/** A GitHub user as a person Projects shows: the Crow user they are, when that is known. */
export async function person(
  sv: Services,
  host: string,
  u: GhUser | null | undefined,
  api?: GitHubApi,
): Promise<SourcePerson | null> {
  if (!u?.login) return null
  const user = await sv.accounts.userFor(host, u.login, api).catch(() => null)
  return {
    user: user ? `user://${user}` : null,
    login: u.login,
    avatar: (u as { avatar_url?: string }).avatar_url ?? null,
    url: (u as { html_url?: string }).html_url ?? null,
  }
}

/** `@login` → Crow user id, for the logins a body mentions that are mapped. */
async function mentionMap(sv: Services, host: string, md: string, api?: GitHubApi) {
  const out = new Map<string, string>()
  for (const login of loginsIn(md)) {
    const user = await sv.accounts.userFor(host, login, api).catch(() => null)
    if (user) out.set(login.toLowerCase(), user)
  }
  return out
}

export async function crowMarkdown(
  sv: Services,
  host: string,
  md: string | null | undefined,
  api?: GitHubApi,
) {
  const text = md ?? ""
  return toCrow(text, await mentionMap(sv, host, text, api))
}

/** A GitHub issue as Projects takes it. The body stays GitHub's text; mentions are mapped. */
export async function sourceIssue(
  sv: Services,
  host: string,
  repo: Rows,
  i: GhIssue,
  api?: GitHubApi,
): Promise<{ external: string; [field: string]: unknown }> {
  const assignees = (await Promise.all((i.assignees ?? []).map((u) => person(sv, host, u, api)))).filter(
    Boolean,
  ) as SourcePerson[]
  return {
    external: String(i.id),
    number: i.number,
    ref: `${repo.fullName}#${i.number}`,
    url: i.html_url,
    title: i.title,
    body: await crowMarkdown(sv, host, i.body, api),
    state: i.state,
    stateReason: i.state_reason ?? null,
    labels: (i.labels ?? []).map((l) =>
      typeof l === "string" ? { name: l, color: null } : { name: l.name, color: l.color ?? null },
    ),
    assignees,
    author: await person(sv, host, i.user, api),
    createdAt: i.created_at,
    updatedAt: i.updated_at,
    comments: i.comments ?? 0,
  }
}

/** A GitHub issue comment as Projects takes it. */
export async function sourceComment(
  sv: Services,
  host: string,
  c: GhComment,
  api?: GitHubApi,
): Promise<{ external: string; [field: string]: unknown }> {
  return {
    external: String(c.id),
    body: await crowMarkdown(sv, host, c.body, api),
    author: await person(sv, host, c.user, api),
    createdAt: c.created_at,
    updatedAt: c.updated_at,
    url: c.html_url,
  }
}

/** The project a repository's issues live in, linking it (and creating the project) when there is none. */
export async function ensureProject(
  sv: Services,
  ctx: Ctx | null,
  repo: Rows,
  opts: { project?: string | null } = {},
): Promise<{ space: string; link: string } | null> {
  const svc = projects(sv)
  const found = (await svc["sources.projects"](ctx, {
    provider: PROVIDER,
    repository: repoUri(repo.id),
    repoSpace: repo.spaceId,
  }).catch(() => [])) as Array<{ id: string; space: string }>
  let link = found[0] ?? null
  // Creating a project needs a person (it is theirs); a delivery or a plugin's own run waits for one.
  if (!link && ctx?.user) {
    const r = (await svc["sources.link"](ctx, {
      provider: PROVIDER,
      repository: repoUri(repo.id),
      name: repo.fullName,
      url: repo.htmlUrl,
      repoSpace: repo.spaceId,
      connection: repo.connection,
      project: opts.project ?? null,
    })) as { link: { id: string; space: string } }
    link = r.link
  }
  if (!link) return null
  if (repo.project !== link.space || repo.projectLink !== link.id) {
    const next = await ghSpace(sv.rookery, String(repo.spaceId))
      .repos.update(repo.id, { project: link.space, projectLink: link.id } as never)
      .catch(() => null)
    if (next) Object.assign(repo, next as RepoRow)
  }
  return { space: link.space, link: link.id }
}
