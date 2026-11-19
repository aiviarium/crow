// Artifacts & Needs-You views for the Agents plugin.
// - `ArtifactsView`: sessions and workspaces across connected Parrot hosts, searchable.
// - `NeedsYouView`: sessions in Parrot's `requires_action` state that need approval or an answer.
import {
  Card,
  EmptyState,
  Icon,
  ListRow,
  NavItem,
  RowList,
  Select,
  TextField,
  ViewHeader,
  ViewLayout,
} from "@aiviarium/nocturne"
import type { ClientRookery } from "@rookery/sdk/client"
import { createMemo, createSignal, For, Show } from "solid-js"
import { PHONE, useMedia } from "./chat"
import { needsYou, relative } from "./model"
import { type AgentsStore, formatChatPath } from "./store"

export function ArtifactsView(rookery: ClientRookery, store: AgentsStore) {
  return (props: { view: { setTitle(t: string): void } }) => {
    props.view.setTitle("Artifacts")
    const phone = useMedia(PHONE)
    const [scope, setScope] = createSignal<"all" | "recent">("all")
    const [hostFilter, setHostFilter] = createSignal<string | null>(null)
    const [query, setQuery] = createSignal("")

    const allEntries = createMemo(() =>
      store.allSessions().map(({ host, session }) => ({
        host,
        id: session.id,
        title: session.title || "Agent session",
        agent: session.agent || "agent",
        updated: session.updated,
        state: session.state,
      })),
    )

    const hostCounts = createMemo(() => {
      const m = new Map<string, number>()
      for (const e of allEntries()) m.set(e.host, (m.get(e.host) ?? 0) + 1)
      return [...m].sort((a, b) => b[1] - a[1])
    })

    const shown = createMemo(() => {
      let list = allEntries()
      if (hostFilter()) list = list.filter((e) => e.host === hostFilter())
      const q = query().trim().toLowerCase()
      if (q) {
        list = list.filter(
          (e) =>
            e.title.toLowerCase().includes(q) ||
            e.host.toLowerCase().includes(q) ||
            e.agent.toLowerCase().includes(q),
        )
      }
      if (scope() === "recent") {
        list = list.filter((e) => Date.now() - Date.parse(e.updated) < 7 * 86400_000)
      }
      return list
    })

    const pick = (s: "all" | "recent") => {
      setScope(s)
      setHostFilter(null)
    }

    const library = (
      <nav class="ag-art__nav" aria-label="Library">
        <span class="ag-list__day">Sessions</span>
        <NavItem
          label="All sessions"
          icon="grid"
          current={scope() === "all" && !hostFilter()}
          meta={allEntries().length ? String(allEntries().length) : undefined}
          onClick={() => pick("all")}
        />
        <NavItem label="Recent" icon="clock" current={scope() === "recent"} onClick={() => pick("recent")} />
        <Show when={hostCounts().length}>
          <span class="ag-list__day">Hosts</span>
          <For each={hostCounts()}>
            {([h, n]) => (
              <NavItem
                label={h}
                icon="server"
                current={hostFilter() === h}
                meta={String(n)}
                onClick={() => setHostFilter(h)}
              />
            )}
          </For>
        </Show>
      </nav>
    )

    return (
      <div class="ag-art" data-part="artifacts">
        <ViewLayout
          id="agents.artifacts"
          sidebar={phone() ? undefined : library}
          sidebarLabel="Library"
          sidebarWidth={220}
        >
          <div class="ag-art__main">
            <ViewHeader class="ag-art__head">
              <span class="crow-push" />
              <Show when={phone()}>
                <Select
                  aria-label="Show"
                  value={hostFilter() ? `host:${hostFilter()}` : scope()}
                  options={[
                    { value: "all", label: "All sessions" },
                    { value: "recent", label: "Recent" },
                    ...hostCounts().map(([h, n]) => ({ value: `host:${h}`, label: `${h} (${n})` })),
                  ]}
                  onChange={(v) => (v.startsWith("host:") ? setHostFilter(v.slice(5)) : pick(v as "all"))}
                />
              </Show>
              <TextField
                variant="search"
                label="Search sessions"
                placeholder="Search"
                value={query()}
                onInput={(e) => setQuery(e.currentTarget.value)}
              />
            </ViewHeader>
            <Show when={shown().length} fallback={<EmptyState icon="grid" title="Nothing here yet" />}>
              <div class="ag-art__grid">
                <For each={shown()}>
                  {(entry) => (
                    <Card
                      class="ag-card"
                      data-part="artifact"
                      label={entry.title}
                      onClick={() =>
                        rookery.workbench.openView("agents.chat", {
                          path: formatChatPath(entry.host, entry.id),
                        })
                      }
                    >
                      <span class="ag-card__thumb" data-scheme="session">
                        <Icon name="sparkle" />
                      </span>
                      <span class="ag-card__name">{entry.title}</span>
                      <span class="nc-meta">
                        {entry.agent} · {relative(entry.updated)}
                      </span>
                      <span class="ag-card__foot">
                        <span class="ag-card__share nc-meta">
                          <Icon name="server" size="sm" />
                          {entry.host}
                        </span>
                      </span>
                    </Card>
                  )}
                </For>
              </div>
            </Show>
          </div>
        </ViewLayout>
      </div>
    )
  }
}

/** Home's "agents that need you": sessions in Parrot's `requires_action` state. */
export function NeedsYouView(rookery: ClientRookery, store: AgentsStore) {
  return (props: { view: { setTitle(t: string): void } }) => {
    props.view.setTitle("Agents that need you")
    const waiting = createMemo(() => store.allSessions().filter(({ session }) => needsYou(session)))
    return (
      <Show when={waiting().length}>
        <RowList label="Agent sessions that need you" data-part="agents-home">
          <For each={waiting()}>
            {({ host, session }) => {
              const path = formatChatPath(host, session.id)
              return (
                <ListRow
                  data-session={session.id}
                  icon="sparkle"
                  title={session.title || "New session"}
                  secondary={`${host}${session.agent ? ` · ${session.agent}` : ""}`}
                  href={rookery.views.href("agents.chat", { path }) ?? undefined}
                  onClick={(e) => {
                    e.preventDefault()
                    rookery.workbench.openView("agents.chat", { path })
                  }}
                />
              )
            }}
          </For>
        </RowList>
      </Show>
    )
  }
}
