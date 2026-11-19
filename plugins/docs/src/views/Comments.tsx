// Comments on a page: threads on the whole page or on a stretch of its text (anchored by the quoted text, so
// they survive edits around it), replies, resolve and reopen, and `@` mentions that notify (the host sends
// them). Rows of `comments` are entities under the page, so a private page's comments are private too.
import { Avatar, Button, RichTextEditor, Tabs } from "@aiviarium/nocturne"
import { plainText, type RichText } from "@rookery/sdk/client"
import { createMemo, createSignal, For, type JSX, Show } from "solid-js"
import type { ClientRookeryWithDocs } from "../types"
import { type Api, ago, type Page } from "./api"

export interface CommentRow {
  id: string
  page: string
  thread: string | null
  body: RichText | null
  text: string
  anchor: { quote: string; prefix?: string } | null
  resolved: boolean
  createdAt: string
  createdBy: string | null
}

export interface Anchor {
  quote: string
  prefix: string
}

function Composer(props: {
  placeholder: string
  submit: string
  onSubmit: (body: RichText, text: string) => Promise<void>
  onCancel?: () => void
  autofocus?: boolean
}): JSX.Element {
  const [value, setValue] = createSignal<RichText | null>(null)
  const [busy, setBusy] = createSignal(false)
  const [key, setKey] = createSignal(0)
  const text = () => (value() ? plainText(value()!).trim() : "")
  const send = async () => {
    if (!text() || busy()) return
    setBusy(true)
    try {
      await props.onSubmit(value()!, text())
      setValue(null)
      setKey((k) => k + 1)
    } finally {
      setBusy(false)
    }
  }
  return (
    <div
      class="docs-composer"
      data-part="comment-composer"
      onKeyDown={(e) => (e.metaKey || e.ctrlKey) && e.key === "Enter" && send()}
    >
      <Show when={key() + 1} keyed>
        <RichTextEditor
          variant="comment"
          value={value() as never}
          onChange={(v) => setValue(v as RichText)}
          placeholder={props.placeholder}
          blockPlaceholder={null}
          aria-label={props.placeholder}
          autofocus={props.autofocus}
        />
      </Show>
      <div class="docs-composer__actions">
        <Show when={props.onCancel}>
          <Button size="sm" variant="secondary" onClick={props.onCancel}>
            Cancel
          </Button>
        </Show>
        <Button
          size="sm"
          variant="primary"
          disabled={!text()}
          loading={busy()}
          onClick={send}
          data-part="comment-send"
        >
          {props.submit}
        </Button>
      </div>
    </div>
  )
}

function Message(props: { c: CommentRow; name: (id: string | null) => string }): JSX.Element {
  return (
    <div class="docs-comment" data-comment={props.c.id}>
      <div class="docs-comment__head">
        <Avatar name={props.name(props.c.createdBy)} size="sm" />
        <span class="label">{props.name(props.c.createdBy)}</span>
        <span class="nc-meta">{ago(props.c.createdAt)}</span>
      </div>
      <Show when={props.c.body} fallback={<p class="body docs-comment__text">{props.c.text}</p>}>
        <RichTextEditor value={props.c.body as never} readOnly variant="comment" aria-label="Comment" />
      </Show>
    </div>
  )
}

