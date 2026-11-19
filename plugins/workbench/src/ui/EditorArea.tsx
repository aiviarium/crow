// Editor groups (one, or two side by side), each with its tabs and the active tab's view: a file in
// Monaco, an image, a diff, a save conflict, a merge conflict, a commit or the history.
import { Button, Callout, EmptyState, Icon, IconButton, Kbd, Split } from "@aiviarium/nocturne"
import type * as Mon from "monaco-editor/editor/editor.api"
import {
  createEffect,
  createMemo,
  createSignal,
  For,
  type JSX,
  Match,
  on,
  onCleanup,
  onMount,
  Show,
  Switch,
} from "solid-js"
import type { ReadResult } from "../api"
import { parseDiff } from "../git/diff"
import { age, blameBlocks } from "../git/log"
import { fileKind } from "../paths"
import { loadMonaco, type Tab, type Workspace } from "../workspace"
import { CommitTab } from "./CommitTab"
import { ConflictTab } from "./ConflictTab"
import { DiffTab, SaveConflictTab } from "./DiffTab"
import { HistoryTab } from "./HistoryTab"

export interface EditorOptions {
  blame: boolean
  minimap: boolean
  wordWrap: string
  phone: boolean
}

/** View state of each tab in each group, so switching tabs keeps the scroll position and cursor. */
const viewStates = new Map<string, Mon.editor.ICodeEditorViewState | null>()

export function EditorArea(props: { w: Workspace; onQuickOpen: () => void } & EditorOptions) {
  const w = props.w
  const opts = (): EditorOptions => ({
    blame: props.blame,
    minimap: props.minimap,
    wordWrap: props.wordWrap,
    phone: props.phone,
  })
  return (
    <div class="wb-editors" data-part="editors">
      <Show
        when={w.groups.length > 1 && !props.phone}
        fallback={<EditorGroup w={w} index={0} opts={opts()} onQuickOpen={props.onQuickOpen} />}
      >
        <Split
          orientation="horizontal"
          defaultSize={560}
          min={240}
          max={2000}
          label="Resize the editor groups"
          first={<EditorGroup w={w} index={0} opts={opts()} onQuickOpen={props.onQuickOpen} />}
          second={<EditorGroup w={w} index={1} opts={opts()} onQuickOpen={props.onQuickOpen} />}
        />
      </Show>
    </div>
  )
}

function tabIcon(t: Tab): "file" | "branch" | "clock" | "layers" | "eye" {
  if (t.kind === "commit") return "branch"
  if (t.kind === "history") return "clock"
  if (t.kind === "diff" || t.kind === "saveConflict" || t.kind === "conflict") return "layers"
  if (t.kind === "image") return "eye"
  return "file"
}

