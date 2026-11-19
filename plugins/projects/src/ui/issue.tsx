// An issue: its title and description (a collaborative document, edited together), sub-issues, relations,
// everything that links to it (docs that mention it, agent sessions started on it, pull requests and
// branches, any entity, grouped by type, from the reference index), and the activity timeline: field
// changes from the collection's history, comments, and links as they were made. Properties sit in a side
// panel. The path is the issue's id or its key (`/crow/projects/issue/CROW-12`).

import {
  Avatar,
  Button,
  ContextMenu,
  DiffView,
  DropdownMenu,
  EmptyState,
  Icon,
  IconButton,
  RichTextEditor,
  ViewHeader,
  ViewLayout,
} from "@aiviarium/nocturne"
import { type ClientRookery, plainText, type RichText } from "@rookery/sdk/client"
import {
  createEffect,
  createMemo,
  createResource,
  createSignal,
  For,
  type JSX,
  on,
  onCleanup,
  Show,
} from "solid-js"
import { parseIssueKey } from "../lib/keys"
import { type CommentRow, type IssueRow, priorityName, type RelationKind, relationLabel } from "../lib/model"
import type { IssueSource } from "../lib/source"
import {
  type FieldChange,
  historyItems,
  isOwnBookkeeping,
  linkGroup,
  mergeTimeline,
  type TimelineItem,
} from "../lib/timeline"
import { createLabel, updateIssues } from "./actions"
import { AgentDialog, STATE_WORDS, sessionState } from "./agent"
import { Key, Person, StateIcon } from "./glyphs"
import { WithPageLinks } from "./links"
import { Picker } from "./picker"
import { formatDay, type Prop, PropControl } from "./props"
import { type DocumentSession, documentsOf, draftsOf, EntityChip, entitiesOf, workbenchShare } from "./sdk"
import { OpenAtSource, SourceNotice, SourcePeople, useSourceKinds } from "./source"
import { acquire, nameOf, type ProjectStore, useMe } from "./store"

const REACTIONS = ["👍", "🎉", "❤️", "👀", "🚀", "😄"]
const EMPTY: RichText = { type: "doc", content: [{ type: "paragraph" }] }

export function ago(iso: string): string {
  const s = Math.max(0, (Date.now() - Date.parse(iso)) / 1000)
  if (s < 60) return "just now"
  if (s < 3600) return `${Math.floor(s / 60)} min ago`
  if (s < 86400) return `${Math.floor(s / 3600)} h ago`
  if (s < 86400 * 7) return `${Math.floor(s / 86400)} d ago`
  return new Date(iso).toLocaleDateString()
}

const GROUP_TITLE: Record<string, string> = {
  doc: "Docs",
  note: "Notes",
  session: "Agent sessions",
  "gh-pr": "Pull requests",
  "gh-issue": "GitHub issues",
  "gh-repo": "Repositories",
  branch: "Branches",
  "sub-issue": "Sub-issues",
  issue: "Issues",
  comment: "Comments",
  dashboard: "Dashboards",
  issueview: "Views",
}

/** Resolves the view's path (an id or a key) to the issue's id and space. */
export function IssueView(props: {
  crow: ClientRookery
  path: string
  space: string | null
  setTitle: (t: string) => void
  /** Marks the tab while the description has edits the kernel has not confirmed. */
  setDirty?: (dirty: boolean) => void
}) {
  const crow = props.crow
  const [where] = createResource(
    () => props.path,
    async (path) => {
      const key = parseIssueKey(decodeURIComponent(path))
      if (key)
        return crow.host.call<{ id: string; space: string } | null>("resolveKey", {
          key: `${key.project}-${key.number}`,
        })
      const e = await entitiesOf(crow).resolve(`issue://${path}`)
      return e?.spaceId
        ? { id: e.id, space: e.spaceId }
        : props.space
          ? { id: path, space: props.space }
          : null
    },
  )
  return (
    <Show
      when={where()}
      keyed
      fallback={
        <Show when={!where.loading}>
          <EmptyState
            icon="list"
            title="This issue is not available"
            description="It was deleted, or it is not shared with you."
          />
        </Show>
      }
    >
      {(w) => (
        <IssuePage
          crow={crow}
          id={w.id}
          space={w.space}
          setTitle={props.setTitle}
          setDirty={props.setDirty}
        />
      )}
    </Show>
  )
}

