// Issues from another tracker (docs/issues.md), as the views show them: a small badge with the source's icon
// and its number (`#212`) on cards, rows and the issue page, "Open on GitHub", the source's people who are not
// Crow users, and the exceptional states (a write the source refused, an issue gone from it). Nothing shows
// while all is well.

import { Avatar, Button, Callout, Icon, type IconName } from "@aiviarium/nocturne"
import type { ClientRookery } from "@rookery/sdk/client"
import { createResource, createSignal, For, type JSX, Show } from "solid-js"
import type { IssueRow } from "../lib/model"
import type { IssueSource, SourcePerson } from "../lib/source"

export interface SourceKind {
  id: string
  title: string
  icon: string | null
}

let kinds: Promise<SourceKind[]> | null = null
/** The sources that are contributed now (their names and icons), read once per page. */
export function useSourceKinds(crow: ClientRookery) {
  if (!kinds)
    kinds = crow.host
      .call<{ sources: SourceKind[] }>("sourceKinds", {})
      .then((r) => r.sources)
      .catch(() => {
        kinds = null
        return []
      })
  const [list] = createResource(() => kinds!)
  return (provider: string | null | undefined): SourceKind => {
    const k = list()?.find((x) => x.id === provider)
    return k ?? { id: provider ?? "", title: provider === "github" ? "GitHub" : (provider ?? ""), icon: null }
  }
}

const iconOf = (k: SourceKind): IconName => (k.icon as IconName | null) ?? "link"

/** Whether the issue's sync is in an exceptional state: refused, rate limited, gone from the source. */
export const troubled = (s: IssueSource | null | undefined) => !!s && (!!s.error || !!s.removed)

/** The source's icon and the issue's number there. Shown only for issues that have a source. */
export function SourceBadge(props: { crow: ClientRookery; issue: IssueRow }) {
  const kind = useSourceKinds(props.crow)
  const src = () => props.issue.source as IssueSource | null | undefined
  return (
    <Show when={src()?.provider}>
      <span
        class="nc-meta projects__source"
        data-part="source-badge"
        data-trouble={troubled(src()) ? "" : undefined}
        title={`${src()!.ref}${src()!.error ? ` · ${src()!.error!.message}` : src()!.removed ? ` · ${removedText(src()!)}` : ""}`}
      >
        <Icon name={troubled(src()) ? "bolt" : iconOf(kind(src()!.provider))} size="sm" />
        <Show when={src()!.number}>
          <span class="mono">#{src()!.number}</span>
        </Show>
      </span>
    </Show>
  )
}

const removedText = (s: IssueSource) =>
  s.removed === "transferred" ? "Moved to another repository" : "Deleted on the source"

/** "Open on GitHub": a link to the issue where it comes from. */
export function OpenAtSource(props: { crow: ClientRookery; issue: IssueRow }) {
  const kind = useSourceKinds(props.crow)
  const src = () => props.issue.source as IssueSource | null | undefined
  return (
    <Show when={src()?.url}>
      <a
        class="projects__source-link"
        href={src()!.url}
        target="_blank"
        rel="noopener noreferrer"
        data-part="open-at-source"
      >
        <Icon name={iconOf(kind(src()!.provider))} size="sm" />
        <span class="mono">{src()!.ref}</span>
      </a>
    </Show>
  )
}

/** The source's people on the issue who are not Crow users (they cannot be assigned in Crow until mapped). */
export function SourcePeople(props: { people: SourcePerson[] | undefined }) {
  return (
    <Show when={props.people?.length}>
      <span class="projects__side-value projects__source-people">
        <For each={props.people}>
          {(p) => (
            <span class="projects__source-person" title={p.login}>
              <Avatar name={p.login} size="sm" />
              <span class="mono">{p.login}</span>
            </span>
          )}
        </For>
      </span>
    </Show>
  )
}

/** A write the source refused, a rate limit, an issue gone from the source: with the reason and a retry. */
export function SourceNotice(props: {
  crow: ClientRookery
  issue: IssueRow
  space: string
  canWrite: boolean
}): JSX.Element {
  const kind = useSourceKinds(props.crow)
  const src = () => props.issue.source as IssueSource | null | undefined
  const [busy, setBusy] = createSignal(false)
  const retry = async () => {
    setBusy(true)
    try {
      await props.crow.host.call("retrySync", { space: props.space, id: props.issue.id })
    } catch (e: any) {
      props.crow.workbench.toast({ title: "Not retried", body: String(e?.message ?? e), kind: "danger" })
    } finally {
      setBusy(false)
    }
  }
  const title = () => kind(src()?.provider).title
  return (
    <Show when={troubled(src())}>
      <Show
        when={src()!.removed}
        fallback={
          <Callout
            tone={src()!.error!.reason.includes("rate") ? "warning" : "danger"}
            data-part="sync-error"
            action={
              <Show when={props.canWrite}>
                <Button
                  size="sm"
                  variant="secondary"
                  loading={busy()}
                  onClick={retry}
                  data-testid="retry-sync"
                >
                  Retry
                </Button>
              </Show>
            }
          >
            <strong>Not saved on {title()}.</strong> {src()!.error!.message}
            <Show when={src()!.error!.retryAt}>
              {" "}
              Retries at {new Date(src()!.error!.retryAt!).toLocaleTimeString([], { timeStyle: "short" })}.
            </Show>
          </Callout>
        }
      >
        <Callout tone="warning" data-part="sync-removed">
          {src()!.removed === "transferred"
            ? `Moved to another repository on ${title()}.`
            : `Deleted on ${title()}.`}
        </Callout>
      </Show>
    </Show>
  )
}
