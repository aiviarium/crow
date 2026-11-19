// One open workspace: a checkout or worktree on a host. Holds the editor groups and their tabs, the
// buffers (Monaco models with the version each was read at), git status, and the panels. Saves pass the
// version they read (`ifMatch`); a file that changed on disk meanwhile opens a save conflict instead of
// being overwritten. Unsaved buffers are drafts in Rookery's storage, so they survive a reload and follow
// the person to another device.
import type { ClientRookery } from "@rookery/sdk/client"
import { batch, createSignal } from "solid-js"
import { createStore, produce } from "solid-js/store"
import { type Api, createApi, type DiffKind, type GitStatus, type WsInfo } from "./api"
import type { Monaco } from "./monaco"

export type TabKind =
  | "file"
  | "diff"
  | "conflict"
  | "saveConflict"
  | "commit"
  | "history"
  | "image"
  | "markdown"
  | "binary"
  | "large"

export interface Tab {
  id: string
  kind: TabKind
  title: string
  /** Relative to the workspace root. */
  path?: string
  /** diff: which one. */
  diff?: { kind: DiffKind | "commit"; base?: string; head?: string }
  sha?: string
  line?: number
  col?: number
}

export interface Group {
  tabs: Tab[]
  active: string | null
}

export interface Buffer {
  path: string
  /** The version on disk the buffer is based on (SHA-256), null for a file not written yet. */
  base: string | null
  /** The model's alternative version id at the last save or load. */
  savedVersion: number
  dirty: boolean
  /** The file changed on disk since it was read: its new version, and its text if known. */
  changedOnDisk?: { sha: string | null; text?: string | null }
  /** Shown once after a clean buffer was reloaded because the file changed on disk. */
  reloaded?: boolean
  readonly?: boolean
}

export interface SaveConflict {
  path: string
  mine: string
  theirs: string | null
  theirsSha: string | null
}

export interface WorkbenchSettings {
  minimap: boolean
  wordWrap: string
  formatOnSave: boolean
  signOff: boolean
  largeFileBytes: number
}

const DEFAULTS: WorkbenchSettings = {
  minimap: true,
  wordWrap: "off",
  formatOnSave: false,
  signOff: false,
  largeFileBytes: 5 * 1024 * 1024,
}

let monacoLoad: Promise<typeof import("./monaco")> | null = null
/** Loads Monaco (once per page). */
export function loadMonaco() {
  monacoLoad ??= import("./monaco").then((m) => {
    m.followTheme()
    return m
  })
  return monacoLoad
}

const DRAFT_LIMIT = 512 * 1024

export const tabId = (kind: string, path = "", extra = "") => `${kind}:${path}${extra ? `#${extra}` : ""}`

export class Workspace {
  readonly api: Api
  readonly status: () => GitStatus | null
  private readonly setStatus: (s: GitStatus | null) => void
  readonly groups: Group[]
  private readonly setGroups: (...args: any[]) => void
  readonly focused: () => number
  readonly setFocused: (i: number) => void
  /** Buffers by path; read `bufferVersion()` to track changes. */
  readonly buffers = new Map<string, Buffer>()
  readonly bufferVersion: () => number
  private readonly bumpBuffers: (f: (n: number) => number) => void
  readonly conflicts = new Map<string, SaveConflict>()
  /** Ticks when the files on disk may have changed (tree and status should reload). */
  readonly refreshed: () => number
  private readonly bumpRefreshed: (f: (n: number) => number) => void
  readonly files: () => string[] | null
  private readonly setFiles: (f: string[] | null) => void
  readonly lastError: () => string | null
  readonly setLastError: (e: string | null) => void
  /** A push, pull or fetch running. */
  readonly syncing: () => string | null
  readonly setSyncing: (op: string | null) => void
  /** The workbench's settings, resolved for the person and following changes made anywhere. */
  readonly settings: () => WorkbenchSettings
  private readonly setSettings: (s: WorkbenchSettings) => void
  private monaco: Monaco | null = null
  private models = new Map<string, import("monaco-editor").editor.ITextModel>()
  private draftTimer: ReturnType<typeof setTimeout> | undefined
  private disposers: Array<() => void> = []
  /** Editors register themselves so commands (save, format, find) reach the focused one. */
  readonly editors = new Map<number, { editor: () => any; kind: () => string }>()

