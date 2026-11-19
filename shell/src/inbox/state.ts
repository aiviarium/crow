// Reactive shell notifications inbox store backed by `notify.list`, `notify.read`, `notify.unread`,
// `notify.readAll`, `notify.archive`, `notify.answer`, and live `notify.new` / `notify.changed`.
import { toast } from "@aiviarium/nocturne"
import type {
  Connection,
  InboxPage,
  InboxQuery,
  KindCount,
  NotificationInfo,
  NotifyChanged,
  NotifyNew,
} from "@rookery/client"
import { type Accessor, createSignal } from "solid-js"

export interface InboxStore {
  readonly notifications: Accessor<NotificationInfo[]>
  readonly unread: Accessor<number>
  readonly counts: Accessor<KindCount[]>
  readonly loading: Accessor<boolean>
  readonly error: Accessor<string | null>
  readonly showArchived: Accessor<boolean>
  refresh(query?: InboxQuery): Promise<void>
  setShowArchived(archived: boolean): Promise<void>
  markRead(ids: string[]): Promise<void>
  markUnread(ids: string[]): Promise<void>
  markAllRead(): Promise<void>
  archive(ids: string[]): Promise<void>
  answer(id: string, action: string, text?: string): Promise<NotificationInfo>
  start(): void
  stop(): void
}

function mergeNotifications(
  existing: NotificationInfo[],
  incoming: NotificationInfo[],
  archivedMode: boolean,
): NotificationInfo[] {
  const byId = new Map<string, NotificationInfo>()
  for (const n of existing) byId.set(n.id, n)
  for (const n of incoming) {
    const isArchived = Boolean(n.archivedAt)
    if (archivedMode !== isArchived) {
      byId.delete(n.id)
    } else {
      byId.set(n.id, n)
    }
  }
  return Array.from(byId.values()).sort((a, b) => b.createdAt.localeCompare(a.createdAt))
}

export function notificationTitle(n: NotificationInfo): string {
  const d = n.data
  if (d && typeof d.title === "string" && d.title.trim()) return d.title.trim()
  return n.text
}

export function notificationLink(n: NotificationInfo): string | null {
  const d = n.data
  if (d && typeof d.url === "string" && d.url.startsWith("/")) return d.url
  if (d && typeof d.link === "string" && d.link.startsWith("/")) return d.link
  return null
}

export function createInboxStore(conn: Connection): InboxStore {
  const [notifications, setNotifications] = createSignal<NotificationInfo[]>([])
  const [unread, setUnread] = createSignal(0)
  const [counts, setCounts] = createSignal<KindCount[]>([])
  const [loading, setLoading] = createSignal(false)
  const [error, setError] = createSignal<string | null>(null)
  const [showArchived, setShowArchivedSignal] = createSignal(false)

  let started = false
  let unsubs: Array<() => void> = []

  const refresh = async (query: InboxQuery = {}) => {
    setLoading(true)
    setError(null)
    try {
      const archived = query.archived ?? showArchived()
      const page = await conn.call<InboxPage>("notify.list", {
        limit: 100,
        ...query,
        archived,
      } as Record<string, unknown>)
      setNotifications(page.notifications ?? [])
      setUnread(page.unread ?? 0)
      setCounts(page.counts ?? [])
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setLoading(false)
    }
  }

  const setShowArchived = async (archived: boolean) => {
    setShowArchivedSignal(archived)
    await refresh({ archived })
  }

  const markRead = async (ids: string[]) => {
    if (ids.length === 0) return
    const res = await conn.call<{ unread?: number }>("notify.read", { ids })
    const now = new Date().toISOString()
    const set = new Set(ids)
    setNotifications((prev) => prev.map((n) => (set.has(n.id) ? { ...n, readAt: n.readAt ?? now } : n)))
    if (typeof res?.unread === "number") {
      setUnread(res.unread)
    } else {
      setUnread((prev) => Math.max(0, prev - ids.length))
    }
  }

  const markUnread = async (ids: string[]) => {
    if (ids.length === 0) return
    const res = await conn.call<{ unread?: number }>("notify.unread", { ids })
    const set = new Set(ids)
    setNotifications((prev) => prev.map((n) => (set.has(n.id) ? { ...n, readAt: undefined } : n)))
    if (typeof res?.unread === "number") {
      setUnread(res.unread)
    } else {
      setUnread((prev) => prev + ids.length)
    }
  }

  const markAllRead = async () => {
    await conn.call("notify.readAll", {})
    const now = new Date().toISOString()
    setNotifications((prev) => prev.map((n) => ({ ...n, readAt: n.readAt ?? now })))
    setUnread(0)
  }

  const archive = async (ids: string[]) => {
    if (ids.length === 0) return
    const res = await conn.call<{ unread?: number }>("notify.archive", { ids })
    const set = new Set(ids)
    if (!showArchived()) {
      setNotifications((prev) => prev.filter((n) => !set.has(n.id)))
    }
    if (typeof res?.unread === "number") {
      setUnread(res.unread)
    }
  }

  const answer = async (id: string, action: string, text?: string): Promise<NotificationInfo> => {
    const params: Record<string, unknown> = { id, action }
    if (text !== undefined && text.trim() !== "") params.text = text.trim()
    const updated = await conn.call<NotificationInfo>("notify.answer", params)
    setNotifications((prev) => mergeNotifications(prev, [updated], showArchived()))
    return updated
  }

  const start = () => {
    if (started) return
    started = true
    unsubs = [
      conn.on("notify.new", (ev: NotifyNew) => {
        if (!ev?.notification) return
        setUnread(ev.unread)
        if (!showArchived()) {
          setNotifications((prev) => mergeNotifications(prev, [ev.notification], false))
        }
        if (ev.native || ev.notification.kind === "approval" || ev.notification.kind === "job_failure") {
          toast({
            title: notificationTitle(ev.notification),
            description:
              notificationTitle(ev.notification) !== ev.notification.text ? ev.notification.text : undefined,
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
          setNotifications((prev) => mergeNotifications(prev, ev.notifications, showArchived()))
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
    counts,
    loading,
    error,
    showArchived,
    refresh,
    setShowArchived,
    markRead,
    markUnread,
    markAllRead,
    archive,
    answer,
    start,
    stop,
  }
}
