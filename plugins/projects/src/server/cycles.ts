// Cycles: creating them, the daily rollover (close what ended, move unfinished issues on), the weekly
// summary each project's members get, and the burn-up of one cycle from its issues' history.
import { type Ctx, type Rookery, RookeryError } from "@rookery/sdk"
import {
  burnup,
  type CycleEvent,
  currentCycle,
  day,
  eventsFromHistory,
  nextDates,
  planRollover,
} from "../lib/cycles"
import { type Category, type CycleRow, closed, type IssueRow } from "../lib/model"
import type { Core } from "./core"
import { idOf } from "./core"
import { sendNotice } from "./sdk"

export function createCycles(rookery: Rookery, core: Core) {
  const cycleUri = (id: string) => `cycle://${id}`

  const list = async (ctx: Ctx | null, space: string) =>
    (await core.data(ctx, space).cycles.find({ orderBy: ["startsOn"], limit: 500 }))
      .rows as unknown as CycleRow[]

  async function create(
    ctx: Ctx | null,
    space: string,
    p: { name?: string; startsOn?: string; endsOn?: string; weeks?: number },
  ) {
    const cycles = await list(ctx, space)
    const proj = await core.project(ctx, space)
    const weeks = p.weeks ?? proj.cycleWeeks ?? 2
    const dates =
      p.startsOn && p.endsOn
        ? { startsOn: p.startsOn, endsOn: p.endsOn }
        : nextDates(cycles, weeks, day(new Date()))
    if (dates.endsOn < dates.startsOn) throw new RookeryError("INVALID", "a cycle ends after it starts")
    const overlap = cycles.find((c) => !c.closed && c.startsOn <= dates.endsOn && c.endsOn >= dates.startsOn)
    if (overlap) throw new RookeryError("CONFLICT", `${overlap.name} already covers those days`)
    const row = (await core
      .data(ctx, space)
      .cycles.insert({ name: p.name?.trim() || "Cycle", ...dates } as never)) as unknown as CycleRow
    if (!p.name?.trim())
      return (await core
        .data(ctx, space)
        .cycles.update(row.id, { name: `Cycle ${row.number}` } as never)) as unknown as CycleRow
    return row
  }

  /** Closes the project's ended cycles and moves their unfinished issues on. Runs as the plugin. */
  async function rolloverProject(space: string, today = day(new Date())) {
    const proj = await core.project(null, space)
    if (proj.archived) return { closed: 0, moved: 0 }
    const cycles = await list(null, space)
    const open = cycles.filter((c) => !c.closed)
    if (!open.length && !proj.cycleAuto) return { closed: 0, moved: 0 }
    const d = core.data(null, space)
    const uris = open.map((c) => cycleUri(c.id))
    const issues = uris.length
      ? ((await d.issues.find({ where: { cycle: { in: uris } }, limit: 1000 })).rows as unknown as IssueRow[])
      : []
    const plan = planRollover(cycles, issues, today, {
      auto: proj.cycleAuto,
      weeks: proj.cycleWeeks ?? 2,
      uri: cycleUri,
    })
    let created: CycleRow | null = null
    if (plan.create) created = await create(null, space, plan.create)
    for (const m of plan.moves) {
      const to = m.to === "new" ? (created ? cycleUri(created.id) : null) : m.to || null
      await d.issues.update(m.issue, { cycle: to } as never)
    }
    for (const id of plan.close) {
      const next = plan.moves.find((m) => m.from === cycleUri(id))?.to
      await d.cycles.update(id, {
        closed: true,
        rolledTo: next === "new" ? (created?.id ?? null) : next ? idOf(next) : null,
      } as never)
    }
    return { closed: plan.close.length, moved: plan.moves.length }
  }

  async function rolloverAll(log: (s: string) => unknown) {
    let closedN = 0
    let moved = 0
    for (const r of await core.registry()) {
      if (r.archived) continue
      try {
        const out = await rolloverProject(r.space)
        closedN += out.closed
        moved += out.moved
        if (out.closed) await log(`${r.key}: closed ${out.closed} cycle(s), moved ${out.moved} issue(s)`)
      } catch (e) {
        await log(`${r.key}: ${String(e)}`)
      }
    }
    return { closed: closedN, moved }
  }

  /** Progress of a cycle: counts by category, scope and completed over time (from history). */
  async function progress(ctx: Ctx, space: string, id: string) {
    const c = (await core.data(ctx, space).cycles.get(id)) as unknown as CycleRow | null
    if (!c) throw new RookeryError("NOT_FOUND", "no such cycle")
    const uri = cycleUri(id)
    const d = core.data(ctx, space)
    const issues = (await d.issues.find({ where: { cycle: uri }, limit: 1000 })).rows as unknown as IssueRow[]
    const events: CycleEvent[] = []
    const start: Record<string, { cycle: string | null; category: Category | null }> = {}
    for (const i of issues) {
      const h = await d.issues.history(i.id, { limit: 500 })
      const r = eventsFromHistory(i.id, { cycle: i.cycle, category: i.stateCategory }, h as never)
      events.push(...r.events)
      start[i.id] = r.start
    }
    const points = burnup(c, uri, events, start, day(new Date()))
    const by: Record<string, number> = {}
    for (const i of issues) by[i.stateCategory ?? "none"] = (by[i.stateCategory ?? "none"] ?? 0) + 1
    const scope = issues.filter((i) => i.stateCategory !== "cancelled").length
    const completed = issues.filter((i) => i.stateCategory === "completed").length
    return {
      cycle: c,
      points,
      byCategory: by,
      scope,
      completed,
      open: issues.filter((i) => !closed(i.stateCategory)).length,
    }
  }

  /** The summary of each project's current cycle, to its members' inboxes and onto the cycle. */
  async function summarizeAll(log: (s: string) => unknown) {
    let sent = 0
    for (const r of await core.registry()) {
      if (r.archived) continue
      const cycles = await list(null, r.space).catch(() => [])
      const cur = currentCycle(cycles, day(new Date()))
      if (!cur) continue
      const issues = (
        await core.data(null, r.space).issues.find({ where: { cycle: cycleUri(cur.id) }, limit: 1000 })
      ).rows as unknown as IssueRow[]
      const done = issues.filter((i) => i.stateCategory === "completed").length
      const started = issues.filter((i) => i.stateCategory === "started").length
      const scope = issues.filter((i) => i.stateCategory !== "cancelled").length
      const left = Math.max(0, Date.parse(`${cur.endsOn}T23:59:59Z`) - Date.now())
      const days = Math.ceil(left / 86_400_000)
      const text = `${r.key} ${cur.name}: ${done} of ${scope} done, ${started} in progress, ${days} day${days === 1 ? "" : "s"} left`
      await core.data(null, r.space).cycles.update(cur.id, { summary: text } as never)
      // Who hears about it: the lead and everyone assigned to or following an issue of the cycle.
      const proj = await core.project(null, r.space).catch(() => null)
      const users = new Set<string>()
      if (proj?.lead) users.add(idOf(proj.lead))
      for (const i of issues) {
        if (i.assignee) users.add(idOf(i.assignee))
        for (const f of i.followers ?? []) users.add(idOf(f))
      }
      for (const u of users) {
        await sendNotice(rookery, {
          user: u,
          kind: "info",
          title: `${r.key} ${cur.name} summary`,
          body: text,
          resource: cycleUri(cur.id),
        })
        sent++
      }
      await log(text)
    }
    return { sent }
  }

  return { list, create, rolloverProject, rolloverAll, progress, summarizeAll }
}
