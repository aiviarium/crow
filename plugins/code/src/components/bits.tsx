import { Avatar, Badge, Callout, LabelChip, parseMarkdown, RichTextEditor, State } from "@aiviarium/nocturne"
import { createResource, For, type JSX, Show } from "solid-js"
import { describe, openEntity, rookery } from "../lib/app"
import { CHECKS, hueOf, REVIEWS, STATE_TONE, SYNC } from "../lib/format"

export function StateBadge(props: { state: string; draft?: boolean }): JSX.Element {
  const word = () =>
    props.draft && props.state === "open" ? "Draft" : props.state[0]!.toUpperCase() + props.state.slice(1)
  return (
    <Badge
      tone={props.draft && props.state === "open" ? "neutral" : (STATE_TONE[props.state] ?? "neutral")}
      data-testid="item-state"
    >
      {word()}
    </Badge>
  )
}

export function ChecksState(props: {
  state?: string
  checks?: { failed?: number; pending?: number; passed?: number; total?: number } | null
  short?: boolean
}): JSX.Element {
  const c = () => CHECKS[props.state ?? "none"] ?? CHECKS.none!
  const detail = () => {
    const k = props.checks
    if (!k?.total) return ""
    return props.state === "failure"
      ? ` (${k.failed} of ${k.total})`
      : props.state === "pending"
        ? ` (${k.pending} running)`
        : ` (${k.total})`
  }
  return (
    <State status={c().status} data-testid="checks-state" data-state={props.state ?? "none"}>
      {props.short ? c().word.replace("Checks ", "") : c().word}
      {detail()}
    </State>
  )
}

export function ReviewBadge(props: { state?: string }): JSX.Element {
  const r = () => REVIEWS[props.state ?? "none"] ?? REVIEWS.none!
  return (
    <Badge tone={r().tone} data-testid="review-state" data-state={props.state ?? "none"}>
      {r().word}
    </Badge>
  )
}

export function Labels(props: { labels?: Array<{ name: string; color: string }> | null }): JSX.Element {
  return (
    <Show when={props.labels?.length}>
      <span class="gh-labels">
        <For each={props.labels}>{(l) => <LabelChip hue={hueOf(l.color)}>{l.name}</LabelChip>}</For>
      </span>
    </Show>
  )
}

export function Person(props: { login: string; muted?: boolean }): JSX.Element {
  return (
    <span class="gh-person" classList={{ "nc-muted": props.muted }}>
      <Avatar name={props.login} size="sm" />
      <span>{props.login}</span>
    </span>
  )
}

export function SyncState(props: { status?: string }): JSX.Element {
  const s = () => SYNC[props.status ?? "pending"] ?? SYNC.pending!
  return (
    <State status={s().status} data-testid="sync-state" data-state={props.status}>
      {s().word}
    </State>
  )
}

/** What went wrong, and what to do about it, from an error of the host half. */
export function ErrorNote(props: { error: unknown; action?: JSX.Element }): JSX.Element {
  const d = () => describe(props.error)
  return (
    <Callout tone="danger" action={props.action} data-testid="error-note" data-reason={d().reason}>
      {d().message}
      <Show when={d().fix}> {d().fix}</Show>
    </Callout>
  )
}

/** A GitHub description or comment as read-only rich text (Nocturne's Markdown reader). */
export function Markdown(props: { text?: string | null; label: string }): JSX.Element {
  const doc = () => parseMarkdown(props.text ?? "")
  return (
    <div class="gh-md">
      <RichTextEditor value={doc() as never} readOnly variant="comment" aria-label={props.label} />
    </div>
  )
}

/** A Crow entity a pull request links to, by its title when the server can resolve it (M2b entities). */
export function EntityChip(props: { uri: string }): JSX.Element {
  const c = rookery()
  const [resolved] = createResource(
    () => props.uri,
    (uri) => c.rpc.call<{ title?: string } | null>("entities.resolve", { uri }).catch(() => null),
  )
  const text = () => resolved()?.title || props.uri.replace(/^[a-z]+:\/\//, "")
  return (
    <button type="button" class="nc-chip gh-chip-btn" onClick={() => openEntity(props.uri)}>
      {text()}
    </button>
  )
}
