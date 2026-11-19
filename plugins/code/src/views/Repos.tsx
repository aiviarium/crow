import { Button, EmptyState, Skeleton, ViewHeader } from "@aiviarium/nocturne"
import type { ViewProps } from "@rookery/sdk/client"
import { createSignal, For, Show } from "solid-js"
import { AttachDialog } from "../components/dialogs"
import { RepoCard } from "../components/RepoCard"
import { openEntity, rookery } from "../lib/app"
import { plural } from "../lib/format"

type Row = Record<string, any>

export function ReposView(props: ViewProps) {
  const c = rookery()
  props.view.setTitle("Repositories")
  const repos = c.data.repos.live({ orderBy: [["fullName", "asc"]], limit: 200 })
  const space = () => c.spaces.current()
  const [attach, setAttach] = createSignal(false)
  const list = () => repos() as unknown as Row[]
  return (
    <div class="gh-view" data-part="repos-view">
      <ViewHeader
        context={
          <span class="nc-meta">
            {space()?.name} · {plural(list().length, "repository", "repositories")}
          </span>
        }
        actions={[
          {
            id: "connections",
            label: "Connections",
            icon: "link",
            onClick: () => c.workbench.openView("code.connect"),
          },
          {
            id: "attach",
            label: "Attach a repository",
            icon: "plus",
            onClick: () => setAttach(true),
          },
        ]}
      />
      <Show when={!repos.loading} fallback={<Skeleton style={{ height: "var(--control-lg)" }} />}>
        <Show
          when={list().length}
          fallback={
            <EmptyState
              icon="folder"
              title="No repository is attached to this space"
              description="Attach one to keep its pull requests and issues here, in sync with GitHub, and to link them to what you track in Crow."
            >
              <Button variant="secondary" icon="plus" onClick={() => setAttach(true)}>
                Attach a repository
              </Button>
            </EmptyState>
          }
        >
          <div class="gh-repos">
            <For each={list()}>
              {(r) => (
                <RepoCard repo={r} space={space()?.id ?? ""} onOpen={() => openEntity(`gh-repo://${r.id}`)} />
              )}
            </For>
          </div>
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
