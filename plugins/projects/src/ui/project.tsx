// Projects: the list of projects with "New project", a project's overview (its description as a
// collaborative document, progress, recent activity, members, repositories and what links to it), and its
// settings (general, workflow states, labels, templates, automation).

import {
  Button,
  Callout,
  ContextMenu,
  Dialog,
  EmptyState,
  Icon,
  IconButton,
  RichTextEditor,
  Select,
  Switch,
  TextField,
  ViewHeader,
} from "@aiviarium/nocturne"
import type { ClientRookery, SpaceInfo } from "@rookery/sdk/client"
import { createEffect, createMemo, createResource, createSignal, For, on, onCleanup, Show } from "solid-js"
import { isProjectKey, suggestKey } from "../lib/keys"
import { CATEGORIES, CATEGORY_TITLE, type Category, closed, HUES, type StateRow } from "../lib/model"
import { between } from "../lib/rank"
import { Key, Label, Person, StateIcon } from "./glyphs"
import { ago } from "./issue"
import { documentsOf, EntityChip, entitiesOf, spaceAccessLevel, toRookeryError, workbenchShare } from "./sdk"
import { useSourceKinds } from "./source"
import { acquire, knowNames, nameOf, type ProjectStore, useMe } from "./store"

export const KIND = "projects.project"

// ── new project ───────────────────────────────────────────────────────────────────────────────────────

const [newOpen, setNewOpen] = createSignal(false)
export const openNewProject = () => setNewOpen(true)

export function NewProjectHost(props: {
  crow: ClientRookery
  onCreated: (s: SpaceInfo, project: string) => void
}) {
  const crow = props.crow
  const [name, setName] = createSignal("")
  const [key, setKey] = createSignal("")
  const [keyEdited, setKeyEdited] = createSignal(false)
  const [summary, setSummary] = createSignal("")
  const [busy, setBusy] = createSignal(false)
  const [error, setError] = createSignal<string | null>(null)
  createEffect(on(name, (n) => !keyEdited() && setKey(n.trim() ? suggestKey(n) : "")))
  createEffect(
    on(newOpen, (o) => {
      if (!o) return
      setName("")
      setKey("")
      setKeyEdited(false)
      setSummary("")
      setError(null)
    }),
  )
  const valid = () => !!name().trim() && isProjectKey(key())
  const create = async () => {
    if (!valid()) return
    setBusy(true)
    setError(null)
    try {
      const r = await crow.host.call<{ space: SpaceInfo; project: { id: string } }>("createProject", {
        name: name().trim(),
        key: key(),
        summary: summary().trim() || undefined,
      })
      setNewOpen(false)
      props.onCreated(r.space, r.project.id)
    } catch (e) {
      setError(toRookeryError(e).message)
    } finally {
      setBusy(false)
    }
  }
  return (
    <Dialog
      open={newOpen()}
      onClose={() => setNewOpen(false)}
      title="New project"
      description="A project is a space: its issues, cycles, members and repositories belong to it."
      size="sm"
      footer={
        <>
          <Button variant="ghost" onClick={() => setNewOpen(false)}>
            Cancel
          </Button>
          <Button
            variant="primary"
            disabled={!valid()}
            loading={busy()}
            onClick={create}
            data-testid="create-project"
          >
            Create project
          </Button>
        </>
      }
      data-part="new-project"
    >
      <form
        class="projects__form"
        onSubmit={(e) => {
          e.preventDefault()
          void create()
        }}
      >
        <TextField
          label="Name"
          value={name()}
          onInput={(e) => setName(e.currentTarget.value)}
          autofocus
          data-testid="project-name"
        />
        <TextField
          label="Key"
          help="Issue keys start with it: KEY-123. Capital letters and digits, 2 to 10."
          value={key()}
          class="mono"
          error={
            key() && !isProjectKey(key())
              ? "2 to 10 capital letters and digits, starting with a letter"
              : undefined
          }
          onInput={(e) => {
            setKeyEdited(true)
            setKey(
              e.currentTarget.value
                .toUpperCase()
                .replace(/[^A-Z0-9]/g, "")
                .slice(0, 10),
            )
          }}
          data-testid="project-key"
        />
        <TextField
          label="Summary"
          value={summary()}
          onInput={(e) => setSummary(e.currentTarget.value)}
          placeholder="What the project is for"
        />
        <button type="submit" hidden />
        <Show when={error()}>
          <Callout tone="danger">
            <span class="label">Not created.</span> {error()}
          </Callout>
        </Show>
      </form>
    </Dialog>
  )
}

