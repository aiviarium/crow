// The Projects plugin's client half: the views (projects, a project's issues as a list or a board, an issue,
// the overview, cycles, my issues, settings, import), the dialogs that open from anywhere (new issue, new
// project, the shortcuts sheet), commands for the palette, widgets and the issue list block for documents.

import { Button, EmptyState } from "@aiviarium/nocturne"
import { type ClientRookery, defineClient, type SpaceInfo } from "@rookery/sdk/client"
import { createEffect, createMemo, createResource, createSignal, on, onCleanup, Show } from "solid-js"
import "./client.css"
import { cycleStatus } from "./lib/cycles"
import { normalizeDisplay } from "./lib/display"
import { normalizeFilter } from "./lib/filter"
import { CreateHost, openCreate } from "./ui/create"
import { CyclesView, CycleView } from "./ui/cycles"
import { IssueCardEmbed, IssueRowEmbed } from "./ui/embed"
import {
  CommentView,
  CycleWidget,
  ImportView,
  IssuesBlock,
  LabelView,
  MineView,
  MyIssuesWidget,
} from "./ui/extras"
import { resolverFor } from "./ui/filters"
import { IssueView } from "./ui/issue"
import { builtinTabs, IssuesSurface, lookupFor, matchContextFor, PROJECT_FIELDS, type Tab } from "./ui/issues"
import { KIND, NewProjectHost, Overview, openNewProject, ProjectSettings, ProjectsHome } from "./ui/project"
import { entitiesOf, registerBlock, registerManifestWidgets, registerWidget, toRookeryError } from "./ui/sdk"
import { openShortcuts, ShortcutsHost } from "./ui/shortcuts"
import { acquire, knowNames, today, useMe } from "./ui/store"