function IssuePage(props: {
  crow: ClientRookery
  id: string
  space: string
  setTitle: (t: string) => void
  setDirty?: (dirty: boolean) => void
}) {
  const crow = props.crow
  const { store, release } = acquire(crow, props.space)
  onCleanup(release)
  const me = useMe(crow)
  const sourceKind = useSourceKinds(crow)
  const uri = `issue://${props.id}`
  const issue = () => store.issue(props.id)
  const canWrite = () => store.level() === "use" || store.level() === "manage" || !!me()?.admin
  createEffect(() => {
    const i = issue()
    if (i) props.setTitle(`${i.key} ${i.title}`)
  })

  // ── title ─────────────────────────────────────────────────────────────────────────────────────────
  const [title, setTitle] = createSignal("")
  const [editingTitle, setEditingTitle] = createSignal(false)
  createEffect(
    on(
      () => issue()?.title,
      (t) => !editingTitle() && t !== undefined && setTitle(t),
    ),
  )
  const saveTitle = () => {
    setEditingTitle(false)
    const i = issue()
    const t = title().trim()
    if (i && t && t !== i.title) void updateIssues(crow, () => store, [i], { title: t })
    else if (i) setTitle(i.title)
  }
  const change = (patch: Partial<IssueRow>) => {
    const i = issue()
    if (i) void updateIssues(crow, () => store, [i], patch as never)
  }

  // ── comments, history, links ──────────────────────────────────────────────────────────────────────
  const comments = crow.data
    .space(props.space)
    .comments.live({ where: { issue: uri }, orderBy: ["createdAt"], limit: 1000 })
  const [tick, setTick] = createSignal(0)
  const poll = setInterval(() => setTick((t) => t + 1), 4000)
  onCleanup(() => clearInterval(poll))
  const [history] = createResource(
    () => [issue()?.rev, tick() % 4 === 0 ? tick() : 0] as const,
    () =>
      crow.data
        .space(props.space)
        .issues.history(props.id, { limit: 300 })
        .catch(() => []),
  )
  const [backlinks] = createResource(
    () => [issue()?.rev, tick()] as const,
    () => crow.data.refs.to(uri).catch(() => []),
  )
  const [outgoing] = createResource(
    () => issue()?.links?.join(","),
    async () => (await crow.data.refs.from(uri).catch(() => [])).filter((r) => r.field === "links"),
  )
  const [relations, { refetch: refetchRelations }] = createResource(
    () => [issue()?.rev, tick() % 2] as const,
    async () =>
      (
        await crow.host
          .call<{
            relations: Array<{
              id: string
              spaceId: string
              source: string
              target: string
              kind: RelationKind
            }>
          }>("relations", { space: props.space, id: props.id })
          .catch(() => ({ relations: [] }))
      ).relations,
  )
  const links = createMemo(() => (backlinks.latest ?? []).filter((b) => !isOwnBookkeeping(b, uri)))
  const grouped = createMemo(() => {
    const m = new Map<
      string,
      Array<{ uri: string; title: string; subtitle?: string | null; at?: string; outgoing?: boolean }>
    >()
    for (const b of links()) {
      const g = linkGroup(b.source, b.field)
      if (g === "sub-issue") continue
      const list = m.get(g) ?? []
      if (!list.some((x) => x.uri === b.source))
        list.push({ uri: b.source, title: b.title ?? b.source, subtitle: b.subtitle, at: b.at })
      m.set(g, list)
    }
    for (const r of outgoing.latest ?? []) {
      const g = linkGroup(r.target, "")
      const list = m.get(g) ?? []
      if (!list.some((x) => x.uri === r.target))
        list.push({ uri: r.target, title: r.title ?? r.target, outgoing: true })
      m.set(g, list)
    }
    return [...m.entries()].sort((a, b) => a[0].localeCompare(b[0]))
  })
  const subs = createMemo(() =>
    store
      .issues()
      .filter((i) => i.parent === uri)
      .sort((a, b) => ((a.rank ?? "") < (b.rank ?? "") ? -1 : 1)),
  )

  const timeline = createMemo<TimelineItem[]>(() =>
    mergeTimeline(
      // An issue from a source was created when it was created there, not when it came in.
      historyItems((history.latest ?? []) as never).map((h) => {
        const at = (issue()?.source as (IssueSource & { createdAt?: string }) | null | undefined)?.createdAt
        return h.kind === "created" && at ? { ...h, at } : h
      }),
      (comments() as unknown as CommentRow[]).map((c) => ({
        kind: "comment" as const,
        // A comment from the source is placed when it was written there, not when it came in.
        at: c.origin?.createdAt ?? c.createdAt,
        id: c.id,
      })),
      ((issue()?.source as IssueSource | null | undefined)?.conflicts ?? []).map((x) => ({
        kind: "conflict" as const,
        at: x.at,
        provider: (issue()!.source as IssueSource).provider,
        field: x.field,
        won: x.won,
        lost: x.lost,
        kept: x.kept,
      })),
      links()
        .filter((b) => b.at && linkGroup(b.source, b.field) !== "sub-issue")
        .map((b) => ({ kind: "link" as const, at: b.at, source: b.source, field: b.field })),
    ),
  )

  // ── description ───────────────────────────────────────────────────────────────────────────────────
  const [doc] = createResource(
    () => issue()?.id,
    async () =>
      issue()?.document
        ? { id: issue()!.document! }
        : await crow.host
            .call<{ id: string } | null>("issueDocument", { space: props.space, id: props.id })
            .catch(() => null),
  )
  const documentId = () => issue()?.document ?? doc()?.id

  // ── comment composer ──────────────────────────────────────────────────────────────────────────────
  const draftId = `comment:${props.id}`
  const [reply, setReply] = createSignal<RichText>(EMPTY)
  const [replyKey, setReplyKey] = createSignal(0)
  const [sending, setSending] = createSignal(false)
  void draftsOf(crow)
    .get<RichText>(draftId)
    .then((d) => {
      if (d && plainText(d).trim()) {
        setReply(d)
        setReplyKey((k) => k + 1)
      }
    })
  let draftTimer: ReturnType<typeof setTimeout> | undefined
  const onReply = (d: RichText) => {
    setReply(d)
    if (draftTimer) clearTimeout(draftTimer)
    draftTimer = setTimeout(
      () =>
        draftsOf(crow)
          .set(draftId, d)
          .catch(() => {}),
      500,
    )
  }
  const send = async () => {
    const body = reply()
    if (!plainText(body).trim() && !JSON.stringify(body).includes('"mention"')) return
    setSending(true)
    try {
      await crow.host.call("comment", { space: props.space, issue: uri, body })
      setReply(EMPTY)
      setReplyKey((k) => k + 1)
      if (draftTimer) clearTimeout(draftTimer)
      await draftsOf(crow)
        .clear(draftId)
        .catch(() => {})
    } catch (e: any) {
      crow.workbench.toast({
        title: "The comment was not sent",
        body: String(e?.message ?? e),
        kind: "danger",
      })
    } finally {
      setSending(false)
    }
  }

  // ── AI summary ───────────────────────────────────────────────────────────────────────────────────
  const [tasks] = createResource(() =>
    crow.plugins.call<{ tasks: Array<{ task: string; available: boolean }> }>("ai", "tasks").then(
      (r) => r.tasks,
      () => [],
    ),
  )
  const canAi = () => !!tasks()?.some((t) => t.task === "fast" && t.available)
  const [summary, setSummary] = createSignal<string[] | null>(null)
  const [summarizing, setSummarizing] = createSignal(false)
  const summarize = async () => {
    setSummarizing(true)
    try {
      setSummary(
        (await crow.host.call<{ points: string[] }>("aiSummarize", { space: props.space, id: props.id }))
          .points,
      )
    } catch (e: any) {
      crow.workbench.toast({ title: "No summary", body: String(e?.message ?? e), kind: "warning" })
    } finally {
      setSummarizing(false)
    }
  }

  // ── keys: s a l p on the page ────────────────────────────────────────────────────────────────────
  const [openProp, setOpenProp] = createSignal<{ prop: Prop; n: number }>({ prop: "state", n: 0 })
  const signal = (p: Prop) => () => (openProp().prop === p ? openProp().n : 0)
  let _root!: HTMLDivElement
  const onKey = (e: KeyboardEvent) => {
    if (
      (e.target as HTMLElement).closest(
        "input, textarea, [contenteditable=true], [role=dialog], .projects__picker",
      )
    )
      return
    if (e.metaKey || e.ctrlKey || e.altKey) return
    const map: Record<string, Prop> = { s: "state", a: "assignee", l: "labels", p: "priority", e: "estimate" }
    const p = map[e.key]
    if (!p || !canWrite()) return
    e.preventDefault()
    setOpenProp((o) => ({ prop: p, n: o.n + 1 }))
  }

  const [agentOpen, setAgentOpen] = createSignal(false)
  const [relating, setRelating] = createSignal<RelationKind | null>(null)
  let relateBtn: HTMLButtonElement | undefined
  const [newSub, setNewSub] = createSignal("")
  const addSub = async () => {
    const t = newSub().trim()
    if (!t) return
    setNewSub("")
    try {
      await crow.host.call("createIssue", {
        space: props.space,
        title: t,
        parent: uri,
        ...(issue()?.cycle ? { cycle: issue()!.cycle } : {}),
      })
    } catch (e: any) {
      crow.workbench.toast({ title: "No sub-issue created", body: String(e?.message ?? e), kind: "danger" })
    }
  }
  const following = () => !!me() && !!issue()?.followers?.includes(me()!.uri)

  // Where the issue is (its project; the tab has its key and title) and its actions in the standard order.
  const header = (i: () => IssueRow) => (
    <ViewHeader
      crumbs={[
        {
          label: store.project()?.name ?? "Project",
          onClick: () => crow.workbench.openView("projects.issues"),
        },
      ]}
      actions={[
        ...((i().source as IssueSource | null | undefined)?.url
          ? [
              {
                id: "open-at-source",
                label: `Open on ${sourceKind((i().source as IssueSource).provider).title}`,
                icon: "arrow-up-right" as const,
                onClick: () => window.open((i().source as IssueSource).url, "_blank", "noopener"),
              },
            ]
          : []),
        {
          id: "follow",
          label: following() ? "Stop following" : "Follow",
          icon: "bell",
          pressed: following(),
          onClick: () =>
            void crow.host
              .call("follow", { space: props.space, id: props.id, on: !following() })
              .catch(() => {}),
        },
        {
          id: "copy-link",
          label: "Copy link",
          icon: "link",
          onClick: () => {
            void navigator.clipboard?.writeText(`${location.origin}/e/issue/${props.id}`)
            crow.workbench.toast({ title: "Link copied", kind: "success" })
          },
        },
        ...(canWrite()
          ? [
              {
                id: "share",
                label: "Share the project…",
                icon: "users" as const,
                overflow: true,
                onClick: () => workbenchShare(crow, `space://${props.space}`),
              },
              {
                id: "trash",
                label: "Move to trash",
                icon: "trash" as const,
                danger: true,
                overflow: true,
                onClick: async () => {
                  if (!confirm(`Move ${i().key} to the trash?`)) return
                  await crow.host.call("remove", { items: [{ id: props.id, space: props.space }] })
                  crow.workbench.openView("projects.issues")
                },
              },
              {
                id: "start-agent",
                label: "Start agent",
                icon: "agent" as const,
                primary: true,
                onClick: () => setAgentOpen(true),
              },
            ]
          : []),
      ]}
    />
  )
  const properties = (i: () => IssueRow) => (
    <div class="projects__issue-side" data-part="properties">
      <For each={["state", "priority", "assignee", "labels", "estimate", "due", "cycle", "parent"] as const}>
        {(p) => (
          <div class="projects__side-row">
            <span class="nc-meta projects__side-label">{SIDE_LABEL[p]}</span>
            <PropControl
              crow={crow}
              store={store}
              issue={i()}
              prop={p}
              disabled={!canWrite()}
              onChange={change}
              openSignal={signal(p)}
              onCreateLabel={(name) => createLabel(crow, props.space, name)}
            />
          </div>
        )}
      </For>
      <Show when={(i().source as IssueSource | null | undefined)?.people?.length}>
        <div class="projects__side-row" data-part="source-people">
          <span class="nc-meta projects__side-label">
            Also on {sourceKind((i().source as IssueSource).provider).title}
          </span>
          <SourcePeople people={(i().source as IssueSource).people} />
        </div>
      </Show>
      <div class="projects__side-row">
        <span class="nc-meta projects__side-label">Created</span>
        <span class="projects__side-value">
          <Show
            when={i().createdBy}
            fallback={
              <Show when={(i().source as IssueSource | null | undefined)?.author}>
                {(a) => (
                  <>
                    <Person name={a().user ? nameOf(crow, a().user!) : a().login} />
                    <span>{a().user ? nameOf(crow, a().user!) : a().login}</span>
                  </>
                )}
              </Show>
            }
          >
            <Person name={nameOf(crow, `user://${i().createdBy}`)} />
            <span>{nameOf(crow, `user://${i().createdBy}`)}</span>
          </Show>
          <span class="nc-meta">
            {ago(
              (i().source as (IssueSource & { createdAt?: string }) | null | undefined)?.createdAt ??
                i().createdAt,
            )}
          </span>
        </span>
      </div>
      <Show when={(i().source as IssueSource | null | undefined)?.ref}>
        <div class="projects__side-row" data-part="source">
          <span class="nc-meta projects__side-label">
            {sourceKind((i().source as IssueSource).provider).title}
          </span>
          <span class="projects__side-value">
            <OpenAtSource crow={crow} issue={i()} />
          </span>
        </div>
      </Show>
      <Show when={i().followers?.length}>
        <div class="projects__side-row">
          <span class="nc-meta projects__side-label">Followers</span>
          <span class="projects__side-value projects__followers">
            <For each={i().followers ?? []}>{(f) => <Person name={nameOf(crow, f)} />}</For>
          </span>
        </div>
      </Show>
    </div>
  )

  return (
    <div
      class="projects__issue"
      data-part="issue"
      data-issue={props.id}
      tabindex="-1"
      ref={(el) => {
        _root = el
        el.addEventListener("keydown", onKey)
      }}
    >
      <Show when={!store.loading() && !issue()}>
        <EmptyState
          icon="list"
          title="This issue is not available"
          description="It was deleted, or it is not shared with you."
        />
      </Show>
      <Show when={issue()}>
        {(i) => (
          <>
            <ViewLayout
              id="projects.issue"
              header={header(i)}
              aside={properties(i)}
              asideLabel="Properties"
              asideWidth={280}
              minMain={560}
            >
              <div class="projects__issue-main">
                <textarea
                  class="title projects__issue-title"
                  rows="1"
                  aria-label="Title"
                  value={title()}
                  readOnly={!canWrite()}
                  data-testid="issue-title"
                  onFocus={() => setEditingTitle(true)}
                  onInput={(e) => setTitle(e.currentTarget.value.replace(/\n/g, " "))}
                  onBlur={saveTitle}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") {
                      e.preventDefault()
                      e.currentTarget.blur()
                    }
                    if (e.key === "Escape") {
                      setTitle(i().title)
                      e.currentTarget.blur()
                    }
                  }}
                />
                <SourceNotice crow={crow} issue={i()} space={props.space} canWrite={canWrite()} />
                <div class="projects__desc" data-part="description">
                  <Show
                    when={documentId()}
                    keyed
                    fallback={<span class="nc-meta">Opening the description…</span>}
                  >
                    {(d) => (
                      <Description
                        crow={crow}
                        document={d}
                        setDirty={props.setDirty}
                        onSaved={
                          (i().source as IssueSource | null | undefined)?.link
                            ? () =>
                                void crow.host
                                  .call("descriptionEdited", { space: props.space, id: props.id })
                                  .catch(() => {})
                            : undefined
                        }
                      />
                    )}
                  </Show>
                </div>

                <section class="projects__section" data-part="sub-issues">
                  <Show when={subs().length}>
                    <header class="projects__section-head">
                      <span class="label">Sub-issues</span>
                      <span class="nc-meta nc-num">
                        {
                          subs().filter(
                            (s) => s.stateCategory === "completed" || s.stateCategory === "cancelled",
                          ).length
                        }
                        /{subs().length}
                      </span>
                    </header>
                  </Show>
                  <For each={subs()}>
                    {(s) => (
                      <div class="projects__sub" data-issue={s.id}>
                        <PropControl
                          crow={crow}
                          store={store}
                          issue={s}
                          prop="state"
                          compact
                          disabled={!canWrite()}
                          onChange={(p) => updateIssues(crow, () => store, [s], p as never)}
                        />
                        <Key>{s.key}</Key>
                        <button
                          type="button"
                          class="projects__sub-title"
                          onClick={() => entitiesOf(crow).open(`issue://${s.id}`)}
                        >
                          {s.title}
                        </button>
                        <PropControl
                          crow={crow}
                          store={store}
                          issue={s}
                          prop="assignee"
                          compact
                          disabled={!canWrite()}
                          onChange={(p) => updateIssues(crow, () => store, [s], p as never)}
                        />
                      </div>
                    )}
                  </For>
                  <Show when={canWrite()}>
                    <form
                      class="projects__sub-add"
                      onSubmit={(e) => {
                        e.preventDefault()
                        void addSub()
                      }}
                    >
                      <Icon name="plus" size="sm" />
                      <input
                        class="projects__inline-input"
                        placeholder="Add a sub-issue"
                        aria-label="New sub-issue title"
                        value={newSub()}
                        onInput={(e) => setNewSub(e.currentTarget.value)}
                        data-testid="new-sub"
                      />
                    </form>
                  </Show>
                </section>

                <section
                  class="projects__section"
                  classList={{ "projects__section--bare": !(relations.latest ?? []).length }}
                  data-part="relations"
                >
                  <header class="projects__section-head">
                    <Show when={(relations.latest ?? []).length}>
                      <span class="label">Relations</span>
                    </Show>
                    <Show when={canWrite()}>
                      <DropdownMenu
                        label="Add a relation"
                        items={[
                          { id: "blocks", label: "Blocks…" },
                          { id: "blocked", label: "Blocked by…" },
                          { id: "relates", label: "Related to…" },
                          { id: "duplicate", label: "Duplicate of…" },
                        ]}
                        onSelect={(id) => queueMicrotask(() => setRelating(id as RelationKind))}
                        trigger={(t) => (
                          <button
                            {...t}
                            ref={(el) => {
                              relateBtn = el
                              t.ref(el)
                            }}
                            type="button"
                            class="projects__add-small nc-meta"
                            aria-label="Add a relation"
                          >
                            <Icon name="plus" size="sm" />
                            <Show when={!(relations.latest ?? []).length}>
                              <span>Add a relation</span>
                            </Show>
                          </button>
                        )}
                      />
                    </Show>
                  </header>
                  <For each={relations.latest ?? []}>
                    {(r) => {
                      const out = r.source === uri
                      const other = out ? r.target : r.source
                      const removable = () => canWrite() && r.spaceId === props.space
                      const unrelate = () =>
                        crow.host
                          .call("unrelate", { space: r.spaceId, id: r.id })
                          .then(() => refetchRelations())
                      return (
                        <ContextMenu
                          label={relationLabel(r.kind, out)}
                          items={() => [
                            {
                              id: "remove",
                              label: "Remove relation",
                              icon: "trash",
                              danger: true,
                              disabled: !removable(),
                            },
                          ]}
                          onSelect={unrelate}
                        >
                          {/* biome-ignore lint/a11y/noStaticElementInteractions: Delete removes the row; the context menu and the Menu key are its other entry points */}
                          <div
                            class="projects__relation"
                            data-kind={r.kind}
                            onKeyDown={(e) => {
                              if (removable() && (e.key === "Delete" || e.key === "Backspace")) {
                                e.preventDefault()
                                unrelate()
                              }
                            }}
                          >
                            <span class="nc-meta projects__relation-kind">{relationLabel(r.kind, out)}</span>
                            <EntityChip crow={crow} uri={other} />
                          </div>
                        </ContextMenu>
                      )
                    }}
                  </For>
                  <Picker
                    open={!!relating()}
                    anchor={relateBtn}
                    label="Pick an issue"
                    limit={60}
                    items={store
                      .issues()
                      .filter((x) => x.id !== props.id)
                      .map((x) => ({
                        id: `issue://${x.id}`,
                        label: `${x.key} ${x.title}`,
                        leading: <StateIcon category={x.stateCategory} />,
                      }))}
                    onPick={async (target) => {
                      const k = relating()!
                      const [source, to, kind] =
                        (k as string) === "blocked" ? [target, uri, "blocks"] : [uri, target, k]
                      await crow.host
                        .call("relate", { space: props.space, source, target: to, kind })
                        .catch((e) =>
                          crow.workbench.toast({
                            title: "Not related",
                            body: String(e?.message ?? e),
                            kind: "danger",
                          }),
                        )
                      refetchRelations()
                    }}
                    onClose={() => setRelating(null)}
                  />
                </section>

                <Show when={grouped().length}>
                  <section class="projects__section" data-part="links">
                    <header class="projects__section-head">
                      <span class="label">Links</span>
                      <span class="nc-meta">
                        Docs, agent sessions, pull requests and anything else that mentions this issue
                      </span>
                    </header>
                    <For each={grouped()}>
                      {([g, list]) => (
                        <div class="projects__link-group" data-group={g}>
                          <span class="section projects__link-title">{GROUP_TITLE[g] ?? g}</span>
                          <For each={list}>
                            {(l) => (
                              <div class="projects__link" data-link={l.uri}>
                                <EntityChip crow={crow} uri={l.uri} label={l.title} />
                                <Show
                                  when={l.uri.startsWith("session://") && sessionState(crow, l.uri)}
                                  fallback={
                                    <Show when={l.subtitle}>
                                      <span class="nc-meta projects__link-state">{l.subtitle}</span>
                                    </Show>
                                  }
                                >
                                  {(st) => (
                                    <span
                                      class="nc-meta projects__link-state"
                                      data-session-state={st().state}
                                    >
                                      {STATE_WORDS[st().state] ?? st().state}
                                    </span>
                                  )}
                                </Show>
                                <Show when={l.at}>
                                  <span class="nc-meta">{ago(l.at!)}</span>
                                </Show>
                              </div>
                            )}
                          </For>
                        </div>
                      )}
                    </For>
                  </section>
                </Show>

                <section class="projects__section projects__activity" data-part="activity">
                  <header class="projects__section-head">
                    <span class="label">Activity</span>
                    <span class="projects__spacer" />
                    <Show when={canAi() && comments().length >= 2}>
                      <Button
                        size="sm"
                        variant="ghost"
                        icon="sparkle"
                        loading={summarizing()}
                        onClick={summarize}
                        data-testid="summarize"
                      >
                        Summarize
                      </Button>
                    </Show>
                  </header>
                  <Show when={summary()}>
                    <div class="projects__summary" data-part="summary">
                      <Icon name="sparkle" size="sm" />
                      <ul>
                        <For each={summary()!}>{(p) => <li>{p}</li>}</For>
                      </ul>
                      <IconButton icon="close" label="Dismiss" onClick={() => setSummary(null)} />
                    </div>
                  </Show>
                  <ol class="projects__timeline" data-part="timeline">
                    <For each={timeline()}>
                      {(item) => (
                        <TimelineEntry
                          crow={crow}
                          store={store}
                          item={item}
                          comment={
                            item.kind === "comment"
                              ? (comments().find((c) => c.id === item.id) as unknown as CommentRow)
                              : undefined
                          }
                          space={props.space}
                          me={me()?.uri ?? null}
                          canWrite={canWrite()}
                          source={issue()?.source as IssueSource | null | undefined}
                          sourceTitle={
                            sourceKind((issue()?.source as IssueSource | null | undefined)?.provider).title
                          }
                          link={
                            item.kind === "link" ? links().find((l) => l.source === item.source) : undefined
                          }
                        />
                      )}
                    </For>
                  </ol>
                  <Show when={canWrite()}>
                    <div
                      class="projects__reply"
                      data-part="reply"
                      ref={(el) =>
                        el.addEventListener("keydown", (e) => {
                          if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) {
                            e.preventDefault()
                            void send()
                          }
                        })
                      }
                    >
                      <Show when={replyKey() + 1} keyed>
                        {(_k) => (
                          <WithPageLinks crow={crow}>
                            <RichTextEditor
                              variant="comment"
                              aria-label="Comment"
                              placeholder="Leave a comment…"
                              value={reply() as never}
                              onChange={(d) => onReply(d as RichText)}
                            />
                          </WithPageLinks>
                        )}
                      </Show>
                      <div class="projects__reply-bar">
                        <span class="nc-meta">Ctrl Enter to send</span>
                        <Button
                          variant="primary"
                          size="sm"
                          loading={sending()}
                          onClick={send}
                          data-testid="send-comment"
                        >
                          Comment
                        </Button>
                      </div>
                    </div>
                  </Show>
                </section>
              </div>
            </ViewLayout>
            <AgentDialog
              crow={crow}
              open={agentOpen()}
              onClose={() => setAgentOpen(false)}
              issue={i()}
              store={store}
            />
          </>
        )}
      </Show>
    </div>
  )
}

