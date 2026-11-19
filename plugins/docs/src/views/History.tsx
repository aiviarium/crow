// A page's history: its document's versions (saved by name, periodic, and before each restore), one shown as
// it was or as a diff against now (both as Markdown), restore, and naming the current state.
import { Button, DiffView, IconButton, RichTextEditor, Tabs } from "@aiviarium/nocturne"
import type { DocumentVersion } from "@rookery/sdk/client"
import { createResource, createSignal, For, type JSX, onCleanup, Show } from "solid-js"
import type { ClientRookeryWithDocs } from "../types"
import { ago } from "./api"
import { ask, confirmAsk } from "./ask"

const KIND: Record<string, string> = { named: "Saved version", auto: "Autosave", restore: "Before a restore" }

export function HistoryPanel(props: {
  rookery: ClientRookeryWithDocs
  document: string
  readOnly: boolean
  who: (principal?: string) => string
}): JSX.Element {
  const docs = props.rookery.documents
  if (!docs) {
    return (
      <div class="docs-history" data-part="history">
        <p class="nc-meta docs-panel__empty">Version history requires Rookery documents (M2b).</p>
      </div>
    )
  }
  const [versions, { refetch }] = createResource(() => docs.history(props.document))
  const timer = setInterval(() => refetch(), 15_000)
  onCleanup(() => clearInterval(timer))
  const [viewing, setViewing] = createSignal<DocumentVersion | null>(null)
  const [mode, setMode] = createSignal<"diff" | "page">("diff")
  const [then] = createResource(viewing, (v) =>
    docs.read(props.document, { version: v.id, format: "markdown" }),
  )
  const [thenJson] = createResource(
    () => (mode() === "page" ? viewing() : null),
    (v) => docs.read(props.document, { version: v.id }),
  )
  const [now, { refetch: refetchNow }] = createResource(viewing, () =>
    docs.read(props.document, { format: "markdown" }),
  )

  const save = async () => {
    const name = (
      await ask("Name this version", { placeholder: "Before the review", confirm: "Save version" })
    )?.trim()
    if (name === undefined || name === null) return
    await docs.saveVersion(props.document, name || undefined)
    refetch()
  }

  return (
    <div class="docs-history" data-part="history">
      <div class="docs-panel__bar">
        <span class="nc-meta">
          {versions()?.length ?? 0} {versions()?.length === 1 ? "version" : "versions"}
        </span>
        <Show when={!props.readOnly}>
          <IconButton label="Name this version" icon="plus" onClick={save} data-part="save-version" />
        </Show>
      </div>
      <ul class="docs-history__list" aria-label="Versions">
        <For
          each={versions()}
          fallback={
            <li class="nc-meta docs-panel__empty">
              No versions yet. One is kept every ten minutes while people edit.
            </li>
          }
        >
          {(v) => (
            <li>
              <button
                type="button"
                class="docs-history__item"
                aria-pressed={viewing()?.id === v.id}
                data-version={v.id}
                onClick={() => {
                  setViewing(viewing()?.id === v.id ? null : v)
                  refetchNow()
                }}
              >
                <span class="label docs-history__name">{v.name ?? KIND[v.kind] ?? v.kind}</span>
                <span class="nc-meta">
                  {ago(v.createdAt)} · {props.who(v.createdBy)}
                </span>
              </button>
            </li>
          )}
        </For>
      </ul>
      <Show when={viewing()}>
        {(v) => (
          <div class="docs-history__view" data-part="version-view">
            <div class="docs-panel__bar">
              <Tabs
                label="Show the version"
                items={[
                  { id: "diff", label: "Changes" },
                  { id: "page", label: "Page" },
                ]}
                value={mode()}
                onChange={(id) => setMode(id as "diff" | "page")}
              />
              <Show when={!props.readOnly}>
                <Button
                  size="sm"
                  variant="primary"
                  data-part="restore-version"
                  onClick={async () => {
                    if (
                      !(await confirmAsk("Restore this version?", {
                        description:
                          "The page goes back to how it was. The current state is kept as a version first, so this can be undone.",
                        confirm: "Restore version",
                      }))
                    )
                      return
                    await docs.restore(props.document, v().id)
                    setViewing(null)
                    refetch()
                    props.rookery.workbench.toast({
                      title: "Restored",
                      body: "The page is back to that version.",
                      kind: "success",
                    })
                  }}
                >
                  Restore
                </Button>
              </Show>
            </div>
            <Show
              when={mode() === "diff"}
              fallback={
                <Show when={thenJson()}>
                  {(c) => (
                    <RichTextEditor
                      value={c().content as never}
                      readOnly
                      variant="comment"
                      aria-label="Version"
                    />
                  )}
                </Show>
              }
            >
              <Show when={then() && now()} fallback={<span class="nc-meta">Loading…</span>}>
                <Show
                  when={then()!.markdown !== now()!.markdown}
                  fallback={<p class="nc-meta docs-panel__empty">No changes since this version.</p>}
                >
                  <DiffView
                    before={then()!.markdown ?? ""}
                    after={now()!.markdown ?? ""}
                    path="Then → now"
                    context={2}
                    data-part="version-diff"
                  />
                </Show>
              </Show>
            </Show>
          </div>
        )}
      </Show>
    </div>
  )
}
