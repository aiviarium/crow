// Cycles: fixed periods of work in a project. Which one is current, what rolls over when one ends, the
// dates of the next ones, and the burn-up (scope and completed issues per day) read from the issues'
// history.
import type { Category, CycleRow } from "./model"
import { closed } from "./model"

/** `YYYY-MM-DD` of a date in UTC. */
export const day = (d: Date) => d.toISOString().slice(0, 10)

export function addDays(date: string, n: number): string {
  const d = new Date(`${date}T00:00:00Z`)
  d.setUTCDate(d.getUTCDate() + n)
  return day(d)
}

export function daysBetween(a: string, b: string): number {
  return Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / 86_400_000)
}

export type CycleStatus = "past" | "current" | "upcoming"

export function cycleStatus(c: Pick<CycleRow, "startsOn" | "endsOn" | "closed">, today: string): CycleStatus {
  if (c.closed || c.endsOn < today) return "past"
  if (c.startsOn <= today) return "current"
  return "upcoming"
}

export function currentCycle<C extends CycleRow>(cycles: C[], today: string): C | null {
  return cycles.find((c) => cycleStatus(c, today) === "current") ?? null
}

/** The first cycle that starts after `c` ends. */
export function nextCycle<C extends CycleRow>(cycles: C[], c: CycleRow): C | null {
  return (
    [...cycles]
      .filter((x) => x.id !== c.id && !x.closed && x.startsOn > c.endsOn)
      .sort((a, b) => (a.startsOn < b.startsOn ? -1 : 1))[0] ?? null
  )
}

/** Dates for a new cycle after the last one (or starting today), `weeks` long. */
export function nextDates(
  cycles: CycleRow[],
  weeks: number,
  today: string,
): { startsOn: string; endsOn: string } {
  const last = [...cycles].sort((a, b) => (a.endsOn < b.endsOn ? 1 : -1))[0]
  const startsOn = last && last.endsOn >= today ? addDays(last.endsOn, 1) : today
  return { startsOn, endsOn: addDays(startsOn, weeks * 7 - 1) }
}

export interface IssueInCycle {
  id: string
  cycle: string | null
  stateCategory: Category | null
}

export interface RolloverPlan {
  /** Cycles that ended: close them. */
  close: string[]
  /** Unfinished issues of an ended cycle and where they go (`"new"`: the cycle `create` makes). */
  moves: Array<{ issue: string; from: string; to: string | "new" }>
  /** A cycle to create (automatic cycles, when none follows the one that ended). */
  create: { startsOn: string; endsOn: string } | null
}

/**
 * What happens at `today`: every open cycle that has ended is closed, and its unfinished issues move to the
 * next cycle. Without a next cycle they move to a new one when the project has automatic cycles, and leave
 * the cycle otherwise (`to: ""`).
 */
export function planRollover(
  cycles: CycleRow[],
  issues: IssueInCycle[],
  today: string,
  opts: { auto: boolean; weeks: number; uri: (id: string) => string },
): RolloverPlan {
  const ended = cycles
    .filter((c) => !c.closed && c.endsOn < today)
    .sort((a, b) => (a.endsOn < b.endsOn ? -1 : 1))
  const plan: RolloverPlan = { close: [], moves: [], create: null }
  if (!ended.length) {
    if (opts.auto && !currentCycle(cycles, today) && !cycles.some((c) => !c.closed && c.startsOn > today))
      plan.create = nextDates(cycles, opts.weeks, today)
    return plan
  }
  const remaining = cycles.filter((c) => !ended.includes(c))
  // Everything unfinished of every ended cycle goes to the first cycle that is not over.
  const target =
    [...remaining].filter((c) => !c.closed).sort((a, b) => (a.startsOn < b.startsOn ? -1 : 1))[0] ?? null
  let to: string | "new" = target ? opts.uri(target.id) : ""
  if (!target && opts.auto) {
    plan.create = nextDates(remaining.length ? remaining : [], opts.weeks, today)
    to = "new"
  }
  for (const c of ended) {
    plan.close.push(c.id)
    const uri = opts.uri(c.id)
    for (const i of issues)
      if (i.cycle === uri && !closed(i.stateCategory)) plan.moves.push({ issue: i.id, from: uri, to })
  }
  return plan
}

/** One change in an issue's life that the burn-up cares about. */
export interface CycleEvent {
  issue: string
  at: string
  /** The issue's cycle after the change, when it changed. */
  cycle?: string | null
  /** The issue's category after the change, when it changed. */
  category?: Category | null
}

export interface BurnPoint {
  date: string
  scope: number
  completed: number
}

/**
 * Scope (issues in the cycle) and completed issues at the end of each day of the cycle, up to `today`.
 * `start` is each issue's state before its first event (an issue created in the cycle starts outside it).
 */
export function burnup(
  cycle: Pick<CycleRow, "startsOn" | "endsOn">,
  cycleUri: string,
  events: CycleEvent[],
  start: Record<string, { cycle: string | null; category: Category | null }>,
  today: string,
): BurnPoint[] {
  const sorted = [...events].sort((a, b) => (a.at < b.at ? -1 : a.at > b.at ? 1 : 0))
  const state = new Map(Object.entries(start).map(([k, v]) => [k, { ...v }]))
  const points: BurnPoint[] = []
  const last = cycle.endsOn < today ? cycle.endsOn : today
  let i = 0
  for (let d = cycle.startsOn; d <= last; d = addDays(d, 1)) {
    const end = `${addDays(d, 1)}T00:00:00Z`
    while (i < sorted.length && sorted[i]!.at < end) {
      const e = sorted[i++]!
      const s = state.get(e.issue) ?? { cycle: null, category: null }
      if (e.cycle !== undefined) s.cycle = e.cycle
      if (e.category !== undefined) s.category = e.category
      state.set(e.issue, s)
    }
    let scope = 0
    let completed = 0
    for (const s of state.values()) {
      if (s.cycle !== cycleUri || s.category === "cancelled") continue
      scope++
      if (s.category === "completed") completed++
    }
    points.push({ date: d, scope, completed })
  }
  return points
}

/**
 * History entries of an issue as burn-up events: its `cycle` and `stateCategory` changes. `current` is the
 * issue as it is now; walking the changes back from it gives where it started.
 */
export function eventsFromHistory(
  issue: string,
  current: { cycle: string | null; category: Category | null },
  entries: Array<{ at: string; op: string; changes: Record<string, [unknown, unknown]> }>,
): { events: CycleEvent[]; start: { cycle: string | null; category: Category | null } } {
  const events: CycleEvent[] = []
  const start = { ...current }
  const newest = [...entries].sort((a, b) => (a.at < b.at ? 1 : -1))
  for (const e of newest) {
    const c = e.changes ?? {}
    const ev: CycleEvent = { issue, at: e.at }
    if ("cycle" in c) {
      ev.cycle = (c.cycle[1] as string | null) ?? null
      start.cycle = (c.cycle[0] as string | null) ?? null
    }
    if ("stateCategory" in c) {
      ev.category = (c.stateCategory[1] as Category | null) ?? null
      start.category = (c.stateCategory[0] as Category | null) ?? null
    }
    if (e.op === "insert") {
      // Before it existed it was in no cycle.
      start.cycle = null
      start.category = null
    }
    if (ev.cycle !== undefined || ev.category !== undefined) events.push(ev)
  }
  return { events: events.reverse(), start }
}