const SIDE_LABEL: Record<Prop, string> = {
  state: "State",
  priority: "Priority",
  assignee: "Assignee",
  labels: "Labels",
  estimate: "Estimate",
  due: "Due date",
  cycle: "Cycle",
  parent: "Parent",
}

function Description(props: {
  crow: ClientRookery
  document: string
  setDirty?: (dirty: boolean) => void
  /** After this person's edits reached the kernel (a synced issue then pushes the description). */
  onSaved?: () => void
}) {
  const docs = documentsOf(props.crow)
  if (!docs) {
    return (
      <p class="nc-meta projects__doc-unavailable">
        Collaborative descriptions require the Rookery documents facility (M2b).
      </p>
    )
  }
  const session: DocumentSession = docs.open(props.document)
  onCleanup(() => session.close())
  // Edits the kernel has not confirmed mark the tab (plugins.md, view.setDirty). When the description goes
  // they are kept for its next session, which sends them, so the mark goes with it.
  createEffect(() => props.setDirty?.(session.unsynced()))
  // Own edits confirmed: the issue's source gets the description a moment after the typing stops.
  let saved: ReturnType<typeof setTimeout> | undefined
  createEffect(
    on(
      () => session.unsynced(),
      (now, before) => {
        if (before && !now && props.onSaved) {
          if (saved) clearTimeout(saved)
          saved = setTimeout(() => props.onSaved?.(), 1500)
        }
      },
    ),
  )
  onCleanup(() => saved && clearTimeout(saved))
  onCleanup(() => props.setDirty?.(false))
  return (
    <>
      <Show when={session.status() === "error"}>
        <p class="projects__error">{session.error()?.message}</p>
      </Show>
      <WithPageLinks crow={props.crow}>
        <RichTextEditor
          provider={session}
          variant="field"
          readOnly={session.readOnly()}
          aria-label="Description"
          placeholder="Add a description…"
          onError={(m) => props.crow.workbench.toast({ title: m, kind: "danger" })}
        />
      </WithPageLinks>
    </>
  )
}

