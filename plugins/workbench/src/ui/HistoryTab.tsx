// History with the commit graph: virtualised rows, 300 commits at a time, of the current branch or all of
// them, or of one file (following renames).
import { Badge, Checkbox, EmptyState, List } from "@aiviarium/nocturne"
import { createMemo, createResource, createSignal, For, Show } from "solid-js"
import { computeGraph, type GraphRow } from "../git/graph"
import { age, type Commit } from "../git/log"
import type { Workspace } from "../workspace"

const LANE = 14
const ROW = 30
const COLORS = [
  "--accent",
  "--label-teal",
  "--label-amber",
  "--label-rose",
  "--label-sky",
  "--label-mint",
  "--label-orchid",
  "--label-ember",
]
const laneColor = (i: number) => `var(${COLORS[i % COLORS.length]})`

function Graph(props: { row: GraphRow; width: number }) {
  const x = (lane: number) => lane * LANE + LANE / 2
  const mid = ROW / 2
  return (
    <svg class="wb-graph" width={props.width * LANE + 4} height={ROW} aria-hidden="true">
      <For each={props.row.into}>
        {(l) => (
          <path
            d={`M ${x(l)} 0 C ${x(l)} ${mid / 2}, ${x(props.row.lane)} ${mid / 2}, ${x(props.row.lane)} ${mid}`}
            stroke={laneColor(props.row.color)}
            fill="none"
            stroke-width="1.5"
          />
        )}
      </For>
      <For each={props.row.edges}>
        {(e) =>
          e.from === props.row.lane ? (
            <path
              d={`M ${x(e.from)} ${mid} C ${x(e.from)} ${ROW}, ${x(e.to)} ${mid}, ${x(e.to)} ${ROW}`}
              stroke={laneColor(e.color)}
              fill="none"
              stroke-width="1.5"
            />
          ) : (
            <path
              d={`M ${x(e.from)} 0 C ${x(e.from)} ${mid}, ${x(e.to)} ${mid}, ${x(e.to)} ${ROW}`}
              stroke={laneColor(e.color)}
              fill="none"
              stroke-width="1.5"
            />
          )
        }
      </For>
      <circle
        cx={x(props.row.lane)}
        cy={mid}
        r="4"
        fill="var(--bg-0)"
        stroke={laneColor(props.row.color)}
        stroke-width="2"
      />
    </svg>
  )
}

export function HistoryTab(props: { w: Workspace; path?: string }) {
  const w = props.w
  const [all, setAll] = createSignal(false)
  const [commits, setCommits] = createSignal<Commit[]>([])
  const [more, setMore] = createSignal(true)
  const [loading, setLoading] = createSignal(false)
  const [active, setActive] = createSignal(0)
  const load = async (reset: boolean) => {
    if (loading()) return
    setLoading(true)
    try {
      const skip = reset ? 0 : commits().length
      const next = await w.api.git.log(w.env, w.root, {
        all: all(),
        path: props.path,
        follow: !!props.path,
        skip,
        limit: 300,
      })
      setCommits(reset ? next : [...commits(), ...next])
      setMore(next.length === 300)
    } finally {
      setLoading(false)
    }
  }
  // An object source: a resource does not run for a source of false.
  createResource(
    () => ({ all: all() }),
    () => load(true),
  )
  const graph = createMemo(() => (props.path ? null : computeGraph(commits())))
  const width = createMemo(() => Math.min(12, Math.max(1, ...(graph()?.map((r) => r.width) ?? [1]))))
  const open = (c: Commit) =>
    w.openTab({
      id: `commit:${c.sha}`,
      kind: "commit",
      title: `${c.sha.slice(0, 7)} ${c.subject}`.slice(0, 40),
      sha: c.sha,
    })
  return (
    <div class="wb-history" data-part="history" data-path={props.path ?? ""}>
      <div class="wb-file__bar">
        <span class="label">{props.path ? `History of ${props.path}` : "History"}</span>
        <span class="caption nc-muted">
          {commits().length}
          {more() ? "+" : ""} commits
        </span>
        <span class="wb-head__spacer" />
        <Show when={!props.path}>
          <Checkbox label="All branches" checked={all()} onChange={setAll} />
        </Show>
      </div>
      <Show
        when={commits().length || loading()}
        fallback={<EmptyState icon="clock" title="No commits yet" />}
      >
        <div class="wb-history__list">
          <List
            items={commits()}
            itemHeight={ROW}
            label="Commits"
            getKey={(c) => c.sha}
            activeIndex={active()}
            onActiveChange={(i) => {
              setActive(i)
              if (more() && i > commits().length - 40) load(false)
            }}
            onSelect={open}
          >
            {(c, i) => (
              <div
                class="wb-commit-row"
                data-commit={c.sha}
                onMouseEnter={() => more() && i > commits().length - 40 && load(false)}
              >
                <Show when={graph()?.[i]}>{(row) => <Graph row={row()} width={width()} />}</Show>
                <span class="wb-commit-row__subject">{c.subject}</span>
                <For each={c.refs}>
                  {(r) => (
                    <Badge
                      tone={r.startsWith("tag:") ? "warning" : r.startsWith("HEAD") ? "accent" : "outline"}
                    >
                      {r.replace(/^HEAD -> /, "")}
                    </Badge>
                  )}
                </For>
                <span class="wb-head__spacer" />
                <span class="caption nc-muted wb-commit-row__author">{c.author}</span>
                <span class="caption nc-muted wb-commit-row__age">{age(c.time)}</span>
                <span class="mono caption nc-muted">{c.sha.slice(0, 7)}</span>
              </div>
            )}
          </List>
        </div>
      </Show>
    </div>
  )
}
