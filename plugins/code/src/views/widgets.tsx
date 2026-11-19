import { Widget } from "@aiviarium/nocturne"
import type { ClientRookery } from "@rookery/sdk/client"
import { createMemo, createResource, For, type JSX, Show } from "solid-js"
import { ChecksState, ReviewBadge } from "../components/bits"
import { openEntity, rookery, useMe } from "../lib/app"
import { same } from "../lib/filters"
import { ago } from "../lib/format"
import type { WidgetProps } from "../lib/widgets"

type Row = Record<string, any>

/**
 * The widgets read pull requests of every space the person is in (a live query over `spaces`), so a tile on
 * the home screen, which belongs to no space, is as useful as one on a project's dashboard.
 */
function spacesOf(c: ClientRookery) {
  const [spaces] = createResource(() => c.spaces.list())
  return () => (spaces() ?? []).map((s) => s.id)
}

function PullTile(
  props: WidgetProps & {
    title: string
    pick: (rows: Row[], me: string[]) => Row[]
    testid: string
    badge: "checks" | "review"
  },
): JSX.Element {
  const c = rookery()
  const spaces = spacesOf(c)
  const { logins, me } = useMe()
  const live = createMemo(() =>
    spaces().length
      ? c.data.prs.live({
          where: { state: "open" },
          spaces: spaces(),
          orderBy: [["ghUpdatedAt", "desc"]],
          limit: 200,
        } as never)
      : null,
  )
  const rows = () =>
    props.pick(
      ((live()?.() ?? []) as unknown as Row[]).filter((r) => !r.removed),
      logins(),
    )
  const limit = () =>
    Math.min(Number(props.widget.settings.limit ?? 6), Math.max(1, props.widget.size.h * 2 - 2))
  // Nothing to list renders nothing, so the page leaves the widget out. Without a token the person can add
  // one, so they are told.
  return (
    <Show when={!me.loading && (logins().length === 0 || rows().length > 0)}>
      <Widget
        fill
        title={props.title}
        value={rows().length ? String(rows().length) : undefined}
        data-widget-body={props.testid}
      >
        <Show
          when={logins().length > 0}
          fallback={
            <span class="nc-meta">Add a personal token in Settings › Connections to see yours here.</span>
          }
        >
          <ul class="gh-widget" aria-label={props.title}>
            <For each={rows().slice(0, limit())}>
              {(r) => (
                <li>
                  <button
                    type="button"
                    class="gh-widget__row"
                    data-item={r.id}
                    onClick={() => openEntity(`gh-pr://${r.id}`)}
                  >
                    <span class="label gh-widget__title">{r.title}</span>
                    <span class="nc-meta">
                      #{r.number} · {ago(r.ghUpdatedAt)}
                    </span>
                    <Show when={props.badge === "checks"} fallback={<ReviewBadge state={r.reviewState} />}>
                      <ChecksState state={r.checksState} short />
                    </Show>
                  </button>
                </li>
              )}
            </For>
          </ul>
        </Show>
      </Widget>
    </Show>
  )
}

export const MyPulls = (p: WidgetProps) => (
  <PullTile
    {...p}
    title="My pull requests"
    testid="my-pulls"
    badge="review"
    pick={(rows, me) => rows.filter((r) => me.some((l) => same(l, r.author)))}
  />
)
export const ReviewRequests = (p: WidgetProps) => (
  <PullTile
    {...p}
    title="Review requests"
    testid="review-requests"
    badge="checks"
    pick={(rows, me) =>
      rows.filter((r) => ((r.reviewers ?? []) as string[]).some((x) => me.some((l) => same(l, x))))
    }
  />
)
export const FailingChecks = (p: WidgetProps) => (
  <PullTile
    {...p}
    title="Checks failing"
    testid="failing-checks"
    badge="checks"
    pick={(rows, me) => rows.filter((r) => r.checksState === "failure" && me.some((l) => same(l, r.author)))}
  />
)
