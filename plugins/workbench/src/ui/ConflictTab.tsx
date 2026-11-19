// A merge conflict in three panes: ours (the index's stage 2) and theirs (stage 3) above, the result (the
// working file with its conflict markers) below, editable. Each conflict is taken from ours, theirs, both,
// or the base, or edited by hand; "Mark resolved" saves the result and stages it.
import { Button, Callout, IconButton } from "@aiviarium/nocturne"
import type * as Mon from "monaco-editor/editor/editor.api"
import { createSignal, onCleanup, onMount, Show } from "solid-js"
import {
  type ConflictRegion,
  hasConflictMarkers,
  parseConflicts,
  type Resolution,
  resolve,
} from "../git/conflict"
import { loadMonaco, type Tab, type Workspace } from "../workspace"
import type { EditorOptions } from "./EditorArea"

let tmp = 0

export function ConflictTab(props: { w: Workspace; tab: Tab; group: number; opts: EditorOptions }) {
  const w = props.w
  const path = props.tab.path!
  let oursEl!: HTMLDivElement
  let theirsEl!: HTMLDivElement
  let resultEl!: HTMLDivElement
  const editors: Mon.editor.IStandaloneCodeEditor[] = []
  const owned: Mon.editor.ITextModel[] = []
  let result: Mon.editor.ITextModel | undefined
  let resultEditor: Mon.editor.IStandaloneCodeEditor | undefined
  let decorations: Mon.editor.IEditorDecorationsCollection | undefined
  let monaco: typeof Mon | undefined
  const [regions, setRegions] = createSignal<ConflictRegion[]>([])
  const [current, setCurrent] = createSignal(0)
  const [error, setError] = createSignal<string | null>(null)
  const [labels, setLabels] = createSignal({ ours: "Ours", theirs: "Theirs" })

  const update = () => {
    if (!result || !monaco) return
    const r = parseConflicts(result.getValue())
    setRegions(r)
    if (current() >= r.length) setCurrent(Math.max(0, r.length - 1))
    if (r[0])
      setLabels({
        ours: `Ours (${r[0].oursLabel || "HEAD"})`,
        theirs: `Theirs (${r[0].theirsLabel || "incoming"})`,
      })
    decorations?.set(
      r.flatMap((g) => [
        {
          range: new monaco!.Range(g.start + 1, 1, g.start + g.ours.length + 1, 1),
          options: { isWholeLine: true, className: "wb-conflict-ours" },
        },
        {
          range: new monaco!.Range(g.end - g.theirs.length, 1, g.end + 1, 1),
          options: { isWholeLine: true, className: "wb-conflict-theirs" },
        },
      ]),
    )
  }

  onMount(async () => {
    try {
      const m = await loadMonaco()
      monaco = m.monaco
      const lang = m.languageFor(path)
      const [ours, theirs] = await Promise.all([
        w.api.git.show(w.env, w.root, ":2:", path),
        w.api.git.show(w.env, w.root, ":3:", path),
      ])
      const mk = (text: string | null, side: string) => {
        const model = monaco!.editor.createModel(
          text ?? "",
          lang,
          monaco!.Uri.parse(`crow-${side}:/${++tmp}/${path}`),
        )
        owned.push(model)
        return model
      }
      const base = { ...m.editorDefaults(), minimap: { enabled: false }, readOnly: true }
      editors.push(monaco.editor.create(oursEl, { ...base, model: mk(ours.text, "ours") }))
      editors.push(monaco.editor.create(theirsEl, { ...base, model: mk(theirs.text, "theirs") }))
      await w.reloadIfClean(path)
      result = await w.model(path)
      resultEditor = monaco.editor.create(resultEl, {
        ...m.editorDefaults(),
        model: result,
        minimap: { enabled: false },
      })
      editors.push(resultEditor)
      w.editors.set(props.group, { editor: () => resultEditor, kind: () => "conflict" })
      decorations = resultEditor.createDecorationsCollection()
      result.onDidChangeContent(update)
      update()
      go(0)
    } catch (e) {
      setError((e as Error).message)
    }
  })
  onCleanup(() => {
    if (w.editors.get(props.group)?.editor() === resultEditor) w.editors.delete(props.group)
    for (const e of editors) e.dispose()
    for (const m of owned) m.dispose()
  })

  const go = (i: number) => {
    const r = regions()[i]
    if (!r || !resultEditor) return
    setCurrent(i)
    resultEditor.revealLineInCenter(r.start + 1)
    resultEditor.setPosition({ lineNumber: r.start + 1, column: 1 })
  }

  const take = (how: Resolution) => {
    const r = regions()[current()]
    if (!r || !result) return
    result.pushEditOperations(
      [],
      [{ range: result.getFullModelRange(), text: resolve(result.getValue(), r, how) }],
      () => null,
    )
    queueMicrotask(() => go(Math.min(current(), regions().length - 1)))
  }

  const markResolved = async () => {
    if (!result) return
    if (hasConflictMarkers(result.getValue())) {
      setError("Conflict markers are still in the result. Resolve every conflict first.")
      return
    }
    setError(null)
    try {
      if (w.isDirty(path) && !(await w.save(path, { format: false }))) return
      await w.api.git.stage(w.env, w.root, [path])
      await w.refreshStatus()
      w.closeTab(props.tab.id, props.group)
      w.rookery.workbench.toast({ title: `${path} is resolved`, kind: "success" })
    } catch (e) {
      setError((e as Error).message)
    }
  }

  return (
    <div class="wb-conflict" data-part="merge-conflict" data-path={path}>
      <div class="wb-file__bar">
        <span class="mono caption nc-muted wb-file__path">{path}</span>
        <span class="caption" data-part="conflict-count">
          {regions().length ? `Conflict ${current() + 1} of ${regions().length}` : "No conflicts left"}
        </span>
        <IconButton
          label="Previous conflict"
          icon="chevron-right"
          class="wb-flip"
          disabled={current() <= 0}
          onClick={() => go(current() - 1)}
        />
        <IconButton
          label="Next conflict"
          icon="chevron-down"
          disabled={current() >= regions().length - 1}
          onClick={() => go(current() + 1)}
        />
        <span class="wb-head__spacer" />
        <Button
          size="sm"
          variant="ghost"
          disabled={!regions().length}
          onClick={() => take("ours")}
          data-part="accept-ours"
        >
          Accept ours
        </Button>
        <Button
          size="sm"
          variant="ghost"
          disabled={!regions().length}
          onClick={() => take("theirs")}
          data-part="accept-theirs"
        >
          Accept theirs
        </Button>
        <Button
          size="sm"
          variant="ghost"
          disabled={!regions().length}
          onClick={() => take("both")}
          data-part="accept-both"
        >
          Both
        </Button>
        <Show when={regions()[current()]?.base}>
          <Button size="sm" variant="ghost" onClick={() => take("base")}>
            Base
          </Button>
        </Show>
        <Button
          size="sm"
          variant="primary"
          disabled={regions().length > 0}
          onClick={markResolved}
          data-part="mark-resolved"
        >
          Mark resolved
        </Button>
      </div>
      <Show when={error()}>
        <Callout tone="danger" class="wb-file__banner">
          {error()}
        </Callout>
      </Show>
      <div class="wb-conflict__top">
        <div class="wb-conflict__pane">
          <span class="caption wb-conflict__label wb-conflict__label--ours">{labels().ours}</span>
          <div class="wb-monaco" ref={oursEl} />
        </div>
        <div class="wb-conflict__pane">
          <span class="caption wb-conflict__label wb-conflict__label--theirs">{labels().theirs}</span>
          <div class="wb-monaco" ref={theirsEl} />
        </div>
      </div>
      <div class="wb-conflict__pane wb-conflict__result">
        <span class="caption wb-conflict__label">Result</span>
        <div class="wb-monaco" ref={resultEl} data-part="conflict-result" />
      </div>
    </div>
  )
}