// ── the list of projects ──────────────────────────────────────────────────────────────────────────────

export function ProjectsHome(props: { crow: ClientRookery; projects: () => SpaceInfo[]; loading: boolean }) {
  const crow = props.crow
  const spaces = () => props.projects().map((s) => s.id)
  const rows = () => (spaces().length ? crow.data.projects.live({ spaces: spaces(), limit: 200 }) : null)
  const live = createMemo(rows)
  const list = () =>
    (live()?.() ?? []) as unknown as Array<{
      id: string
      spaceId: string
      key: string
      name: string
      summary: string | null
      archived: boolean
      lead: string | null
    }>
  const [showArchived, setShowArchived] = createSignal(false)
  return (
    <div class="projects__page" data-part="projects-home">
      <ViewHeader>
        <span class="projects__spacer" />
        <Button
          variant="secondary"
          size="sm"
          icon="user"
          onClick={() => crow.workbench.openView("projects.mine")}
        >
          My issues
        </Button>
        <IconButton label="New project" icon="plus" onClick={openNewProject} data-testid="new-project" />
      </ViewHeader>
      <Show
        when={list().length}
        fallback={
          <Show when={!props.loading}>
            <EmptyState icon="board" title="No projects yet">
              <Button variant="secondary" icon="plus" onClick={openNewProject}>
                New project
              </Button>
            </EmptyState>
          </Show>
        }
      >
        <div class="projects__grid">
          <For each={list().filter((p) => showArchived() || !p.archived)}>
            {(p) => {
              const space = () => props.projects().find((s) => s.id === p.spaceId)
              return (
                <button
                  type="button"
                  class="nc-card projects__project-card"
                  data-project={p.key}
                  onClick={() => entitiesOf(crow).open(`project://${p.id}`)}
                >
                  <span class="projects__project-top">
                    <Icon name="board" />
                    <span class="label" title={p.name}>
                      {p.name}
                    </span>
                    <Key>{p.key}</Key>
                  </span>
                  <Show when={p.summary}>
                    <span class="nc-meta projects__project-summary" title={p.summary ?? undefined}>
                      {p.summary}
                    </span>
                  </Show>
                  <span class="projects__project-foot">
                    <Show when={p.lead}>
                      <Person name={nameOf(crow, p.lead)} />
                    </Show>
                    <span class="nc-meta">
                      {spaceAccessLevel(space()?.level) === "view"
                        ? "Viewer"
                        : spaceAccessLevel(space()?.level) === "manage"
                          ? "Manager"
                          : "Member"}
                    </span>
                    <Show when={p.archived}>
                      <span class="nc-badge">Archived</span>
                    </Show>
                  </span>
                </button>
              )
            }}
          </For>
        </div>
        <Show when={list().some((p) => p.archived)}>
          <div class="projects__switch-row">
            <Switch checked={showArchived()} onChange={setShowArchived} aria-label="Show archived projects" />
            <span class="nc-meta">Show archived projects</span>
          </div>
        </Show>
      </Show>
    </div>
  )
}

// ── a project's overview ──────────────────────────────────────────────────────────────────────────────

