// The changes of a range, file by file: a file list with viewed marks, and each file's hunks with word
// changes. Against the index or working tree, hunks and single lines are staged, unstaged or reverted from
// here. Used by the review view and by a commit's tab.
import { Badge, Button, Checkbox, diffWords, EmptyState, Icon, IconButton } from "@aiviarium/nocturne"
import { createEffect, createMemo, createResource, createSignal, For, type JSX, on, Show } from "solid-js"
import type { Api, DiffSpec } from "../api"
import {
  buildPatch,
  countChanges,
  type DiffLine,
  type FileDiff,
  filePath,
  type Hunk,
  type LineRef,
  parseDiff,
} from "../git/diff"
import { confirmAction } from "./prompt"

export interface ReviewProps {
  api: Api
  rookery: import("@rookery/sdk/client").ClientRookery
  env: string
  root: string
  spec: DiffSpec
  /** Stage, unstage and revert are offered (for unstaged and staged changes). */
  editable?: boolean
  /** Open a file in the editor at a line. */
  onOpen?: (path: string, line?: number) => void
  /** Called after the index or working tree changed. */
  onChanged?: () => void
  /** Split (side by side) or unified. */
  mode: "split" | "unified"
  /** A key for the viewed marks of this range. */
  viewedKey?: string
}

/** FNV-1a of a file's patch: a viewed mark is cleared when the file's changes change. */
function hash(s: string): string {
  let h = 0x811c9dc5
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i)
    h = Math.imul(h, 0x01000193)
  }
  return (h >>> 0).toString(36)
}

const fileText = (f: FileDiff) =>
  `${f.header.join("\n")}\n${f.hunks.map((h) => h.lines.map((l) => l.type + l.text).join("\n")).join("\n")}`

