// The smaller views: "My issues" across projects, a label's issues, a comment (which opens its issue),
// the import (CSV or GitHub JSON, with field mapping, run as a job with progress), the widgets and the
// editor block that lists a project's issues in any document.

import {
  Button,
  Callout,
  EmptyState,
  Icon,
  Select,
  Switch,
  TextArea,
  ViewHeader,
  Widget,
} from "@aiviarium/nocturne"
import type { ClientRookery, SpaceInfo } from "@rookery/sdk/client"
import { createEffect, createMemo, createResource, createSignal, For, onCleanup, Show } from "solid-js"
import { cycleStatus } from "../lib/cycles"
import { matches, parseQuery } from "../lib/filter"
import { guessMapping, IMPORT_FIELDS, type ImportField, parseCsv } from "../lib/importer"
import { closed, type IssueRow } from "../lib/model"
import { resolverFor } from "./filters"
import { Key, StateIcon } from "./glyphs"
import { IssuesSurface, matchContextFor, type Tab } from "./issues"
import { entitiesOf, toRookeryError } from "./sdk"
import { acquire, nameOf, type ProjectStore, today, useMe } from "./store"

// ── stores for several projects ─────────────────────────────────────────────────────────────────────

/** Stores for a set of project spaces, acquired while the caller lives. */
export function useStores(crow: ClientRookery, spaces: () => string[]) {
  const held = new Map<string, { store: ProjectStore; release: () => void }>()
  const [version, setVersion] = createSignal(0)
  createEffect(() => {
    const want = new Set(spaces())
    for (const [s, h] of held)
      if (!want.has(s)) {
        h.release()
        held.delete(s)
      }
    for (const s of want) if (!held.has(s)) held.set(s, acquire(crow, s))
    setVersion((v) => v + 1)
  })
  onCleanup(() => {
    for (const h of held.values()) h.release()
    held.clear()
  })
  const list = () => {
    version()
    return [...held.values()].map((h) => h.store)
  }
  const of = (space: string) => {
    version()
    return held.get(space)?.store ?? null
  }
  return { list, of }
}

// ── my issues ────────────────────────────────────────────────────────────────────────────────────────

export function MineView(props: {
  crow: ClientRookery
  projects: () => SpaceInfo[]
  loading: boolean
  setTitle: (t: string) => void
}) {
  const crow = props.crow
  props.setTitle("My issues")
  const me = useMe(crow)
  const stores = useStores(crow, () => props.projects().map((p) => p.id))
  const [tab, setTab] = createSignal("assigned")
  const all = createMemo(() => stores.list().flatMap((s) => s.issues()))
  const issues = createMemo(() => {
    const m = me()?.uri
    if (!m) return []
    const id = m.replace("user://", "")
    const t = tab()
    return all().filter((i) =>
      t === "assigned" ? i.assignee === m : t === "created" ? i.createdBy === id : i.followers?.includes(m),
    )
  })
  const projects = () =>
    stores.list().map((s) => ({ space: s.space, key: s.project()?.key ?? "", name: s.project()?.name ?? "" }))
  const tabs: Tab[] = [
    {
      id: "assigned",
      name: "Assigned",
      filter: { conditions: [{ field: "category", op: "is", values: ["unstarted", "started", "backlog"] }] },
    },
    { id: "created", name: "Created", filter: { conditions: [] } },
    { id: "following", name: "Following", filter: { conditions: [] } },
  ]
  return (
    <IssuesSurface
      crow={crow}
      store={null}
      issues={issues}
      storeOf={stores.of}
      lookup={{
        get states() {
          return stores.list().flatMap((s) => s.states())
        },
        get labels() {
          return stores.list().flatMap((s) => s.labels())
        },
        get cycles() {
          return stores.list().flatMap((s) => s.cycles())
        },
        userName: (id) => nameOf(crow, id),
        issue: (id) =>
          stores
            .list()
            .map((s) => s.issue(id))
            .find(Boolean),
      }}
      resolver={resolverFor(crow, null, projects())}
      fields={["category", "priority", "project", "due"]}
      tabs={tabs}
      tab={tab()}
      setTab={setTab}
      displayKey="projects.display.mine"
      head={<h1 class="heading">My issues</h1>}
      onOpen={(i) => entitiesOf(crow).open(`issue://${i.id}`)}
      canWrite={(i) => {
        const s = i ? stores.of(i.spaceId) : null
        return !i || s?.level() === "use" || s?.level() === "manage"
      }}
      matchContext={matchContextFor(me, stores.list)}
      showProject
      loading={props.loading || stores.list().some((s) => s.loading())}
    />
  )
}

