// "Start an agent on this issue": the one function between the Projects plugin and agent sessions.
//
// Where the server has no agent sessions (`agents.start` is not present), this says so with UNAVAILABLE
// and changes nothing.
import { type Ctx, type Rookery, RookeryError } from "@rookery/sdk"
import { branchName } from "../lib/keys"
import { closed } from "../lib/model"
import type { Core } from "./core"
import { issueUri } from "./core"
import { agentsOf, callPluginService, requireAccess, toRookeryError } from "./sdk"

export interface StartOnIssue {
  space: string
  id: string
  /** `<plugin>.<name>` of a driver; default the server's first. */
  driver?: string
  env: string
  /** A checkout's path on the environment. */
  checkout?: string
  /** Work in a new worktree of the checkout on the issue's branch (default), or in the checkout itself. */
  worktree?: boolean
  branch?: string
  base?: string
  model?: string
  /** What to ask beyond "work on this issue". */
  instructions?: string
  /** Leave the issue's state alone. */
  keepState?: boolean
}

/** The first message of the session. */
export function agentPrompt(key: string, title: string, instructions?: string) {
  const ask = instructions?.trim() || "Implement it, test it, and summarise what you changed."
  return `Work on issue ${key}: ${title}.\n\nThe issue, its comments and the docs linked to it are attached as context. ${ask}`
}

export function createAgents(rookery: Rookery, core: Core) {
  /** Whether this server has agent sessions (the agents facility's methods). */
  const available = async (ctx: Ctx) => {
    try {
      const list = agentsOf(rookery)?.list
      if (typeof list !== "function") return false
      await list(ctx, {})
      return true
    } catch {
      return false
    }
  }

  async function start(ctx: Ctx, p: StartOnIssue) {
    const issue = await core.getIssue(ctx, p.space, p.id)
    if (!issue) throw new RookeryError("NOT_FOUND", "no such issue")
    await requireAccess(ctx, issueUri(issue.id), "use")
    const branch = p.branch?.trim() || branchName(issue.key, issue.title)
    const useWorktree = p.worktree !== false && !!p.checkout
    type Started = { id?: string; uri?: string; title?: string } | null
    // The docs that specify the issue: those that mention it, and those its description mentions.
    const docs = new Set<string>()
    const isDoc = (u: string) => /^(doc|note):\/\//.test(u)
    for (const b of await ctx.data.refs.to(issueUri(issue.id)).catch(() => []))
      if (isDoc(b.source)) docs.add(b.source)
    for (const r of await ctx.data.refs.from(issueUri(issue.id)).catch(() => []))
      if (isDoc(r.target) && !r.dangling) docs.add(r.target)
    const startFn = agentsOf(rookery)?.start
    if (typeof startFn !== "function") {
      throw new RookeryError("UNAVAILABLE", "agent sessions are not available on this server yet", { branch })
    }
    let session: Started = null
    try {
      session = (await startFn(ctx, {
        env: p.env,
        ...(p.driver ? { driver: p.driver } : {}),
        ...(p.checkout ? { checkout: p.checkout } : {}),
        ...(useWorktree ? { worktree: { branch, ...(p.base ? { base: p.base } : {}) } } : {}),
        ...(p.model ? { model: p.model } : {}),
        title: `${issue.key} ${issue.title}`,
        space: issue.spaceId,
        prompt: {
          text: agentPrompt(issue.key, issue.title, p.instructions),
          mentions: [issueUri(issue.id), ...[...docs].slice(0, 10)],
        },
      })) as unknown as Started
    } catch (e) {
      const err = toRookeryError(e)
      if (err.code === "NOT_FOUND" && /agents\.start|method/i.test(err.message))
        throw new RookeryError("UNAVAILABLE", "agent sessions are not available on this server yet", {
          branch,
        })
      throw err
    }
    let moved = false
    if (!p.keepState && issue.stateCategory !== "started" && !closed(issue.stateCategory)) {
      await core.updateIssue(ctx, issue, { stateCategory: "started" })
      moved = true
    }
    const started = session as Started
    const id = started?.id ?? (started?.uri ? started.uri.replace("session://", "") : undefined)
    const uri = id ? `session://${id}` : null
    // The GitHub plugin links the pull request from this branch to the session (and, by its key, the issue).
    if (uri && useWorktree) {
      try {
        await callPluginService(rookery, ctx, "github", "github", "linkSession", {
          space: issue.spaceId,
          session: uri,
          branch,
        })
      } catch {
        // No GitHub plugin, or no repository of the project on GitHub: nothing to link.
      }
    }
    return { session: uri, branch, moved, docs: [...docs] }
  }

  return { start, available }
}