export function ReviewBody(props: ReviewProps): JSX.Element {
  const [patch, { refetch }] = createResource(
    () => ({ ...props.spec, env: props.env, root: props.root }),
    async (s) => {
      const text = await props.api.git.diff(s.env, s.root, {
        kind: s.kind,
        base: s.base,
        head: s.head,
        paths: s.paths,
      })
      let files = parseDiff(text)
      // Untracked files are part of what is not staged: show them as new files.
      if (s.kind === "unstaged" || s.kind === "worktree") {
        const st = await props.api.git.diffFiles(s.env, s.root, { kind: "unstaged" }).catch(() => [])
        for (const u of st.filter((x) => x.status === "untracked")) {
          const r = await props.api.fs
            .read(s.env, `${s.root.replace(/\/$/, "")}/${u.path}`, { limit: 512 * 1024 })
            .catch(() => null)
          const lines = r?.kind === "text" ? r.text.split("\n") : []
          if (lines[lines.length - 1] === "") lines.pop()
          files.push({
            oldPath: null,
            newPath: u.path,
            status: "added",
            binary: r?.kind !== "text",
            header: [`diff --git a/${u.path} b/${u.path}`, "new file mode 100644"],
            hunks: lines.length
              ? [
                  {
                    oldStart: 0,
                    oldLines: 0,
                    newStart: 1,
                    newLines: lines.length,
                    section: "",
                    lines: lines.map((t, i) => ({ type: "+" as const, text: t, new: i + 1 })),
                  },
                ]
              : [],
            untracked: true,
          } as FileDiff & { untracked: boolean })
        }
      }
      files = files.sort((a, b) => filePath(a).localeCompare(filePath(b)))
      return files
    },
  )
  const files = () => patch() ?? []
  const [viewed, setViewed] = createSignal<Record<string, string>>({})
  const [collapsed, setCollapsed] = createSignal<Record<string, boolean>>({})
  const [selected, setSelected] = createSignal<Record<string, Set<string>>>({})
  const [busy, setBusy] = createSignal(false)
  const [error, setError] = createSignal<string | null>(null)
  const [listOpen, setListOpen] = createSignal(true)

  createEffect(
    on(
      () => props.viewedKey,
      async (k) => {
        if (!k) return
        setViewed(
          (await props.rookery.storage
            .get<Record<string, string>>(k, { scope: "user" })
            .catch(() => undefined)) ?? {},
        )
      },
    ),
  )
  const isViewed = (f: FileDiff) => viewed()[filePath(f)] === hash(fileText(f))
  const markViewed = (f: FileDiff, on: boolean) => {
    const v = { ...viewed() }
    if (on) v[filePath(f)] = hash(fileText(f))
    else delete v[filePath(f)]
    setViewed(v)
    if (on) setCollapsed({ ...collapsed(), [filePath(f)]: true })
    if (props.viewedKey) props.rookery.storage.set(props.viewedKey, v, { scope: "user" }).catch(() => {})
  }
  const viewedCount = createMemo(() => files().filter(isViewed).length)
  const totals = createMemo(() =>
    files().reduce(
      (t, f) => {
        const c = countChanges(f)
        return { added: t.added + c.added, removed: t.removed + c.removed }
      },
      { added: 0, removed: 0 },
    ),
  )

  async function apply(f: FileDiff, refs: LineRef[] | undefined, op: "stage" | "unstage" | "revert") {
    setBusy(true)
    setError(null)
    try {
      if ((f as { untracked?: boolean }).untracked) {
        if (op === "stage") await props.api.git.stage(props.env, props.root, [filePath(f)])
        else if (op === "revert") {
          if (
            !(await confirmAction({
              title: `Delete ${filePath(f)}?`,
              body: "It is untracked: reverting deletes it.",
              confirm: "Delete",
              danger: true,
            }))
          )
            return
          await props.api.git.discard(props.env, props.root, [], [filePath(f)])
        }
      } else {
        if (
          op === "revert" &&
          !(await confirmAction({
            title: "Revert these changes?",
            body: `The working tree of ${filePath(f)} loses them. This cannot be undone.`,
            confirm: "Revert",
            danger: true,
          }))
        )
          return
        const p = buildPatch(f, refs, { reverse: op !== "stage" })
        if (!p) return
        await props.api.git.apply(props.env, props.root, p, {
          cached: op !== "revert",
          reverse: op !== "stage",
        })
      }
      setSelected({ ...selected(), [filePath(f)]: new Set() })
      props.onChanged?.()
      await refetch()
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setBusy(false)
    }
  }

  const toggleLine = (f: FileDiff, ref: LineRef) => {
    const k = `${ref.hunk}:${ref.line}`
    const cur = new Set(selected()[filePath(f)] ?? [])
    if (cur.has(k)) cur.delete(k)
    else cur.add(k)
    setSelected({ ...selected(), [filePath(f)]: cur })
  }
  const selectedRefs = (f: FileDiff): LineRef[] =>
    [...(selected()[filePath(f)] ?? [])].map((k) => {
      const [h, l] = k.split(":").map(Number)
      return { hunk: h!, line: l! }
    })

  const scrollTo = (path: string) => {
    document.querySelector(`[data-review-file="${CSS.escape(path)}"]`)?.scrollIntoView({ block: "start" })
  }

  const ops = () =>
    props.spec.kind === "staged"
      ? (["unstage"] as const)
      : props.spec.kind === "unstaged"
        ? (["stage", "revert"] as const)
        : ([] as const)

  return (
    <div class="wb-review" data-part="review" data-mode={props.mode}>
      <Show when={error()}>
        <p class="body wb-review__error" role="alert">
          {error()}
        </p>
      </Show>
      <Show
        when={!patch.loading || patch()}
        fallback={<EmptyState icon="layers" title="Reading the changes" />}
      >
        <Show
          when={files().length}
          fallback={
            <EmptyState icon="check" title="No changes" description="Nothing differs in this range." />
          }
        >
          <aside class="wb-review__files" data-open={listOpen() ? "" : undefined} aria-label="Changed files">
            <button
              type="button"
              class="wb-review__files-head label"
              onClick={() => setListOpen(!listOpen())}
            >
              <Icon name={listOpen() ? "chevron-down" : "chevron-right"} size="sm" />
              {files().length} files
              <span class="mono wb-review__plus">+{totals().added}</span>
              <span class="mono wb-review__minus">−{totals().removed}</span>
              <span class="caption nc-muted" data-part="viewed-count">
                {viewedCount()} of {files().length} viewed
              </span>
            </button>
            <Show when={listOpen()}>
              <For each={files()}>
                {(f) => {
                  const c = countChanges(f)
                  return (
                    <button
                      type="button"
                      class="wb-review__file"
                      data-file={filePath(f)}
                      data-viewed={isViewed(f) ? "" : undefined}
                      onClick={() => scrollTo(filePath(f))}
                    >
                      <span class="wb-change__letter mono" data-letter={f.status[0]!.toUpperCase()}>
                        {(f as { untracked?: boolean }).untracked
                          ? "U"
                          : f.status === "renamed"
                            ? "R"
                            : f.status[0]!.toUpperCase()}
                      </span>
                      <span class="wb-review__file-name">{filePath(f)}</span>
                      <span class="mono caption wb-review__plus">+{c.added}</span>
                      <span class="mono caption wb-review__minus">−{c.removed}</span>
                      <Show when={isViewed(f)}>
                        <Icon name="check" size="sm" />
                      </Show>
                    </button>
                  )
                }}
              </For>
            </Show>
          </aside>
          <div class="wb-review__diffs">
            <For each={files()}>
              {(f) => {
                const path = filePath(f)
                const c = countChanges(f)
                const sel = () => selected()[path]?.size ?? 0
                return (
                  <section
                    class="nc-card wb-review__card"
                    data-review-file={path}
                    data-viewed={isViewed(f) ? "" : undefined}
                  >
                    <header class="wb-review__card-head">
                      <IconButton
                        label={collapsed()[path] ? "Expand" : "Collapse"}
                        icon={collapsed()[path] ? "chevron-right" : "chevron-down"}
                        onClick={() => setCollapsed({ ...collapsed(), [path]: !collapsed()[path] })}
                      />
                      <span class="mono wb-review__path">
                        {f.status === "renamed" ? `${f.oldPath} → ${f.newPath}` : path}
                      </span>
                      <Show when={(f as { untracked?: boolean }).untracked}>
                        <Badge tone="outline">untracked</Badge>
                      </Show>
                      <span class="mono caption wb-review__plus">+{c.added}</span>
                      <span class="mono caption wb-review__minus">−{c.removed}</span>
                      <span class="wb-head__spacer" />
                      <Show when={props.editable && sel()}>
                        <For each={ops()}>
                          {(op) => (
                            <Button
                              size="sm"
                              variant={op === "revert" ? "ghost" : "secondary"}
                              disabled={busy()}
                              onClick={() => apply(f, selectedRefs(f), op)}
                              data-part={`${op}-selected`}
                            >
                              {op[0]!.toUpperCase() + op.slice(1)} {sel()} line{sel() === 1 ? "" : "s"}
                            </Button>
                          )}
                        </For>
                      </Show>
                      <Show when={props.editable}>
                        <For each={ops()}>
                          {(op) => (
                            <Button
                              size="sm"
                              variant="ghost"
                              disabled={busy()}
                              onClick={() => apply(f, undefined, op)}
                              data-part={`${op}-file`}
                            >
                              {op === "stage"
                                ? "Stage file"
                                : op === "unstage"
                                  ? "Unstage file"
                                  : "Revert file"}
                            </Button>
                          )}
                        </For>
                      </Show>
                      <Show when={props.onOpen && f.newPath}>
                        <IconButton
                          label={`Edit ${path}`}
                          icon="edit"
                          onClick={() => props.onOpen!(path, f.hunks[0]?.newStart)}
                        />
                      </Show>
                      <Checkbox label="Viewed" checked={isViewed(f)} onChange={(on) => markViewed(f, on)} />
                    </header>
                    <Show when={!collapsed()[path]}>
                      <Show
                        when={!f.binary}
                        fallback={<p class="caption nc-muted wb-panel__note">A binary file.</p>}
                      >
                        <Show
                          when={f.hunks.length}
                          fallback={
                            <p class="caption nc-muted wb-panel__note">
                              {f.status === "renamed" ? "Renamed without changes." : "Only its mode changed."}
                            </p>
                          }
                        >
                          <For each={f.hunks}>
                            {(h, hi) => (
                              <HunkView
                                hunk={h}
                                index={hi()}
                                mode={props.mode}
                                selected={selected()[path] ?? new Set()}
                                selectable={!!props.editable && ops().length > 0}
                                onToggle={(li) => toggleLine(f, { hunk: hi(), line: li })}
                                onOpen={
                                  props.onOpen && f.newPath ? (line) => props.onOpen!(path, line) : undefined
                                }
                                actions={
                                  props.editable ? (
                                    <For each={ops()}>
                                      {(op) => (
                                        <button
                                          type="button"
                                          class="wb-hunk__action caption"
                                          disabled={busy()}
                                          data-part={`${op}-hunk`}
                                          onClick={() =>
                                            apply(
                                              f,
                                              h.lines.flatMap((l, li) =>
                                                l.type === " " ? [] : [{ hunk: hi(), line: li }],
                                              ),
                                              op,
                                            )
                                          }
                                        >
                                          {op === "stage"
                                            ? "Stage hunk"
                                            : op === "unstage"
                                              ? "Unstage hunk"
                                              : "Revert hunk"}
                                        </button>
                                      )}
                                    </For>
                                  ) : undefined
                                }
                              />
                            )}
                          </For>
                        </Show>
                      </Show>
                    </Show>
                  </section>
                )
              }}
            </For>
          </div>
        </Show>
      </Show>
    </div>
  )
}