// ── a label ──────────────────────────────────────────────────────────────────────────────────────────

export function LabelView(props: {
  crow: ClientRookery
  id: string
  projects: () => SpaceInfo[]
  setTitle: (t: string) => void
}) {
  const crow = props.crow
  const [label] = createResource(
    () => props.id,
    (id) => crow.data.labels.get(id),
  )
  createEffect(() => label() && props.setTitle(String((label() as any).name)))
  const stores = useStores(crow, () => props.projects().map((p) => p.id))
  const uri = `label://${props.id}`
  const issues = createMemo(() =>
    stores
      .list()
      .flatMap((s) => s.issues())
      .filter((i) => i.labels?.includes(uri)),
  )
  return (
    <div class="projects__page" data-part="label">
      <ViewHeader>
        <span class="nc-meta nc-num">{issues().length} issues</span>
      </ViewHeader>
      <div class="projects__cycles">
        <For each={issues()} fallback={<EmptyState icon="tag" title="No issues have this label" />}>
          {(i) => (
            <button
              type="button"
              class="projects__recent"
              onClick={() => entitiesOf(crow).open(`issue://${i.id}`)}
            >
              <StateIcon category={i.stateCategory} />
              <Key>{i.key}</Key>
              <span class="projects__recent-title">{i.title}</span>
            </button>
          )}
        </For>
      </div>
    </div>
  )
}

/** A comment opens its issue. */
export function CommentView(props: { crow: ClientRookery; id: string }) {
  const [where] = createResource(async () => {
    const e = await entitiesOf(props.crow).resolve(`comment://${props.id}`)
    return e?.parent ?? null
  })
  createEffect(() => {
    const p = where()
    if (p) entitiesOf(props.crow).open(p)
  })
  return (
    <Show when={where.loading} fallback={<EmptyState icon="chat" title="This comment is not available" />}>
      <span class="nc-meta projects__loading">Opening the issue…</span>
    </Show>
  )
}

// ── import ───────────────────────────────────────────────────────────────────────────────────────────

