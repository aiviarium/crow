import { Badge, Button, EmptyState, Icon, Select, Skeleton, Tabs, TextField } from "@aiviarium/nocturne"
import { createMemo, createSignal, For, type JSX, Show } from "solid-js"
import { openEntity, rookery, useMe } from "../lib/app"
import { applyFilters, type Filters, facets, type ItemRow, NO_FILTERS } from "../lib/filters"
import { ago, plural } from "../lib/format"
import { ChecksState, Labels, ReviewBadge, StateBadge } from "./bits"
import { AttachDialog } from "./dialogs"

type Row = ItemRow & Record<string, any>

const STATES = [
  { id: "open", label: "Open" },
  { id: "merged", label: "Merged" },
  { id: "closed", label: "Closed" },
  { id: "all", label: "All" },
] as const

/**
 * The list of pull requests of the current space (or of one repository), kept live. (Issues are Projects
 * issues, listed by Projects.) The state is asked of the store; the other filters (mine, author, label,
 * review, checks, text) apply to what comes back.
 */
export function ItemList(props: {
  kind: "pr"
  repo?: string
  embedded?: boolean
  initial?: Partial<Filters>
}): JSX.Element {
  const c = rookery()
  const pr = props.kind === "pr"
  const [filters, setFilters] = createSignal<Filters>({
    ...NO_FILTERS,
    ...props.initial,
    repo: props.repo ?? props.initial?.repo ?? "",
  })
  const set = (patch: Partial<Filters>) => setFilters({ ...filters(), ...patch })
  const { logins, me } = useMe()
  const [attach, setAttach] = createSignal(false)

  const states = createMemo(() => {
    const s = filters().state
    return s === "all" ? undefined : s
  })
  // One live query per state choice; the store filters by it, so a repository with thousands of closed items
  // does not send them to a view that shows the open ones.
  const live = createMemo(() => {
    const where = { ...(states() ? { state: states() } : {}), ...(props.repo ? { repo: props.repo } : {}) }
    const q = { where, orderBy: [["ghUpdatedAt", "desc"]] as Array<[string, "desc"]>, limit: 500 }
    return c.data.prs.live(q as never)
  })
  const repos = c.data.repos.live({ limit: 200 })
  const rows = () => live()() as unknown as Row[]
  const shown = createMemo(() =>
    applyFilters(
      rows().filter((r) => !r.removed),
      filters(),
      logins(),
    ),
  )
  const fac = createMemo(() => facets(rows()))
  const repoName = (uri: string) =>
    (repos() as unknown as Row[]).find((r) => `gh-repo://${r.id}` === uri)?.fullName ?? ""
  const open = (r: Row) => openEntity(`gh-pr://${r.id}`)
  const anyFilter = () =>
    JSON.stringify({ ...filters(), state: "" }) !==
    JSON.stringify({ ...NO_FILTERS, ...(props.repo ? { repo: props.repo } : {}), state: "" })
  const noun = pr ? "pull request" : "issue"
  const mineOptions: Array<{ id: Filters["mine"]; label: string }> = [
    { id: "all", label: "Everyone's" },
    { id: "authored", label: "Mine" },
    ...(pr ? [{ id: "review" as const, label: "Review requested" }] : []),
    { id: "assigned", label: "Assigned" },
  ]

  return (
    <div class="gh-list" data-part={pr ? "pull-list" : "issue-list"}>
      <div class="gh-filters">
        <Tabs
          label="State"
          variant="segmented"
          items={STATES.map((x) => ({ id: x.id, label: x.label }))}
          value={filters().state}
          onChange={(v) => set({ state: v as Filters["state"] })}
        />
        <Show when={(me()?.logins.length ?? 0) > 0}>
          <Tabs
            label="Whose"
            variant="segmented"
            items={mineOptions}
            value={filters().mine}
            onChange={(v) => set({ mine: v as Filters["mine"] })}
          />
        </Show>
        <TextField
          variant="search"
          aria-label={`Search ${noun}s`}
          placeholder={`Search ${noun}s`}
          value={filters().text}
          onInput={(e) => set({ text: e.currentTarget.value })}
          class="gh-search"
        />
        <Select<string>
          label="Author"
          options={[
            { value: "", label: "Any author" },
            ...fac().authors.map((a) => ({ value: a, label: a })),
          ]}
          value={filters().author}
          onChange={(v) => set({ author: v })}
          class="gh-filter"
        />
        <Select<string>
          label="Label"
          options={[
            { value: "", label: "Any label" },
            ...fac().labels.map((l) => ({ value: l.name, label: l.name })),
          ]}
          value={filters().label}
          onChange={(v) => set({ label: v })}
          class="gh-filter"
        />
        <Show when={pr}>
          <Select<string>
            label="Review"
            options={[
              { value: "", label: "Any review state" },
              { value: "pending", label: "Review required" },
              { value: "approved", label: "Approved" },
              { value: "changes_requested", label: "Changes requested" },
              { value: "commented", label: "Commented" },
            ]}
            value={filters().review}
            onChange={(v) => set({ review: v })}
            class="gh-filter"
          />
          <Select<string>
            label="Checks"
            options={[
              { value: "", label: "Any checks" },
              { value: "success", label: "Passing" },
              { value: "failure", label: "Failing" },
              { value: "pending", label: "Running" },
            ]}
            value={filters().checks}
            onChange={(v) => set({ checks: v })}
            class="gh-filter"
          />
        </Show>
        <Show when={!props.repo && (repos().length ?? 0) > 1}>
          <Select<string>
            label="Repository"
            options={[
              { value: "", label: "Every repository" },
              ...(repos() as unknown as Row[]).map((r) => ({
                value: `gh-repo://${r.id}`,
                label: r.fullName,
              })),
            ]}
            value={filters().repo}
            onChange={(v) => set({ repo: v })}
            class="gh-filter"
          />
        </Show>
        <Show when={anyFilter()}>
          <Button
            size="sm"
            variant="ghost"
            onClick={() => setFilters({ ...NO_FILTERS, state: filters().state, repo: props.repo ?? "" })}
          >
            Clear filters
          </Button>
        </Show>
      </div>

      <Show when={live().error}>
        <p class="gh-error">{live().error?.message}</p>
      </Show>
      <Show
        when={!live().loading}
        fallback={
          <div class="gh-rows" aria-busy="true">
            <Skeleton style={{ height: "var(--row-default)" }} />
          </div>
        }
      >
        <Show
          when={shown().length > 0}
          fallback={
            <Show
              when={rows().length === 0 && !anyFilter() && (repos().length ?? 0) === 0}
              fallback={
                <EmptyState
                  icon="filter"
                  title={`No ${noun}s match`}
                  description={
                    rows().length
                      ? "Change or clear the filters to see more."
                      : `There are no ${filters().state === "all" ? "" : `${filters().state} `}${noun}s here yet.`
                  }
                />
              }
            >
              <EmptyState
                icon="branch"
                title="No repository is attached to this space"
                description={`Attach a repository to see its ${noun}s here, kept in sync with GitHub.`}
              >
                <Button
                  variant="secondary"
                  icon="plus"
                  onClick={() => setAttach(true)}
                  data-testid="attach-first"
                >
                  Attach a repository
                </Button>
              </EmptyState>
            </Show>
          }
        >
          <ul class="gh-rows" aria-label={`${plural(shown().length, noun)}`}>
            <For each={shown()}>
              {(r) => (
                <li>
                  <button
                    type="button"
                    class="gh-row"
                    data-item={r.id}
                    data-number={r.number}
                    onClick={() => open(r)}
                  >
                    <span class="gh-row__state">
                      <Icon name={pr ? "branch" : "list"} size="sm" />
                    </span>
                    <span class="gh-row__main">
                      <span class="gh-row__title">
                        <span class="gh-row__name">{r.title}</span>
                        <Labels labels={r.labels} />
                      </span>
                      <span class="nc-meta gh-row__meta">
                        {repoName(r.repo)}#{r.number} · {r.author} · {ago(r.ghUpdatedAt)}
                        <Show when={r.commentCount}> · {plural(r.commentCount, "comment")}</Show>
                      </span>
                    </span>
                    <span class="gh-row__badges">
                      <Show when={r.state !== "open" || r.draft || !pr}>
                        <StateBadge state={r.state} draft={r.draft} />
                      </Show>
                      <Show when={pr && r.state === "open"}>
                        <Show when={r.checksState && r.checksState !== "none"}>
                          <ChecksState state={r.checksState} short />
                        </Show>
                        <Show when={r.reviewState && r.reviewState !== "none"}>
                          <ReviewBadge state={r.reviewState} />
                        </Show>
                      </Show>
                    </span>
                  </button>
                </li>
              )}
            </For>
          </ul>
          <Show when={live().hasMore}>
            <p class="nc-meta gh-more">Showing the {rows().length} most recently changed.</p>
          </Show>
        </Show>
      </Show>
      <AttachDialog
        open={attach()}
        onClose={() => setAttach(false)}
        onAttached={(r) => openEntity(`gh-repo://${r.id}`)}
      />
    </div>
  )
}