function changeText(crow: ClientRookery, store: ProjectStore, c: FieldChange): JSX.Element {
  const label = (u: unknown) => store.labels().find((l) => `label://${l.id}` === u)?.name ?? "a label"
  const state = (s: unknown) => store.states().find((x) => x.id === s)?.name ?? "a removed state"
  const person = (u: unknown) => (u ? nameOf(crow, String(u)) : "nobody")
  switch (c.field) {
    case "state":
      return (
        <>
          moved it from <b>{state(c.from)}</b> to <b>{state(c.to)}</b>
        </>
      )
    case "title":
      return (
        <>
          renamed it to <b>{String(c.to)}</b>
        </>
      )
    case "priority":
      return (
        <>
          set the priority to <b>{priorityName(c.to as number)}</b>
        </>
      )
    case "assignee":
      return c.to ? (
        <>
          assigned it to <b>{person(c.to)}</b>
        </>
      ) : (
        <>removed the assignee</>
      )
    case "labels": {
      const from = (c.from as string[] | null) ?? []
      const to = (c.to as string[] | null) ?? []
      const added = to.filter((x) => !from.includes(x)).map(label)
      const removed = from.filter((x) => !to.includes(x)).map(label)
      return (
        <>
          {added.length ? (
            <>
              added <b>{added.join(", ")}</b>
            </>
          ) : null}
          {added.length && removed.length ? " and " : ""}
          {removed.length ? (
            <>
              removed <b>{removed.join(", ")}</b>
            </>
          ) : null}
        </>
      )
    }
    case "estimate":
      return c.to == null ? (
        <>removed the estimate</>
      ) : (
        <>
          estimated it at <b>{String(c.to)}</b>
        </>
      )
    case "due":
      return c.to ? (
        <>
          set the due date to <b>{formatDay(String(c.to))}</b>
        </>
      ) : (
        <>removed the due date</>
      )
    case "parent":
      return c.to ? (
        <>
          made it a sub-issue of <b>{store.issue(String(c.to))?.key ?? "another issue"}</b>
        </>
      ) : (
        <>removed the parent</>
      )
    case "cycle":
      return c.to ? (
        <>
          added it to <b>{store.cycles().find((x) => `cycle://${x.id}` === c.to)?.name ?? "a cycle"}</b>
        </>
      ) : (
        <>removed it from its cycle</>
      )
  }
}

