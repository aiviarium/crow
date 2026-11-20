// `code.issue` (`/<space>/github/issue/<id>`): an address from before issues were Projects issues. The
// stored issue became a Projects issue and `gh-issue://<id>` names it, so this view only opens that issue,
// in the place of this address.
import { EmptyState, Skeleton } from "@aiviarium/nocturne"
import type { ViewProps } from "@rookery/sdk/client"
import { createEffect, createResource, Show } from "solid-js"
import { rookery } from "../lib/app"

export function IssueView(props: ViewProps) {
  props.view.setTitle("Issue")
  const c = rookery()
  const [target] = createResource(
    () => props.view.path,
    (id) => c.host.call<{ space: string; key: string } | null>("issueFor", { id }).catch(() => null),
  )
  createEffect(() => {
    const t = target()
    if (t)
      c.workbench.openView("projects.issue", {
        path: t.key,
        context: { "rookery.space": t.space },
        replace: true,
      })
  })
  return (
    <div class="gh-view" data-part="issue-moved">
      <Show when={!target.loading} fallback={<Skeleton style={{ height: "var(--control-lg)" }} />}>
        <Show when={!target()}>
          <EmptyState icon="list" title="This issue is not available" />
        </Show>
      </Show>
    </div>
  )
}