interface SplitRow {
  left?: { line: DiffLine; index: number }
  right?: { line: DiffLine; index: number }
}

/** Pairs a hunk's lines for side by side: runs of removals beside the additions that follow them. */
function splitRows(h: Hunk): SplitRow[] {
  const rows: SplitRow[] = []
  let i = 0
  while (i < h.lines.length) {
    const l = h.lines[i]!
    if (l.type === " ") {
      rows.push({ left: { line: l, index: i }, right: { line: l, index: i } })
      i++
      continue
    }
    const dels: Array<{ line: DiffLine; index: number }> = []
    const adds: Array<{ line: DiffLine; index: number }> = []
    while (i < h.lines.length && h.lines[i]!.type === "-") dels.push({ line: h.lines[i]!, index: i++ })
    while (i < h.lines.length && h.lines[i]!.type === "+") adds.push({ line: h.lines[i]!, index: i++ })
    for (let k = 0; k < Math.max(dels.length, adds.length); k++) rows.push({ left: dels[k], right: adds[k] })
  }
  return rows
}

function Words(props: { text: string; other?: string; side: "old" | "new" }) {
  const segs = () =>
    props.other === undefined
      ? null
      : diffWords(
          props.side === "old" ? props.text : props.other,
          props.side === "old" ? props.other : props.text,
        )[props.side]
  return (
    <Show when={segs()} fallback={props.text}>
      <For each={segs()!}>
        {(s) => (s.changed ? props.side === "old" ? <del>{s.text}</del> : <ins>{s.text}</ins> : s.text)}
      </For>
    </Show>
  )
}