export function ImportView(props: {
  crow: ClientRookery
  space: string | null
  projects: () => SpaceInfo[]
  setTitle: (t: string) => void
}) {
  const crow = props.crow
  props.setTitle("Import issues")
  const [space, setSpace] = createSignal(
    props.space && props.projects().some((p) => p.id === props.space)
      ? props.space
      : (props.projects()[0]?.id ?? ""),
  )
  createEffect(() => {
    if (!space() && props.projects()[0]) setSpace(props.projects()[0]!.id)
  })
  const [format, setFormat] = createSignal<"csv" | "github">("csv")
  const [text, setText] = createSignal("")
  const [header, setHeader] = createSignal(true)
  const rows = createMemo(() => (format() === "csv" && text().trim() ? parseCsv(text()) : []))
  const [mapping, setMapping] = createSignal<ImportField[]>([])
  createEffect(() => {
    const h = rows()[0]
    if (h && mapping().length !== h.length)
      setMapping(header() ? guessMapping(h) : h.map(() => "ignore" as ImportField))
  })
  const [preview] = createResource(
    () => (text().trim() ? { format: format(), text: text(), mapping: mapping(), header: header() } : null),
    async (p) => {
      try {
        return {
          ok: await crow.host.call<{
            count: number
            skipped: number
            sample: Array<{ title: string; state?: string; labels: string[]; assignee?: string }>
          }>("importPreview", p),
        }
      } catch (e) {
        return { error: toRookeryError(e).message }
      }
    },
  )
  const [job, setJob] = createSignal<{
    id: string
    state: string
    done?: number
    total?: number
    lines: string[]
  } | null>(null)
  let follower: { dispose(): void } | undefined
  onCleanup(() => follower?.dispose())
  const start = async () => {
    try {
      const j = await crow.jobs.enqueue("projects.import", {
        space: space(),
        format: format(),
        text: text(),
        mapping: mapping(),
        header: header(),
      })
      setJob({ id: j.id, state: j.state, lines: [] })
      follower = await crow.jobs.follow(
        j.id,
        (it) => {
          setJob((cur) => {
            if (!cur) return cur
            const next = { ...cur, lines: [...cur.lines] }
            const p = (it.payload ?? it) as {
              progress?: { done: number; total: number }
              text?: string
              state?: string
            }
            if (p.progress) Object.assign(next, { done: p.progress.done, total: p.progress.total })
            if (p.text) next.lines.push(p.text)
            if (p.state) next.state = p.state
            return next
          })
        },
        {
          onDone(state) {
            setJob((cur) => (cur ? { ...cur, state } : cur))
          },
        },
      )
    } catch (e) {
      crow.workbench.toast({
        title: "The import did not start",
        body: toRookeryError(e).message,
        kind: "danger",
      })
    }
  }
  const readFile = async (f: File) => {
    setText(await f.text())
    if (f.name.endsWith(".json")) setFormat("github")
    else setFormat("csv")
  }
  return (
    <div class="projects__page projects__import" data-part="import">
      <ViewHeader></ViewHeader>
      <div class="projects__settings-body">
        <section class="projects__section">
          <Select
            label="Into project"
            value={space()}
            options={props.projects().map((p) => ({ value: p.id, label: p.name }))}
            onChange={setSpace}
          />
          <div class="nc-seg" role="tablist" aria-label="Format">
            <button
              type="button"
              role="tab"
              class="nc-seg__item"
              aria-selected={format() === "csv"}
              onClick={() => setFormat("csv")}
            >
              CSV
            </button>
            <button
              type="button"
              role="tab"
              class="nc-seg__item"
              aria-selected={format() === "github"}
              onClick={() => setFormat("github")}
            >
              GitHub issues (JSON)
            </button>
          </div>
          <label class="nc-btn nc-btn--secondary nc-btn--sm projects__file">
            <Icon name="file" size="sm" />
            Choose a file
            <input
              type="file"
              accept=".csv,.json,text/csv,application/json"
              class="nc-visually-hidden"
              onChange={(e) => e.currentTarget.files?.[0] && readFile(e.currentTarget.files[0])}
              data-testid="import-file"
            />
          </label>
          <TextArea
            label={
              format() === "csv"
                ? "Or paste CSV"
                : "Or paste the JSON (gh issue list --json number,title,body,state,labels,assignees)"
            }
            value={text()}
            rows={6}
            onInput={(e) => setText(e.currentTarget.value)}
            class="mono"
            data-testid="import-text"
            dictation={false}
          />
        </section>
        <Show when={format() === "csv" && rows().length}>
          <section class="projects__section" data-part="mapping">
            <span class="label">Columns</span>
            <div class="projects__switch-row">
              <Switch checked={header()} onChange={setHeader} aria-label="The first row is a header" />
              <span class="nc-meta">The first row names the columns</span>
            </div>
            <div class="projects__mapping">
              <For each={rows()[0] ?? []}>
                {(h, n) => (
                  <div class="projects__map-row">
                    <span class="mono projects__map-col">{header() ? h : `Column ${n() + 1}`}</span>
                    <Icon name="arrow-right" size="sm" />
                    <Select
                      aria-label={`Field for ${h}`}
                      value={mapping()[n()] ?? "ignore"}
                      options={IMPORT_FIELDS.map((f) => ({ value: f.id, label: f.name }))}
                      onChange={(v) =>
                        setMapping((m) => m.map((x, k) => (k === n() ? (v as ImportField) : x)))
                      }
                    />
                  </div>
                )}
              </For>
            </div>
          </section>
        </Show>
        <Show when={preview()}>
          {(p) => (
            <section class="projects__section" data-part="preview">
              <Show
                when={"error" in p()}
                fallback={
                  <>
                    <span class="label" data-testid="import-count">
                      {(p() as any).ok.count} issues to import
                      {(p() as any).ok.skipped ? `, ${(p() as any).ok.skipped} skipped` : ""}
                    </span>
                    <For each={(p() as any).ok.sample}>
                      {(s: any) => (
                        <div class="projects__recent">
                          <span class="projects__recent-title">{s.title}</span>
                          <span class="nc-meta">
                            {[s.state ?? s.category, s.assignee, ...(s.labels ?? [])]
                              .filter(Boolean)
                              .join(" · ")}
                          </span>
                        </div>
                      )}
                    </For>
                  </>
                }
              >
                <Callout tone="warning">
                  <span class="label">Not ready to import.</span> {(p() as any).error}
                </Callout>
              </Show>
            </section>
          )}
        </Show>
        <div class="nc-row">
          <Button
            variant="primary"
            icon="arrow-up-right"
            disabled={
              !space() ||
              !(preview() as any)?.ok?.count ||
              (!!job() && job()!.state !== "failed" && job()!.state !== "succeeded")
            }
            onClick={start}
            data-testid="import-start"
          >
            Import
          </Button>
        </div>
        <Show when={job()}>
          {(j) => (
            <section class="projects__section" data-part="import-job" data-state={j().state}>
              <span class="label">
                {j().state === "succeeded"
                  ? "Imported"
                  : j().state === "failed"
                    ? "The import failed"
                    : "Importing…"}
                {j().total ? ` ${j().done ?? 0} of ${j().total}` : ""}
              </span>
              <span class="nc-meter projects__import-meter">
                <span
                  style={{ width: `${j().total ? Math.round(((j().done ?? 0) / j().total!) * 100) : 0}%` }}
                />
              </span>
              <For each={j().lines.slice(-8)}>{(l) => <span class="nc-meta mono">{l}</span>}</For>
              <Show when={j().state === "succeeded"}>
                <Button
                  size="sm"
                  variant="secondary"
                  onClick={() => crow.workbench.openView("projects.issues")}
                >
                  Open the issues
                </Button>
              </Show>
            </section>
          )}
        </Show>
      </div>
    </div>
  )
}