function EditorGroup(props: { w: Workspace; index: number; opts: EditorOptions; onQuickOpen: () => void }) {
  const w = props.w
  const g = () => w.groups[props.index]
  const active = () => g()?.tabs.find((t) => t.id === g()!.active)
  const changedOnDisk = (path: string) => {
    w.bufferVersion()
    return !!w.buffers.get(path)?.changedOnDisk
  }
  const deco = createMemo(() => {
    const m = new Map<string, string>()
    for (const e of w.status()?.entries ?? [])
      if (e.kind !== "ignored") m.set(e.path, e.kind === "untracked" ? "U" : e.y !== "." ? e.y : e.x)
    return m
  })
  return (
    <div
      class="wb-group"
      data-part="editor-group"
      data-group={props.index}
      data-focused={w.focused() === props.index ? "" : undefined}
      onFocusIn={() => w.setFocused(props.index)}
      onPointerDown={() => w.setFocused(props.index)}
    >
      <div class="wb-tabs" role="tablist" aria-label={`Editors ${props.index + 1}`}>
        <For each={g()?.tabs ?? []}>
          {(t) => (
            <div
              class="wb-tab"
              data-tab={t.id}
              data-kind={t.path && t.kind !== "commit" && t.kind !== "history" ? fileKind(t.path) : undefined}
              data-selected={g()?.active === t.id ? "" : undefined}
              data-dirty={t.path && t.kind === "file" && w.isDirty(t.path) ? "" : undefined}
              data-ondisk={t.path && changedOnDisk(t.path) ? "" : undefined}
              data-status={t.path && t.kind === "file" ? deco().get(t.path) : undefined}
              onAuxClick={(e) => e.button === 1 && w.closeTab(t.id, props.index)}
            >
              <button
                type="button"
                role="tab"
                aria-selected={g()?.active === t.id}
                class="wb-tab__label"
                title={t.path ?? t.title}
                onClick={() => w.setActive(t.id, props.index)}
              >
                <Icon name={tabIcon(t)} size="sm" />
                <span>{t.title}</span>
              </button>
              <span class="wb-tab__dirty" aria-hidden="true" />
              <IconButton
                label={`Close ${t.title}`}
                icon="close"
                class="wb-tab__close"
                onClick={() => w.closeTab(t.id, props.index)}
              />
            </div>
          )}
        </For>
        <span class="wb-head__spacer" />
        <Show when={props.index === 0 && w.groups.length < 2 && !props.opts.phone}>
          <IconButton label="Split the editor" icon="sidebar" onClick={() => w.split()} />
        </Show>
        <Show when={w.groups.length > 1}>
          <IconButton label="Close this group" icon="close" onClick={() => w.closeGroup(props.index)} />
        </Show>
      </div>
      <div class="wb-group__body">
        <Show
          when={active()}
          keyed
          fallback={
            <EmptyState icon="edit" title="No file open">
              <Button size="sm" onClick={props.onQuickOpen}>
                Open file <Kbd keys="mod+p" />
              </Button>
            </EmptyState>
          }
        >
          {(t) => (
            <Switch>
              <Match when={t.kind === "file"}>
                <FileEditor w={w} tab={t} group={props.index} opts={props.opts} />
              </Match>
              <Match when={t.kind === "image"}>
                <ImageView w={w} path={t.path!} />
              </Match>
              <Match when={t.kind === "diff"}>
                <DiffTab w={w} tab={t} group={props.index} opts={props.opts} />
              </Match>
              <Match when={t.kind === "saveConflict"}>
                <SaveConflictTab w={w} tab={t} group={props.index} opts={props.opts} />
              </Match>
              <Match when={t.kind === "conflict"}>
                <ConflictTab w={w} tab={t} group={props.index} opts={props.opts} />
              </Match>
              <Match when={t.kind === "commit"}>
                <CommitTab w={w} sha={t.sha!} />
              </Match>
              <Match when={t.kind === "history"}>
                <HistoryTab w={w} path={t.path} />
              </Match>
            </Switch>
          )}
        </Show>
      </div>
    </div>
  )
}

function ImageView(props: { w: Workspace; path: string }) {
  const [src, setSrc] = createSignal<string | null>(null)
  const [info, setInfo] = createSignal("")
  onMount(async () => {
    const r = await props.w.api.fs.read(props.w.env, props.w.abs(props.path))
    if (r.kind === "binary" && r.base64) {
      setSrc(`data:${r.mime};base64,${r.base64}`)
      setInfo(`${r.mime} · ${(r.size / 1024).toFixed(1)} KB`)
    } else if (r.kind === "text") {
      setSrc(`data:image/svg+xml;charset=utf-8,${encodeURIComponent(r.text)}`)
      setInfo(`SVG · ${(r.size / 1024).toFixed(1)} KB`)
    }
  })
  return (
    <div class="wb-image" data-part="image-view">
      <Show when={src()} fallback={<EmptyState icon="eye" title="Loading the image" />}>
        <img src={src()!} alt={props.path} />
        <span class="caption nc-muted">{info()}</span>
      </Show>
    </div>
  )
}

/** Applies the shared editor options and the workspace's commands to an editor. */
export function wireEditor(
  w: Workspace,
  monaco: typeof Mon,
  editor: Mon.editor.IStandaloneCodeEditor,
  path: () => string | undefined,
) {
  editor.addAction({
    id: "rookery.save",
    label: "Save",
    keybindings: [monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyS],
    run: () => {
      const p = path()
      if (p) w.save(p)
    },
  })
  editor.addAction({
    id: "rookery.quickOpen",
    label: "Open file by name",
    keybindings: [monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyP],
    run: () => w.rookery.commands.run("workbench.quickOpen"),
  })
}