export function Overview(props: { crow: ClientRookery; space: string; setTitle: (t: string) => void }) {
  const crow = props.crow
  const { store, release } = acquire(crow, props.space)
  onCleanup(release)
  const me = useMe(crow)
  const p = () => store.project()
  createEffect(() => p() && props.setTitle(p()!.name))
  createEffect(() => knowNames(store.members()))
  const manage = () => store.level() === "manage" || !!me()?.admin
  const counts = createMemo(() => {
    const by: Record<Category, number> = { backlog: 0, unstarted: 0, started: 0, completed: 0, cancelled: 0 }
    for (const i of store.issues()) if (i.stateCategory) by[i.stateCategory]++
    return by
  })
  const total = () => store.issues().filter((i) => i.stateCategory !== "cancelled").length
  const done = () => counts().completed
  const recent = createMemo(() =>
    [...store.issues()].sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : -1)).slice(0, 8),
  )
  const [doc] = createResource(
    () => p()?.id,
    async () =>
      p()?.document
        ? { id: p()!.document! }
        : await crow.host.call<{ id: string }>("projectDocument", { space: props.space }).catch(() => null),
  )
  const [repos, { refetch: refetchRepos }] = createResource(() =>
    crow.host
      .call<{ repositories: Array<{ id: string; name: string; url: string }> }>("repositories", {
        space: props.space,
      })
      .catch(() => ({ repositories: [] })),
  )
  const [tick, setTick] = createSignal(0)
  const t = setInterval(() => setTick((n) => n + 1), 6000)
  onCleanup(() => clearInterval(t))
  const [links] = createResource(
    () => [p()?.id, tick()] as const,
    async ([id]) =>
      id
        ? (await crow.data.refs.to(`project://${id}`).catch(() => [])).filter(
            (b) => !b.source.startsWith("issue://"),
          )
        : [],
  )
  const [repoUrl, setRepoUrl] = createSignal("")
  const addRepo = async () => {
    const url = repoUrl().trim()
    if (!url) return
    try {
      await crow.host.call("addRepository", { space: props.space, url })
      setRepoUrl("")
      refetchRepos()
    } catch (e) {
      crow.workbench.toast({ title: "Not added", body: toRookeryError(e).message, kind: "danger" })
    }
  }
  return (
    <div class="projects__page projects__overview" data-part="overview">
      <Show
        when={p()}
        fallback={
          <Show when={!store.loading()}>
            <EmptyState
              icon="board"
              title="This project is not available"
              description="It is not shared with you, or it was removed."
            />
          </Show>
        }
      >
        {(proj) => (
          <>
            <ViewHeader>
              <Key>{proj().key}</Key>
              <Show when={proj().archived}>
                <span class="nc-badge">Archived</span>
              </Show>
              <span class="projects__spacer" />
              <Button
                size="sm"
                variant="secondary"
                icon="list"
                onClick={() => crow.workbench.openView("projects.issues")}
                data-testid="open-issues"
              >
                Issues
              </Button>
              <Button
                size="sm"
                variant="secondary"
                icon="clock"
                onClick={() => crow.workbench.openView("projects.cycles")}
              >
                Cycles
              </Button>
              <Show when={manage()}>
                <IconButton
                  icon="users"
                  label="Members"
                  onClick={() => workbenchShare(crow, `space://${props.space}`)}
                />
                <IconButton
                  icon="settings"
                  label="Project settings"
                  onClick={() => crow.workbench.openView("projects.settings")}
                  data-testid="project-settings"
                />
              </Show>
            </ViewHeader>
            <div class="projects__overview-body">
              <main class="projects__overview-main">
                <Show when={proj().summary}>
                  <p class="body-lg projects__summary-text">{proj().summary}</p>
                </Show>
                <section class="projects__section" data-part="progress">
                  <header class="projects__section-head">
                    <span class="label">Progress</span>
                    <span class="nc-meta nc-num">
                      {done()} of {total()} done
                    </span>
                  </header>
                  <div
                    class="projects__progress"
                    role="img"
                    aria-label={`${done()} of ${total()} issues done`}
                  >
                    <For each={["completed", "started", "unstarted", "backlog"] as const}>
                      {(c) => <span data-category={c} style={{ "flex-grow": counts()[c] }} />}
                    </For>
                  </div>
                  <div class="projects__progress-legend">
                    <For each={["backlog", "unstarted", "started", "completed", "cancelled"] as const}>
                      {(c) => (
                        <span class="nc-meta">
                          <StateIcon category={c} /> {CATEGORY_TITLE[c]} {counts()[c]}
                        </span>
                      )}
                    </For>
                  </div>
                </section>
                <section class="projects__section" data-part="project-description">
                  <header class="projects__section-head">
                    <span class="label">Description</span>
                  </header>
                  <Show when={doc()?.id} keyed fallback={<span class="nc-meta">Opening…</span>}>
                    {(id) => <ProjectDoc crow={crow} document={id} />}
                  </Show>
                </section>
                <section class="projects__section" data-part="recent">
                  <header class="projects__section-head">
                    <span class="label">Recent activity</span>
                  </header>
                  <For each={recent()} fallback={<span class="nc-meta">No issues yet.</span>}>
                    {(i) => (
                      <button
                        type="button"
                        class="projects__recent"
                        onClick={() => entitiesOf(crow).open(`issue://${i.id}`)}
                      >
                        <StateIcon
                          category={i.stateCategory}
                          color={store.states().find((s) => s.id === i.state)?.color}
                        />
                        <Key>{i.key}</Key>
                        <span class="projects__recent-title">{i.title}</span>
                        <span class="nc-meta">
                          {i.updatedBy ? nameOf(crow, `user://${i.updatedBy}`) : ""} · {ago(i.updatedAt)}
                        </span>
                      </button>
                    )}
                  </For>
                </section>
              </main>
              <aside class="projects__overview-side">
                <section class="projects__section" data-part="members">
                  <header class="projects__section-head">
                    <span class="label">Members</span>
                    <span class="nc-meta nc-num">{store.members().length}</span>
                  </header>
                  <For each={store.members()}>
                    {(m) => (
                      <div class="projects__member" data-member={m.uri}>
                        <Person name={m.name ?? m.email ?? m.uri} />
                        <span class="projects__member-name">{m.name ?? m.email}</span>
                        <span class="nc-meta">
                          {m.owner
                            ? "Owner"
                            : m.level === "view"
                              ? "Viewer"
                              : m.level === "manage"
                                ? "Manager"
                                : "Member"}
                        </span>
                      </div>
                    )}
                  </For>
                  <Show when={manage()}>
                    <IconButton
                      label="Add people"
                      icon="plus"
                      onClick={() => workbenchShare(crow, `space://${props.space}`)}
                      data-testid="add-members"
                    />
                  </Show>
                </section>
                <section class="projects__section" data-part="repositories">
                  <header class="projects__section-head">
                    <span class="label">Repositories</span>
                  </header>
                  <For
                    each={repos()?.repositories ?? []}
                    fallback={<span class="nc-meta">None attached.</span>}
                  >
                    {(r) => (
                      <div class="projects__repo">
                        <Icon name="branch" size="sm" />
                        <span class="projects__repo-name">{r.name}</span>
                        <span class="nc-meta mono projects__repo-url">{r.url}</span>
                      </div>
                    )}
                  </For>
                  <Show when={manage()}>
                    <form
                      class="projects__sub-add"
                      onSubmit={(e) => {
                        e.preventDefault()
                        void addRepo()
                      }}
                    >
                      <Icon name="plus" size="sm" />
                      <input
                        class="projects__inline-input mono"
                        placeholder="Attach a repository: its git URL"
                        aria-label="Repository URL"
                        value={repoUrl()}
                        onInput={(e) => setRepoUrl(e.currentTarget.value)}
                      />
                    </form>
                  </Show>
                </section>
                {/* Docs that mention the project; no section while there are none. */}
                <Show when={links()?.length}>
                  <section class="projects__section" data-part="project-links">
                    <header class="projects__section-head">
                      <span class="label">Linked docs</span>
                    </header>
                    <For each={links() ?? []}>
                      {(l) => (
                        <div class="projects__link">
                          <EntityChip crow={crow} uri={l.source} label={l.title ?? l.source} />
                        </div>
                      )}
                    </For>
                  </section>
                </Show>
              </aside>
            </div>
          </>
        )}
      </Show>
    </div>
  )
}