export default defineClient((crow) => {
  // The projects the person can see: spaces of the project kind.
  const [tick, setTick] = createSignal(0)
  // The list being read, so a dialog opened by a key pressed at once after the page loaded can wait for it.
  let listing: Promise<unknown> = Promise.resolve()
  const [spaces] = createResource(tick, () => (listing = crow.spaces.list().catch(() => [] as SpaceInfo[])))
  const projects = createMemo(() => (spaces.latest ?? []).filter((s) => s.kind === KIND))
  const refreshProjects = () => setTick((t) => t + 1)
  setInterval(refreshProjects, 20_000)
  // New projects appear when the window changes space too.
  createEffect(on(() => crow.spaces.current()?.id, refreshProjects, { defer: true }))

  const isProject = (s: SpaceInfo | null | undefined) => s?.kind === KIND

  // The sidebar: Projects is a level listing the projects; each drills into its pages and saved views.
  const [savedViews] = createResource(
    () => projects().map((p) => p.id),
    async (ids) => {
      const out: Record<string, Array<{ id: string; name: string }>> = {}
      await Promise.all(
        ids.map(async (id) => {
          const { rows } = await crow.data
            .space(id)
            .views.find({ limit: 50 })
            .catch(() => ({ rows: [] as unknown[] }))
          out[id] = (rows as Array<{ id: string; name: string; deletedAt?: string }>).filter(
            (v) => !v.deletedAt,
          )
        }),
      )
      return out
    },
  )
  crow.nav.section("projects.sidebar", {
    items: () =>
      projects().map((p) => {
        const context = { "rookery.space": p.slug }
        return {
          id: p.slug,
          title: p.name,
          group: "Projects",
          children: [
            { id: "overview", title: "Overview", icon: "home", view: "projects.overview", context },
            { id: "issues", title: "Issues", icon: "list", view: "projects.issues", context },
            { id: "cycles", title: "Cycles", icon: "clock", view: "projects.cycles", context },
            { id: "docs", title: "Docs", icon: "book-open", view: "docs.home", context },
            ...(savedViews.latest?.[p.id] ?? []).map((v) => ({
              id: `view:${v.id}`,
              title: v.name,
              icon: "filter",
              view: "projects.issues",
              path: v.id,
              context,
              group: "Views",
            })),
          ],
        }
      }),
  })

  // Dialogs that open from anywhere live in a status bar item that renders nothing of its own. The shell
  // may mount the item more than once (it remounts status items as others register): one instance at a
  // time holds the dialogs, and another takes over when it goes away.
  const [holder, setHolder] = createSignal<number | null>(null)
  let instances = 0
  crow.workbench.statusItem("projects.overlays", () => {
    const me = ++instances
    createEffect(() => {
      if (holder() === null) setHolder(me)
    })
    onCleanup(() => {
      if (holder() === me) setHolder(null)
    })
    return (
      <Show when={holder() === me}>
        <CreateHost crow={crow} projects={projects} settled={() => listing} />
        <NewProjectHost
          crow={crow}
          onCreated={(s) => {
            refreshProjects()
            crow.workbench.toast({ title: `Created ${s.name}`, kind: "success" })
            // The new project's issues, through the shell's router (no page load).
            history.pushState(null, "", `/${s.slug}/projects/issues`)
            dispatchEvent(new PopStateEvent("popstate"))
          }}
        />
        <ShortcutsHost />
      </Show>
    )
  })

  /** Shown by views that need a project when the window is in another space. */
  const PickProject = (props: { view: string }) => (
    <div class="projects__page">
      <EmptyState icon="board" title="Open a project" description="This view belongs to a project.">
        <div class="projects__pick">
          {projects().map((p) => (
            <Button variant="secondary" href={`/${p.slug}/projects/${props.view}`}>
              {p.name}
            </Button>
          ))}
          <Button variant="secondary" icon="plus" onClick={openNewProject}>
            New project
          </Button>
        </div>
      </EmptyState>
    </div>
  )

  crow.views.register("projects.home", (props) => {
    props.view.setTitle("Projects")
    refreshProjects()
    return <ProjectsHome crow={crow} projects={projects} loading={spaces.loading} />
  })

  crow.views.register("projects.issues", (props) => {
    const space = () => props.view.space ?? crow.spaces.current()
    return (
      <Show when={isProject(space()) && space()} keyed fallback={<PickProject view="issues" />}>
        {(s) => (
          <ProjectIssues crow={crow} space={s.id} path={props.view.path} setTitle={props.view.setTitle} />
        )}
      </Show>
    )
  })

  crow.views.register("projects.issue", (props) => (
    <IssueView
      crow={crow}
      path={props.view.path}
      space={props.view.space?.id ?? null}
      setTitle={props.view.setTitle}
      setDirty={props.view.setDirty}
    />
  ))

  /** The project space a view is for: its path names a project row, else the window's space. */
  const spaceForProject = (path: string, fallback: SpaceInfo | null | undefined) =>
    createResource(
      () => path || fallback?.id || "",
      async () => {
        if (path) {
          const e = await entitiesOf(crow)
            .resolve(`project://${path}`)
            .catch(() => null)
          if (e?.spaceId) return e.spaceId
        }
        return isProject(fallback) ? fallback!.id : null
      },
    )[0]

  crow.views.register("projects.overview", (props) => {
    const space = spaceForProject(props.view.path, props.view.space ?? crow.spaces.current())
    return (
      <Show
        when={space()}
        keyed
        fallback={
          <Show when={!space.loading}>
            <PickProject view="overview" />
          </Show>
        }
      >
        {(s) => <Overview crow={crow} space={s} setTitle={props.view.setTitle} />}
      </Show>
    )
  })

  crow.views.register("projects.settings", (props) => {
    props.view.setTitle("Project settings")
    const space = () => props.view.space ?? crow.spaces.current()
    return (
      <Show when={isProject(space()) && space()} keyed fallback={<PickProject view="settings" />}>
        {(s) => <ProjectSettings crow={crow} space={s.id} />}
      </Show>
    )
  })

  crow.views.register("projects.cycles", (props) => {
    const space = () => props.view.space ?? crow.spaces.current()
    return (
      <Show when={isProject(space()) && space()} keyed fallback={<PickProject view="cycles" />}>
        {(s) => <CyclesView crow={crow} space={s.id} setTitle={props.view.setTitle} />}
      </Show>
    )
  })

  crow.views.register("projects.cycle", (props) => {
    const [space] = createResource(
      () => props.view.path,
      async (id) =>
        (
          await entitiesOf(crow)
            .resolve(`cycle://${id}`)
            .catch(() => null)
        )?.spaceId ??
        props.view.space?.id ??
        null,
    )
    return (
      <Show
        when={space()}
        keyed
        fallback={
          <Show when={!space.loading}>
            <EmptyState icon="clock" title="This cycle is not available" />
          </Show>
        }
      >
        {(s) => <CycleView crow={crow} space={s} id={props.view.path} setTitle={props.view.setTitle} />}
      </Show>
    )
  })

  crow.views.register("projects.mine", (props) => {
    refreshProjects()
    return (
      <MineView crow={crow} projects={projects} loading={spaces.loading} setTitle={props.view.setTitle} />
    )
  })

  crow.views.register("projects.import", (props) => (
    <ImportView
      crow={crow}
      space={(props.view.space ?? crow.spaces.current())?.id ?? null}
      projects={projects}
      setTitle={props.view.setTitle}
    />
  ))

  crow.views.register("projects.label", (props) => (
    <LabelView crow={crow} id={props.view.path} projects={projects} setTitle={props.view.setTitle} />
  ))
  crow.views.register("projects.comment", (props) => <CommentView crow={crow} id={props.view.path} />)

  // ── commands ──────────────────────────────────────────────────────────────────────────────────────

  crow.commands.register("projects.newIssue", {
    title: "New issue",
    run: () => {
      openCreate()
    },
  })
  crow.commands.register("projects.newProject", {
    title: "New project",
    run: () => {
      openNewProject()
    },
  })
  crow.commands.register("projects.open", {
    title: "Open projects",
    run: () => crow.workbench.openView("projects.home"),
  })
  crow.commands.register("projects.myIssues", {
    title: "My issues",
    run: () => crow.workbench.openView("projects.mine"),
  })
  crow.commands.register("projects.shortcuts", {
    title: "Projects keyboard shortcuts",
    run: () => openShortcuts(),
  })
  crow.commands.register("projects.import", {
    title: "Import issues",
    run: () => crow.workbench.openView("projects.import"),
  })
  crow.commands.register("projects.currentCycle", {
    title: "Go to the current cycle",
    async run() {
      const cur = crow.spaces.current()
      const list = isProject(cur) ? [cur!, ...projects().filter((p) => p.id !== cur!.id)] : projects()
      for (const p of list) {
        const { rows } = await crow.data.space(p.id).cycles.find({ where: { closed: false }, limit: 100 })
        const c = (rows as any[]).find((x) => cycleStatus(x, today()) === "current")
        if (c) return entitiesOf(crow).open(`cycle://${c.id}`)
      }
      crow.workbench.toast({
        title: "No current cycle",
        body: "None of your projects has a cycle running today.",
        kind: "info",
      })
    },
  })

  // ── widgets and the block ─────────────────────────────────────────────────────────────────────────

  registerManifestWidgets(crow)
  registerWidget(crow, "projects.myIssues", (props) => (
    <MyIssuesWidget
      crow={crow}
      projects={projects}
      limit={Math.min(Number(props.widget.settings.limit ?? 8), Math.max(1, props.widget.size.h * 2 - 2))}
    />
  ))
  registerWidget(crow, "projects.cycle", (props) => (
    <CycleWidget
      crow={crow}
      projects={projects}
      projectKey={String(props.widget.settings.project ?? "")}
      editing={props.widget.editing}
    />
  ))
  // An issue looks the same wherever it shows as a card or a row: a document's database, a search.
  const entities = entitiesOf(crow)
  entities.card("issue", (p) => <IssueCardEmbed crow={crow} p={p} />)
  entities.row("issue", (p) => <IssueRowEmbed crow={crow} p={p} />)
  registerBlock(crow, "projects.issues", (props) => (
    <IssuesBlock
      crow={crow}
      projects={projects}
      attrs={props.attrs}
      setAttrs={props.setAttrs}
      readOnly={props.readOnly}
    />
  ))
})