function HunkView(props: {
  hunk: Hunk
  index: number
  mode: "split" | "unified"
  selected: Set<string>
  selectable: boolean
  onToggle: (line: number) => void
  onOpen?: (line: number) => void
  actions?: JSX.Element
}) {
  const h = props.hunk
  const isSel = (i: number) => props.selected.has(`${props.index}:${i}`)
  const cell = (
    e: { line: DiffLine; index: number } | undefined,
    pair: { line: DiffLine } | undefined,
    side: "old" | "new",
  ) => {
    if (!e) return <div class="nc-diff__line nc-diff__line--empty" />
    const l = e.line
    const kind = l.type === "+" ? "add" : l.type === "-" ? "del" : "ctx"
    return (
      <div
        class={`nc-diff__line${kind === "add" ? " nc-diff__line--add" : kind === "del" ? " nc-diff__line--del" : ""}`}
        data-selected={isSel(e.index) ? "" : undefined}
        data-line={`${props.index}:${e.index}`}
        onClick={() => props.selectable && l.type !== " " && props.onToggle(e.index)}
        onDblClick={() => props.onOpen?.(l.new ?? l.old ?? h.newStart)}
      >
        <span class="nc-diff__num">{side === "old" ? (l.old ?? "") : (l.new ?? "")}</span>
        <span class="nc-diff__sign">{l.type === " " ? "" : l.type === "+" ? "+" : "−"}</span>
        <span class="nc-diff__text">
          <Words
            text={l.text}
            other={pair && pair.line.type !== " " && l.type !== " " ? pair.line.text : undefined}
            side={side}
          />
        </span>
      </div>
    )
  }
  return (
    <div class="wb-hunk" data-hunk={props.index}>
      <div class="wb-hunk__head mono caption">
        <span>
          @@ −{h.oldStart},{h.oldLines} +{h.newStart},{h.newLines} @@ {h.section}
        </span>
        <span class="wb-head__spacer" />
        {props.actions}
      </div>
      <Show
        when={props.mode === "split"}
        fallback={
          <div class="nc-diff nc-diff--unified wb-diff-unified">
            <For each={h.lines}>
              {(l, i) => (
                <div
                  class={`nc-diff__line${l.type === "+" ? " nc-diff__line--add" : l.type === "-" ? " nc-diff__line--del" : ""}`}
                  data-selected={isSel(i()) ? "" : undefined}
                  data-line={`${props.index}:${i()}`}
                  onClick={() => props.selectable && l.type !== " " && props.onToggle(i())}
                  onDblClick={() => props.onOpen?.(l.new ?? h.newStart)}
                >
                  <span class="nc-diff__num">{l.old ?? ""}</span>
                  <span class="nc-diff__num">{l.new ?? ""}</span>
                  <span class="nc-diff__sign">{l.type === " " ? "" : l.type === "+" ? "+" : "−"}</span>
                  <span class="nc-diff__text">{l.text}</span>
                </div>
              )}
            </For>
          </div>
        }
      >
        <div class="nc-diff">
          <For each={splitRows(h)}>
            {(r) => (
              <>
                {cell(r.left, r.right, "old")}
                {cell(r.right, r.left, "new")}
              </>
            )}
          </For>
        </div>
      </Show>
    </div>
  )
}
