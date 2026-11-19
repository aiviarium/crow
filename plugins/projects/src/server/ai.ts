// Small model requests through the `fast` task of the Models plugin (an optional dependency): labels and a
// cleaner title for a new issue, a summary of a long thread, and likely duplicates of a new issue (found by
// search; the model only ranks them). The client hides all of it where the task is not set up; these also
// refuse with UNAVAILABLE then.
import { type Ctx, type Rookery, RookeryError, z } from "@rookery/sdk"
import type { IssueRow } from "../lib/model"
import type { Core } from "./core"
import { issueUri } from "./core"
import { callPluginService, toRookeryError } from "./sdk"
import type { createText } from "./text"

/** A structured answer from the model the Models plugin has for `task`, checked against `schema`. */
async function ask<S extends z.ZodType>(
  rookery: Rookery,
  ctx: Ctx,
  req: {
    task: "text" | "fast"
    system?: string
    prompt: string
    schema: S
    schemaName?: string
    maxTokens?: number
  },
): Promise<z.output<S>> {
  const { schema, ...rest } = req
  try {
    const r = await callPluginService<{ object?: unknown }>(rookery, ctx, "ai", "ai", "complete", {
      ...rest,
      plugin: rookery.id,
      schema: z.toJSONSchema(schema, { io: "input", unrepresentable: "any" }) as Record<string, unknown>,
    })
    return schema.parse(r.object)
  } catch (e) {
    const err = toRookeryError(e)
    if (err.code === "NOT_FOUND") {
      throw new RookeryError("UNAVAILABLE", "no model is set up: the Models plugin is not installed")
    }
    throw err
  }
}

/** Whether the Models plugin has a model for `task` for the caller; false without the plugin. */
async function available(
  rookery: Rookery,
  ctx: Ctx,
  task: "text" | "fast" | "transcription",
): Promise<boolean> {
  try {
    const r = await callPluginService<{ tasks?: Array<{ task: string; available: boolean }> }>(
      rookery,
      ctx,
      "ai",
      "ai",
      "tasks",
      {},
    )
    return (r?.tasks ?? []).some((t) => t.task === task && t.available)
  } catch {
    return false
  }
}

export function createAi(rookery: Rookery, core: Core, text: ReturnType<typeof createText>) {
  const ready = async (ctx: Ctx) => {
    if (!(await available(rookery, ctx, "fast")))
      throw new RookeryError("UNAVAILABLE", "no model is set up for the fast task")
  }

  /** A cleaner title and labels from the project's own, for a draft issue. */
  async function suggest(ctx: Ctx, space: string, p: { title: string; description?: string }) {
    await ready(ctx)
    const labels = await core.labelsOf(ctx, space)
    const object = await ask(rookery, ctx, {
      task: "fast",
      system:
        "You help file issues in a project tracker. Rewrite the title as a short, specific imperative or " +
        "problem statement (at most 12 words, no trailing period, keep the language and any identifiers). " +
        "Pick the labels that fit from the list given, by exact name; pick none if none fit.",
      prompt: `Title: ${p.title}\n\nDescription: ${(p.description ?? "").slice(0, 4000)}\n\nLabels: ${labels
        .map((l) => l.name)
        .join(", ")}`,
      schema: z.object({ title: z.string().min(1).max(160), labels: z.array(z.string()).max(6) }),
      schemaName: "issue_suggestion",
    })
    const byName = new Map(labels.map((l) => [l.name.toLowerCase(), l]))
    const picked = object.labels.map((n) => byName.get(n.toLowerCase())).filter((l) => !!l)
    return {
      title: object.title.trim().replace(/\.$/, ""),
      labels: [...new Set(picked.map((l) => `label://${l!.id}`))],
    }
  }

  /** A summary of an issue's discussion. */
  async function summarize(ctx: Ctx, space: string, id: string) {
    await ready(ctx)
    const issue = await core.getIssue(ctx, space, id)
    if (!issue) throw new RookeryError("NOT_FOUND", "no such issue")
    const body = await text.issueText(ctx, issue)
    const object = await ask(rookery, ctx, {
      task: "fast",
      system:
        "Summarise the discussion of this issue for someone who has not read it: what was decided, what is " +
        "open, and who is doing what. Three to six short bullet points, in the thread's language.",
      prompt: body.slice(0, 16_000),
      schema: z.object({ points: z.array(z.string()).min(1).max(8) }),
      schemaName: "thread_summary",
    })
    return { points: object.points }
  }

  /**
   * Issues like a draft. Search finds candidates (title words, then the whole text); with a model the
   * candidates are ranked and only likely duplicates kept, without one the best search hits are returned.
   */
  async function duplicates(
    ctx: Ctx,
    space: string,
    p: { title: string; description?: string; exclude?: string },
  ) {
    const words = p.title
      .split(/\s+/)
      .filter((w) => w.length > 2)
      .slice(0, 8)
    if (!words.length) return { issues: [], ranked: false }
    const d = core.data(ctx, space)
    const seen = new Map<string, IssueRow>()
    for (const q of [words.join(" "), ...words.slice(0, 4)]) {
      const { rows } = await d.issues.search(q, { limit: 8 })
      for (const r of rows as unknown as IssueRow[])
        if (r.id !== p.exclude && seen.size < 12) seen.set(r.id, r)
      if (seen.size >= 12) break
    }
    const candidates = [...seen.values()]
    if (!candidates.length) return { issues: [], ranked: false }
    const can = await available(rookery, ctx, "fast")
    if (!can) return { issues: candidates.slice(0, 3).map(brief), ranked: false }
    const object = await ask(rookery, ctx, {
      task: "fast",
      system:
        "Decide which existing issues are likely duplicates of a new one: the same problem or request, not " +
        "merely the same area. Answer with the keys of likely duplicates, most likely first, and a short reason each.",
      prompt: `New issue: ${p.title}\n${(p.description ?? "").slice(0, 2000)}\n\nExisting issues:\n${candidates
        .map((c) => `${c.key}: ${c.title} [${c.stateName}]`)
        .join("\n")}`,
      schema: z.object({ duplicates: z.array(z.object({ key: z.string(), reason: z.string() })).max(5) }),
      schemaName: "duplicates",
    })
    const byKey = new Map(candidates.map((c) => [c.key.toUpperCase(), c]))
    const issues = object.duplicates
      .map((x) => ({ issue: byKey.get(x.key.trim().toUpperCase()), reason: x.reason }))
      .filter((x) => !!x.issue)
      .map((x) => ({ ...brief(x.issue!), reason: x.reason }))
    return { issues, ranked: true }
  }

  const brief = (i: IssueRow) => ({
    uri: issueUri(i.id),
    id: i.id,
    key: i.key,
    title: i.title,
    stateName: i.stateName,
    stateCategory: i.stateCategory,
  })

  return { suggest, summarize, duplicates }
}