function FileEditor(props: { w: Workspace; tab: Tab; group: number; opts: EditorOptions }) {
  const w = props.w
  const path = props.tab.path!
  const key = `${props.group}:${props.tab.id}`
  let el!: HTMLDivElement
  let editor: Mon.editor.IStandaloneCodeEditor | undefined
  let monaco: typeof Mon | undefined
  const [state, setState] = createSignal<"loading" | "ready" | ReadResult | { error: string }>("loading")
  const [preview, setPreview] = createSignal(false)
  const [markdown, setMarkdown] = createSignal("")
  const isMarkdown = /\.(md|markdown|mdx)$/i.test(path)
  const buffer = () => {
    w.bufferVersion()
    return w.buffers.get(path)
  }

  async function mount(force = false) {
    const m = await loadMonaco()
    monaco = m.monaco
    try {
      let model = w.getModel(path)
      if (!model && force) {
        const r = await w.api.fs.read(w.env, w.abs(path), { force: true, limit: 2 * 1024 * 1024 * 1024 })
        if (r.kind !== "text") throw Object.assign(new Error(r.kind), { result: r })
        model = await w.model(path, { text: r.text, sha256: r.sha256, readonly: true })
      }
      model ??= await w.model(path)
      setState("ready")
      editor = monaco.editor.create(el, {
        ...m.editorDefaults(),
        model,
        readOnly: !!w.buffers.get(path)?.readonly,
        minimap: { enabled: props.opts.minimap && !props.opts.phone, renderCharacters: false },
        wordWrap: props.opts.wordWrap as "off" | "on" | "bounded",
        lineNumbers: "on",
        glyphMargin: false,
        folding: !props.opts.phone,
      })
      const vs = viewStates.get(key)
      if (vs) editor.restoreViewState(vs)
      reveal()
      editor.focus()
      wireEditor(w, monaco, editor, () => path)
      w.editors.set(props.group, { editor: () => editor, kind: () => "file" })
      w.formatter = async (p: string) => {
        const target = [...w.editors.values()]
          .map((e) => e.editor())
          .find((e) => e?.getModel?.()?.uri.toString() === w.getModel(p)?.uri.toString())
        await target?.getAction?.("editor.action.formatDocument")?.run()
      }
      if (isMarkdown) {
        setMarkdown(model.getValue())
        model.onDidChangeContent(() => setMarkdown(model!.getValue()))
      }
      applyBlame()
      applyGutter()
    } catch (e: any) {
      if (e?.result) setState(e.result)
      else setState({ error: e?.message ?? String(e) })
    }
  }

  const reveal = () => {
    if (!editor || !props.tab.line) return
    const line = props.tab.line
    const col = props.tab.col ?? 1
    editor.revealLineInCenter(line)
    editor.setPosition({ lineNumber: line, column: col })
  }

  onMount(() => mount())
  createEffect(on(() => [props.tab.line, props.tab.col], reveal, { defer: true }))
  createEffect(
    on(
      () => [props.opts.minimap, props.opts.wordWrap] as const,
      ([minimap, wordWrap]) =>
        editor?.updateOptions({
          minimap: { enabled: minimap && !props.opts.phone },
          wordWrap: wordWrap as "off",
        }),
      { defer: true },
    ),
  )

  // Blame in the gutter: who changed each block of lines and when, from git blame of the saved file.
  let blameHover: Mon.IDisposable | undefined
  let blameClick: Mon.IDisposable | undefined
  async function applyBlame() {
    if (!editor || !monaco) return
    blameHover?.dispose()
    blameClick?.dispose()
    if (!props.opts.blame || !w.info.isRepo) {
      editor.updateOptions({ lineNumbers: "on", lineNumbersMinChars: 5 })
      el.removeAttribute("data-blame")
      return
    }
    try {
      const b = await w.api.git.blame(w.env, w.root, path)
      const starts = new Map<number, string>()
      for (const block of blameBlocks(b)) {
        const c = b.commits[block.sha]!
        const who = c.uncommitted ? "You" : c.author.split(" ")[0]!
        starts.set(
          block.start,
          `${who.slice(0, 10).padEnd(10)} ${(c.uncommitted ? "not committed" : age(c.time)).padEnd(14)}`,
        )
      }
      editor.updateOptions({
        lineNumbersMinChars: 32,
        lineNumbers: (n: number) => `${(starts.get(n) ?? "").padEnd(26)}${String(n).padStart(5)}`,
      })
      el.setAttribute("data-blame", "")
      const uri = editor.getModel()?.uri
      blameHover = monaco.languages.registerHoverProvider("*", {
        provideHover(model, pos) {
          if (model.uri.toString() !== uri?.toString()) return null
          const sha = b.lines[pos.lineNumber - 1]
          const c = sha ? b.commits[sha] : null
          if (!c || pos.column > 2) return null
          return {
            range: new monaco!.Range(pos.lineNumber, 1, pos.lineNumber, 1),
            contents: [
              {
                value: c.uncommitted
                  ? "**Not committed yet**"
                  : `**${c.summary}**\n\n${c.author} · ${age(c.time)} · \`${c.sha.slice(0, 7)}\``,
              },
            ],
          }
        },
      })
      blameClick = editor.onMouseDown((e) => {
        if (e.target.type !== monaco!.editor.MouseTargetType.GUTTER_LINE_NUMBERS) return
        const sha = b.lines[(e.target.position?.lineNumber ?? 0) - 1]
        const c = sha ? b.commits[sha] : null
        if (c && !c.uncommitted)
          w.openTab({ id: `commit:${c.sha}`, kind: "commit", title: c.sha.slice(0, 7), sha: c.sha })
      })
    } catch (e) {
      w.rookery.workbench.toast({
        title: "No blame for this file",
        body: (e as Error).message,
        kind: "warning",
      })
    }
  }
  createEffect(
    on(
      () => props.opts.blame,
      () => applyBlame(),
      { defer: true },
    ),
  )

  // Lines changed against HEAD, marked in the gutter (from git's diff of the saved file).
  let gutter: Mon.editor.IEditorDecorationsCollection | undefined
  async function applyGutter() {
    if (!editor || !monaco || !w.info.isRepo) return
    const entry = w.status()?.entries.find((e) => e.path === path)
    if (!entry || entry.kind === "untracked" || entry.kind === "ignored") {
      gutter?.clear()
      return
    }
    const patch = await w.api.git
      .diff(w.env, w.root, { kind: "worktree", base: "HEAD", paths: [path], context: 0 })
      .catch(() => "")
    const f = parseDiff(patch)[0]
    const marks: Mon.editor.IModelDeltaDecoration[] = []
    for (const h of f?.hunks ?? []) {
      const added = h.lines.filter((l) => l.type === "+")
      const removed = h.lines.some((l) => l.type === "-")
      for (const l of added)
        marks.push({
          range: new monaco.Range(l.new!, 1, l.new!, 1),
          options: {
            isWholeLine: true,
            linesDecorationsClassName: removed ? "wb-gutter-modified" : "wb-gutter-added",
          },
        })
      if (removed && !added.length) {
        const at = Math.max(1, h.newStart)
        marks.push({
          range: new monaco.Range(at, 1, at, 1),
          options: { isWholeLine: true, linesDecorationsClassName: "wb-gutter-deleted" },
        })
      }
    }
    gutter ??= editor.createDecorationsCollection()
    gutter.set(marks)
  }
  createEffect(
    on(
      () => w.status(),
      () => applyGutter(),
    ),
  )

  onCleanup(() => {
    if (editor) viewStates.set(key, editor.saveViewState())
    blameHover?.dispose()
    blameClick?.dispose()
    if (w.editors.get(props.group)?.editor() === editor) w.editors.delete(props.group)
    editor?.dispose()
  })

  const ondisk = () => buffer()?.changedOnDisk
  const compare = async () => {
    const r = await w.api.fs.read(w.env, w.abs(path))
    w.conflicts.set(path, {
      path,
      mine: w.getModel(path)?.getValue() ?? "",
      theirs: r.kind === "text" ? r.text : null,
      theirsSha: r.kind === "text" || r.kind === "binary" ? r.sha256 : null,
    })
    w.openTab({
      id: `saveConflict:${path}`,
      kind: "saveConflict",
      title: `${path.split("/").pop()} (changed on disk)`,
      path,
    })
  }

  return (
    <div class="wb-file" data-part="file-editor" data-path={path}>
      <div class="wb-file__bar">
        <span class="mono caption nc-muted wb-file__path">{path}</span>
        <Show when={buffer()?.dirty}>
          <span class="caption wb-file__state" data-part="unsaved">
            Unsaved
          </span>
        </Show>
        <span class="wb-head__spacer" />
        <Show when={isMarkdown}>
          <Button
            size="sm"
            variant="ghost"
            icon="eye"
            aria-pressed={preview()}
            onClick={() => setPreview(!preview())}
          >
            Preview
          </Button>
        </Show>
        <IconButton
          label="Go to line"
          icon="arrow-right"
          onClick={() => editor?.getAction("editor.action.gotoLine")?.run()}
        />
        <IconButton
          label="Find and replace"
          icon="search"
          onClick={() => editor?.getAction("editor.action.startFindReplaceAction")?.run()}
        />
        <IconButton
          label="Format"
          icon="edit"
          onClick={() => editor?.getAction("editor.action.formatDocument")?.run()}
        />
        <IconButton
          label="Blame"
          icon="user"
          pressed={props.opts.blame}
          onClick={() => w.rookery.commands.run("workbench.toggleBlame")}
        />
        <IconButton
          label="History of the file"
          icon="clock"
          onClick={() =>
            w.openTab({
              id: `history:${path}`,
              kind: "history",
              title: `History of ${path.split("/").pop()}`,
              path,
            })
          }
        />
        <IconButton label="Save" icon="check" disabled={!buffer()?.dirty} onClick={() => w.save(path)} />
      </div>
      <Show when={ondisk()}>
        <Callout
          tone="warning"
          class="wb-file__banner"
          data-part="changed-on-disk"
          action={
            <span class="nc-row">
              <Button size="sm" onClick={compare}>
                Compare
              </Button>
              <Button size="sm" variant="ghost" onClick={() => w.takeTheirs(path)}>
                Take theirs
              </Button>
            </span>
          }
        >
          {ondisk()!.sha
            ? "This file changed on disk since you started editing it. Saving will ask which version to keep."
            : "This file was deleted on disk."}
        </Callout>
      </Show>
      <Show when={buffer()?.reloaded}>
        <Callout
          tone="info"
          class="wb-file__banner"
          data-part="reloaded"
          action={
            <IconButton
              label="Dismiss"
              icon="close"
              onClick={() => {
                const b = w.buffers.get(path)
                if (b) b.reloaded = false
                w.refreshStatus()
              }}
            />
          }
        >
          Reloaded: the file changed on disk.
        </Callout>
      </Show>
      <div class="wb-file__body">
        <Switch>
          <Match when={state() === "loading"}>
            <EmptyState icon="file" title={`Loading ${path.split("/").pop()}`} />
          </Match>
          <Match when={typeof state() === "object" && (state() as ReadResult).kind === "large"}>
            <EmptyState
              icon="file"
              title="A large file"
              description={`${((state() as { size: number }).size / 1048576).toFixed(1)} MB: more than the editor opens by default.`}
            >
              <Button
                onClick={() => {
                  setState("loading")
                  mount(true)
                }}
              >
                Open it read-only
              </Button>
            </EmptyState>
          </Match>
          <Match when={typeof state() === "object" && (state() as ReadResult).kind === "binary"}>
            <EmptyState
              icon="file"
              title="A binary file"
              description={`${(((state() as { size: number }).size ?? 0) / 1024).toFixed(1)} KB, ${(state() as { mime?: string }).mime ?? "not text"}. Download it from the tree.`}
            />
          </Match>
          <Match when={typeof state() === "object" && "error" in (state() as object)}>
            <EmptyState
              icon="file"
              title="This file cannot be opened"
              description={(state() as { error: string }).error}
            />
          </Match>
        </Switch>
        <div class="wb-file__panes" hidden={state() !== "ready"}>
          <div class="wb-monaco" ref={el} data-part="monaco" />
          <Show when={preview()}>
            <MarkdownPreview text={markdown()} />
          </Show>
        </div>
      </div>
    </div>
  )
}

function MarkdownPreview(props: { text: string }): JSX.Element {
  const [html, setHtml] = createSignal("")
  createEffect(
    on(
      () => props.text,
      async (t) => {
        const m = await import("../monaco")
        setHtml(m.renderMarkdown(t))
      },
    ),
  )
  return <article class="wb-markdown body" data-part="markdown-preview" innerHTML={html()} />
}
