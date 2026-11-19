import { Button, EmptyState, ListRow, Skeleton, ViewHeader } from "@aiviarium/nocturne"
import type { ViewProps } from "@rookery/sdk/client"
import { createEffect, createResource, For, Show } from "solid-js"
import { ItemList } from "../components/ItemList"
import { rookery } from "../lib/app"

export function PullsView(props: ViewProps) {
  props.view.setTitle("Pull requests")
  const c = rookery()
  return (
    <div class="gh-view" data-part="pulls-view">
      <ViewHeader
        context={<span class="nc-meta">{c.spaces.current()?.name}</span>}
        actions={[
          {
            id: "repositories",
            label: "Repositories",
            icon: "folder",
            onClick: () => c.workbench.openView("code.repos"),
          },
        ]}
      />
      <ItemList kind="pr" />
    </div>
  )
}

/**
 * "Issues" in GitHub's navigation: a space's GitHub issues are the issues of the project its repositories are
 * linked to, so this opens that project's issues. With several projects it lists them.
 */
export function IssuesView(props: ViewProps) {
  props.view.setTitle("Issues")
  const c = rookery()
  const [found] = createResource(
    () => c.spaces.current()?.id,
    async (space) =>
      (
        await c.host
          .call<{
            projects: Array<{ space: string; slug: string; name: string; key: string | null; repo: string }>
          }>("projects", { space })
          .catch(() => ({ projects: [] }))
      ).projects,
  )
  const distinct = () => {
    const seen = new Map<string, { slug: string; name: string; repos: string[] }>()
    for (const p of found() ?? []) {
      const s = seen.get(p.space) ?? { slug: p.slug, name: p.name, repos: [] }
      s.repos.push(p.repo)
      seen.set(p.space, s)
    }
    return [...seen.values()]
  }
  const open = (slug: string, replace = false) =>
    c.workbench.openView("projects.issues", { context: { "rookery.space": slug }, replace })
  createEffect(() => {
    const list = distinct()
    if (found.state === "ready" && list.length === 1) open(list[0]!.slug, true)
  })
  return (
    <div class="gh-view" data-part="issues-view">
      <Show when={found.state === "ready"} fallback={<Skeleton style={{ height: "var(--control-lg)" }} />}>
        <Show
          when={distinct().length > 1}
          fallback={
            <Show when={distinct().length === 0}>
              <EmptyState icon="list" title="No repository is attached here">
                <Button variant="primary" icon="plus" onClick={() => c.workbench.openView("code.repos")}>
                  Attach a repository
                </Button>
              </EmptyState>
            </Show>
          }
        >
          <ViewHeader context={<span class="nc-meta">{c.spaces.current()?.name}</span>} />
          <div class="gh-projects" data-part="issue-projects">
            <For each={distinct()}>
              {(p) => (
                <ListRow
                  icon="board"
                  title={p.name}
                  secondary={p.repos.join(", ")}
                  onClick={() => open(p.slug)}
                />
              )}
            </For>
          </div>
        </Show>
      </Show>
    </div>
  )
}