function TimelineEntry(props: {
  crow: ClientRookery
  store: ProjectStore
  item: TimelineItem
  comment?: CommentRow
  space: string
  me: string | null
  canWrite: boolean
  link?: { source: string; title: string | null; subtitle?: string | null; field: string }
  /** For an issue from a source: what the plugin wrote came from there. */
  source?: IssueSource | null
  sourceTitle?: string
}) {
  const crow = props.crow
  const it = props.item
  const fromSource = (a: string) => !!props.source?.provider && a === "service:plugin:projects"
  const actorName = (a: string) =>
    a.startsWith("session://")
      ? "An agent"
      : fromSource(a)
        ? it.kind === "created" && props.source?.author
          ? props.source.author.user
            ? nameOf(crow, props.source.author.user)
            : props.source.author.login
          : (props.sourceTitle ?? "Automation")
        : a.startsWith("service:plugin:")
          ? "Automation"
          : a.startsWith("service:")
            ? "A service"
            : nameOf(crow, a)
  switch (it.kind) {
    case "created":
      return (
        <li class="projects__event" data-event="created">
          <Person name={actorName(it.actor)} />
          <span>
            <b>{actorName(it.actor)}</b> created the issue
          </span>
          <span class="nc-meta">{ago(it.at)}</span>
        </li>
      )
    case "change":
      return (
        <li
          class="projects__event"
          data-event="change"
          data-fields={it.changes.map((c) => c.field).join(" ")}
        >
          <Show when={it.actor.startsWith("session://")} fallback={<Person name={actorName(it.actor)} />}>
            <Avatar kind="agent" name="Agent" size="sm" />
          </Show>
          <span>
            <Show when={it.actor.startsWith("session://")} fallback={<b>{actorName(it.actor)}</b>}>
              <EntityChip crow={crow} uri={it.actor} label="An agent" />
            </Show>{" "}
            <For each={it.changes}>
              {(c, n) => (
                <>
                  {n() > 0 ? ", " : ""}
                  {changeText(crow, props.store, c)}
                </>
              )}
            </For>
          </span>
          <span class="nc-meta">{ago(it.at)}</span>
        </li>
      )
    case "link": {
      const scheme = it.source.slice(0, it.source.indexOf("://"))
      return (
        <li class="projects__event" data-event="link" data-source={it.source}>
          <Icon name={scheme === "session" ? "agent" : scheme === "gh-pr" ? "branch" : "link"} size="sm" />
          <span>
            {scheme === "session" ? "Agent session " : "Mentioned in "}
            <EntityChip crow={crow} uri={it.source} label={props.link?.title ?? it.source} />
            <Show
              when={scheme === "session" && sessionState(crow, it.source)}
              fallback={
                <Show when={props.link?.subtitle}>
                  <span class="nc-meta"> · {props.link!.subtitle}</span>
                </Show>
              }
            >
              {(st) => (
                <span class="nc-meta" data-session-state={st().state}>
                  {" "}
                  · {STATE_WORDS[st().state] ?? st().state}
                </span>
              )}
            </Show>
          </span>
          <span class="nc-meta">{ago(it.at)}</span>
        </li>
      )
    }
    case "conflict":
      return <ConflictEntry crow={crow} store={props.store} item={it} />
    case "comment":
      return (
        <Show when={props.comment}>
          {(c) => (
            <Comment crow={crow} comment={c()} space={props.space} me={props.me} canWrite={props.canWrite} />
          )}
        </Show>
      )
  }
}