  constructor(
    readonly rookery: ClientRookery,
    readonly info: WsInfo,
  ) {
    this.api = createApi(rookery)
    ;[this.status, this.setStatus] = createSignal<GitStatus | null>(null)
    const [groups, setGroups] = createStore<Group[]>([{ tabs: [], active: null }])
    this.groups = groups
    this.setGroups = setGroups
    ;[this.focused, this.setFocused] = createSignal(0)
    ;[this.bufferVersion, this.bumpBuffers] = createSignal(0)
    ;[this.refreshed, this.bumpRefreshed] = createSignal(0)
    ;[this.files, this.setFiles] = createSignal<string[] | null>(null)
    ;[this.lastError, this.setLastError] = createSignal<string | null>(null)
    ;[this.syncing, this.setSyncing] = createSignal<string | null>(null)
    ;[this.settings, this.setSettings] = createSignal<WorkbenchSettings>(DEFAULTS)
  }

  get env() {
    return this.info.env
  }
  get root() {
    return this.info.root
  }
  abs(path: string) {
    return `${this.root.replace(/\/$/, "")}/${path}`
  }
  rel(abs: string) {
    const r = this.root.replace(/\/$/, "")
    return abs.startsWith(`${r}/`) ? abs.slice(r.length + 1) : abs
  }
  get draftKey() {
    return `draft:ws:${this.env}:${this.root}`
  }
  get layoutKey() {
    return `layout:${this.env}:${this.root}`
  }

  async init() {
    await Promise.all([this.refreshStatus(), this.initSettings()])
    await this.restoreDrafts()
  }

  async initSettings() {
    const value = async (key: string) => this.rookery.settings.get(key as never).catch(() => undefined)
    const [minimap, wordWrap, formatOnSave, signOff, large] = await Promise.all([
      value("workbench.minimap"),
      value("workbench.wordWrap"),
      value("workbench.formatOnSave"),
      value("workbench.signOff"),
      value("workbench.largeFileBytes"),
    ])
    this.setSettings({
      minimap: (minimap as boolean | undefined) ?? DEFAULTS.minimap,
      wordWrap: (wordWrap as string | undefined) ?? DEFAULTS.wordWrap,
      formatOnSave: !!formatOnSave,
      signOff: !!signOff,
      largeFileBytes: (large as number | undefined) ?? DEFAULTS.largeFileBytes,
    })
  }

  dispose() {
    clearTimeout(this.draftTimer)
    for (const d of this.disposers.splice(0)) d()
    for (const m of this.models.values()) m.dispose()
    this.models.clear()
  }

  // ── Git status and files ───────────────────────────────────────────────────────────────────────

  async refreshStatus() {
    if (!this.info.isRepo) return
    try {
      this.setStatus(await this.api.git.status(this.env, this.root, this.info.gitDir))
    } catch (e) {
      this.setLastError((e as Error).message)
    }
  }

  async loadFiles(force = false) {
    if (this.files() && !force) return this.files()!
    if (!this.info.isRepo) {
      this.setFiles([])
      return []
    }
    const f = await this.api.git.lsFiles(this.env, this.root)
    this.setFiles(f)
    return f
  }

  /**
   * Everything that may have changed on disk without the workbench knowing (there is no file watch on a
   * host): git status, the tree, the file list, and the open buffers' versions.
   */
  async refresh() {
    this.bumpRefreshed((n) => n + 1)
    await Promise.all([this.refreshStatus(), this.files() ? this.loadFiles(true) : null, this.checkBuffers()])
  }

  /** Compares each open buffer with the file on disk. A clean buffer reloads; a dirty one is marked. */
  async checkBuffers() {
    const paths = [...this.buffers.values()].filter((b) => b.base !== null || b.dirty).map((b) => b.path)
    if (!paths.length) return
    let versions: Record<string, string | null>
    try {
      versions = await this.api.fs.versions(
        this.env,
        paths.map((p) => this.abs(p)),
      )
    } catch {
      return
    }
    for (const path of paths) {
      const b = this.buffers.get(path)
      if (!b) continue
      const now = versions[this.abs(path)] ?? null
      if (now === b.base) {
        if (b.changedOnDisk) {
          b.changedOnDisk = undefined
          this.bumpBuffers((n) => n + 1)
        }
        continue
      }
      if (!b.dirty && now) {
        const r = await this.api.fs.read(this.env, this.abs(path)).catch(() => null)
        const m = this.models.get(path)
        if (r?.kind === "text" && m) {
          m.pushEditOperations([], [{ range: m.getFullModelRange(), text: r.text }], () => null)
          b.base = r.sha256
          b.savedVersion = m.getAlternativeVersionId()
          b.dirty = false
          b.reloaded = true
          this.bumpBuffers((n) => n + 1)
          continue
        }
      }
      b.changedOnDisk = { sha: now }
      this.bumpBuffers((n) => n + 1)
    }
  }