/** A project's issues: the built-in tabs and the saved views, as a list or a board. */
function ProjectIssues(props: {
  crow: ClientRookery
  space: string
  path: string
  setTitle: (t: string) => void
}) {
  const crow = props.crow
  const { store, release } = acquire(crow, props.space)
  onCleanup(release)
  const me = useMe(crow)
  createEffect(() => knowNames(store.members()))
  createEffect(() => props.setTitle(`${store.project()?.name ?? "Project"} · Issues`))
  const tabs = createMemo<Tab[]>(() => [
    ...builtinTabs(),
    ...store
      .views()
      .filter((v) => !(v as { deletedAt?: string }).deletedAt)
      .map((v) => ({
        id: v.id,
        name: v.name,
        filter: normalizeFilter(v.filter),
        view: { id: v.id, personal: v.personal, display: normalizeDisplay(v.display) },
      })),
  ])
  const [tab, setTab] = createSignal(props.path || "all")
  createEffect(
    on(
      () => props.path,
      (p) => p && setTab(p),
      { defer: true },
    ),
  )
  const canWrite = () => store.level() === "use" || store.level() === "manage" || !!me()?.admin
  return (
    <IssuesSurface
      crow={crow}
      store={store}
      issues={() => store.issues().filter((i) => !i.deletedAt)}
      storeOf={(s) => (s === store.space ? store : null)}
      lookup={lookupFor(crow, store)}
      resolver={resolverFor(crow, store)}
      fields={PROJECT_FIELDS}
      tabs={tabs()}
      tab={tabs().some((t) => t.id === tab()) ? tab() : "all"}
      setTab={setTab}
      displayKey={`projects.display.${props.space}`}
      head={
        <span class="projects__crumbs">
          <button
            type="button"
            class="projects__crumb"
            onClick={() => crow.workbench.openView("projects.overview")}
          >
            {store.project()?.name ?? "…"}
          </button>
          <span class="nc-meta">›</span>
          <span class="label">Issues</span>
        </span>
      }
      onOpen={(i) => crow.workbench.openView("projects.issue", { path: i.key })}
      canWrite={() => canWrite()}
      matchContext={matchContextFor(me, () => [store])}
      loading={store.loading() && !store.issues().length}
      onSaveView={async (v) => {
        try {
          if (v.id)
            await crow.data
              .space(props.space)
              .views.update(v.id, { filter: v.filter, display: v.display } as never)
          else {
            const row = (await crow.data.space(props.space).views.insert({
              name: v.name,
              personal: v.personal,
              filter: v.filter,
              display: v.display,
            } as never)) as unknown as { id: string }
            setTab(row.id)
          }
          crow.workbench.toast({ title: v.id ? "View updated" : `Saved ${v.name}`, kind: "success" })
        } catch (e) {
          crow.workbench.toast({
            title: "The view was not saved",
            body: toRookeryError(e).message,
            kind: "danger",
          })
        }
      }}
      onDeleteView={async (id) => {
        await crow.data.space(props.space).views.delete(id)
        setTab("all")
      }}
    />
  )
}