// ── widgets ──────────────────────────────────────────────────────────────────────────────────────────

export function MyIssuesWidget(props: { crow: ClientRookery; projects: () => SpaceInfo[]; limit: number }) {
  const crow = props.crow
  const me = useMe(crow)
  const stores = useStores(crow, () => props.projects().map((p) => p.id))
  const mine = createMemo(() =>
    stores
      .list()
      .flatMap((s) => s.issues())
      .filter((i) => i.assignee === me()?.uri && !closed(i.stateCategory))
      .sort((a, b) => (a.priority || 5) - (b.priority || 5) || (a.updatedAt < b.updatedAt ? 1 : -1)),
  )
  // Nothing assigned renders nothing, so the page leaves the widget out.
  return (
    <Show when={mine().length}>
      <Widget fill title="My issues" value={String(mine().length)} data-widget-body="projects.myIssues">
        <ul class="projects__widget">
          <For each={mine().slice(0, props.limit)}>
            {(i) => (
              <li>
                <button
                  type="button"
                  class="projects__widget-row"
                  onClick={() => entitiesOf(crow).open(`issue://${i.id}`)}
                >
                  <StateIcon category={i.stateCategory} />
                  <Key>{i.key}</Key>
                  <span class="projects__recent-title">{i.title}</span>
                </button>
              </li>
            )}
          </For>
        </ul>
      </Widget>
    </Show>
  )
}

