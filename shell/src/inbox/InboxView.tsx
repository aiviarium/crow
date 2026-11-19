// Shell Notifications Inbox view (`/inbox` and `/inbox/:id`): filterable notification list,
// read/unread/archive controls, actionable `notify.answer` buttons + text input, and live updates.
import {
  Badge,
  type BadgeTone,
  Button,
  Callout,
  Card,
  EmptyState,
  ListRow,
  MetaLine,
  RowList,
  Select,
  Tabs,
  TextField,
  toast,
  ViewHeader,
  ViewLayout,
} from "@aiviarium/nocturne"
import type { NotificationAction, NotificationInfo } from "@rookery/client"
import { createEffect, createMemo, createSignal, For, type JSX, on, onMount, Show } from "solid-js"
import type { ShellApp } from "../app/state"
import { formatTimeAgo } from "../jobs/state"
import { notificationLink, notificationTitle } from "./state"

type InboxFilter = "all" | "unread" | "archived"

const FILTER_TABS: Array<{ id: InboxFilter; label: string }> = [
  { id: "all", label: "All" },
  { id: "unread", label: "Unread" },
  { id: "archived", label: "Archived" },
]

function kindTone(kind: string): BadgeTone {
  switch (kind) {
    case "job_failure":
      return "danger"
    case "approval":
      return "warning"
    case "question":
      return "accent"
    case "mention":
    case "assignment":
      return "info"
    default:
      return "neutral"
  }
}

function kindLabel(kind: string): string {
  return kind.replace(/[._]/g, " ")
}

function actionVariant(style?: string): "primary" | "secondary" | "danger" {
  if (style === "primary") return "primary"
  if (style === "danger") return "danger"
  return "secondary"
}

