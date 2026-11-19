// One live model of a project per page, shared by every view that shows it: the project row, its states,
// labels, cycles, templates and saved views, and all of its issues (a live query that follows the whole
// project, page by page past 1000 rows). Views that open the same project share one subscription; it is
// kept a while after the last view closes, so moving between the list, the board and an issue is instant.
import type { ClientRookery } from "@rookery/sdk/client"
import { type Accessor, createMemo, createResource, createRoot, createSignal } from "solid-js"
import type {
  CycleRow,
  IssueRow,
  LabelRow,
  ProjectRow,
  SavedViewRow,
  StateRow,
  TemplateRow,
} from "../lib/model"
import { entitiesOf, workbenchMe } from "./sdk"

/** At most this many issues per project are followed live. */
export const ISSUE_LIMIT = 20_000

export interface Member {
  uri: string
  name: string | null
  email: string | null
  level: "view" | "use" | "manage"
  owner: boolean
}

export interface ProjectStore {
  readonly space: string
  project: Accessor<ProjectRow | undefined>
  states: Accessor<StateRow[]>
  labels: Accessor<LabelRow[]>
  cycles: Accessor<CycleRow[]>
  templates: Accessor<TemplateRow[]>
  views: Accessor<SavedViewRow[]>
  issues: Accessor<IssueRow[]>
  /** Issues by id (and by URI). */
  issue(id: string): IssueRow | undefined
  loading: Accessor<boolean>
  error: Accessor<string | undefined>
  members: Accessor<Member[]>
  /** The viewer's level on the project. */
  level: Accessor<"view" | "use" | "manage" | null>
  refreshMembers(): void
  /**
   * Shows a change before the kernel confirms it: the patch is laid over the issue until a newer revision
   * of it arrives. Returns a function that takes it back (when the write fails).
   */
  optimistic(id: string, patch: Partial<IssueRow>): () => void
}

interface Entry {
  store: ProjectStore
  dispose: () => void
  refs: number
  timer?: ReturnType<typeof setTimeout>
}

const stores = new Map<string, Entry>()
const KEEP_MS = 60_000

function build(crow: ClientRookery, space: string): Entry {
  return createRoot((dispose) => {
    const d = crow.data.space(space)
    const project = d.projects.live({ limit: 1 })
    const states = d.states.live({ orderBy: ["rank"], limit: 200 })
    const labels = crow.data.labels.live({
      where: { or: [{ scope: `space://${space}` }, { scope: null }] },
      orderBy: ["name"],
      limit: 1000,
    })
    const cycles = d.cycles.live({ orderBy: ["startsOn"], limit: 500 })
    const templates = d.templates.live({ orderBy: ["name"], limit: 200 })
    const views = d.views.live({ orderBy: ["name"], limit: 200 })
    const issues = d.issues.live({ orderBy: ["rank"], limit: ISSUE_LIMIT })
    const [overlay, setOverlay] = createSignal<Record<string, { rev: number; patch: Partial<IssueRow> }>>({})
    const rows = createMemo(() => {
      const list = issues() as unknown as IssueRow[]
      const o = overlay()
      const keys = Object.keys(o)
      if (!keys.length) return list
      const stale: string[] = []
      const out = list.map((i) => {
        const p = o[i.id]
        if (!p) return i
        if (i.rev > p.rev) {
          stale.push(i.id)
          return i
        }
        return { ...i, ...p.patch }
      })
      if (stale.length)
        queueMicrotask(() =>
          setOverlay((cur) => {
            const next = { ...cur }
            for (const id of stale) delete next[id]
            return next
          }),
        )
      return out
    })
    const byId = createMemo(() => {
      const m = new Map<string, IssueRow>()
      for (const i of rows()) {
        m.set(i.id, i)
        m.set(`issue://${i.id}`, i)
      }
      return m
    })
    const [membersTick, setMembersTick] = createSignal(0)
    const [members] = createResource(
      () => membersTick() + 1,
      async () => {
        try {
          return await crow.host.call<{ level: Member["level"] | null; members: Member[] }>("members", {
            space,
          })
        } catch {
          return { level: null, members: [] }
        }
      },
    )
    const store: ProjectStore = {
      space,
      project: () => project()[0] as unknown as ProjectRow | undefined,
      states: () => states() as unknown as StateRow[],
      labels: () => labels() as unknown as LabelRow[],
      cycles: () => cycles() as unknown as CycleRow[],
      templates: () => templates() as unknown as TemplateRow[],
      views: () => views() as unknown as SavedViewRow[],
      issues: rows,
      issue: (id) => byId().get(id),
      loading: () => issues.loading || project.loading || states.loading,
      error: () => (issues.error ?? project.error)?.message,
      members: () => members()?.members ?? [],
      level: () => members()?.level ?? null,
      refreshMembers: () => setMembersTick((t) => t + 1),
      optimistic(id, patch) {
        const base = byId().get(id)
        if (!base) return () => {}
        const rev = (issues() as unknown as IssueRow[]).find((i) => i.id === id)?.rev ?? base.rev
        setOverlay((cur) => ({ ...cur, [id]: { rev, patch: { ...(cur[id]?.patch ?? {}), ...patch } } }))
        return () =>
          setOverlay((cur) => {
            const next = { ...cur }
            delete next[id]
            return next
          })
      },
    }
    return { store, dispose, refs: 0 }
  })
}