  // ── Tabs ───────────────────────────────────────────────────────────────────────────────────────

  activeTab(group = this.focused()): Tab | undefined {
    const g = this.groups[group]
    return g?.tabs.find((t) => t.id === g.active)
  }

  openTab(tab: Tab, opts: { group?: number; background?: boolean } = {}) {
    const gi = Math.min(opts.group ?? this.focused(), this.groups.length - 1)
    batch(() => {
      this.setGroups(
        gi,
        produce((g: Group) => {
          const existing = g.tabs.find((t) => t.id === tab.id)
          if (existing)
            Object.assign(existing, { line: tab.line, col: tab.col, diff: tab.diff ?? existing.diff })
          else {
            const at = g.tabs.findIndex((t) => t.id === g.active)
            g.tabs.splice(at < 0 ? g.tabs.length : at + 1, 0, tab)
          }
          if (!opts.background) g.active = tab.id
        }),
      )
      if (!opts.background) this.setFocused(gi)
    })
    this.saveLayout()
  }

  closeTab(id: string, group = this.focused()) {
    this.setGroups(
      group,
      produce((g: Group) => {
        const i = g.tabs.findIndex((t) => t.id === id)
        if (i < 0) return
        g.tabs.splice(i, 1)
        if (g.active === id) g.active = g.tabs[Math.min(i, g.tabs.length - 1)]?.id ?? null
      }),
    )
    if (this.groups.length > 1 && this.groups[group]!.tabs.length === 0) this.closeGroup(group)
    this.saveLayout()
  }

  setActive(id: string, group: number) {
    batch(() => {
      this.setGroups(group, "active", id)
      this.setFocused(group)
    })
    this.saveLayout()
  }

  /** Splits the editor: the active tab opens in a second group beside the first. */
  split() {
    const tab = this.activeTab()
    if (this.groups.length >= 2) {
      if (tab) this.openTab({ ...tab }, { group: this.focused() === 0 ? 1 : 0 })
      return
    }
    this.setGroups([
      ...this.groups.map((g) => ({ tabs: [...g.tabs], active: g.active })),
      { tabs: tab ? [{ ...tab }] : [], active: tab?.id ?? null },
    ])
    this.setFocused(1)
    this.saveLayout()
  }

  closeGroup(i: number) {
    if (this.groups.length < 2) return
    const rest = this.groups.filter((_, k) => k !== i).map((g) => ({ tabs: [...g.tabs], active: g.active }))
    this.setGroups(rest)
    this.setFocused(0)
  }

  /** Opens a file by its path relative to the root, in the editor or the viewer its kind needs. */
  async openFile(
    path: string,
    opts: { line?: number; col?: number; group?: number; background?: boolean } = {},
  ) {
    const name = path.split("/").pop() ?? path
    let kind: TabKind = "file"
    if (/\.(png|jpe?g|gif|webp|bmp|ico|avif|svg)$/i.test(path)) kind = "image"
    this.openTab({ id: tabId("file", path), kind, title: name, path, line: opts.line, col: opts.col }, opts)
  }

  openDiff(path: string, kind: DiffKind | "commit", extra: { base?: string; head?: string } = {}) {
    const name = path.split("/").pop() ?? path
    const label =
      kind === "staged" ? "staged" : kind === "unstaged" ? "working tree" : (extra.head ?? "").slice(0, 7)
    this.openTab({
      id: tabId("diff", path, `${kind}${extra.base ?? ""}${extra.head ?? ""}`),
      kind: "diff",
      title: `${name} (${label})`,
      path,
      diff: { kind, ...extra },
    })
  }

  // ── Buffers and models ─────────────────────────────────────────────────────────────────────────

  async monacoApi(): Promise<Monaco> {
    if (!this.monaco) this.monaco = (await loadMonaco()).monaco
    return this.monaco
  }

  uri(path: string) {
    return this.monaco!.Uri.from({ scheme: "rookery", authority: this.env, path: this.abs(path) })
  }

  getModel(path: string) {
    return this.models.get(path)
  }

