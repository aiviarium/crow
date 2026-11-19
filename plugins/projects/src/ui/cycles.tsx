// Cycles of a project: the current one first, then upcoming and past ones, each with its progress; a cycle's
// page shows its scope and burn-up (read from the issues' history) and its issues by state.

import { Button, EmptyState, Icon, IconButton, StatCard, ViewHeader } from "@aiviarium/nocturne"
import type { ClientRookery } from "@rookery/sdk/client"
import { createEffect, createMemo, createResource, createSignal, For, onCleanup, Show } from "solid-js"
import { type BurnPoint, cycleStatus } from "../lib/cycles"
import { DEFAULT_DISPLAY, groupIssues } from "../lib/display"
import type { CycleRow } from "../lib/model"
import { Key, StateIcon } from "./glyphs"
import { lookupFor } from "./issues"
import { formatDay } from "./props"
import { entitiesOf, toRookeryError } from "./sdk"
import { acquire, today } from "./store"

export function CyclesView(props: { crow: ClientRookery; space: string; setTitle: (t: string) => void }) {
  const crow = props.crow
  const { store, release } = acquire(crow, props.space)
  onCleanup(release)
  props.setTitle("Cycles")
  const canUse = () => store.level() === "use" || store.level() === "manage"
  const ordered = createMemo(() => {
    const t = today()
    const by = { current: [] as CycleRow[], upcoming: [] as CycleRow[], past: [] as CycleRow[] }
    for (const c of store.cycles()) by[cycleStatus(c, t)].push(c)
    by.past.reverse()
    return by
  })
  const stats = (c: CycleRow) => {
    const uri = `cycle://${c.id}`
    const list = store.issues().filter((i) => i.cycle === uri && i.stateCategory !== "cancelled")
    const done = list.filter((i) => i.stateCategory === "completed").length
    const started = list.filter((i) => i.stateCategory === "started").length
    return { total: list.length, done, started }
  }
  const create = async () => {
    try {
      const c = await crow.host.call<CycleRow>("createCycle", { space: props.space })
      crow.workbench.openView("projects.cycle", { path: c.id })
    } catch (e) {
      crow.workbench.toast({ title: "No cycle created", body: toRookeryError(e).message, kind: "danger" })
    }
  }
  const Row = (p: { c: CycleRow }) => {
    const s = () => stats(p.c)
    return (
      <button
        type="button"
        class="projects__cycle-row"
        data-cycle={p.c.id}
        onClick={() => crow.workbench.openView("projects.cycle", { path: p.c.id })}
      >
        <Icon name="clock" size="sm" />
        <span class="label">{p.c.name}</span>
        <span class="nc-meta">
          {formatDay(p.c.startsOn)} – {formatDay(p.c.endsOn)}
        </span>
        <span class="projects__spacer" />
        <span class="projects__meter nc-meter" aria-hidden="true">
          <span style={{ width: `${s().total ? Math.round((s().done / s().total) * 100) : 0}%` }} />
        </span>
        <span class="nc-meta nc-num">
          {s().done}/{s().total}
        </span>
      </button>
    )
  }
  return (
    <div class="projects__page" data-part="cycles">
      <ViewHeader>
        <span class="nc-meta">{store.project()?.name}</span>
        <span class="projects__spacer" />
        <Show when={canUse()}>
          <IconButton label="New cycle" icon="plus" onClick={create} data-testid="new-cycle" />
        </Show>
      </ViewHeader>
      <Show
        when={store.cycles().length}
        fallback={
          <EmptyState
            icon="clock"
            title="No cycles yet"
            description="A cycle is a fixed stretch of work, one or more weeks. Unfinished issues roll over to the next one."
          >
            <Show when={canUse()}>
              <Button variant="secondary" icon="plus" onClick={create}>
                Start a cycle
              </Button>
            </Show>
          </EmptyState>
        }
      >
        <div class="projects__cycles">
          <For
            each={
              [
                ["Current", ordered().current],
                ["Upcoming", ordered().upcoming],
                ["Past", ordered().past],
              ] as const
            }
          >
            {([title, list]) => (
              <Show when={list.length}>
                <section class="projects__section">
                  <span class="section">{title}</span>
                  <For each={list}>{(c) => <Row c={c} />}</For>
                </section>
              </Show>
            )}
          </For>
        </div>
      </Show>
    </div>
  )
}

