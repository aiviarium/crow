// A file's diff in Monaco's diff editor, side by side or inline. Against the working tree the right side is
// the file itself, editable. Hunks and selected lines are staged, unstaged or reverted with patches built
// from git's own diff and applied with git apply. Also the save conflict: what is on disk now against what
// the user tried to save, with keep mine, take theirs, or merging by hand on the right.
import { Button, Callout, EmptyState, IconButton } from "@aiviarium/nocturne"
import type * as Mon from "monaco-editor/editor/editor.api"
import { createSignal, onCleanup, onMount, Show } from "solid-js"
import { buildPatch, hunkAt, type LineRef, linesInRange, parseDiff } from "../git/diff"
import { loadMonaco, type Tab, type Workspace } from "../workspace"
import { type EditorOptions, wireEditor } from "./EditorArea"

/** The empty tree's id, for the diff of a root commit. */
export const EMPTY_TREE = "4b825dc642cb6eb9a060e54bf8d69288fbee4904"

let tmp = 0

export function DiffTab(props: { w: Workspace; tab: Tab; group: number; opts: EditorOptions }) {
  const w = props.w
  const path = props.tab.path!
  const spec = props.tab.diff!
  const editable = spec.kind === "unstaged" || spec.kind === "worktree"
  let el!: HTMLDivElement
  let diff: Mon.editor.IStandaloneDiffEditor | undefined
  let monaco: typeof Mon | undefined
  const owned: Mon.editor.ITextModel[] = []
  const [inline, setInline] = createSignal(props.opts.phone)
  const [error, setError] = createSignal<string | null>(null)
  const [busy, setBusy] = createSignal(false)
  const [empty, setEmpty] = createSignal(false)

  const show = async (ref: string) => {
    const r = await w.api.git.show(w.env, w.root, ref, path)
    return r.text ?? ""
  }

  async function sides(): Promise<{ left: string; right: Mon.editor.ITextModel | string }> {
    switch (spec.kind) {
      case "unstaged": {
        const left = await show(":")
        const exists = w.status()?.entries.find((e) => e.path === path)?.y !== "D"
        return { left, right: exists ? await w.model(path) : "" }
      }
      case "worktree":
        return { left: await show(spec.base ?? "HEAD"), right: await w.model(path) }
      case "staged":
        return { left: await show("HEAD"), right: await show(":") }
      case "commit":
      case "range":
        return { left: await show(spec.base ?? `${spec.head}^`), right: await show(spec.head ?? "HEAD") }
    }
  }

  async function load() {
    const m = await loadMonaco()
    monaco = m.monaco
    const lang = m.languageFor(path)
    const { left, right } = await sides()
    const temp = (text: string) => {
      const model = monaco!.editor.createModel(text, lang, monaco!.Uri.parse(`crow-diff:/${++tmp}/${path}`))
      owned.push(model)
      return model
    }
    const original = temp(left)
    const modified = typeof right === "string" ? temp(right) : right
    if (!diff) {
      diff = monaco.editor.createDiffEditor(el, {
        ...m.editorDefaults(),
        renderSideBySide: !inline(),
        originalEditable: false,
        readOnly: !editable,
        useInlineViewWhenSpaceIsLimited: true,
        renderSideBySideInlineBreakpoint: 560,
        renderOverviewRuler: !props.opts.phone,
        hideUnchangedRegions: { enabled: true, contextLineCount: 3, minimumLineCount: 6 },
        minimap: { enabled: false },
        wordWrap: props.opts.wordWrap as "off",
      })
      wireEditor(w, monaco, diff.getModifiedEditor(), () => (editable ? path : undefined))
      w.editors.set(props.group, { editor: () => diff?.getModifiedEditor(), kind: () => "diff" })
    }
    const old = diff.getModel()
    diff.setModel({ original, modified })
    for (const mm of [old?.original, old?.modified])
      if (mm && owned.includes(mm) && mm !== original && mm !== modified) mm.dispose()
    setEmpty(left === (typeof right === "string" ? right : right.getValue()))
    if (props.tab.line) diff.getModifiedEditor().revealLineInCenter(props.tab.line)
  }

  onMount(() => load().catch((e) => setError((e as Error).message)))
  onCleanup(() => {
    if (w.editors.get(props.group)?.editor() === diff?.getModifiedEditor()) w.editors.delete(props.group)
    diff?.dispose()
    for (const m of owned) m.dispose()
  })

  /** Stage, unstage or revert the hunk at the cursor or the selected lines. */
  async function partial(op: "stage" | "unstage" | "revert", mode: "hunk" | "lines") {
    if (!diff) return
    setBusy(true)
    setError(null)
    try {
      if (op !== "unstage" && w.isDirty(path) && !(await w.save(path))) return
      const kind = op === "unstage" ? "staged" : "unstaged"
      const untracked = w.status()?.entries.find((e) => e.path === path)?.kind === "untracked"
      if (untracked && op === "stage") {
        await w.api.git.stage(w.env, w.root, [path])
      } else {
        const files = parseDiff(await w.api.git.diff(w.env, w.root, { kind, paths: [path] }))
        const f = files[0]
        if (!f) throw new Error("git shows no difference here any more")
        const ed = diff.getModifiedEditor()
        const sel = ed.getSelection()
        const from = sel?.startLineNumber ?? 1
        const to = sel
          ? sel.endColumn === 1 && sel.endLineNumber > sel.startLineNumber
            ? sel.endLineNumber - 1
            : sel.endLineNumber
          : from
        let refs: LineRef[]
        if (mode === "hunk") {
          const h = hunkAt(f, from)
          if (h < 0) throw new Error("the cursor is not in a changed hunk")
          refs = f.hunks[h]!.lines.flatMap((l, i) => (l.type === " " ? [] : [{ hunk: h, line: i }]))
        } else {
          refs = linesInRange(f, from, to)
          if (!refs.length) throw new Error("no changed lines are selected")
        }
        const patch = buildPatch(f, refs, { reverse: op !== "stage" })
        if (!patch) throw new Error("nothing to apply")
        await w.api.git.apply(w.env, w.root, patch, { cached: op !== "revert", reverse: op !== "stage" })
      }
      await w.refreshStatus()
      if (op === "revert") await w.checkBuffers()
      await load()
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setBusy(false)
    }
  }

  return (
    <div class="wb-diff" data-part="diff-tab" data-path={path} data-kind={spec.kind}>
      <div class="wb-file__bar">
        <span class="mono caption nc-muted wb-file__path">
          {path} ·{" "}
          {spec.kind === "unstaged"
            ? "index ↔ working tree"
            : spec.kind === "staged"
              ? "HEAD ↔ index"
              : spec.kind === "worktree"
                ? `${spec.base ?? "HEAD"} ↔ working tree`
                : `${(spec.base ?? `${spec.head}^`).slice(0, 9)} ↔ ${(spec.head ?? "").slice(0, 9)}`}
        </span>
        <span class="wb-head__spacer" />
        <Show when={spec.kind === "unstaged"}>
          <Button
            size="sm"
            variant="secondary"
            loading={busy()}
            onClick={() => partial("stage", "hunk")}
            data-part="stage-hunk"
          >
            Stage hunk
          </Button>
          <Button size="sm" variant="ghost" onClick={() => partial("stage", "lines")} data-part="stage-lines">
            Stage lines
          </Button>
          <Button size="sm" variant="ghost" onClick={() => partial("revert", "hunk")} data-part="revert-hunk">
            Revert hunk
          </Button>
        </Show>
        <Show when={spec.kind === "staged"}>
          <Button
            size="sm"
            variant="secondary"
            loading={busy()}
            onClick={() => partial("unstage", "hunk")}
            data-part="unstage-hunk"
          >
            Unstage hunk
          </Button>
          <Button
            size="sm"
            variant="ghost"
            onClick={() => partial("unstage", "lines")}
            data-part="unstage-lines"
          >
            Unstage lines
          </Button>
        </Show>
        <IconButton
          label="Previous change"
          icon="chevron-right"
          class="wb-flip"
          onClick={() => diff?.goToDiff("previous")}
        />
        <IconButton label="Next change" icon="chevron-down" onClick={() => diff?.goToDiff("next")} />
        <IconButton
          label={inline() ? "Side by side" : "Inline"}
          icon="sidebar"
          pressed={!inline()}
          onClick={() => {
            setInline(!inline())
            diff?.updateOptions({ renderSideBySide: !inline() })
          }}
        />
        <Show when={editable}>
          <IconButton label="Open the file" icon="file" onClick={() => w.openFile(path)} />
        </Show>
      </div>
      <Show when={error()}>
        <Callout
          tone="danger"
          class="wb-file__banner"
          action={<IconButton label="Dismiss" icon="close" onClick={() => setError(null)} />}
        >
          {error()}
        </Callout>
      </Show>
      <Show when={empty()}>
        <p class="caption nc-muted wb-panel__note">No differences.</p>
      </Show>
      <div class="wb-monaco" ref={el} data-part="monaco-diff" />
    </div>
  )
}