function Comment(props: {
  crow: ClientRookery
  comment: CommentRow
  space: string
  me: string | null
  canWrite: boolean
}) {
  const crow = props.crow
  const c = () => props.comment
  // A comment from the source: its author as a Crow user when they are one, else their login there.
  const author = () => (c().createdBy ? `user://${c().createdBy}` : (c().author ?? ""))
  const authorName = () => (author() ? nameOf(crow, author()) : (c().origin?.author?.login ?? "Someone"))
  const mine = () => !!props.me && props.me === author() && !!c().createdBy
  const [editing, setEditing] = createSignal(false)
  const [body, setBody] = createSignal<RichText>(c().body as RichText)
  const save = async () => {
    try {
      await crow.host.call("editComment", { space: props.space, id: c().id, body: body() })
      setEditing(false)
    } catch (e: any) {
      crow.workbench.toast({ title: "Not saved", body: String(e?.message ?? e), kind: "danger" })
    }
  }
  const react = (emoji: string) =>
    crow.host.call("react", { space: props.space, id: c().id, emoji }).catch(() => {})
  return (
    <li class="projects__comment" data-comment={c().id}>
      <Person name={authorName()} size="md" />
      <div class="projects__comment-body">
        <div class="projects__comment-head">
          <b>{authorName()}</b>
          <span class="nc-meta">
            {ago(c().origin?.createdAt ?? c().createdAt)}
            {c().editedAt ? " · edited" : ""}
          </span>
          <span class="projects__spacer" />
          <Show when={props.canWrite}>
            <DropdownMenu
              label="Add a reaction"
              items={REACTIONS.map((r) => ({ id: r, label: r }))}
              onSelect={react}
              trigger={(t) => (
                <button
                  {...t}
                  type="button"
                  class="nc-icon-btn projects__comment-act"
                  aria-label="Add a reaction"
                >
                  <Icon name="star" size="sm" />
                </button>
              )}
            />
          </Show>
          <Show when={mine()}>
            <IconButton
              icon="edit"
              label="Edit comment"
              onClick={() => setEditing(true)}
              class="projects__comment-act"
            />
            <IconButton
              icon="trash"
              label="Delete comment"
              class="projects__comment-act"
              onClick={() =>
                confirm("Delete this comment?") &&
                crow.host.call("deleteComment", { space: props.space, id: c().id })
              }
            />
          </Show>
        </div>
        <Show
          when={editing()}
          fallback={
            <RichTextEditor value={c().body as never} readOnly variant="comment" aria-label="Comment" />
          }
        >
          <WithPageLinks crow={crow}>
            <RichTextEditor
              value={body() as never}
              onChange={(d) => setBody(d as RichText)}
              variant="comment"
              aria-label="Edit comment"
              autofocus
            />
          </WithPageLinks>
          <div class="projects__reply-bar">
            <Button size="sm" variant="ghost" onClick={() => setEditing(false)}>
              Cancel
            </Button>
            <Button size="sm" variant="primary" onClick={save}>
              Save
            </Button>
          </div>
        </Show>
        <Show when={Object.keys(c().reactions ?? {}).length}>
          <div class="projects__reactions">
            <For each={Object.entries(c().reactions ?? {})}>
              {([emoji, users]) => (
                <button
                  type="button"
                  class="projects__reaction"
                  aria-pressed={!!props.me && users.includes(props.me.replace("user://", ""))}
                  title={users.map((u) => nameOf(crow, `user://${u}`)).join(", ")}
                  onClick={() => props.canWrite && react(emoji)}
                >
                  {emoji} <span class="nc-num">{users.length}</span>
                </button>
              )}
            </For>
          </div>
        </Show>
      </div>
    </li>
  )
}

