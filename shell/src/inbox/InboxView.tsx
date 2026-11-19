// Shell Notifications Inbox view (`/inbox` and `/inbox/:id`): filterable notification list,
// read controls, actionable `notify.answer` buttons, and live updates.
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
  toast,
  ViewHeader,
  ViewLayout,
} from "@aiviarium/nocturne"
import type { NotificationInfo } from "@rookery/client"
import { createEffect, createMemo, createSignal, For, type JSX, on, onMount, Show } from "solid-js"
import type { ShellApp } from "../app/state"
import { formatTimeAgo } from "../jobs/state"
import { actionLabel, notificationLink, notificationTitle } from "./state"

type InboxFilter = "all" | "unread"

const FILTER_TABS: Array<{ id: InboxFilter; label: string }> = [
  { id: "all", label: "All" },
  { id: "unread", label: "Unread" },
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

function actionVariant(action: string): "primary" | "secondary" | "danger" {
  const id = action.toLowerCase()
  if (id.includes("deny") || id.includes("reject") || id.includes("dismiss")) return "danger"
  if (id.includes("approve") || id.includes("accept") || id === "yes") return "primary"
  return "secondary"
}

export function InboxView(props: { app: ShellApp; notificationId?: string }): JSX.Element {
  const [tab, setTab] = createSignal<InboxFilter>("all")
  const [kindFilter, setKindFilter] = createSignal("all")
  const [answering, setAnswering] = createSignal<string | null>(null)
  const [answerError, setAnswerError] = createSignal<string | null>(null)

  const selectedId = () => props.notificationId ?? props.app.routeMatch()?.params.id ?? ""

  onMount(() => {
    props.app.setViewTitle("Inbox")
    void props.app.inbox.refresh()
  })

  const kindOptions = createMemo(() => {
    const kinds = new Set<string>()
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
      setAnswerError(null)
    }),
  )

  const selectNotification = (n: NotificationInfo) => {
    props.app.navigate(`/inbox/${encodeURIComponent(n.id)}`)
    if (!n.readAt) {
      void props.app.inbox.markRead([n.id])
    }
  }

  const submitAnswer = async (n: NotificationInfo, action: string) => {
    if (answering()) return
    setAnswering(action)
    setAnswerError(null)
    try {
      await props.app.inbox.answer(n.id, action)
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

  return (
    <ViewLayout
      id="crow.inbox"
      sidebarLabel="Notifications"
      sidebarWidth={340}
      scroll={false}
      sidebar={
        <div class="crow-split-list" data-part="inbox-list">
          <div class="crow-split-list__controls">
            <Tabs
              label="Notification filter"
              items={FILTER_TABS}
              value={tab()}
              onChange={(id) => setTab(id as InboxFilter)}
            />
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
                      secondary={n.body ?? kindLabel(n.kind)}
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
                  <Show when={!n().readAt}>
                    <Button
                      size="sm"
                      variant="ghost"
                      data-part="inbox-mark-read"
                      onClick={() => void props.app.inbox.markRead([n().id])}
                    >
                      Mark read
                    </Button>
                  </Show>
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
                      { label: formatTimeAgo(n().createdAt) },
                    ]}
                  />

                  <Show when={n().body}>
                    {(body) => (
                      <p class="body" data-part="inbox-detail-text">
                        {body()}
                      </p>
                    )}
                  </Show>

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
                {(answered) => (
                  <Callout tone="info" data-part="inbox-answered">
                    Answered with <strong class="mono">{actionLabel(answered())}</strong>
                  </Callout>
                )}
              </Show>

              <Show when={!n().answer && n().actions.length > 0}>
                <Card title="Respond" data-part="inbox-actions">
                  <div class="crow-detail-stack">
                    <Show when={answerError()}>
                      {(err) => (
                        <Callout tone="danger" data-part="inbox-answer-error">
                          {err()}
                        </Callout>
                      )}
                    </Show>

                    <div class="crow-row">
                      <For each={n().actions}>
                        {(action) => (
                          <Button
                            size="sm"
                            variant={actionVariant(action)}
                            disabled={answering() !== null}
                            data-part="inbox-action-btn"
                            data-action-id={action}
                            onClick={() => void submitAnswer(n(), action)}
                          >
                            {answering() === action ? "Sending…" : actionLabel(action)}
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
