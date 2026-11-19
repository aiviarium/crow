// The file tree: folders load when opened, rows are virtualised (a folder of thousands of files scrolls as
// fast as one of ten), git's status decorates files and the folders above them, ignored files are dimmed.
// Create, rename, move (drag a row onto a folder), delete, upload and download. There is no file watch on a
// berth host, so it reloads the open folders when the window gets the focus back and on demand.

import { Icon, IconButton, List, Menu, type MenuEntry, Popover } from "@aiviarium/nocturne"
import type { DirEntry } from "@rookery/client"
import { batch, createEffect, createMemo, createSignal, on, onMount, Show } from "solid-js"
import { createStore, produce } from "solid-js/store"
import { decorations, isIgnored } from "../git/status"
import { fileKind } from "../paths"
import type { Workspace } from "../workspace"
import { confirmAction, promptText } from "./prompt"

interface Row {
  path: string
  name: string
  dir: boolean
  depth: number
  size: number
}

interface Folder {
  entries?: DirEntry[]
  loading?: boolean
  error?: string
}

const ROW = 24

export function FileTree(props: { w: Workspace; reveal: string | null; onRevealed: () => void }) {
  const w = props.w
  const [folders, setFolders] = createStore<Record<string, Folder>>({})
  const [open, setOpen] = createStore<Record<string, boolean>>({ "": true })
  const [selected, setSelected] = createSignal<string | null>(null)
  const [menu, setMenu] = createSignal<{ row: Row | null; anchor: HTMLElement } | null>(null)
  const [dropTarget, setDropTarget] = createSignal<string | null>(null)
  let upload!: HTMLInputElement

  const abs = (rel: string) => (rel ? w.abs(rel) : w.root)

  async function load(rel: string) {
    setFolders(rel, (f) => ({ ...f, loading: true }))
    try {
      const l = await w.api.fs.list(w.env, abs(rel))
      setFolders(rel, { entries: l.entries.filter((e) => !(rel === "" && e.name === ".git")) })
    } catch (e) {
      setFolders(rel, { error: (e as Error).message })
    }
  }

  onMount(() => load(""))
  // Reload what is open when the workspace refreshes.
  createEffect(
    on(
      w.refreshed,
      () => {
        for (const rel of Object.keys(folders)) if (rel === "" || open[rel]) load(rel)
      },
      { defer: true },
    ),
  )

  const deco = createMemo(() => decorations(w.status()?.entries ?? []))

  const rows = createMemo(() => {
    const out: Row[] = []
    const walk = (rel: string, depth: number) => {
      const f = folders[rel]
      for (const e of f?.entries ?? []) {
        const path = rel ? `${rel}/${e.name}` : e.name
        const dir = e.kind === "dir"
        out.push({ path, name: e.name, dir, depth, size: e.size })
        if (dir && open[path]) walk(path, depth + 1)
      }
    }
    walk("", 0)
    return out
  })

  const toggle = (r: Row) => {
    const now = !open[r.path]
    setOpen(r.path, now)
    if (now && !folders[r.path]?.entries) load(r.path)
  }

  const activate = (r: Row) => {
    setSelected(r.path)
    if (r.dir) toggle(r)
    else w.openFile(r.path)
  }

  // Reveal: open every folder above the file, load them, then select it.
  createEffect(
    on(
      () => props.reveal,
      async (path) => {
        if (!path) return
        const parts = path.split("/")
        let acc = ""
        for (const p of parts.slice(0, -1)) {
          acc = acc ? `${acc}/${p}` : p
          setOpen(acc, true)
          if (!folders[acc]?.entries) await load(acc)
        }
        setSelected(path)
        props.onRevealed()
      },
    ),
  )

  const activeIndex = createMemo(() => rows().findIndex((r) => r.path === selected()))

  /** The folder a new file or an upload goes to: the selected folder, or the selected file's. */
  const targetDir = () => {
    const s = selected()
    if (!s) return ""
    const r = rows().find((x) => x.path === s)
    if (r?.dir) return r.path
    return s.includes("/") ? s.slice(0, s.lastIndexOf("/")) : ""
  }
  const parentOf = (p: string) => (p.includes("/") ? p.slice(0, p.lastIndexOf("/")) : "")

  async function newFile(dir = targetDir(), folder = false) {
    const name = await promptText({
      title: folder ? "New folder" : "New file",
      label: `In ${dir || w.root.split("/").pop()}`,
      confirm: "Create",
      mono: true,
    })
    if (!name) return
    const rel = dir ? `${dir}/${name}` : name
    try {
      if (folder) await w.api.fs.mkdir(w.env, abs(rel))
      else await w.api.fs.write(w.env, abs(rel), { text: "" }, { overwrite: false })
      batch(() => {
        if (dir) setOpen(dir, true)
      })
      await load(dir)
      if (rel.includes("/")) await load(parentOf(rel))
      setSelected(rel)
      if (!folder) w.openFile(rel)
      w.refreshStatus()
    } catch (e) {
      w.rookery.workbench.toast({
        title: `Cannot create ${name}`,
        body: (e as Error).message,
        kind: "danger",
      })
    }
  }

  async function rename(r: Row) {
    const name = await promptText({
      title: `Rename ${r.name}`,
      label: "New name",
      value: r.name,
      confirm: "Rename",
      mono: true,
    })
    if (!name || name === r.name) return
    await move(r, parentOf(r.path) ? `${parentOf(r.path)}/${name}` : name)
  }

  async function move(r: Row, to: string) {
    try {
      await w.api.fs.rename(w.env, abs(r.path), abs(to))
      await load(parentOf(r.path))
      if (parentOf(to) !== parentOf(r.path)) await load(parentOf(to))
      setSelected(to)
      w.refreshStatus()
    } catch (e) {
      w.rookery.workbench.toast({
        title: `Cannot move ${r.name}`,
        body: (e as Error).message,
        kind: "danger",
      })
    }
  }

  async function remove(r: Row) {
    if (
      !(await confirmAction({
        title: `Delete ${r.name}?`,
        body: r.dir
          ? "The folder and everything in it are deleted on the environment."
          : "The file is deleted on the environment.",
        confirm: "Delete",
        danger: true,
      }))
    )
      return
    try {
      await w.api.fs.delete(w.env, abs(r.path), r.dir)
      await load(parentOf(r.path))
      w.refreshStatus()
    } catch (e) {
      w.rookery.workbench.toast({
        title: `Cannot delete ${r.name}`,
        body: (e as Error).message,
        kind: "danger",
      })
    }
  }

  async function download(r: Row) {
    const res = await w.api.fs.read(w.env, abs(r.path), { force: true, limit: 512 * 1024 * 1024 })
    let blob: Blob
    if (res.kind === "text") blob = new Blob([res.text], { type: "text/plain" })
    else if (res.kind === "binary" && res.base64)
      blob = new Blob([Uint8Array.from(atob(res.base64), (c) => c.charCodeAt(0))], { type: res.mime })
    else return
    const a = document.createElement("a")
    a.href = URL.createObjectURL(blob)
    a.download = r.name
    a.click()
    setTimeout(() => URL.revokeObjectURL(a.href), 10_000)
  }

  async function onUpload(files: FileList | null) {
    if (!files?.length) return
    const dir = targetDir()
    for (const f of Array.from(files)) {
      const rel = dir ? `${dir}/${f.name}` : f.name
      const bytes = new Uint8Array(await f.arrayBuffer())
      let bin = ""
      for (let i = 0; i < bytes.length; i += 0x8000)
        bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000))
      const base64 = btoa(bin)
      try {
        await w.api.fs.write(w.env, abs(rel), { base64 }, { overwrite: false })
      } catch (e: any) {
        if (
          e?.code === "CONFLICT" &&
          (await confirmAction({
            title: `Replace ${f.name}?`,
            body: `${rel} exists.`,
            confirm: "Replace",
            danger: true,
          }))
        )
          await w.api.fs.write(w.env, abs(rel), { base64 }, { overwrite: true })
        else if (e?.code !== "CONFLICT")
          w.rookery.workbench.toast({ title: `Uploading ${f.name} failed`, body: e?.message, kind: "danger" })
      }
    }
    if (dir) setOpen(dir, true)
    await load(dir)
    w.refreshStatus()
    upload.value = ""
  }

  const menuItems = (r: Row | null): MenuEntry[] => [
    { id: "newFile", label: "New file", icon: "plus" },
    { id: "newFolder", label: "New folder", icon: "folder" },
    { id: "upload", label: "Upload files", icon: "arrow-up-right" },
    ...(r
      ? ([
          { type: "separator" },
          ...(!r.dir
            ? [
                { id: "open", label: "Open", icon: "file" },
                { id: "split", label: "Open to the side", icon: "sidebar" },
                { id: "history", label: "File history", icon: "clock" },
                { id: "download", label: "Download", icon: "chevron-down" },
              ]
            : []),
          { id: "rename", label: "Rename", icon: "edit", shortcut: "F2" },
          { id: "copyPath", label: "Copy path", icon: "link" },
          ...(!r.dir ? [{ id: "copyLink", label: "Copy link", icon: "link" }] : []),
          { type: "separator" },
          { id: "delete", label: "Delete", icon: "trash", danger: true },
        ] as MenuEntry[])
      : []),
  ]

  const onMenu = async (id: string) => {
    const r = menu()?.row ?? null
    setMenu(null)
    if (id === "newFile") return newFile(r ? (r.dir ? r.path : parentOf(r.path)) : "")
    if (id === "newFolder") return newFile(r ? (r.dir ? r.path : parentOf(r.path)) : "", true)
    if (id === "upload") return upload.click()
    if (!r) return
    if (id === "open") return w.openFile(r.path)
    if (id === "split") {
      if (w.groups.length < 2) w.split()
      return w.openFile(r.path, { group: 1 })
    }
    if (id === "history")
      return w.openTab({
        id: `history:${r.path}`,
        kind: "history",
        title: `History of ${r.name}`,
        path: r.path,
      })
    if (id === "download") return download(r)
    if (id === "rename") return rename(r)
    if (id === "delete") return remove(r)
    if (id === "copyPath") return navigator.clipboard?.writeText(abs(r.path)).catch(() => {})
    if (id === "copyLink") return w.rookery.commands.run("workbench.copyLink").catch(() => {})
  }

  return (
    <div class="wb-panel" data-part="file-tree">
      <div class="wb-panel__head">
        <span class="label wb-panel__title">Files</span>
        <IconButton label="New file" icon="plus" onClick={() => newFile()} />
        <IconButton label="New folder" icon="folder" onClick={() => newFile(targetDir(), true)} />
        <IconButton label="Upload files" icon="arrow-up-right" onClick={() => upload.click()} />
        <IconButton label="Refresh" icon="activity" onClick={() => w.refresh()} />
        <IconButton
          label="Collapse all"
          icon="chevron-right"
          onClick={() =>
            setOpen(
              produce((o) => {
                for (const k of Object.keys(o)) if (k !== "") delete o[k]
              }),
            )
          }
        />
        <input
          ref={upload}
          type="file"
          multiple
          hidden
          onChange={(e) => onUpload(e.currentTarget.files)}
          data-part="upload-input"
        />
      </div>
      <Show when={folders[""]?.error}>
        <p class="body nc-muted wb-panel__note">{folders[""]!.error}</p>
      </Show>
      <div
        class="wb-tree"
        onContextMenu={(e) => {
          if ((e.target as HTMLElement).closest("[data-tree-row]")) return
          e.preventDefault()
          setMenu({ row: null, anchor: e.currentTarget })
        }}
      >
        <List
          items={rows()}
          itemHeight={ROW}
          label="Files"
          getKey={(r) => r.path}
          activeIndex={activeIndex() >= 0 ? activeIndex() : undefined}
          onActiveChange={(i) => setSelected(rows()[i]?.path ?? null)}
          onSelect={(r) => activate(r)}
        >
          {(r) => {
            const letter = () => deco().files.get(r.path) ?? (r.dir && deco().folders.has(r.path) ? "•" : "")
            const ignored = () => isIgnored(r.path, deco().ignored)
            return (
              <div
                class="wb-tree__row"
                data-tree-row={r.path}
                data-dir={r.dir ? "" : undefined}
                data-kind={r.dir ? undefined : fileKind(r.path)}
                data-status={letter() || undefined}
                data-ignored={ignored() ? "" : undefined}
                data-selected={selected() === r.path ? "" : undefined}
                data-open-file={w.activeTab()?.path === r.path ? "" : undefined}
                data-drop={dropTarget() === r.path ? "" : undefined}
                style={{ "padding-left": `calc(var(--space-2) + ${r.depth} * 14px)` }}
                title={r.path}
                draggable={true}
                onDragStart={(e) => e.dataTransfer?.setData("text/x-crow-path", r.path)}
                onDragOver={(e) => {
                  if (!r.dir) return
                  e.preventDefault()
                  setDropTarget(r.path)
                }}
                onDragLeave={() => setDropTarget(null)}
                onDrop={(e) => {
                  setDropTarget(null)
                  const from = e.dataTransfer?.getData("text/x-crow-path")
                  if (!from || !r.dir || from === r.path || r.path.startsWith(`${from}/`)) return
                  e.preventDefault()
                  const src = rows().find((x) => x.path === from)
                  if (src) move(src, `${r.path}/${src.name}`)
                }}
                onContextMenu={(e) => {
                  e.preventDefault()
                  e.stopPropagation()
                  setSelected(r.path)
                  setMenu({ row: r, anchor: e.currentTarget })
                }}
                onKeyDown={(e) => {
                  if (e.key === "F2") rename(r)
                  if (e.key === "Delete") remove(r)
                }}
              >
                <Show when={r.dir} fallback={<span class="wb-tree__chev" />}>
                  <span class="wb-tree__chev" data-open={open[r.path] ? "" : undefined}>
                    <Icon name={open[r.path] ? "chevron-down" : "chevron-right"} size="sm" />
                  </span>
                </Show>
                <Icon name={r.dir ? "folder" : "file"} size="sm" class="wb-tree__icon" />
                <span class="wb-tree__name">{r.name}</span>
                <Show when={folders[r.path]?.loading && !folders[r.path]?.entries}>
                  <span class="wb-tree__loading caption nc-muted">…</span>
                </Show>
                <span class="wb-tree__status mono">{letter()}</span>
              </div>
            )
          }}
        </List>
      </div>
      <Popover open={!!menu()} anchor={menu()?.anchor} onClose={() => setMenu(null)} placement="bottom-start">
        <Menu
          label="File actions"
          items={menuItems(menu()?.row ?? null)}
          onSelect={onMenu}
          autoFocus
          onRequestClose={() => setMenu(null)}
        />
      </Popover>
    </div>
  )
}
