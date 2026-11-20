// Issues and projects as text, for models and agents (`entities.text`): what an agent started on an
// issue reads, and what `@CROW-12` in the composer adds.
import { type Ctx, plainText, type RichText, type Rookery } from "@rookery/sdk"
import { type CommentRow, type IssueRow, type ProjectRow, priorityName } from "../lib/model"
import type { Core } from "./core"
import { idOf, issueUri } from "./core"
import { documentText, entitiesOf } from "./sdk"

export function createText(rookery: Rookery, core: Core) {
  const names = new Map<string, string>()
  const nameOf = async (ctx: Ctx | null, uri: string | null | undefined) => {
    if (!uri) return null
    const hit = names.get(uri)
    if (hit) return hit
    const e = await entitiesOf(rookery)
      .lookup(ctx as Ctx, uri)
      .catch(() => null)
    const n = e?.title ?? uri
    names.set(uri, n)
    return n
  }

  async function issueText(ctx: Ctx, issue: IssueRow, opts: { comments?: boolean } = {}) {
    const lines: string[] = [`${issue.key}: ${issue.title}`]
    const proj = await core.project(ctx, issue.spaceId).catch(() => null)
    if (proj) lines.push(`Project: ${proj.name} (${proj.key})`)
    lines.push(`State: ${issue.stateName ?? "none"} (${issue.stateCategory ?? "none"})`)
    lines.push(`Priority: ${priorityName(issue.priority)}`)
    if (issue.assignee) lines.push(`Assignee: ${await nameOf(ctx, issue.assignee)}`)
    if (issue.labels?.length) {
      const labels = (await entitiesOf(rookery)?.lookupMany(ctx, issue.labels)) ?? []
      if (labels.length) lines.push(`Labels: ${labels.map((l) => l.title).join(", ")}`)
    }
    if (issue.estimate != null) lines.push(`Estimate: ${issue.estimate}`)
    if (issue.due) lines.push(`Due: ${issue.due}`)
    if (issue.parent) lines.push(`Parent: ${await nameOf(ctx, issue.parent)}`)
    if (issue.cycle) lines.push(`Cycle: ${await nameOf(ctx, issue.cycle)}`)
    if (issue.document) {
      const body = await documentText(rookery.documents, ctx, issue.document).catch(() => "")
      if (body.trim()) lines.push("", "Description:", body.trim())
    }
    const d = core.data(ctx, issue.spaceId)
    const subs = (
      await d.issues.find({ where: { parent: issueUri(issue.id) }, orderBy: ["rank"], limit: 100 })
    ).rows as unknown as IssueRow[]
    if (subs.length) {
      lines.push("", "Sub-issues:")
      for (const s of subs) lines.push(`- ${s.key} ${s.title} [${s.stateName ?? ""}]`)
    }
    const rels = await core.relations(ctx, issue).catch(() => [])
    if (rels.length) {
      lines.push("", "Relations:")
      for (const r of rels) {
        const out = r.source === issueUri(issue.id)
        const other = out ? r.target : r.source
        lines.push(`- ${r.kind}${out ? "" : " (incoming)"}: ${await nameOf(ctx, other)}`)
      }
    }
    // Docs and other entities that mention the issue: titles only.
    const links = (await ctx.data.refs.to(issueUri(issue.id)).catch(() => [])) as Array<{
      source: string
      title: string | null
    }>
    const linked = links.filter((l) => !l.source.startsWith("comment://") && !l.source.startsWith("issue://"))
    if (linked.length) {
      lines.push("", "Linked:")
      for (const l of linked.slice(0, 30)) lines.push(`- ${l.title ?? l.source} (${l.source})`)
    }
    if (opts.comments !== false) {
      const comments = (
        await d.comments.find({ where: { issue: issueUri(issue.id) }, orderBy: ["createdAt"], limit: 200 })
      ).rows as unknown as CommentRow[]
      if (comments.length) {
        lines.push("", "Comments:")
        for (const c of comments) {
          const by = c.createdBy ? await nameOf(ctx, `user://${c.createdBy}`) : "someone"
          lines.push(`- ${by} (${c.createdAt.slice(0, 10)}): ${plainText(c.body as RichText).trim()}`)
        }
      }
    }
    return lines.join("\n")
  }

  async function projectText(ctx: Ctx, p: ProjectRow) {
    const lines = [`Project ${p.name} (${p.key})`]
    if (p.summary) lines.push(p.summary)
    if (p.lead) lines.push(`Lead: ${await nameOf(ctx, p.lead)}`)
    if (p.document) {
      const body = await documentText(rookery.documents, ctx, p.document).catch(() => "")
      if (body.trim()) lines.push("", body.trim())
    }
    const states = await core.states(ctx, p.spaceId)
    lines.push("", `States: ${states.map((s) => `${s.name} (${s.category})`).join(", ")}`)
    const d = core.data(ctx, p.spaceId)
    const open = await d.issues.count({
      where: { stateCategory: { in: ["backlog", "unstarted", "started"] } },
    })
    const done = await d.issues.count({ where: { stateCategory: "completed" } })
    lines.push(`Issues: ${open} open, ${done} completed`)
    return lines.join("\n")
  }

  if (typeof rookery.entities?.text === "function") {
    rookery.entities.text("issue", async (ctx, { id }) => {
      const issue = await core.findIssue(ctx, id)
      return issue ? { title: `${issue.key} ${issue.title}`, text: await issueText(ctx, issue) } : null
    })
    rookery.entities.text("project", async (ctx, { id }) => {
      const e = await entitiesOf(rookery).lookup(ctx, `project://${id}`)
      if (!e?.spaceId) return null
      const p = await core.project(ctx, e.spaceId).catch(() => null)
      return p ? { title: p.name, text: await projectText(ctx, p) } : null
    })
    rookery.entities.text("comment", async (ctx, { id }) => {
      const e = await entitiesOf(rookery).lookup(ctx, `comment://${id}`)
      if (!e?.spaceId) return null
      const c = (await core.data(ctx, e.spaceId).comments.get(id)) as unknown as CommentRow | null
      if (!c) return null
      const issue = await core.findIssue(ctx, c.issue, e.spaceId)
      return { title: `Comment on ${issue?.key ?? idOf(c.issue)}`, text: plainText(c.body as RichText) }
    })
  }

  return { issueText, projectText, nameOf }
}