function ProjectDoc(props: { crow: ClientRookery; document: string }) {
  const docs = documentsOf(props.crow)
  if (!docs) {
    return (
      <p class="nc-meta projects__doc-unavailable">
        Project descriptions require the Rookery documents facility (M2b).
      </p>
    )
  }
  const session = docs.open(props.document)
  onCleanup(() => session.close())
  return (
    <RichTextEditor
      provider={session}
      variant="field"
      readOnly={session.readOnly()}
      aria-label="Project description"
      placeholder="What is this project, and how will we know it is done?"
    />
  )
}

// ── settings ──────────────────────────────────────────────────────────────────────────────────────────

export function ProjectSettings(props: { crow: ClientRookery; space: string }) {
  const crow = props.crow
  const { store, release } = acquire(crow, props.space)
  onCleanup(release)
  const p = () => store.project()
  const me = useMe(crow)
  const manage = () => store.level() === "manage" || !!me()?.admin
  const canUse = () => manage() || store.level() === "use"
  const deleteLabel = (l: { id: string; name: string }) =>
    confirm(`Delete the label ${l.name}?`) && crow.data.labels.delete(l.id)
  const update = async (patch: Record<string, unknown>) => {
    try {
      await crow.host.call("updateProject", { space: props.space, patch })
    } catch (e) {
      crow.workbench.toast({ title: "Not saved", body: toRookeryError(e).message, kind: "danger" })
    }
  }
  const [name, setName] = createSignal("")
  const [summary, setSummary] = createSignal("")
  createEffect(
    on(
      () => p()?.id,
      () => {
        setName(p()?.name ?? "")
        setSummary(p()?.summary ?? "")
      },
    ),
  )
  const states = () => [...store.states()].sort((a, b) => (a.rank < b.rank ? -1 : 1))
  const addState = async (category: Category) => {
    const list = states()
    const last = list.filter((s) => s.category === category).pop() ?? list[list.length - 1]
    const next = last ? list[list.indexOf(last) + 1] : undefined
    await crow.data.space(props.space).states.insert({
      name: CATEGORY_TITLE[category],
      category,
      color: "muted",
      rank: between(last?.rank ?? null, next?.rank ?? null),
    } as never)
  }
  const moveState = async (s: StateRow, dir: -1 | 1) => {
    const list = states()
    const at = list.indexOf(s)
    const to = at + dir
    if (to < 0 || to >= list.length) return
    const rest = list.filter((x) => x.id !== s.id)
    const above = rest[to - 1] ?? null
    const below = rest[to] ?? null
    await crow.data
      .space(props.space)
      .states.update(s.id, { rank: between(above?.rank ?? null, below?.rank ?? null) } as never)
  }
  const [removing, setRemoving] = createSignal<StateRow | null>(null)
  const [moveTo, setMoveTo] = createSignal("")
  const [labelName, setLabelName] = createSignal("")
  const [labelWide, setLabelWide] = createSignal(false)
  const [tplName, setTplName] = createSignal("")

  // Repositories of other trackers the project's issues sync with (docs/issues.md).
  type Link = { id: string; name: string; provider: string; url?: string | null }
  type Linkable = {
    provider: string
    providerTitle: string
    repository: string
    name: string
    url?: string
    repoSpace?: string
    connection?: string
    linked?: unknown
  }
  const sourceKind = useSourceKinds(crow)
  const [links, { refetch: refetchLinks }] = createResource(
    () => props.space,
    async (space) =>
      (
        await crow.host
          .call<{ links: Link[] }>("sourceLinks", { space })
          .catch(() => ({ links: [] as Link[] }))
      ).links,
  )
  const [linkable, { refetch: refetchLinkable }] = createResource(
    () => (manage() ? props.space : undefined),
    async (space) =>
      (
        await crow.host
          .call<{ repositories: Linkable[] }>("linkable", { space })
          .catch(() => ({ repositories: [] as Linkable[] }))
      ).repositories,
  )
  const candidates = () => (linkable() ?? []).filter((r) => !r.linked)
  const linkRepo = async (key: string) => {
    const r = candidates().find((x) => `${x.provider}:${x.repository}:${x.repoSpace ?? ""}` === key)
    if (!r) return
    try {
      await crow.host.call("linkSource", {
        space: props.space,
        provider: r.provider,
        repository: r.repository,
        name: r.name,
        ...(r.url ? { url: r.url } : {}),
        ...(r.repoSpace ? { repoSpace: r.repoSpace } : {}),
        ...(r.connection ? { connection: r.connection } : {}),
      })
    } catch (e) {
      crow.workbench.toast({ title: "Not linked", body: toRookeryError(e).message, kind: "danger" })
    }
    refetchLinks()
    refetchLinkable()
  }
  const unlinkRepo = async (l: Link) => {
    if (!confirm(`Unlink ${l.name}? Its issues stay in this project and stop syncing.`)) return
    try {
      await crow.host.call("unlinkSource", { id: l.id })
    } catch (e) {
      crow.workbench.toast({ title: "Not unlinked", body: toRookeryError(e).message, kind: "danger" })
    }
    refetchLinks()
    refetchLinkable()
  }

  return (
    <div class="projects__page projects__settings" data-part="project-settings">
      <ViewHeader>
        <span class="nc-meta">{p()?.name}</span>
      </ViewHeader>
      <Show when={p()}>
        {(proj) => (
          <div class="projects__settings-body">
            <section class="projects__section">
              <span class="label">General</span>
              <TextField
                label="Name"
                value={name()}
                disabled={!manage()}
                onInput={(e) => setName(e.currentTarget.value)}
                onBlur={() => name().trim() && name() !== proj().name && update({ name: name() })}
              />
              <TextField
                label="Summary"
                value={summary()}
                disabled={!manage()}
                onInput={(e) => setSummary(e.currentTarget.value)}
                onBlur={() => summary() !== (proj().summary ?? "") && update({ summary: summary() || null })}
              />
              <TextField
                label="Key"
                value={proj().key}
                disabled
                help="Existing keys stay as they are"
                class="mono"
              />
              <Select
                label="Lead"
                value={proj().lead ?? ""}
                disabled={!manage()}
                options={[
                  { value: "", label: "No lead" },
                  ...store.members().map((m) => ({ value: m.uri, label: m.name ?? m.email ?? m.uri })),
                ]}
                onChange={(v) => update({ lead: v || null })}
              />
              <div class="projects__switch-row">
                <Switch
                  checked={!!proj().autoCloseParent}
                  disabled={!manage()}
                  onChange={(v) => update({ autoCloseParent: v })}
                  aria-label="Close a parent when its sub-issues are done"
                  data-testid="auto-close"
                />
                <span>Complete a parent when its sub-issues are done</span>
              </div>
              <div class="projects__switch-row">
                <Switch
                  checked={!!proj().cycleAuto}
                  disabled={!manage()}
                  onChange={(v) => update({ cycleAuto: v })}
                  aria-label="Automatic cycles"
                />
                <span>Start the next cycle when one ends</span>
              </div>
              <Select
                label="Cycle length"
                value={String(proj().cycleWeeks ?? 2)}
                disabled={!manage()}
                options={[1, 2, 3, 4].map((w) => ({
                  value: String(w),
                  label: `${w} week${w === 1 ? "" : "s"}`,
                }))}
                onChange={(v) => update({ cycleWeeks: Number(v) })}
              />
              <div class="nc-row">
                <Button
                  size="sm"
                  variant="secondary"
                  disabled={!manage()}
                  onClick={() => update({ archived: !proj().archived })}
                >
                  {proj().archived ? "Restore the project" : "Archive the project"}
                </Button>
                <Button
                  size="sm"
                  variant="secondary"
                  icon="users"
                  disabled={!manage()}
                  onClick={() => workbenchShare(crow, `space://${props.space}`)}
                >
                  Members and access
                </Button>
                <Button
                  size="sm"
                  variant="secondary"
                  icon="arrow-up-right"
                  disabled={!canUse()}
                  onClick={() => crow.workbench.openView("projects.import")}
                >
                  Import issues
                </Button>
              </div>
            </section>

            <Show when={(links()?.length ?? 0) > 0 || candidates().length > 0}>
              <section class="projects__section" data-part="source-links">
                <span class="label">Linked repositories</span>
                <div class="projects__source-links">
                  <For each={links() ?? []}>
                    {(l) => (
                      <div class="projects__source-row" data-link={l.name}>
                        <a
                          class="projects__source-link"
                          href={l.url ?? undefined}
                          target="_blank"
                          rel="noopener noreferrer"
                        >
                          <Icon name={(sourceKind(l.provider).icon ?? "link") as never} size="sm" />
                          <span class="mono">{l.name}</span>
                        </a>
                        <Show when={manage()}>
                          <IconButton
                            icon="close"
                            label={`Unlink ${l.name}`}
                            onClick={() => void unlinkRepo(l)}
                            data-testid="unlink-source"
                          />
                        </Show>
                      </div>
                    )}
                  </For>
                </div>
                <Show when={manage() && candidates().length > 0}>
                  <Select
                    aria-label="Link a repository"
                    placeholder="Link a repository"
                    value=""
                    options={candidates().map((r) => ({
                      value: `${r.provider}:${r.repository}:${r.repoSpace ?? ""}`,
                      label: r.name,
                      description: r.providerTitle,
                    }))}
                    onChange={(v) => void linkRepo(v)}
                    data-testid="link-source"
                  />
                </Show>
              </section>
            </Show>

            <section class="projects__section" data-part="workflow">
              <span class="label">Workflow</span>
              <For each={CATEGORIES}>
                {(cat) => (
                  <div class="projects__state-group">
                    <span class="section">{CATEGORY_TITLE[cat]}</span>
                    <For each={states().filter((s) => s.category === cat)}>
                      {(s) => (
                        <ContextMenu
                          label={s.name}
                          items={() => [
                            {
                              id: "delete",
                              label: "Delete state",
                              icon: "trash",
                              danger: true,
                              disabled: !canUse() || states().length <= 1,
                            },
                          ]}
                          onSelect={() => setRemoving(s)}
                        >
                          <div class="projects__state-row" data-state={s.id}>
                            <StateIcon category={s.category} color={s.color} />
                            <input
                              onContextMenu={(e) => e.stopPropagation()}
                              class="nc-input projects__state-name"
                              value={s.name}
                              aria-label="State name"
                              disabled={!canUse()}
                              onChange={(e) =>
                                e.currentTarget.value.trim() &&
                                crow.data
                                  .space(props.space)
                                  .states.update(s.id, { name: e.currentTarget.value.trim() } as never)
                              }
                            />
                            <Select
                              aria-label="Colour"
                              value={s.color}
                              disabled={!canUse()}
                              options={HUES.map((h) => ({ value: h, label: h }))}
                              onChange={(v) =>
                                crow.data.space(props.space).states.update(s.id, { color: v } as never)
                              }
                            />
                            <IconButton
                              icon="arrow-up-right"
                              label="Move up"
                              disabled={!canUse()}
                              onClick={() => moveState(s, -1)}
                            />
                          </div>
                        </ContextMenu>
                      )}
                    </For>
                    <Show when={canUse()}>
                      <IconButton
                        label={`Add a ${CATEGORY_TITLE[cat].toLowerCase()} state`}
                        icon="plus"
                        onClick={() => addState(cat)}
                      />
                    </Show>
                  </div>
                )}
              </For>
            </section>

            <section class="projects__section" data-part="labels">
              <span class="label">Labels</span>
              <div class="projects__label-list">
                <For each={store.labels()}>
                  {(l) => (
                    <ContextMenu
                      label={l.name}
                      items={() => [
                        {
                          id: "delete",
                          label: `Delete ${l.name}`,
                          icon: "trash",
                          danger: true,
                          disabled: !canUse(),
                        },
                      ]}
                      onSelect={() => deleteLabel(l)}
                    >
                      {/* biome-ignore lint/a11y/noStaticElementInteractions: Delete removes the row; the context menu and the Menu key are its other entry points */}
                      <span
                        class="projects__label-edit"
                        tabIndex={canUse() ? 0 : undefined}
                        onKeyDown={(e) => {
                          if (canUse() && (e.key === "Delete" || e.key === "Backspace")) {
                            e.preventDefault()
                            deleteLabel(l)
                          }
                        }}
                      >
                        <Label name={l.name} color={l.color} />
                        <span class="nc-meta">{l.scope ? "" : "workspace"}</span>
                      </span>
                    </ContextMenu>
                  )}
                </For>
              </div>
              <Show when={canUse()}>
                <form
                  class="nc-row"
                  onSubmit={async (e) => {
                    e.preventDefault()
                    if (!labelName().trim()) return
                    await crow.data.labels.insert({
                      name: labelName().trim(),
                      color: HUES[store.labels().length % (HUES.length - 1)],
                      scope: labelWide() ? null : `space://${props.space}`,
                    } as never)
                    setLabelName("")
                  }}
                >
                  <input
                    class="nc-input"
                    placeholder="New label"
                    aria-label="New label"
                    value={labelName()}
                    onInput={(e) => setLabelName(e.currentTarget.value)}
                  />
                  <div class="projects__switch-row">
                    <Switch checked={labelWide()} onChange={setLabelWide} aria-label="For every project" />
                    <span class="nc-meta">Every project</span>
                  </div>
                  <Button size="sm" type="submit">
                    Add label
                  </Button>
                </form>
              </Show>
            </section>

            <section class="projects__section" data-part="templates">
              <span class="label">Templates</span>
              <span class="nc-meta">
                A template fills in a new issue: its title, priority, labels, estimate and description.
              </span>
              <For each={store.templates()}>
                {(t) => (
                  <ContextMenu
                    label={t.name}
                    items={() => [
                      {
                        id: "delete",
                        label: "Delete template",
                        icon: "trash",
                        danger: true,
                        disabled: !canUse(),
                      },
                    ]}
                    onSelect={() => crow.data.space(props.space).templates.delete(t.id)}
                  >
                    <div class="projects__template">
                      <Icon name="file" size="sm" />
                      <input
                        onContextMenu={(e) => e.stopPropagation()}
                        class="nc-input"
                        value={t.name}
                        aria-label="Template name"
                        disabled={!canUse()}
                        onChange={(e) =>
                          crow.data
                            .space(props.space)
                            .templates.update(t.id, { name: e.currentTarget.value } as never)
                        }
                      />
                      <input
                        onContextMenu={(e) => e.stopPropagation()}
                        class="nc-input"
                        value={t.title ?? ""}
                        placeholder="Title"
                        aria-label="Template title"
                        disabled={!canUse()}
                        onChange={(e) =>
                          crow.data
                            .space(props.space)
                            .templates.update(t.id, { title: e.currentTarget.value || null } as never)
                        }
                      />
                    </div>
                  </ContextMenu>
                )}
              </For>
              <Show when={canUse()}>
                <form
                  class="nc-row"
                  onSubmit={async (e) => {
                    e.preventDefault()
                    if (!tplName().trim()) return
                    await crow.data
                      .space(props.space)
                      .templates.insert({ name: tplName().trim(), title: `${tplName().trim()}: ` } as never)
                    setTplName("")
                  }}
                >
                  <input
                    class="nc-input"
                    placeholder="New template"
                    aria-label="New template"
                    value={tplName()}
                    onInput={(e) => setTplName(e.currentTarget.value)}
                  />
                  <Button size="sm" type="submit">
                    Add template
                  </Button>
                </form>
              </Show>
            </section>
          </div>
        )}
      </Show>
      <Dialog
        open={!!removing()}
        onClose={() => setRemoving(null)}
        title={`Delete ${removing()?.name ?? "state"}`}
        description="Its issues move to another state first."
        size="sm"
        footer={
          <>
            <Button variant="ghost" onClick={() => setRemoving(null)}>
              Cancel
            </Button>
            <Button
              variant="danger"
              disabled={!moveTo()}
              onClick={async () => {
                try {
                  await crow.host.call("deleteState", {
                    space: props.space,
                    id: removing()!.id,
                    moveTo: moveTo(),
                  })
                  setRemoving(null)
                } catch (e) {
                  crow.workbench.toast({
                    title: "Not deleted",
                    body: toRookeryError(e).message,
                    kind: "danger",
                  })
                }
              }}
            >
              Delete state
            </Button>
          </>
        }
      >
        <Select
          label="Move its issues to"
          value={moveTo()}
          options={states()
            .filter((s) => s.id !== removing()?.id)
            .map((s) => ({ value: s.id, label: s.name }))}
          onChange={setMoveTo}
        />
      </Dialog>
    </div>
  )
}

/** Whether an issue counts as open work (for widgets). */
export const isOpen = (c: Category | null) => !closed(c)

export type { ProjectStore }