/**
 * A save that found the file changed on disk. Left: what is on disk now (theirs). Right: what was being
 * saved (mine), editable, to merge by hand. Nothing is written until the user picks.
 */
export function SaveConflictTab(props: { w: Workspace; tab: Tab; group: number; opts: EditorOptions }) {
  const w = props.w
  const path = props.tab.path!
  let el!: HTMLDivElement
  let diff: Mon.editor.IStandaloneDiffEditor | undefined
  const owned: Mon.editor.ITextModel[] = []
  const c = () => w.conflicts.get(path)
  onMount(async () => {
    const m = await loadMonaco()
    const conflict = c()
    if (!conflict) return
    const lang = m.languageFor(path)
    const theirs = m.monaco.editor.createModel(
      conflict.theirs ?? "",
      lang,
      m.monaco.Uri.parse(`crow-theirs:/${++tmp}/${path}`),
    )
    const mine = m.monaco.editor.createModel(
      conflict.mine,
      lang,
      m.monaco.Uri.parse(`crow-mine:/${++tmp}/${path}`),
    )
    owned.push(theirs, mine)
    diff = m.monaco.editor.createDiffEditor(el, {
      ...m.editorDefaults(),
      renderSideBySide: !props.opts.phone,
      originalEditable: false,
      readOnly: false,
      minimap: { enabled: false },
    })
    diff.setModel({ original: theirs, modified: mine })
    w.editors.set(props.group, { editor: () => diff?.getModifiedEditor(), kind: () => "saveConflict" })
  })
  onCleanup(() => {
    if (w.editors.get(props.group)?.editor() === diff?.getModifiedEditor()) w.editors.delete(props.group)
    diff?.dispose()
    for (const m of owned) m.dispose()
  })
  return (
    <div class="wb-diff" data-part="save-conflict" data-path={path}>
      <Show
        when={c()}
        fallback={<EmptyState icon="check" title="Resolved" description="This conflict was settled." />}
      >
        <Callout
          tone="warning"
          class="wb-file__banner"
          action={
            <span class="nc-row">
              <Button
                size="sm"
                variant="primary"
                onClick={() => w.keepMine(path, diff?.getModifiedEditor().getValue())}
                data-part="keep-mine"
              >
                Keep mine
              </Button>
              <Button size="sm" onClick={() => w.takeTheirs(path)} data-part="take-theirs">
                Take theirs
              </Button>
            </span>
          }
        >
          {c()!.theirs === null && c()!.theirsSha === null
            ? `${path} was deleted on disk while you edited it.`
            : `${path} changed on disk since you opened it. Left is what is on disk now, right is yours: edit the right side to merge by hand, then keep it.`}
        </Callout>
        <div class="wb-conflict-labels caption nc-muted">
          <span>On disk (theirs)</span>
          <span>Yours</span>
        </div>
      </Show>
      <div class="wb-monaco" ref={el} data-part="monaco-diff" />
    </div>
  )
}