  /** The model of a file, loaded from disk (or from its draft) the first time. */
  async model(
    path: string,
    read?: { text: string; sha256: string | null; dirtyText?: string; readonly?: boolean },
  ) {
    const existing = this.models.get(path)
    if (existing) return existing
    const m = await loadMonaco()
    const monaco = await this.monacoApi()
    let text: string
    let sha: string | null
    if (read) {
      text = read.text
      sha = read.sha256
    } else {
      const r = await this.api.fs.read(this.env, this.abs(path), { limit: this.settings().largeFileBytes })
      if (r.kind !== "text") throw Object.assign(new Error(r.kind), { result: r })
      text = r.text
      sha = r.sha256
    }
    const again = this.models.get(path)
    if (again) return again
    const model = monaco.editor.createModel(text, m.languageFor(path), this.uri(path))
    this.models.set(path, model)
    const b: Buffer = {
      path,
      base: sha,
      savedVersion: model.getAlternativeVersionId(),
      dirty: false,
      readonly: read?.readonly,
    }
    this.buffers.set(path, b)
    if (read?.dirtyText !== undefined && read.dirtyText !== text) {
      model.setValue(read.dirtyText)
      b.dirty = true
    }
    model.onDidChangeContent(() => {
      const dirty = model.getAlternativeVersionId() !== b.savedVersion
      if (dirty !== b.dirty) {
        b.dirty = dirty
        this.bumpBuffers((n) => n + 1)
      }
      if (b.reloaded) {
        b.reloaded = false
        this.bumpBuffers((n) => n + 1)
      }
      this.scheduleDrafts()
    })
    this.bumpBuffers((n) => n + 1)
    return model
  }

  isDirty(path: string) {
    this.bufferVersion()
    return !!this.buffers.get(path)?.dirty
  }

  dirtyPaths() {
    this.bufferVersion()
    return [...this.buffers.values()].filter((b) => b.dirty).map((b) => b.path)
  }

  /** A buffer without unsaved changes is read again, when git may have changed the file (a merge, a checkout). */
  async reloadIfClean(path: string) {
    const b = this.buffers.get(path)
    if (b && !b.dirty) await this.revert(path)
  }

  /** Throws away unsaved changes: the buffer goes back to what was read. */
  async revert(path: string) {
    const b = this.buffers.get(path)
    const m = this.models.get(path)
    if (!b || !m) return
    const r = await this.api.fs.read(this.env, this.abs(path))
    if (r.kind !== "text") return
    m.setValue(r.text)
    b.base = r.sha256
    b.savedVersion = m.getAlternativeVersionId()
    b.dirty = false
    b.changedOnDisk = undefined
    this.bumpBuffers((n) => n + 1)
    clearTimeout(this.draftTimer)
    await this.writeDrafts()
  }

  /**
   * Saves a buffer with the version it was read at. If the file changed on disk meanwhile, nothing is
   * written: a save conflict tab opens with both versions.
   */
  async save(path: string, opts: { force?: string | null; format?: boolean } = {}): Promise<boolean> {
    const b = this.buffers.get(path)
    const m = this.models.get(path)
    if (!b || !m || b.readonly) return false
    if ((opts.format ?? this.settings().formatOnSave) && this.formatter)
      await this.formatter(path).catch(() => {})
    const text = m.getValue()
    const version = m.getAlternativeVersionId()
    const ifMatch = opts.force !== undefined ? opts.force : b.base
    try {
      const r = await this.api.fs.write(
        this.env,
        this.abs(path),
        { text },
        ifMatch ? { ifMatch } : { overwrite: false },
      )
      b.base = r.sha256
      b.savedVersion = version
      b.dirty = m.getAlternativeVersionId() !== version
      b.changedOnDisk = undefined
      this.conflicts.delete(path)
      this.bumpBuffers((n) => n + 1)
      // At once, not after the usual pause: a draft left behind would come back as unsaved changes.
      clearTimeout(this.draftTimer)
      await this.writeDrafts()
      this.refreshStatus()
      return true
    } catch (e) {
      if ((e as { code?: string } | null)?.code === "CONFLICT") {
        const current = (e as { details?: { current?: string | null } }).details?.current ?? null
        // Read what is on disk now, so the conflict tab shows both versions.
        const now = await this.api.fs.read(this.env, this.abs(path)).catch(() => null)
        const theirs = now?.kind === "text" ? now.text : null
        const version = now && "sha256" in now ? now.sha256 : null
        this.conflicts.set(path, { path, mine: text, theirs, theirsSha: current ?? version })
        b.changedOnDisk = { sha: current ?? version, text: theirs }
        this.bumpBuffers((n) => n + 1)
        this.openTab({
          id: tabId("saveConflict", path),
          kind: "saveConflict",
          title: `${path.split("/").pop()} (conflict)`,
          path,
        })
        return false
      }
      this.rookery.workbench.toast({
        title: `Saving ${path} failed`,
        body: (e as Error).message,
        kind: "danger",
      })
      return false
    }
  }

  /** Set by the editor layer: formats a file's model where Monaco can. */
  formatter: ((path: string) => Promise<void>) | null = null

