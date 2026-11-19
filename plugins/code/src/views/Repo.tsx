import { EmptyState, Skeleton } from "@aiviarium/nocturne"
import type { ViewProps } from "@rookery/sdk/client"
import { createEffect, Show } from "solid-js"
import { ItemList } from "../components/ItemList"
import { RepoCard } from "../components/RepoCard"
import { rookery } from "../lib/app"

type Row = Record<string, any>

/** A repository: its sync state and its pull requests. Its issues are its project's (the card links it). */
export function RepoView(props: ViewProps) {
  const c = rookery()
  const live = c.data.repos.live({ where: { id: props.view.path }, limit: 1 })
  const repo = () => live()[0] as Row | undefined
  createEffect(() => {
    if (repo()) props.view.setTitle(repo()!.fullName)
  })
  return (
    <div class="gh-view" data-part="repo-view">
      <Show
        when={repo()}
        fallback={
          <Show when={!live.loading} fallback={<Skeleton style={{ height: "var(--control-lg)" }} />}>
            <EmptyState icon="folder" title="This repository is not attached here" />
          </Show>
        }
      >
        {(r) => (
          <>
            <RepoCard repo={r()} space={r().spaceId} onDetached={() => c.workbench.openView("code.repos")} />
            <ItemList kind="pr" repo={`gh-repo://${r().id}`} embedded />
          </>
        )}
      </Show>
    </div>
  )
}
