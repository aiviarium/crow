// Reactive shell notifications inbox store backed by `notify.list`, `notify.read` and
// `notify.answer`, plus live `notify.new` / `notify.changed`. Rookery's wire types have one
// `NotificationInfo` with a `title`, an optional `body`, string action ids and a single answer.
import { toast } from "@aiviarium/nocturne"
import type {
  Connection,
  NotificationInfo,
  NotificationList,
  NotifyChanged,
  NotifyNew,
  NotifyQuery,
} from "@rookery/client"
import { type Accessor, createSignal } from "solid-js"

export interface InboxStore {
  readonly notifications: Accessor<NotificationInfo[]>
  readonly unread: Accessor<number>
  readonly loading: Accessor<boolean>
  readonly error: Accessor<string | null>
  refresh(query?: Partial<NotifyQuery>): Promise<void>
  markRead(ids: string[]): Promise<void>
  markAllRead(): Promise<void>
  answer(id: string, answer: string): Promise<NotificationInfo>
  start(): void
  stop(): void
}

function mergeNotifications(existing: NotificationInfo[], incoming: NotificationInfo[]): NotificationInfo[] {
  const byId = new Map<string, NotificationInfo>()
  for (const n of existing) byId.set(n.id, n)
  for (const n of incoming) byId.set(n.id, n)
  return Array.from(byId.values()).sort((a, b) => b.createdAt.localeCompare(a.createdAt))
}

export function notificationTitle(n: NotificationInfo): string {
  return n.title
}

export function notificationLink(n: NotificationInfo): string | null {
  const d = n.data
  if (!d || typeof d !== "object") return null
  const data = d as Record<string, unknown>
  if (typeof data.url === "string" && data.url.startsWith("/")) return data.url
  if (typeof data.link === "string" && data.link.startsWith("/")) return data.link
  return null
}

/** A notification action id as a button label, such as `dismiss` -> `Dismiss`. */
export function actionLabel(action: string): string {
  return action.replace(/[._-]+/g, " ").replace(/\b\w/g, (c) => c.toUpperCase())
}

export function createInboxStore(conn: Connection): InboxStore {
  const [notifications, setNotifications] = createSignal<NotificationInfo[]>([])
  const [unread, setUnread] = createSignal(0)
  const [loading, setLoading] = createSignal(false)
  const [error, setError] = createSignal<string | null>(null)

  let started = false
  let unsubs: Array<() => void> = []

  const refresh = async (query: Partial<NotifyQuery> = {}) => {
    setLoading(true)
    setError(null)
    try {
      const page = await conn.call<NotificationList>("notify.list", {
        unread: false,
        limit: 100,
        ...query,
      } as Record<string, unknown>)
      setNotifications(page.notifications ?? [])
      setUnread(page.unread ?? 0)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setLoading(false)
    }
  }

  const markRead = async (ids: string[]) => {
    if (ids.length === 0) return
    await conn.call<{ count: number }>("notify.read", { ids })
    const now = new Date().toISOString()
    const set = new Set(ids)
    const newlyRead = notifications().filter((n) => set.has(n.id) && !n.readAt).length
    setNotifications((prev) => prev.map((n) => (set.has(n.id) ? { ...n, readAt: n.readAt ?? now } : n)))
    setUnread((prev) => Math.max(0, prev - newlyRead))
  }

  const markAllRead = async () => {
    await conn.call<{ count: number }>("notify.read", {})
    const now = new Date().toISOString()
    setNotifications((prev) => prev.map((n) => ({ ...n, readAt: n.readAt ?? now })))
    setUnread(0)
  }

  const answer = async (id: string, action: string): Promise<NotificationInfo> => {
    const updated = await conn.call<NotificationInfo>("notify.answer", { id, answer: action })
    setNotifications((prev) => mergeNotifications(prev, [updated]))
    return updated
  }

  const start = () => {
    if (started) return
    started = true
    unsubs = [
      conn.on("notify.new", (ev: NotifyNew) => {
        if (!ev?.notification) return
        setUnread(ev.unread)
        setNotifications((prev) => mergeNotifications(prev, [ev.notification]))
        if (ev.native || ev.notification.kind === "approval" || ev.notification.kind === "job_failure") {
          toast({
            title: notificationTitle(ev.notification),
            description: ev.notification.body ?? undefined,
            tone:
              ev.notification.kind === "job_failure"
                ? "danger"
                : ev.notification.kind === "approval"
                  ? "warning"
                  : "neutral",
          })
        }
      }),
      conn.on("notify.changed", (ev: NotifyChanged) => {
        if (!ev) return
        setUnread(ev.unread)
        if (ev.allRead) {
          const now = new Date().toISOString()
          setNotifications((prev) => prev.map((n) => ({ ...n, readAt: n.readAt ?? now })))
        }
        if (ev.notifications && ev.notifications.length > 0) {
          setNotifications((prev) => mergeNotifications(prev, ev.notifications))
        }
      }),
      conn.onOpen(() => {
        void refresh()
      }),
    ]
    if (conn.state() === "open") {
      void refresh()
    }
  }

  const stop = () => {
    if (!started) return
    started = false
    for (const u of unsubs) u()
    unsubs = []
  }

  return {
    notifications,
    unread,
    loading,
    error,
    refresh,
    markRead,
    markAllRead,
    answer,
    start,
    stop,
  }
}