  /** Keep mine: write my text over theirs, knowingly (their version is the condition now). */
  async keepMine(path: string, text?: string) {
    const c = this.conflicts.get(path)
    const m = this.models.get(path)
    if (!c || !m) return
    if (text !== undefined) m.setValue(text)
    if (await this.save(path, { force: c.theirsSha, format: false }))
      this.closeTab(tabId("saveConflict", path))
  }

  /** Take theirs: the buffer becomes what is on disk. */
  async takeTheirs(path: string) {
    await this.revert(path)
    this.conflicts.delete(path)
    this.closeTab(tabId("saveConflict", path))
  }

  // ── Drafts ─────────────────────────────────────────────────────────────────────────────────────

  private scheduleDrafts() {
    clearTimeout(this.draftTimer)
    this.draftTimer = setTimeout(() => this.writeDrafts(), 800)
  }

  async writeDrafts() {
    const files: Record<string, { text: string; base: string | null }> = {}
    for (const b of this.buffers.values()) {
      if (!b.dirty) continue
      const text = this.models.get(b.path)?.getValue()
      if (text === undefined || text.length > DRAFT_LIMIT) continue
      files[b.path] = { text, base: b.base }
    }
    try {
      if (Object.keys(files).length)
        await this.rookery.storage.set(this.draftKey, { files, at: Date.now() }, { scope: "user" })
      else await this.rookery.storage.delete(this.draftKey, { scope: "user" })
    } catch {}
  }

  /** Unsaved buffers from an earlier visit, on this device or another: opened again, dirty. */
  async restoreDrafts() {
    let d: { files?: Record<string, { text: string; base: string | null }> } | null | undefined
    try {
      d = await this.rookery.storage.get(this.draftKey, { scope: "user" })
    } catch {
      return
    }
    const files = d?.files ?? {}
    const paths = Object.keys(files)
    if (!paths.length) return
    await this.monacoApi()
    for (const path of paths) {
      const f = files[path]!
      try {
        const r = await this.api.fs.read(this.env, this.abs(path)).catch(() => null)
        const disk = r?.kind === "text" ? r : null
        await this.model(path, {
          text: disk?.text ?? "",
          sha256: disk ? disk.sha256 : null,
          dirtyText: f.text,
        })
        const b = this.buffers.get(path)!
        // The draft was made on top of another version than what is on disk now.
        if ((disk?.sha256 ?? null) !== f.base) {
          b.base = f.base
          b.changedOnDisk = { sha: disk?.sha256 ?? null, text: disk?.text ?? null }
        }
        this.openFile(path, { background: true })
      } catch {}
    }
    const first = this.groups[0]!.tabs[0]
    if (first && !this.groups[0]!.active) this.setActive(first.id, 0)
    this.bumpBuffers((n) => n + 1)
  }

  // ── Layout per workspace, kept for the person ─────────────────────────────────────────────────

  private layoutTimer: ReturnType<typeof setTimeout> | undefined
  private saveLayout() {
    clearTimeout(this.layoutTimer)
    this.layoutTimer = setTimeout(() => {
      const tabs = this.groups.map((g) => ({
        tabs: g.tabs
          .filter((t) => t.kind === "file" || t.kind === "image" || t.kind === "markdown")
          .map((t) => ({ path: t.path!, kind: t.kind })),
        active: g.tabs.find((t) => t.id === g.active)?.path ?? null,
      }))
      this.rookery.storage.set(this.layoutKey, { groups: tabs }, { scope: "user" }).catch(() => {})
    }, 500)
  }

  async restoreLayout() {
    const l = await this.rookery.storage
      .get<{
        groups: Array<{ tabs: Array<{ path: string; kind: TabKind }>; active: string | null }>
      }>(this.layoutKey, { scope: "user" })
      .catch(() => undefined)
    if (!l?.groups?.length) return
    l.groups.slice(0, 2).forEach((g, gi) => {
      if (gi === 1 && this.groups.length < 2)
        this.setGroups([...this.groups.map((x) => ({ ...x, tabs: [...x.tabs] })), { tabs: [], active: null }])
      for (const t of g.tabs) {
        const name = t.path.split("/").pop() ?? t.path
        this.openTab(
          { id: tabId("file", t.path), kind: t.kind, title: name, path: t.path },
          { group: gi, background: t.path !== g.active },
        )
      }
    })
    this.groups.forEach((g, gi) => {
      if (!g.active && g.tabs[0]) this.setGroups(gi, "active", g.tabs[0].id)
    })
    this.setFocused(0)
  }
}
