// The client half's calls to the host half, typed, and small helpers the views share.
import { createSignal } from "solid-js"
import type { Hue } from "../lib/props"
import type { PageRow } from "../lib/tree"
import type { ClientRookeryWithDocs } from "../types"

export type Page = PageRow & { spaceId: string; rev: number; updatedAt: string; createdAt: string }

export interface Template {
  id: string
  title: string
  description: string
  icon: string
  builtin: boolean
}

export function openEntity(rookery: ClientRookeryWithDocs, uri: string) {
  if (rookery.entities?.open) {
    rookery.entities.open(uri)
    return
  }
  if (uri.startsWith("doc://")) {
    rookery.workbench.openView("docs.page", { path: uri.slice(6) })
  } else if (uri.startsWith("doc-comment://")) {
    rookery.workbench.openView("docs.comment", { path: uri.slice(14) })
  }
}

export function api(rookery: ClientRookeryWithDocs) {
  const call = <T>(method: string, params: Record<string, unknown>) => rookery.host.call<T>(method, params)
  return {
    create: (p: {
      title?: string
      parent?: string | null
      space?: string
      index?: number
      template?: string
      markdown?: string
      private?: boolean
    }) => call<{ id: string; spaceId: string; document: string; title: string }>("create", p),
    document: (id: string, space?: string) => call<{ id: string }>("document", { id, space }),
    move: (id: string, parent: string | null, index: number | undefined, space?: string) =>
      call<{ id: string }>("move", { id, parent, ...(index === undefined ? {} : { index }), space }),
    trash: (id: string, space?: string) => call<{ trashed: number }>("trash", { id, space }),
    restore: (id: string, space?: string) => call<{ restored: number }>("restore", { id, space }),
    purge: (id: string, space?: string) => call<{ purged: number }>("purge", { id, space }),
    emptyTrash: (space?: string) => call<{ purged: number }>("emptyTrash", { space }),
    duplicate: (id: string, subpages: boolean, space?: string) =>
      call<{ id: string }>("duplicate", { id, subpages, space }),
    templates: (space?: string) => call<Template[]>("templates", { space }),
    saveTemplate: (id: string, subpages: boolean, space?: string) =>
      call<{ id: string }>("saveTemplate", { id, subpages, space }),
    exportMarkdown: (id: string, subpages: boolean, space?: string) =>
      call<{
        files: Array<{ path: string; text: string }>
        attachments: Array<{ path: string; blob: string }>
      }>("exportMarkdown", {
        id,
        subpages,
        space,
      }),
    importPages: (p: {
      parent?: string | null
      space?: string
      pages: Array<{
        key: string
        title: string
        parent: string | null
        props: Record<string, unknown>
        icon?: string
      }>
    }) => call<{ space: string; ids: Record<string, string> }>("importPages", p),
    importContent: (items: Array<{ id: string; markdown: string }>, space?: string) =>
      call<{ done: number }>("importContent", { items, space }),
    comment: (p: {
      page: string
      body: unknown
      text: string
      anchor?: unknown
      thread?: string | null
      space?: string
    }) => call<{ id: string }>("comment", p),
    ancestors: (id: string, space?: string) =>
      call<{ ancestors: Array<{ id: string; title: string; icon: string | null }> }>("ancestors", {
        id,
        space,
      }),
    markdown: (id: string, space?: string) => call<{ markdown: string }>("markdown", { id, space }),
    backlinks: (page: string, space?: string) =>
      call<{
        linked: Array<{
          source: string
          title: string
          icon: string | null
          field: string
          snippet: string | null
        }>
        unlinked: Array<{ uri: string; title: string; snippet: string | null }>
      }>("backlinks", { page, space }),
  }
}

export type Api = ReturnType<typeof api>

/** A page icon is a core icon name, optionally with a label hue: `terminal:teal`. */
export function iconOf(icon: string | null | undefined): { name: string; hue: Hue | null } {
  const [name, hue] = String(icon || "file").split(":")
  return { name: name || "file", hue: (hue as Hue) || null }
}

export const ICON_CHOICES = [
  "file",
  "folder",
  "terminal",
  "users",
  "calendar",
  "check",
  "star",
  "chart",
  "server",
  "layers",
  "board",
  "grid",
  "list",
  "bolt",
  "branch",
  "settings",
  "chat",
  "tag",
  "home",
  "inbox",
  "sparkle",
  "agent",
  "activity",
  "edit",
  "link",
  "eye",
]

/** Relative time, short. */
export function ago(iso: string | null | undefined): string {
  if (!iso) return ""
  const s = Math.max(0, (Date.now() - Date.parse(iso)) / 1000)
  if (s < 45) return "just now"
  if (s < 3600) return `${Math.max(1, Math.round(s / 60))}m ago`
  if (s < 86400) return `${Math.round(s / 3600)}h ago`
  if (s < 86400 * 7) return `${Math.round(s / 86400)}d ago`
  return new Date(iso).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" })
}

/** Remembered per browser: which tree nodes are open, the side panel, the outline. */
export function stored<T>(key: string, fallback: T): { get(): T; set(v: T): void } {
  const k = `crow.docs.${key}`
  return {
    get() {
      try {
        const raw = localStorage.getItem(k)
        return raw ? (JSON.parse(raw) as T) : fallback
      } catch {
        return fallback
      }
    },
    set(v: T) {
      try {
        localStorage.setItem(k, JSON.stringify(v))
      } catch {}
    },
  }
}

/** Downloads bytes as a file. */
export function download(name: string, data: Uint8Array | string, type = "application/octet-stream") {
  const blob = new Blob([data as BlobPart], { type })
  const a = document.createElement("a")
  a.href = URL.createObjectURL(blob)
  a.download = name
  document.body.append(a)
  a.click()
  a.remove()
  setTimeout(() => URL.revokeObjectURL(a.href), 10_000)
}

/** Names of users by id (or `user://` URI), from the entity index, fetched in batches and kept. */
export function userNames(rookery: ClientRookeryWithDocs) {
  const [names, setNames] = createSignal<Record<string, string>>({})
  const want = new Set<string>()
  let scheduled = false
  const flush = async () => {
    scheduled = false
    const ids = [...want].filter((id) => !(id in names()))
    want.clear()
    if (!ids.length || !rookery.entities) return
    try {
      const found = await rookery.entities.resolveMany(ids.map((id) => `user://${id}`))
      setNames((n) => ({
        ...n,
        ...Object.fromEntries(ids.map((id) => [id, found.find((e) => e.id === id)?.title ?? "Someone"])),
      }))
    } catch {}
  }
  return (idOrUri: string | null | undefined): string => {
    if (!idOrUri) return "Someone"
    const id = idOrUri.replace(/^user:\/\//, "").replace(/^user:/, "")
    if (!/^[0-9a-f-]{36}$/i.test(id))
      return idOrUri.startsWith("service:plugin:")
        ? "Docs"
        : idOrUri.startsWith("agent:")
          ? "An agent"
          : "Someone"
    const n = names()[id]
    if (n) return n
    if (!rookery.entities) return "Someone"
    want.add(id)
    if (!scheduled) {
      scheduled = true
      setTimeout(flush, 20)
    }
    return "…"
  }
}