export function CycleView(props: {
  crow: ClientRookery
  space: string
  id: string
  setTitle: (t: string) => void
}) {
  const crow = props.crow
  const { store, release } = acquire(crow, props.space)
  onCleanup(release)
  const cycle = () => store.cycles().find((c) => c.id === props.id)
  createEffect(() => cycle() && props.setTitle(cycle()!.name))
  const uri = `cycle://${props.id}`
  const issues = createMemo(() => store.issues().filter((i) => i.cycle === uri))
  const [progress] = createResource(
    () =>
      [
        issues()
          .map((i) => `${i.id}:${i.rev}`)
          .join(","),
        cycle()?.id,
      ] as const,
    () =>
      crow.host
        .call<{ points: BurnPoint[]; scope: number; completed: number; open: number }>("cycleProgress", {
          space: props.space,
          id: props.id,
        })
        .catch(() => null),
  )
  const groups = createMemo(() =>
    groupIssues(issues(), { ...DEFAULT_DISPLAY, completed: "all" }, lookupFor(crow, store)),
  )
  const status = () => (cycle() ? cycleStatus(cycle()!, today()) : "past")
  const daysLeft = () =>
    cycle()
      ? Math.max(0, Math.ceil((Date.parse(`${cycle()!.endsOn}T23:59:59Z`) - Date.now()) / 86_400_000))
      : 0
  const [rolling, setRolling] = createSignal(false)
  return (
    <div class="projects__page" data-part="cycle">
      <Show
        when={cycle()}
        fallback={
          <Show when={!store.loading()}>
            <EmptyState icon="clock" title="This cycle is not available" />
          </Show>
        }
      >
        {(c) => (
          <>
            <ViewHeader>
              <span class="nc-meta">
                {formatDay(c().startsOn)} – {formatDay(c().endsOn)}
              </span>
              <span class="nc-badge" data-status={status()}>
                {status() === "current"
                  ? `${daysLeft()} days left`
                  : status() === "upcoming"
                    ? "Upcoming"
                    : "Closed"}
              </span>
              <span class="projects__spacer" />
              <Show when={status() === "past" && !c().closed}>
                <Button
                  size="sm"
                  variant="secondary"
                  loading={rolling()}
                  onClick={async () => {
                    setRolling(true)
                    await crow.host.call("rollover", { space: props.space }).catch(() => {})
                    setRolling(false)
                  }}
                >
                  Roll over now
                </Button>
              </Show>
              <Button
                size="sm"
                variant="secondary"
                icon="list"
                onClick={() => crow.workbench.openView("projects.cycles")}
              >
                All cycles
              </Button>
            </ViewHeader>
            <div class="projects__cycle-body">
              <div class="projects__stats">
                <StatCard
                  label="Scope"
                  value={String(
                    progress()?.scope ?? issues().filter((i) => i.stateCategory !== "cancelled").length,
                  )}
                />
                <StatCard
                  label="Completed"
                  value={String(
                    progress()?.completed ?? issues().filter((i) => i.stateCategory === "completed").length,
                  )}
                />
                <StatCard label="Open" value={String(progress()?.open ?? 0)} />
              </div>
              <section class="projects__section" data-part="burnup">
                <header class="projects__section-head">
                  <span class="label">Burn-up</span>
                  <span class="nc-meta">Scope and done, per day</span>
                </header>
                <BurnUp points={progress()?.points ?? []} start={c().startsOn} end={c().endsOn} />
              </section>
              <Show when={c().summary}>
                <p class="nc-meta">{c().summary}</p>
              </Show>
              <section class="projects__section">
                <For each={groups()}>
                  {(g) => (
                    <div class="projects__cycle-group">
                      <span class="projects__cycle-group-head">
                        <StateIcon category={g.state?.category} color={g.state?.color} />
                        <span class="label">{g.name}</span>
                        <span class="nc-meta nc-num">{g.issues.length}</span>
                      </span>
                      <For each={g.issues}>
                        {(i) => (
                          <button
                            type="button"
                            class="projects__recent"
                            onClick={() => entitiesOf(crow).open(`issue://${i.id}`)}
                          >
                            <Key>{i.key}</Key>
                            <span class="projects__recent-title">{i.title}</span>
                          </button>
                        )}
                      </For>
                    </div>
                  )}
                </For>
              </section>
            </div>
          </>
        )}
      </Show>
    </div>
  )
}

/** The burn-up as an SVG: scope as a line, completed as an area, one point per day. */
function BurnUp(props: { points: BurnPoint[]; start: string; end: string }) {
  const W = 640
  const H = 180
  const P = 24
  const days = () => Math.max(1, Math.round((Date.parse(props.end) - Date.parse(props.start)) / 86_400_000))
  const max = () => Math.max(1, ...props.points.map((p) => p.scope))
  const x = (i: number) => P + (i / days()) * (W - 2 * P)
  const y = (v: number) => H - P - (v / max()) * (H - 2 * P)
  const line = (k: "scope" | "completed") =>
    props.points.map((p, i) => `${i ? "L" : "M"}${x(i).toFixed(1)},${y(p[k]).toFixed(1)}`).join(" ")
  const area = () =>
    props.points.length
      ? `${line("completed")} L${x(props.points.length - 1).toFixed(1)},${y(0)} L${x(0)},${y(0)} Z`
      : ""
  return (
    <Show
      when={props.points.length}
      fallback={<span class="nc-meta">The burn-up starts on the cycle's first day.</span>}
    >
      <svg class="projects__burnup" viewBox={`0 0 ${W} ${H}`} role="img" aria-label="Burn-up chart">
        <line x1={P} x2={W - P} y1={y(0)} y2={y(0)} style={{ stroke: "var(--line-soft)" }} />
        <line
          x1={P}
          x2={W - P}
          y1={y(max())}
          y2={y(max())}
          style={{ stroke: "var(--line-subtle)" }}
          stroke-dasharray="3 3"
        />
        <path d={area()} style={{ fill: "var(--accent-tint)" }} />
        <path d={line("completed")} fill="none" stroke-width="2" style={{ stroke: "var(--accent-strong)" }} />
        <path
          d={line("scope")}
          fill="none"
          stroke-width="1.5"
          style={{ stroke: "var(--text-3)" }}
          stroke-dasharray="4 3"
        />
        <text x={P} y={H - 6} class="projects__burnup-text">
          {formatDay(props.start)}
        </text>
        <text x={W - P} y={H - 6} text-anchor="end" class="projects__burnup-text">
          {formatDay(props.end)}
        </text>
        <text x={W - P} y={y(max()) - 4} text-anchor="end" class="projects__burnup-text">
          {max()} in scope
        </text>
      </svg>
      <div class="projects__progress-legend">
        <span class="nc-meta">
          <span class="projects__legend projects__legend--scope" /> Scope
        </span>
        <span class="nc-meta">
          <span class="projects__legend projects__legend--done" /> Completed
        </span>
      </div>
    </Show>
  )
}