export function CommentsPanel(props: {
  rookery: ClientRookeryWithDocs
  api: Api
  page: Page
  comments: () => CommentRow[]
  /** A stretch of text someone chose to comment on, not sent yet. */
  pending: () => Anchor | null
  clearPending: () => void
  active: () => string | null
  setActive: (id: string | null) => void
  name: (id: string | null) => string
}): JSX.Element {
  const [show, setShow] = createSignal<"open" | "resolved">("open")
  const [replying, setReplying] = createSignal<string | null>(null)
  const threads = createMemo(() => {
    const all = props.comments()
    const roots = all.filter((c) => !c.thread)
    return roots
      .map((r) => ({
        root: r,
        replies: all.filter((c) => c.thread === r.id).sort((a, b) => (a.createdAt < b.createdAt ? -1 : 1)),
      }))
      .sort((a, b) => (a.root.createdAt < b.root.createdAt ? 1 : -1))
  })
  const shown = () => threads().filter((t) => (show() === "resolved" ? t.root.resolved : !t.root.resolved))
  const resolvedCount = () => threads().filter((t) => t.root.resolved).length

  const send = async (body: RichText, text: string, o: { thread?: string; anchor?: Anchor | null }) => {
    try {
      await props.api.comment({
        page: props.page.id,
        space: props.page.spaceId,
        body,
        text,
        ...(o.thread ? { thread: o.thread } : {}),
        ...(o.anchor ? { anchor: o.anchor } : {}),
      })
    } catch (e: any) {
      props.rookery.workbench.toast({
        title: "The comment was not sent",
        body: String(e?.message ?? e),
        kind: "danger",
      })
      throw e
    }
  }

  const setResolved = (c: CommentRow, resolved: boolean) =>
    props.rookery.data
      .space(props.page.spaceId)
      .comments.update(c.id, { resolved } as never)
      .catch((e: any) =>
        props.rookery.workbench.toast({
          title: "Not changed",
          body: String(e?.message ?? e),
          kind: "danger",
        }),
      )

  return (
    <div class="docs-comments" data-part="comments">
      <div class="docs-panel__bar">
        <Tabs
          label="Which comments"
          items={[
            { id: "open", label: "Open" },
            { id: "resolved", label: `Resolved${resolvedCount() ? ` ${resolvedCount()}` : ""}` },
          ]}
          value={show()}
          onChange={(v) => setShow(v as "open" | "resolved")}
        />
      </div>
      <Show when={props.pending()}>
        {(a) => (
          <div class="docs-thread docs-thread--new" data-part="new-range-comment">
            <span class="docs-thread__anchor nc-meta">{a().quote}</span>
            <Composer
              placeholder="Comment on this, @ to mention"
              submit="Comment"
              autofocus
              onCancel={props.clearPending}
              onSubmit={async (body, text) => {
                await send(body, text, { anchor: a() })
                props.clearPending()
              }}
            />
          </div>
        )}
      </Show>
      <div class="docs-comments__list">
        <For
          each={shown()}
          fallback={
            <p class="nc-meta docs-panel__empty">
              {show() === "open"
                ? "No open comments. Select text and choose Comment, or write one below."
                : "Nothing resolved yet."}
            </p>
          }
        >
          {(t) => (
            <div
              class="docs-thread"
              classList={{ "docs-thread--active": props.active() === t.root.id }}
              data-thread={t.root.id}
            >
              <Show when={t.root.anchor?.quote}>
                <button
                  type="button"
                  class="docs-thread__anchor nc-meta"
                  onClick={() => props.setActive(t.root.id)}
                  title="Show it in the page"
                >
                  {t.root.anchor!.quote}
                </button>
              </Show>
              <Message c={t.root} name={props.name} />
              <For each={t.replies}>{(r) => <Message c={r} name={props.name} />}</For>
              <div class="docs-thread__actions">
                <Show
                  when={replying() === t.root.id}
                  fallback={
                    <>
                      <Button size="sm" variant="ghost" onClick={() => setReplying(t.root.id)}>
                        Reply
                      </Button>
                      <Button
                        size="sm"
                        variant="ghost"
                        icon={t.root.resolved ? "arrow-up-right" : "check"}
                        onClick={() => setResolved(t.root, !t.root.resolved)}
                        data-part="resolve"
                      >
                        {t.root.resolved ? "Reopen" : "Resolve"}
                      </Button>
                    </>
                  }
                >
                  <Composer
                    placeholder="Reply, @ to mention"
                    submit="Reply"
                    autofocus
                    onCancel={() => setReplying(null)}
                    onSubmit={async (body, text) => {
                      await send(body, text, { thread: t.root.id })
                      setReplying(null)
                    }}
                  />
                </Show>
              </div>
            </div>
          )}
        </For>
      </div>
      <Show when={show() === "open"}>
        <div class="docs-comments__new">
          <Composer
            placeholder="Comment on the page, @ to mention"
            submit="Comment"
            onSubmit={(body, text) => send(body, text, {})}
          />
        </div>
      </Show>
    </div>
  )
}

/** The count chip for the header button. */
export function commentCount(rows: CommentRow[]): number {
  return rows.filter((c) => !c.thread && !c.resolved).length
}
