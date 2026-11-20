// The import job: CSV or GitHub issue JSON into a project, as the person who started it, with progress.
// States are matched by name (then by category), labels by name (missing ones are created in the
// project), people by email or name among Crow's users. Issues are written in batches of one transaction
// each, so a failure leaves whole batches.
import { type Ctx, type JobHandle, type Rookery, RookeryError } from "@rookery/sdk"
import { type ImportField, type ImportIssue, mapCsv, mapGithub, parseCsv } from "../lib/importer"
import { formatIssueKey, keyWords } from "../lib/keys"
import { CATEGORY_ICON, defaultState, firstOf, type IssueRow, issueLabel, type StateRow } from "../lib/model"
import { sequence } from "../lib/rank"
import type { Core } from "./core"
import { uid, userUri } from "./core"
import { entitiesOf } from "./sdk"

export interface ImportParams {
  space: string
  format: "csv" | "github"
  text: string
  mapping?: ImportField[]
  header?: boolean
}

const BATCH = 200

/** What an import would do, without writing: the issues, and what was skipped. For the preview. */
export function readImport(p: Pick<ImportParams, "format" | "text" | "mapping" | "header">) {
  if (p.format === "github") {
    let json: unknown
    try {
      json = JSON.parse(p.text)
    } catch {
      throw new RookeryError("INVALID", "that is not JSON")
    }
    const r = mapGithub(json)
    return { issues: r.issues, skipped: r.skipped }
  }
  const rows = parseCsv(p.text)
  if (!rows.length) throw new RookeryError("INVALID", "the file has no rows")
  if (!p.mapping?.length) throw new RookeryError("INVALID", "map the columns to fields first")
  const r = mapCsv(rows, p.mapping, { header: p.header !== false })
  return { issues: r.issues, skipped: r.skipped.length }
}

export function createImporter(rookery: Rookery, core: Core) {
  async function run(ctx: Ctx, job: JobHandle, p: ImportParams) {
    const { issues, skipped } = readImport(p)
    await job.log(`${issues.length} issues to import${skipped ? `, ${skipped} rows skipped` : ""}`)
    const proj = await core.project(ctx, p.space)
    const states = await core.states(ctx, p.space)
    const d = core.data(ctx, p.space)

    // Labels by name; missing ones are created in the project.
    const labels = new Map(
      (await core.labelsOf(ctx, p.space)).map((l) => [l.name.toLowerCase(), `label://${l.id}`]),
    )
    const wanted = [...new Set(issues.flatMap((i) => i.labels.map((l) => l.trim()).filter(Boolean)))]
    for (const name of wanted) {
      if (labels.has(name.toLowerCase())) continue
      const row = (await ctx.data.labels.insert({
        name,
        color: "accent",
        scope: `space://${p.space}`,
      } as never)) as {
        id: string
      }
      labels.set(name.toLowerCase(), `label://${row.id}`)
      await job.log(`created the label ${name}`)
    }

    // People by email or name.
    const people = new Map<string, string | null>()
    const person = async (who: string | undefined) => {
      if (!who) return null
      const k = who.toLowerCase()
      if (people.has(k)) return people.get(k)!
      const hits =
        (await entitiesOf(rookery)
          ?.search(ctx, who, { schemes: ["user"], limit: 5 })
          .catch(() => [])) ?? []
      const hit =
        hits.find((h) => h.title.toLowerCase() === k || (h.subtitle ?? "").toLowerCase() === k) ??
        (hits.length === 1 ? hits[0] : undefined)
      const uri = hit ? userUri(hit.id) : null
      people.set(k, uri)
      if (!uri) await job.log(`nobody in Crow is called ${who}; left unassigned`, "warn")
      return uri
    }

    const pick = (it: ImportIssue): StateRow | null => {
      if (it.state) {
        const s = states.find((x) => x.name.toLowerCase() === it.state!.toLowerCase())
        if (s) return s
      }
      if (it.category) return firstOf(states, it.category) ?? defaultState(states)
      return defaultState(states)
    }

    const ranks = sequence(issues.length, await core.lastRank(ctx, p.space))
    const me = ctx.user ? userUri(uid(ctx)) : null
    const now = new Date().toISOString()
    let done = 0
    const created: string[] = []
    for (let at = 0; at < issues.length; at += BATCH) {
      if (ctx.signal.aborted || job.signal.aborted)
        throw new RookeryError("TIMEOUT", "the import was cancelled")
      const chunk = issues.slice(at, at + BATCH)
      const values = []
      for (const [n, it] of chunk.entries()) {
        const st = pick(it)
        const assignee = await person(it.assignee)
        values.push({
          title: it.title.slice(0, 500),
          label: it.title.slice(0, 500),
          ...core.stateFields(st, null, now),
          icon: st ? CATEGORY_ICON[st.category] : "list",
          priority: it.priority ?? 0,
          assignee,
          labels: it.labels.map((l) => labels.get(l.trim().toLowerCase())).filter(Boolean),
          estimate: it.estimate ?? null,
          due: it.due ?? null,
          rank: ranks[at + n],
          followers: [...new Set([...(me ? [me] : []), ...(assignee ? [assignee] : [])])],
          importedFrom: it.source ?? null,
        })
      }
      const rows = (await d.issues.batch(
        values.map((v) => ({ op: "insert" as const, values: v })),
      )) as unknown as IssueRow[]
      // Keys follow from the numbers the store assigned.
      await d.issues.batch(
        rows.map((r) => {
          const key = formatIssueKey(proj.key, r.number)
          return {
            op: "update" as const,
            id: r.id,
            patch: { key, keyWords: keyWords(key), label: issueLabel(key, r.title) },
          }
        }),
      )
      // Descriptions become the issues' documents.
      for (const [n, r] of rows.entries()) {
        const md = chunk[n]!.description
        if (!md?.trim()) continue
        const doc = await rookery.documents.create(ctx, {
          parent: `issue://${r.id}`,
          title: r.title,
          markdown: md,
        })
        await d.issues.update(r.id, { document: doc.id } as never)
      }
      done += rows.length
      created.push(...rows.map((r) => r.id))
      await job.progress(done, issues.length, `${done} of ${issues.length}`)
    }
    await job.log(`imported ${done} issues into ${proj.key}`)
    return { imported: done, skipped, labels: wanted.length }
  }

  return { run }
}
