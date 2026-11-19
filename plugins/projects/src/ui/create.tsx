// The dialog for a new issue, reachable from anywhere: the palette ("New issue"), Ctrl Alt N, `c` in a project's
// views, and the + of a group or column (which presets that group). The draft is kept in the kernel
// (crow.drafts), so closing the dialog, reloading or switching devices keeps what was typed. With a model
// set up for the fast task it suggests a cleaner title and labels, and it always looks for likely
// duplicates as the title is typed (search first; the model only ranks).

import { Button, Dialog, Icon, IconButton, RichTextEditor, Select, Switch } from "@aiviarium/nocturne"
import { type ClientRookery, plainText, type RichText } from "@rookery/sdk/client"
import { createEffect, createResource, createSignal, For, on, onCleanup, Show } from "solid-js"
import type { IssueRow } from "../lib/model"
import { createIssue, createLabel } from "./actions"
import { StateIcon } from "./glyphs"
import { WithPageLinks } from "./links"
import { type Editable, PropControl } from "./props"
import { draftsOf, entitiesOf } from "./sdk"
import { acquire, type ProjectStore } from "./store"

export interface CreatePreset {
  space?: string
  values?: Partial<Editable> & { title?: string }
}

const [request, setRequest] = createSignal<CreatePreset | null>(null)

/** Opens the dialog (in the current project, or the one named). */
export function openCreate(preset: CreatePreset = {}) {
  setRequest({ ...preset })
}

interface Draft extends Partial<Editable> {
  space?: string
  title?: string
  description?: RichText | null
  template?: string
  /** With several linked repositories: which one gets the issue too, or `local`. */
  link?: string
}

const DRAFT = "new-issue"
const EMPTY: RichText = { type: "doc", content: [{ type: "paragraph" }] }

