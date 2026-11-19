import { Avatar, Badge, Button, Icon, TextArea } from "@aiviarium/nocturne"
import { createMemo, createResource, createSignal, For, type JSX, Match, Show, Switch } from "solid-js"
import { rookery } from "../lib/app"
import { ago } from "../lib/format"
import { ErrorNote, Markdown } from "./bits"

type Row = Record<string, any>

interface TimelineEvent {
  id: number | null
  event: string
  at: string
  actor: string
  label: string
  target: string
  message: string
  sha: string
}

const EVENT_TEXT: Record<string, (e: TimelineEvent) => string> = {
  labeled: (e) => `added the ${e.label} label`,
  unlabeled: (e) => `removed the ${e.label} label`,
  assigned: (e) => `assigned ${e.target || "someone"}`,
  unassigned: (e) => `unassigned ${e.target || "someone"}`,
  review_requested: (e) => `requested a review from ${e.target || "someone"}`,
  review_request_removed: (e) => `cancelled the review request to ${e.target || "someone"}`,
  closed: () => "closed this",
  reopened: () => "reopened this",
  merged: () => "merged this pull request",
  committed: (e) => `pushed ${e.sha.slice(0, 7)} ${e.message.split("\n")[0] ?? ""}`.trim(),
  renamed: () => "changed the title",
  ready_for_review: () => "marked this ready for review",
  convert_to_draft: () => "converted this to a draft",
  head_ref_force_pushed: () => "force-pushed the branch",
  milestoned: () => "set the milestone",
}

type Entry =
  | { at: string; kind: "comment"; row: Row }
  | { at: string; kind: "review"; row: Row }
  | { at: string; kind: "event"; e: TimelineEvent }
  | { at: string; kind: "inline"; path: string; rows: Row[] }

/**
 * The conversation of a pull request: its description, then comments, reviews, inline review comments and
 * what happened to it (labels, assignments, pushes, closing), in time order. Comments and reviews are live
 * rows, so a comment made anywhere appears here as it is synced; the events are read from GitHub when the
 * item changes.
 */