const FIELD_WORDS: Record<string, string> = {
  title: "the title",
  body: "the description",
  state: "the state",
  labels: "the labels",
  assignee: "the assignee",
}

/** A field both sides changed: whose value the issue kept, and the one it lost (a description as a diff). */
function ConflictEntry(props: {
  crow: ClientRookery
  store: ProjectStore
  item: Extract<TimelineItem, { kind: "conflict" }>
}) {
  const kind = useSourceKinds(props.crow)
  const it = props.item
  const source = () => kind(it.provider).title
  const show = (v: unknown): string => {
    if (v == null || v === "") return "nothing"
    if (Array.isArray(v)) return v.length ? v.join(", ") : "none"
    if (typeof v === "string" && v.startsWith("user://")) return nameOf(props.crow, v)
    return String(v)
  }
  return (
    <li class="projects__event" data-event="conflict" data-field={it.field}>
      <Icon name={kind(it.provider).icon ? (kind(it.provider).icon as never) : "link"} size="sm" />
      <span class="projects__conflict">
        <span>
          <b>{source()}</b> and <b>Crow</b> both changed {FIELD_WORDS[it.field] ?? it.field} · kept{" "}
          {it.won === "source" ? source() : "Crow"}’s
          <Show when={it.field !== "body"}>
            {" "}
            · lost <s data-testid="conflict-lost">{show(it.lost)}</s>
          </Show>
        </span>
        <Show when={it.field === "body"}>
          <DiffView before={String(it.lost ?? "")} after={String(it.kept ?? "")} bare />
        </Show>
      </span>
      <span class="nc-meta">{ago(it.at)}</span>
    </li>
  )
}