export function InboxView(props: { app: ShellApp; notificationId?: string }): JSX.Element {
  const [tab, setTab] = createSignal<InboxFilter>("all")
  const [kindFilter, setKindFilter] = createSignal("all")
  const [answerText, setAnswerText] = createSignal("")
  const [answering, setAnswering] = createSignal<string | null>(null)
  const [answerError, setAnswerError] = createSignal<string | null>(null)

  const selectedId = () => props.notificationId ?? props.app.routeMatch()?.params.id ?? ""

  onMount(() => {
    props.app.setViewTitle("Inbox")
    void props.app.inbox.refresh({ archived: false })
  })

  const switchTab = (next: string) => {
    const f = next as InboxFilter
    setTab(f)
    const wantArchived = f === "archived"
    if (wantArchived !== props.app.inbox.showArchived()) {
      void props.app.inbox.setShowArchived(wantArchived)
    }
  }

  const kindOptions = createMemo(() => {
    const kinds = new Set<string>()
    for (const c of props.app.inbox.counts()) kinds.add(c.kind)
    for (const n of props.app.inbox.notifications()) kinds.add(n.kind)
    return [
      { value: "all", label: "All kinds" },
      ...Array.from(kinds)
        .sort()
        .map((k) => ({ value: k, label: kindLabel(k) })),
    ]
  })

  const filtered = createMemo(() => {
    const f = tab()
    const k = kindFilter()
    return props.app.inbox.notifications().filter((n) => {
      if (f === "unread" && n.readAt) return false
      if (k !== "all" && n.kind !== k) return false
      return true
    })
  })

  const selected = createMemo<NotificationInfo | null>(() => {
    const id = selectedId()
    if (!id) return null
    return props.app.inbox.notifications().find((n) => n.id === id) ?? null
  })

  createEffect(
    on(selectedId, () => {
      setAnswerText("")
      setAnswerError(null)
    }),
  )

  const selectNotification = (n: NotificationInfo) => {
    props.app.navigate(`/inbox/${encodeURIComponent(n.id)}`)
    if (!n.readAt) {
      void props.app.inbox.markRead([n.id])
    }
  }

  const submitAnswer = async (n: NotificationInfo, act: NotificationAction) => {
    if (answering()) return
    setAnswering(act.id)
    setAnswerError(null)
    try {
      const text = act.input !== undefined ? answerText() : undefined
      await props.app.inbox.answer(n.id, act.id, text)
      setAnswerText("")
      if (!n.readAt) void props.app.inbox.markRead([n.id])
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      setAnswerError(msg)
      void props.app.inbox.refresh()
    } finally {
      setAnswering(null)
    }
  }

  const markAllRead = async () => {
    try {
      await props.app.inbox.markAllRead()
    } catch (err) {
      toast({
        title: "Could not mark all read",
        description: err instanceof Error ? err.message : String(err),
        tone: "danger",
      })
    }
  }

  const toggleRead = async (n: NotificationInfo) => {
    try {
      if (n.readAt) await props.app.inbox.markUnread([n.id])
      else await props.app.inbox.markRead([n.id])
    } catch (err) {
      toast({
        title: "Could not update notification",
        description: err instanceof Error ? err.message : String(err),
        tone: "danger",
      })
    }
  }

  const archiveItem = async (n: NotificationInfo) => {
    try {
      await props.app.inbox.archive([n.id])
      props.app.navigate("/inbox")
    } catch (err) {
      toast({
        title: "Could not archive notification",
        description: err instanceof Error ? err.message : String(err),
        tone: "danger",
      })
    }
  }

  const inputAction = createMemo(() => selected()?.actions?.find((a) => a.input !== undefined) ?? null)

  return (
    <ViewLayout
      id="crow.inbox"
      sidebarLabel="Notifications"
      sidebarWidth={340}
      scroll={false}
      sidebar={
        <div class="crow-split-list" data-part="inbox-list">
          <div class="crow-split-list__controls">
            <Tabs label="Notification filter" items={FILTER_TABS} value={tab()} onChange={switchTab} />
            <Show when={kindOptions().length > 1}>
              <Select
                aria-label="Filter by kind"
                options={kindOptions()}
                value={kindFilter()}
                onChange={setKindFilter}
              />
            </Show>
          </div>

          <div class="crow-split-list__body">
            <Show when={props.app.inbox.error()}>
              {(err) => (
                <div class="crow-pad">
                  <Callout
                    tone="danger"
                    action={
                      <Button size="sm" onClick={() => void props.app.inbox.refresh()}>
                        Retry
                      </Button>
                    }
                  >
                    {err()}
                  </Callout>
                </div>
              )}
            </Show>

            <Show
              when={filtered().length > 0}
              fallback={
                <div class="crow-pad">
                  <EmptyState
                    icon="inbox"
                    title={tab() === "unread" ? "All caught up" : "No notifications"}
                    description={
                      tab() === "unread"
                        ? "You have no unread notifications."
                        : "Approvals, job failures, and mentions will land here."
                    }
                  />
                </div>
              }
            >
              <RowList label="Notifications">
                <For each={filtered()}>
                  {(n) => (
                    <ListRow
                      title={notificationTitle(n)}
                      secondary={
                        notificationTitle(n) !== n.text
                          ? n.text
                          : (n.actorName ?? n.plugin ?? kindLabel(n.kind))
                      }
                      meta={formatTimeAgo(n.createdAt)}
                      unread={!n.readAt}
                      selected={n.id === selectedId()}
                      data-notification-row={n.id}
                      status={
                        <Badge square tone={kindTone(n.kind)}>
                          {kindLabel(n.kind)}
                        </Badge>
                      }
                      onClick={() => selectNotification(n)}
                    />
                  )}
                </For>
              </RowList>
            </Show>
          </div>
        </div>
      }
      header={
        <ViewHeader
          noPin
          crumbs={[{ label: "Inbox", icon: "inbox" }]}
          actions={[
            {
              id: "refresh",
              label: "Refresh inbox",
              icon: "refresh-cw",
              onClick: () => void props.app.inbox.refresh(),
            },
            {
              id: "read-all",
              label: "Mark all read",
              icon: "check",
              disabled: props.app.inbox.unread() === 0,
              onClick: () => void markAllRead(),
            },
          ]}
        />
      }
    >
      <div class="crow-detail-pane" data-part="inbox-detail">
        <Show
          when={selected()}
          fallback={
            <div class="crow-home">
              <EmptyState
                icon="inbox"
                title="Select a notification"
                description="Choose an item from the inbox to read details or respond to pending actions."
              />
            </div>
          }
        >
          {(n) => (
            <div class="crow-detail-stack">
              <Card
                title={notificationTitle(n())}
                action={
                  <div class="crow-row">
                    <Button
                      size="sm"
                      variant="ghost"
                      data-part="inbox-toggle-read"
                      onClick={() => void toggleRead(n())}
                    >
                      {n().readAt ? "Mark unread" : "Mark read"}
                    </Button>
                    <Show when={!n().archivedAt}>
                      <Button
                        size="sm"
                        variant="ghost"
                        icon="archive"
                        data-part="inbox-archive"
                        onClick={() => void archiveItem(n())}
                      >
                        Archive
                      </Button>
                    </Show>
                  </div>
                }
              >
                <div class="crow-detail-stack">
                  <MetaLine
                    items={[
                      {
                        label: (
                          <Badge square tone={kindTone(n().kind)}>
                            {kindLabel(n().kind)}
                          </Badge>
                        ),
                      },
                      n().actorName ? { label: n().actorName! } : null,
                      n().plugin ? { label: n().plugin! } : null,
                      { label: formatTimeAgo(n().createdAt) },
                    ]}
                  />

                  <p class="body" data-part="inbox-detail-text">
                    {n().text}
                  </p>

                  <Show when={notificationLink(n())}>
                    {(href) => (
                      <div>
                        <Button
                          size="sm"
                          variant="secondary"
                          icon="arrow-up-right"
                          onClick={() => props.app.navigate(href())}
                        >
                          Open linked view
                        </Button>
                      </div>
                    )}
                  </Show>
                </div>
              </Card>

              <Show when={n().answer}>
                {(ans) => (
                  <Callout tone="info" data-part="inbox-answered">
                    Answered with <strong class="mono">{ans().action}</strong>
                    <Show when={ans().text}>: {ans().text}</Show>
                    <Show when={ans().byName}> by {ans().byName}</Show> ({formatTimeAgo(ans().at)})
                  </Callout>
                )}
              </Show>

              <Show when={!n().answer && (n().actions?.length ?? 0) > 0}>
                <Card title="Respond" data-part="inbox-actions">
                  <div class="crow-detail-stack">
                    <Show when={answerError()}>
                      {(err) => (
                        <Callout tone="danger" data-part="inbox-answer-error">
                          {err()}
                        </Callout>
                      )}
                    </Show>

                    <Show when={inputAction()}>
                      {(act) => (
                        <TextField
                          id="inbox-answer-input"
                          label="Reply"
                          placeholder={act().input || "Enter response…"}
                          value={answerText()}
                          onInput={(e) => setAnswerText(e.currentTarget.value)}
                        />
                      )}
                    </Show>

                    <div class="crow-row">
                      <For each={n().actions}>
                        {(act) => (
                          <Button
                            size="sm"
                            variant={actionVariant(act.style)}
                            disabled={answering() !== null}
                            data-part="inbox-action-btn"
                            data-action-id={act.id}
                            onClick={() => void submitAnswer(n(), act)}
                          >
                            {answering() === act.id ? "Sending…" : act.label}
                          </Button>
                        )}
                      </For>
                    </div>
                  </div>
                </Card>
              </Show>
            </div>
          )}
        </Show>
      </div>
    </ViewLayout>
  )
}
