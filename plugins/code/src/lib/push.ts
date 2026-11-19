// Changes made in Crow to an issue that comes from GitHub, written to GitHub: the `push` of the plugin's
// contribution to `projects.issueSources`. Projects' job calls it as the person who made the change, so it
// is made with their own token, and with the repository's connection (the app) when they have none. It runs
// under the repository's lock: an issue or a comment created here is linked to its Crow copy before the
// webhook delivery about it (or the next poll) is handled, so nothing comes back as a second copy.
import { type Ctx, RookeryError } from "@rookery/sdk"
import { rookeryError } from "./errors"
import { toGitHub, usersIn } from "./gfm"
import { GitHubError } from "./http"
import { crowMarkdown, PROVIDER, projects, repoUri, sourceComment, sourceIssue } from "./issues"
import type { Gh } from "./pool"
import { ghSpace, type Rows } from "./rows"
import { withLock } from "./store"
import type { Services } from "./sync"
import type { GhIssue } from "./types"

export interface PushIn {
  link: { id: string; space: string; repository: string; repoSpace?: string | null; name: string }
  create: boolean
  external?: string | null
  number?: number | null
  fields: Array<"title" | "body" | "state" | "labels" | "assignee">
  issue: {
    id: string
    key: string
    title: string
    body: string
    state: "open" | "closed:completed" | "closed:not_planned"
    labels: Array<{ name: string; color?: string }>
    assignee: string | null
    people: Array<{ login: string }>
  }
  comment?: { op: "create" | "edit" | "delete"; id: string; external?: string | null; body?: string }
}

/** The repository row a link names, from the space it is attached to. */
export async function linkedRepo(sv: Services, link: PushIn["link"]): Promise<Rows> {
  const id = link.repository.replace(/^gh-repo:\/\//, "")
  if (!link.repoSpace) throw new RookeryError("NOT_FOUND", `${link.name} is not attached to a space`)
  const repo = (await ghSpace(sv.rookery, link.repoSpace).repos.get(id)) as Rows | null
  if (!repo)
    throw new RookeryError("NOT_FOUND", `${link.name} is no longer attached`, {
      reason: "github_detached",
      fix: "Attach the repository again, or unlink it in the project's settings.",
    })
  return repo
}

/** Crow user id → their GitHub login on this host, for the users a body mentions and the assignee. */
async function loginsFor(sv: Services, host: string, users: string[]) {
  const out = new Map<string, string>()
  for (const u of users) {
    const id = u.replace(/^user:\/\//, "")
    const [login] = await sv.accounts.loginsOf(host, id).catch(() => [] as string[])
    if (login) out.set(id.toLowerCase(), login)
  }
  return out
}

const stateOf = (s: PushIn["issue"]["state"]) =>
  s === "open"
    ? { state: "open" as const }
    : {
        state: "closed" as const,
        state_reason: s === "closed:not_planned" ? ("not_planned" as const) : ("completed" as const),
      }

export async function pushIssue(sv: Services, ctx: Ctx, p: PushIn) {
  const repo = await linkedRepo(sv, p.link)
  const ghClient: Gh = await sv.pool.forAction(ctx, repo)
  const host = new URL(ghClient.web).host
  const full = String(repo.fullName)
  const target = { provider: PROVIDER, repository: repoUri(repo.id), repoSpace: repo.spaceId }
  return withLock(`repo:${repo.id}`, async () => {
    const logins = await loginsFor(sv, host, [
      ...usersIn(p.issue.body),
      ...usersIn(p.comment?.body),
      ...(p.issue.assignee ? [p.issue.assignee] : []),
    ])
    const body = toGitHub(p.issue.body, logins)
    const mine = p.issue.assignee
      ? logins.get(p.issue.assignee.replace(/^user:\/\//, "").toLowerCase())
      : undefined
    const assignees = [...new Set([...(mine ? [mine] : []), ...p.issue.people.map((x) => x.login)])]
    let issue: GhIssue
    if (p.create) {
      issue = (
        await ghClient.guard("create the issue on GitHub", () =>
          ghClient.api.createIssue(full, {
            title: p.issue.title,
            body,
            labels: p.issue.labels.map((l) => l.name),
            assignees,
          }),
        )
      ).data
      if (p.issue.state !== "open")
        issue = (
          await ghClient.guard("close the issue on GitHub", () =>
            ghClient.api.updateIssue(full, issue.number, stateOf(p.issue.state)),
          )
        ).data
      // Linked at once, under the lock: the delivery about the new issue then finds it.
      await projects(sv)["issues.upsertFromSource"](ctx, {
        ...target,
        items: [{ ...(await sourceIssue(sv, host, repo, issue, ghClient.api)), crowId: p.issue.id }],
      })
    } else {
      const n = p.number
      if (!n) throw new RookeryError("INVALID", `${p.issue.key} has no number on GitHub`)
      const patch: Parameters<Gh["api"]["updateIssue"]>[2] = {}
      if (p.fields.includes("title")) patch.title = p.issue.title
      if (p.fields.includes("body")) patch.body = body
      if (p.fields.includes("state")) Object.assign(patch, stateOf(p.issue.state))
      if (p.fields.includes("labels")) patch.labels = p.issue.labels.map((l) => l.name)
      if (p.fields.includes("assignee")) patch.assignees = assignees
      issue = Object.keys(patch).length
        ? (await ghClient.guard(`change ${full}#${n}`, () => ghClient.api.updateIssue(full, n, patch))).data
        : (await ghClient.guard(`${full}#${n}`, () => ghClient.api.issue(full, n))).data
    }
    let comment: { external: string; url: string; remoteUpdatedAt: string; body: string } | undefined
    if (p.comment) {
      const text = toGitHub(p.comment.body ?? "", logins)
      const c = p.comment
      if (c.op === "create") {
        const made = (
          await ghClient.guard("comment on GitHub", () => ghClient.api.comment(full, issue.number, text))
        ).data
        await projects(sv)["comments.upsertFromSource"](ctx, {
          ...target,
          issue: String(issue.id),
          comments: [{ ...(await sourceComment(sv, host, made, ghClient.api)), crowId: c.id }],
        })
        comment = {
          external: String(made.id),
          url: made.html_url,
          remoteUpdatedAt: made.updated_at,
          body: await crowMarkdown(sv, host, made.body, ghClient.api),
        }
      } else if (c.op === "edit" && c.external) {
        const edited = (
          await ghClient.guard("edit the comment on GitHub", () =>
            ghClient.api.editComment(full, Number(c.external), text),
          )
        ).data
        comment = {
          external: String(edited.id),
          url: edited.html_url,
          remoteUpdatedAt: edited.updated_at,
          body: await crowMarkdown(sv, host, edited.body, ghClient.api),
        }
      } else if (c.op === "delete" && c.external) {
        try {
          await ghClient.api.deleteComment(full, Number(c.external))
        } catch (e) {
          // Already gone on GitHub: that is what was wanted.
          if (!(e instanceof GitHubError && (e.kind === "not_found" || e.kind === "gone")))
            throw rookeryError(e, ghClient.who, "delete the comment on GitHub")
        }
      }
    }
    return {
      external: String(issue.id),
      number: issue.number,
      ref: `${full}#${issue.number}`,
      url: issue.html_url,
      remoteUpdatedAt: issue.updated_at,
      body: await crowMarkdown(sv, host, issue.body, ghClient.api),
      ...(comment ? { comment } : {}),
    }
  })
}