export function Thread(props: {
  uri: string
  row: Row
  kind: "pr" | "issue"
  onRef?: (n: number) => void
}): JSX.Element {
  const c = rookery()
  const comments = createMemo(() =>
    c.data.comments.live({
      where: { repo: props.row.repo, onKind: props.kind, number: props.row.number },
      orderBy: [["ghCreatedAt", "asc"]],
      limit: 500,
    } as never),
  )
  const [events, { refetch }] = createResource(
    () => `${props.uri}:${props.row.ghUpdatedAt}`,
    async () => {
      try {
        return await c.host.call<TimelineEvent[]>("item.timeline", { uri: props.uri })
      } catch {
        return []
      }
    },
  )
  const entries = createMemo<Entry[]>(() => {
    const rows = comments()() as unknown as Row[]
    const out: Entry[] = []
    const inline = new Map<string, Row[]>()
    for (const r of rows) {
      if (r.kind === "review_comment") {
        const key = `${r.path}`
        inline.set(key, [...(inline.get(key) ?? []), r])
      } else out.push({ at: r.ghCreatedAt ?? "", kind: r.kind === "review" ? "review" : "comment", row: r })
    }
    for (const [path, list] of inline)
      out.push({ at: list[0]!.ghCreatedAt ?? "", kind: "inline", path, rows: list })
    for (const e of events() ?? []) if (EVENT_TEXT[e.event]) out.push({ at: e.at, kind: "event", e })
    return out.sort((a, b) => Date.parse(a.at || "0") - Date.parse(b.at || "0"))
  })

  const [text, setText] = createSignal("")
  const [busy, setBusy] = createSignal(false)
  const [error, setError] = createSignal<unknown>()
  const send = async () => {
    if (!text().trim() || busy()) return
    setBusy(true)
    setError(undefined)
    try {
      await c.host.call("item.comment", { uri: props.uri, body: text() })
      setText("")
      refetch()
    } catch (e) {
      setError(e)
    } finally {
      setBusy(false)
    }
  }

  return (
    <div class="gh-thread" data-part="thread">
      <article class="gh-comment gh-comment--body" data-testid="description">
        <header class="gh-comment__head">
          <Avatar name={props.row.author} size="sm" />
          <strong>{props.row.author}</strong>
          <span class="nc-meta">opened {ago(props.row.ghCreatedAt)}</span>
        </header>
        <Markdown text={props.row.body} label="Description" />
      </article>

      <For each={entries()}>
        {(e) => (
          <Switch>
            <Match when={e.kind === "comment"}>
              {(() => {
                const r = (e as Extract<Entry, { kind: "comment" }>).row
                return (
                  <article class="gh-comment" data-comment={r.ghId} data-testid="comment">
                    <header class="gh-comment__head">
                      <Avatar name={r.author} size="sm" />
                      <strong>{r.author}</strong>
                      <span class="nc-meta">commented {ago(r.ghCreatedAt)}</span>
                      <a
                        class="nc-meta gh-link gh-comment__link"
                        href={r.htmlUrl}
                        target="_blank"
                        rel="noopener noreferrer"
                      >
                        on GitHub
                      </a>
                    </header>
                    <Markdown text={r.body} label={`Comment by ${r.author}`} />
                  </article>
                )
              })()}
            </Match>
            <Match when={e.kind === "review"}>
              {(() => {
                const r = (e as Extract<Entry, { kind: "review" }>).row
                const tone =
                  r.reviewState === "approved"
                    ? "success"
                    : r.reviewState === "changes_requested"
                      ? "danger"
                      : "neutral"
                const word =
                  r.reviewState === "approved"
                    ? "approved these changes"
                    : r.reviewState === "changes_requested"
                      ? "requested changes"
                      : r.reviewState === "dismissed"
                        ? "had a review dismissed"
                        : "reviewed"
                return (
                  <article class="gh-comment gh-comment--review" data-testid="review">
                    <header class="gh-comment__head">
                      <Avatar name={r.author} size="sm" />
                      <strong>{r.author}</strong>
                      <span class="nc-meta">
                        {word} {ago(r.ghCreatedAt)}
                      </span>
                      <Badge tone={tone}>{String(r.reviewState).replace("_", " ")}</Badge>
                    </header>
                    <Show when={r.body}>
                      <Markdown text={r.body} label={`Review by ${r.author}`} />
                    </Show>
                  </article>
                )
              })()}
            </Match>
            <Match when={e.kind === "inline"}>
              {(() => {
                const x = e as Extract<Entry, { kind: "inline" }>
                return (
                  <article class="gh-comment gh-comment--inline" data-testid="inline-comments">
                    <header class="gh-comment__head">
                      <Icon name="file" size="sm" />
                      <span class="nc-mono">{x.path}</span>
                    </header>
                    <For each={x.rows}>
                      {(r) => (
                        <div class="gh-inline">
                          <div class="gh-comment__head">
                            <Avatar name={r.author} size="sm" />
                            <strong>{r.author}</strong>
                            <span class="nc-meta">
                              on line {r.line ?? "?"} · {ago(r.ghCreatedAt)}
                            </span>
                          </div>
                          <Markdown text={r.body} label={`Inline comment by ${r.author}`} />
                        </div>
                      )}
                    </For>
                  </article>
                )
              })()}
            </Match>
            <Match when={e.kind === "event"}>
              {(() => {
                const ev = (e as Extract<Entry, { kind: "event" }>).e
                return (
                  <div class="gh-event nc-meta" data-event={ev.event}>
                    <span class="gh-event__dot" aria-hidden="true" />
                    <span>
                      <strong>{ev.actor || "Someone"}</strong> {EVENT_TEXT[ev.event]!(ev)} · {ago(ev.at)}
                    </span>
                  </div>
                )
              })()}
            </Match>
          </Switch>
        )}
      </For>

      <form
        class="gh-reply"
        data-part="reply"
        onSubmit={(e) => {
          e.preventDefault()
          void send()
        }}
      >
        <TextArea
          aria-label="Write a comment"
          placeholder="Leave a comment"
          rows={4}
          value={text()}
          onInput={(e) => setText(e.currentTarget.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
              e.preventDefault()
              void send()
            }
          }}
          data-testid="reply"
        />
        <div class="gh-reply__actions">
          <span class="nc-meta">Markdown works. Ctrl Enter sends.</span>
          <Button
            variant="primary"
            type="submit"
            loading={busy()}
            disabled={!text().trim()}
            data-testid="reply-send"
          >
            Comment
          </Button>
        </div>
        <Show when={error()}>
          <ErrorNote error={error()} />
        </Show>
      </form>
    </div>
  )
}