export function CycleWidget(props: {
  crow: ClientRookery
  projects: () => SpaceInfo[]
  projectKey: string
  editing: boolean
}) {
  const crow = props.crow
  const space = () => {
    const k = props.projectKey.trim().toLowerCase()
    return (k ? props.projects().find((p) => p.slug === k) : props.projects()[0])?.id
  }
  const stores = useStores(crow, () => (space() ? [space()!] : []))
  const store = () => stores.list()[0]
  const cur = () =>
    store()
      ?.cycles()
      .find((c) => cycleStatus(c, today()) === "current")
  const counts = () => {
    const c = cur()
    if (!c || !store()) return { done: 0, total: 0 }
    const list = store()!
      .issues()
      .filter((i) => i.cycle === `cycle://${c.id}` && i.stateCategory !== "cancelled")
    return { done: list.filter((i) => i.stateCategory === "completed").length, total: list.length }
  }
  const missing = () => !!props.projectKey.trim() && props.projects().length > 0 && !space()
  // No cycle running renders nothing. A project key that matches no project is the arranger's to fix: it shows
  // while editing only.
  return (
    <Show
      when={cur()}
      fallback={
        <Show when={props.editing && missing()}>
          <Widget fill title="Current cycle">
            <span class="nc-meta">No project with the key {props.projectKey.trim().toUpperCase()}.</span>
          </Widget>
        </Show>
      }
    >
      {(c) => (
        <Widget
          fill
          title={`${store()?.project()?.key} ${c().name}`}
          value={`${counts().done}/${counts().total}`}
          caption={
            <button
              type="button"
              class="projects__widget-link"
              onClick={() => entitiesOf(crow).open(`cycle://${c().id}`)}
            >
              Open the cycle
            </button>
          }
        >
          <span class="nc-meter">
            <span
              style={{
                width: `${counts().total ? Math.round((counts().done / counts().total) * 100) : 0}%`,
              }}
            />
          </span>
        </Widget>
      )}
    </Show>
  )
}

// ── the editor block ─────────────────────────────────────────────────────────────────────────────────

export function IssuesBlock(props: {
  crow: ClientRookery
  projects: () => SpaceInfo[]
  attrs: { project?: string; query?: string; limit?: number }
  setAttrs: (p: Record<string, unknown>) => void
  readOnly: boolean
}) {
  const crow = props.crow
  const space = () => props.projects().find((p) => p.slug === (props.attrs.project ?? "").toLowerCase())?.id
  const stores = useStores(crow, () => (space() ? [space()!] : []))
  const me = useMe(crow)
  const store = () => stores.list()[0]
  const shown = createMemo<IssueRow[]>(() => {
    const s = store()
    if (!s) return []
    const { filter } = parseQuery(props.attrs.query ?? "", resolverFor(crow, s))
    return s
      .issues()
      .filter((i) => matches(i, filter, { me: me()?.uri ?? null, today: today() }))
      .slice(0, props.attrs.limit ?? 10)
  })
  return (
    <div class="projects__block" data-part="issues-block" contentEditable={false}>
      <div class="projects__block-head">
        <Icon name="list" size="sm" />
        <Show when={!props.readOnly} fallback={<span class="label">{props.attrs.project || "Issues"}</span>}>
          <Select
            aria-label="Project"
            placeholder="Pick a project"
            value={(props.attrs.project ?? "").toLowerCase()}
            options={props.projects().map((p) => ({ value: p.slug, label: p.name }))}
            onChange={(v) => props.setAttrs({ project: v.toUpperCase() })}
          />
          <input
            class="nc-input projects__block-query"
            aria-label="Filter"
            placeholder="state:todo label:bug"
            value={props.attrs.query ?? ""}
            onChange={(e) => props.setAttrs({ query: e.currentTarget.value })}
          />
        </Show>
      </div>
      <For
        each={shown()}
        fallback={<span class="nc-meta">{space() ? "No issues match." : "Pick a project."}</span>}
      >
        {(i) => (
          <button
            type="button"
            class="projects__recent"
            onClick={() => entitiesOf(crow).open(`issue://${i.id}`)}
          >
            <StateIcon
              category={i.stateCategory}
              color={
                store()
                  ?.states()
                  .find((s) => s.id === i.state)?.color
              }
            />
            <Key>{i.key}</Key>
            <span class="projects__recent-title">{i.title}</span>
            <span class="nc-meta">{i.stateName}</span>
          </button>
        )}
      </For>
    </div>
  )
}