/** The store of a project space; release it when done (the views do this in onCleanup). */
export function acquire(crow: ClientRookery, space: string): { store: ProjectStore; release: () => void } {
  let e = stores.get(space)
  if (!e) {
    e = build(crow, space)
    stores.set(space, e)
  }
  if (e.timer) clearTimeout(e.timer)
  e.timer = undefined
  e.refs++
  const entry = e
  let released = false
  return {
    store: e.store,
    release: () => {
      if (released) return
      released = true
      entry.refs--
      if (entry.refs > 0) return
      entry.timer = setTimeout(() => {
        if (entry.refs > 0) return
        entry.dispose()
        stores.delete(space)
      }, KEEP_MS)
    },
  }
}

// ── lookups ─────────────────────────────────────────────────────────────────────────────────────────

const lite = new Map<string, Entry>()

function buildLite(crow: ClientRookery, space: string): Entry {
  return createRoot((dispose) => {
    const d = crow.data.space(space)
    const project = d.projects.live({ limit: 1 })
    const states = d.states.live({ orderBy: ["rank"], limit: 200 })
    const labels = crow.data.labels.live({
      where: { or: [{ scope: `space://${space}` }, { scope: null }] },
      orderBy: ["name"],
      limit: 1000,
    })
    const cycles = d.cycles.live({ orderBy: ["startsOn"], limit: 500 })
    const none = () => []
    const store: ProjectStore = {
      space,
      project: () => project()[0] as unknown as ProjectRow | undefined,
      states: () => states() as unknown as StateRow[],
      labels: () => labels() as unknown as LabelRow[],
      cycles: () => cycles() as unknown as CycleRow[],
      templates: none,
      views: none,
      issues: none,
      issue: () => undefined,
      loading: () => states.loading,
      error: () => states.error?.message,
      members: none,
      level: () => null,
      refreshMembers: () => {},
      optimistic: () => () => {},
    }
    return { store, dispose, refs: 0 }
  })
}

/**
 * What an issue's card or row needs of its project (states, labels, cycles) without following every issue:
 * for issues shown outside Projects (a document's database). The full store when a view already has it open.
 */
export function acquireLookups(
  crow: ClientRookery,
  space: string,
): { store: ProjectStore; release: () => void } {
  if (stores.has(space)) return acquire(crow, space)
  let e = lite.get(space)
  if (!e) {
    e = buildLite(crow, space)
    lite.set(space, e)
  }
  if (e.timer) clearTimeout(e.timer)
  e.timer = undefined
  e.refs++
  const entry = e
  let released = false
  return {
    store: e.store,
    release: () => {
      if (released) return
      released = true
      entry.refs--
      if (entry.refs > 0) return
      entry.timer = setTimeout(() => {
        if (entry.refs > 0) return
        entry.dispose()
        lite.delete(space)
      }, KEEP_MS)
    },
  }
}

/** Forgets every store: after a plugin reload, the old live queries belong to the old module. */
export function disposeAll() {
  for (const e of stores.values()) e.dispose()
  stores.clear()
  for (const e of lite.values()) e.dispose()
  lite.clear()
}

// ── people ──────────────────────────────────────────────────────────────────────────────────────────

const [names, setNames] = createSignal<Record<string, string>>({})
const asked = new Set<string>()
let pendingNames: string[] = []

/** A person's (or any entity's) display name, resolved through the entity index and cached. */
export function nameOf(crow: ClientRookery, uri: string | null | undefined): string {
  if (!uri) return ""
  const n = names()[uri]
  if (n !== undefined) return n
  if (!asked.has(uri)) {
    asked.add(uri)
    pendingNames.push(uri)
    if (pendingNames.length === 1)
      queueMicrotask(async () => {
        const list = pendingNames
        pendingNames = []
        try {
          const found = await entitiesOf(crow).resolveMany(list)
          const add: Record<string, string> = {}
          for (const u of list) add[u] = found.find((e) => e.uri === u)?.title ?? u.replace(/^user:\/\//, "")
          setNames((m) => ({ ...m, ...add }))
        } catch {
          for (const u of list) asked.delete(u)
        }
      })
  }
  return uri.startsWith("user://") ? "…" : uri
}

/** Remembers names already known (from a members list), so they show without a lookup. */
export function knowNames(list: Array<{ uri: string; name: string | null }>) {
  const add: Record<string, string> = {}
  for (const m of list) if (m.name) add[m.uri] = m.name
  if (Object.keys(add).length) setNames((n) => ({ ...n, ...add }))
  for (const u of Object.keys(add)) asked.add(u)
}

// ── who is looking ──────────────────────────────────────────────────────────────────────────────────

const [me, setMe] = createSignal<{ uri: string; name: string; admin: boolean } | null>(null)
let meAsked = false

export function useMe(crow: ClientRookery): Accessor<{ uri: string; name: string; admin: boolean } | null> {
  if (!meAsked) {
    meAsked = true
    workbenchMe(crow)
      .then((m) => setMe({ uri: `user://${m.user.id}`, name: m.user.name, admin: !!m.user.admin }))
      .catch(() => {
        meAsked = false
      })
  }
  return me
}

/** Today in UTC as `YYYY-MM-DD`, refreshed every minute. */
const [todaySig, setToday] = createSignal(new Date().toISOString().slice(0, 10))
setInterval(() => setToday(new Date().toISOString().slice(0, 10)), 60_000)
export const today = todaySig