export function CreateHost(props: {
  crow: ClientRookery
  projects: () => Array<{ id: string; name: string; slug: string }>
  /** Resolves when the list of projects has been read: it is empty until then, and not because there are none. */
  settled?: () => Promise<unknown>
}) {
  const crow = props.crow
  const [open, setOpen] = createSignal(false)
  const [draft, setDraft] = createSignal<Draft>({})
  const [store, setStore] = createSignal<ProjectStore | null>(null)
  const [more, setMore] = createSignal(false)
  const [busy, setBusy] = createSignal(false)
  const [editorKey, setEditorKey] = createSignal(0)
  let titleEl: HTMLTextAreaElement | undefined
  let release: (() => void) | undefined
  onCleanup(() => release?.())

  // Opening: the kept draft, then the preset on top (a column's state, say).
  createEffect(
    on(request, async (r) => {
      if (!r) return
      setRequest(null)
      const kept = ((await draftsOf(crow)
        .get<Draft>(DRAFT)
        .catch(() => undefined)) ?? {}) as Draft
      await props.settled?.()
      const current = crow.spaces.current()
      const projects = props.projects()
      const space =
        r.space ??
        (current && projects.some((p) => p.id === current.id) ? current.id : undefined) ??
        (kept.space && projects.some((p) => p.id === kept.space) ? kept.space : undefined) ??
        projects[0]?.id
      if (!space) {
        crow.workbench.toast({
          title: "Create a project first",
          body: "Issues live in projects.",
          kind: "info",
        })
        crow.workbench.openView("projects.home")
        return
      }
      const fromPreset = r.values ?? {}
      setDraft({
        ...(kept.space === space ? kept : { title: kept.title, description: kept.description }),
        ...fromPreset,
        space,
      })
      setEditorKey((k) => k + 1)
      setOpen(true)
      queueMicrotask(() => titleEl?.focus())
    }),
  )

  // The project's store, while the dialog shows it.
  createEffect(
    on(
      () => (open() ? draft().space : undefined),
      (space) => {
        release?.()
        release = undefined
        if (!space) return setStore(null)
        const a = acquire(crow, space)
        release = a.release
        setStore(a.store)
      },
    ),
  )

  // The repositories the project is linked to (docs/issues.md): with one, the issue is created there too;
  // with several, the dialog asks which (or none).
  const [links] = createResource(
    () => (open() ? draft().space : undefined),
    async (space) =>
      (
        await crow.host
          .call<{ links: Array<{ id: string; name: string; provider: string }> }>("sourceLinks", { space })
          .catch(() => ({ links: [] }))
      ).links,
  )
  const link = () => {
    const l = links() ?? []
    const d = draft().link
    return d && (d === "local" || l.some((x) => x.id === d)) ? d : (l[0]?.id ?? "local")
  }

  // Keep the draft in the kernel.
  let saveTimer: ReturnType<typeof setTimeout> | undefined
  const keep = (d: Draft) => {
    setDraft(d)
    if (saveTimer) clearTimeout(saveTimer)
    saveTimer = setTimeout(
      () =>
        draftsOf(crow)
          .set(DRAFT, d)
          .catch(() => {}),
      400,
    )
  }
  const patch = (p: Partial<Draft>) => keep({ ...draft(), ...p })

  const [tasks] = createResource(() =>
    crow.plugins.call<{ tasks: Array<{ task: string; available: boolean }> }>("ai", "tasks").then(
      (r) => r.tasks,
      () => [],
    ),
  )
  const canAi = () => !!tasks()?.some((t) => t.task === "fast" && t.available)
  const [suggestion, setSuggestion] = createSignal<{ title: string; labels: string[] } | null>(null)
  const [suggesting, setSuggesting] = createSignal(false)
  const suggest = async () => {
    const d = draft()
    if (!d.space || !d.title?.trim()) return
    setSuggesting(true)
    try {
      setSuggestion(
        await crow.host.call("aiSuggest", {
          space: d.space,
          title: d.title,
          description: plain(d.description),
        }),
      )
    } catch (e: any) {
      crow.workbench.toast({ title: "No suggestion", body: String(e?.message ?? e), kind: "warning" })
    } finally {
      setSuggesting(false)
    }
  }

  // Likely duplicates, a moment after the title stops changing.
  const [dupQuery, setDupQuery] = createSignal<{ space: string; title: string } | null>(null)
  let dupTimer: ReturnType<typeof setTimeout> | undefined
  createEffect(
    on(
      () => [open(), draft().space, draft().title] as const,
      ([o, space, title]) => {
        if (dupTimer) clearTimeout(dupTimer)
        if (!o || !space || (title ?? "").trim().split(/\s+/).length < 2) return setDupQuery(null)
        dupTimer = setTimeout(() => setDupQuery({ space, title: title!.trim() }), 700)
      },
    ),
  )
  const [dups] = createResource(dupQuery, (q) =>
    crow.host
      .call<{
        issues: Array<{
          uri: string
          key: string
          title: string
          stateName: string
          stateCategory: any
          reason?: string
        }>
        ranked: boolean
      }>("aiDuplicates", q)
      .catch(() => ({ issues: [], ranked: false })),
  )

  const close = () => setOpen(false)
  const submit = async () => {
    const d = draft()
    const s = store()
    if (!d.space || !d.title?.trim() || !s) return
    setBusy(true)
    // A draft save still waiting would bring the old text back.
    if (saveTimer) clearTimeout(saveTimer)
    saveTimer = undefined
    try {
      const row = (await createIssue(crow, d.space, {
        title: d.title,
        description: d.description && plain(d.description).trim() ? d.description : undefined,
        ...(d.state ? { state: d.state } : {}),
        priority: d.priority ?? 0,
        ...(d.assignee ? { assignee: d.assignee } : {}),
        ...(d.labels?.length ? { labels: d.labels } : {}),
        ...(d.estimate != null ? { estimate: d.estimate } : {}),
        ...(d.due ? { due: d.due } : {}),
        ...(d.cycle ? { cycle: d.cycle } : {}),
        ...(d.parent ? { parent: d.parent } : {}),
        ...((links()?.length ?? 0) > 1 ? { link: link() } : {}),
      })) as IssueRow
      crow.workbench.toast({ title: `Created ${row.key}`, body: row.title, kind: "success" })
      const next: Draft = more()
        ? {
            space: d.space,
            state: d.state,
            assignee: d.assignee,
            labels: d.labels,
            cycle: d.cycle,
            parent: d.parent,
            link: d.link,
          }
        : {}
      setDraft(next)
      setSuggestion(null)
      setEditorKey((k) => k + 1)
      if (saveTimer) clearTimeout(saveTimer)
      saveTimer = undefined
      if (more())
        await draftsOf(crow)
          .set(DRAFT, next)
          .catch(() => {})
      else
        await draftsOf(crow)
          .clear(DRAFT)
          .catch(() => {})
      if (more()) queueMicrotask(() => titleEl?.focus())
      else close()
    } catch (e: any) {
      crow.workbench.toast({
        title: "The issue was not created",
        body: String(e?.message ?? e),
        kind: "danger",
      })
    } finally {
      setBusy(false)
    }
  }

  const applyTemplate = (id: string) => {
    const t = store()
      ?.templates()
      .find((x) => x.id === id)
    if (!t) return patch({ template: undefined })
    patch({
      template: id,
      ...(t.title ? { title: t.title } : {}),
      ...(t.priority != null ? { priority: t.priority } : {}),
      ...(t.labels?.length ? { labels: t.labels } : {}),
      ...(t.estimate != null ? { estimate: t.estimate } : {}),
      ...(t.body ? { description: t.body as RichText } : {}),
    })
    setEditorKey((k) => k + 1)
  }

  const editable = (): Editable => ({
    state:
      draft().state ??
      store()
        ?.states()
        .find((s) => s.category === "unstarted")?.id ??
      null,
    stateCategory: null,
    priority: draft().priority ?? 0,
    assignee: draft().assignee ?? null,
    labels: draft().labels ?? [],
    estimate: draft().estimate ?? null,
    due: draft().due ?? null,
    cycle: draft().cycle ?? null,
    parent: draft().parent ?? null,
  })

  return (
    <Dialog
      open={open()}
      onClose={close}
      size="lg"
      closeOnBackdrop={false}
      label="New issue"
      title={
        <span class="projects__create-head">
          <Select
            aria-label="Project"
            value={draft().space}
            options={props.projects().map((p) => ({ value: p.id, label: p.name }))}
            onChange={(v) =>
              patch({
                space: v,
                state: undefined,
                labels: [],
                cycle: undefined,
                parent: undefined,
                link: undefined,
              })
            }
          />
          <Show when={(links()?.length ?? 0) > 1}>
            <Select
              aria-label="Repository"
              value={link()}
              options={[
                ...(links() ?? []).map((l) => ({ value: l.id, label: l.name })),
                { value: "local", label: "Only in Crow" },
              ]}
              onChange={(v) => patch({ link: v })}
              data-testid="create-repository"
            />
          </Show>
          <Icon name="chevron-right" size="sm" />
          <span>New issue</span>
        </span>
      }
      footer={
        <>
          <div class="projects__create-more">
            <Switch checked={more()} onChange={setMore} aria-label="Create more" />
            <span class="nc-meta">Create more</span>
          </div>
          <span class="projects__spacer" />
          <Button variant="ghost" onClick={close}>
            Close
          </Button>
          <Button
            variant="primary"
            kbd="Ctrl ↵"
            loading={busy()}
            disabled={!draft().title?.trim()}
            onClick={submit}
            data-testid="create-issue"
          >
            Create issue
          </Button>
        </>
      }
      data-part="create-issue"
    >
      <div
        class="projects__create"
        ref={(el) =>
          el.addEventListener("keydown", (e) => {
            if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
              e.preventDefault()
              void submit()
            }
          })
        }
      >
        <Show when={store()?.templates().length}>
          <Select
            aria-label="Template"
            placeholder="Template"
            value={draft().template}
            options={[
              { value: "", label: "No template" },
              ...store()!
                .templates()
                .map((t) => ({ value: t.id, label: t.name })),
            ]}
            onChange={applyTemplate}
          />
        </Show>
        <div class="projects__create-title">
          <textarea
            ref={titleEl}
            class="heading projects__title-input"
            rows="1"
            aria-label="Issue title"
            placeholder="Issue title"
            value={draft().title ?? ""}
            data-testid="new-title"
            onInput={(e) => patch({ title: e.currentTarget.value.replace(/\n/g, " ") })}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.metaKey && !e.ctrlKey) e.preventDefault()
            }}
          />
          <Show when={canAi()}>
            <IconButton
              icon="sparkle"
              label={suggesting() ? "Suggesting…" : "Suggest a title and labels"}
              disabled={suggesting() || !draft().title?.trim()}
              onClick={suggest}
              data-testid="ai-suggest"
            />
          </Show>
        </div>
        <Show when={suggestion()}>
          {(s) => (
            <div class="projects__suggestion" data-part="suggestion">
              <Icon name="sparkle" size="sm" />
              <span class="projects__suggestion-text">
                <span>{s().title}</span>
                <Show when={s().labels.length}>
                  <span class="nc-meta">
                    {" "}
                    ·{" "}
                    {s()
                      .labels.map(
                        (u) =>
                          store()
                            ?.labels()
                            .find((l) => `label://${l.id}` === u)?.name,
                      )
                      .filter(Boolean)
                      .join(", ")}
                  </span>
                </Show>
              </span>
              <Button
                size="sm"
                variant="accent"
                onClick={() => {
                  patch({
                    title: s().title,
                    labels: [...new Set([...(draft().labels ?? []), ...s().labels])],
                  })
                  setSuggestion(null)
                }}
              >
                Apply
              </Button>
              <IconButton icon="close" label="Dismiss" onClick={() => setSuggestion(null)} />
            </div>
          )}
        </Show>
        <Show when={editorKey()} keyed>
          {(_k) => (
            <div class="projects__create-desc">
              <WithPageLinks crow={crow}>
                <RichTextEditor
                  variant="field"
                  aria-label="Description"
                  placeholder="Add a description… Type @ to mention an issue, a doc or a person, [[ to link a page."
                  value={(draft().description ?? EMPTY) as never}
                  onChange={(doc) => patch({ description: doc as RichText })}
                />
              </WithPageLinks>
            </div>
          )}
        </Show>
        <Show when={store()}>
          {(s) => (
            <div class="projects__create-props" data-part="create-props">
              <For
                each={
                  ["state", "priority", "assignee", "labels", "estimate", "due", "cycle", "parent"] as const
                }
              >
                {(prop) => (
                  <Show
                    when={
                      prop !== "cycle" ||
                      s()
                        .cycles()
                        .some((c) => !c.closed)
                    }
                  >
                    <PropControl
                      crow={crow}
                      store={s()}
                      issue={editable()}
                      prop={prop}
                      onChange={(p) => patch(p as Partial<Draft>)}
                      onCreateLabel={(name) => createLabel(crow, s().space, name)}
                    />
                  </Show>
                )}
              </For>
            </div>
          )}
        </Show>
        <Show when={dups()?.issues.length}>
          <div class="projects__dups" data-part="duplicates">
            <span class="nc-meta">{dups()!.ranked ? "Likely duplicates" : "Similar issues"}</span>
            <For each={dups()!.issues}>
              {(d) => (
                <button
                  type="button"
                  class="projects__dup"
                  onClick={() => entitiesOf(crow).open(d.uri)}
                  title={d.reason ?? d.title}
                >
                  <StateIcon category={d.stateCategory} />
                  <span class="mono projects__key">{d.key}</span>
                  <span class="projects__dup-title">{d.title}</span>
                  <Show when={d.reason}>
                    <span class="nc-meta">{d.reason}</span>
                  </Show>
                </button>
              )}
            </For>
          </div>
        </Show>
      </div>
    </Dialog>
  )
}

const plain = (doc: RichText | null | undefined) => plainText(doc).trim()
