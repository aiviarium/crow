// The dashboards plugin's client half: the list of a space's dashboards, and a dashboard, a grid of widgets
// that is arranged by dragging and resizing (`WidgetArea`). Everything is stored with the data layer: a
// dashboard is a row of a collection, so it is shared with the space it is in, found by search, pinned,
// mentioned and kept in the trash like any entity, and another person who has it open sees changes live.
import { Button, EmptyState, IconButton, TextField, ViewHeader } from "@aiviarium/nocturne"
import type { PluginList } from "@rookery/client"
import { type ClientRookery, defineClient, type Live } from "@rookery/sdk/client"
import { type Component, createEffect, createMemo, createSignal, For, on, onCleanup, Show } from "solid-js"
import {
  registerManifestWidgets,
  WidgetArea,
  type WidgetAreaProps,
  type WidgetInstance,
  type Widgets,
} from "./widgets"
import "./client.css"

type Dashboard = {
  id: string
  title: string
  description: string | null
  layout: WidgetInstance[] | null
  rev: number
  updatedAt: string
}

type RookeryWithOptionalExtensions = ClientRookery & {
  widgets?: Widgets
  workbench: ClientRookery["workbench"] & {
    share?: (uri: string) => void
  }
}

const SAVE_DELAY_MS = 350

/** Loads `contributes.widgets` from active plugins advertised by `plugins.list` into the shared widget registry. */
async function syncManifestWidgets(rookery: ClientRookery): Promise<void> {
  try {
    const res = await rookery.rpc.call<PluginList>("plugins.list")
    for (const plugin of res?.plugins ?? []) {
      const widgets = plugin?.manifest?.contributes?.widgets
      if (widgets && widgets.length > 0) {
        registerManifestWidgets(plugin.id, widgets)
      }
    }
  } catch {
    // Pre-M2 servers without `plugins.list`: plugins still register their own widgets when loaded.
  }
}

export default defineClient((rookery) => {
  const rk = rookery as RookeryWithOptionalExtensions
  const Area: Component<WidgetAreaProps> = rk.widgets?.Area ?? WidgetArea
  void syncManifestWidgets(rookery)

  const open = (id: string, editing = false) =>
    rookery.workbench.openView("dashboards.dashboard", {
      path: id,
      params: editing ? { edit: "1" } : undefined,
    })

  const create = async (title = "Untitled dashboard") => {
    try {
      const row = await rookery.data.dashboards.insert({ title, layout: [] })
      open(row.id, true)
    } catch (e) {
      rookery.workbench.toast({
        title: "Could not create dashboard",
        body: (e as Error).message,
        kind: "danger",
      })
    }
  }

  rookery.commands.register("dashboards.create", { run: () => create() })
  rookery.commands.register("dashboards.open", {
    run: () => rookery.workbench.openView("dashboards.list"),
  })

  rookery.views.register("dashboards.list", (props) => {
    props.view.setTitle("Dashboards")
    const rows = rookery.data.dashboards.live({
      orderBy: [["updatedAt", "desc"]],
      limit: 200,
    }) as unknown as Live<Dashboard>
    const space = () => rookery.spaces.current()
    return (
      <div class="dashboards" data-part="dashboards-list">
        <ViewHeader>
          <span class="nc-meta">{space()?.name}</span>
          <span class="dashboards__spacer" />
          <IconButton
            label="New dashboard"
            icon="plus"
            data-testid="new-dashboard"
            onClick={() => void create()}
          />
        </ViewHeader>
        <Show
          when={rows().length > 0 || rows.loading}
          fallback={
            <EmptyState
              icon="grid"
              title="No dashboards in this space yet"
              description={
                space()?.personal
                  ? "Dashboards here are yours alone. Switch to a team space to make one for everyone in it."
                  : "Dashboards here are shared with the members of the space."
              }
            >
              <Button variant="secondary" icon="plus" onClick={() => void create()}>
                New dashboard
              </Button>
            </EmptyState>
          }
        >
          <ul class="dashboards__list" aria-label="Dashboards">
            <For each={rows()}>
              {(d) => (
                <li>
                  <button
                    type="button"
                    class="dashboards__item"
                    data-dashboard={d.id}
                    onClick={() => open(d.id)}
                  >
                    <span class="label dashboards__title">{d.title}</span>
                    <span class="nc-meta">{(d.layout as WidgetInstance[] | null)?.length ?? 0} widgets</span>
                  </button>
                </li>
              )}
            </For>
          </ul>
        </Show>
      </div>
    )
  })

  rookery.views.register("dashboards.dashboard", (props) => {
    const id = props.view.path
    const live = rookery.data.dashboards.live({ where: { id } }) as unknown as Live<Dashboard>
    const row = createMemo(() => live()[0])
    const [editing, setEditing] = createSignal(props.view.params.edit === "1")
    // What the person is arranging right now, until it is saved; the stored layout otherwise.
    const [local, setLocal] = createSignal<WidgetInstance[] | null>(null)
    const [title, setTitle] = createSignal<string | null>(null)
    const [saving, setSaving] = createSignal(false)
    let timer: ReturnType<typeof setTimeout> | undefined

    const layout = () => local() ?? (row()?.layout as WidgetInstance[] | null) ?? []
    createEffect(() => {
      const r = row()
      if (r) props.view.setTitle(r.title)
    })
    // The revision our last save made: what is shown stays ours until the live row has caught up with it,
    // so a widget does not vanish and come back between the save and its echo (or under a drag).
    let savedRev: number | null = null
    // Another person's change shows unless this window has changes of its own waiting to be saved.
    createEffect(
      on(
        () => row()?.rev,
        (rev) => {
          if (timer) return
          if (savedRev !== null && (rev ?? 0) < savedRev) return
          savedRev = null
          setLocal(null)
          setTitle(null)
        },
        { defer: true },
      ),
    )

    const flush = async () => {
      timer = undefined
      const patch: Record<string, unknown> = {}
      if (local()) patch.layout = local()
      if (title() !== null) patch.title = title()
      if (!Object.keys(patch).length) return
      setSaving(true)
      try {
        savedRev = (await rookery.data.dashboards.update(id, patch)).rev
      } catch (e) {
        rookery.workbench.toast({
          title: "Could not save the dashboard",
          body: (e as Error).message,
          kind: "danger",
        })
      } finally {
        setSaving(false)
      }
    }
    const later = () => {
      clearTimeout(timer)
      timer = setTimeout(() => void flush(), SAVE_DELAY_MS)
    }
    onCleanup(() => {
      if (timer) {
        clearTimeout(timer)
        void flush()
      }
    })

    const change = (next: WidgetInstance[]) => {
      setLocal(next)
      later()
    }
    const done = async () => {
      clearTimeout(timer)
      await flush()
      setEditing(false)
    }
    const space = () => rookery.spaces.current()
    const shareSpace = () => {
      const s = space()
      if (!s) return
      if (rk.workbench.share) {
        rk.workbench.share(`space://${s.id}`)
      } else {
        rookery.workbench.toast({
          title: "Space sharing is not available yet",
          body: "Sharing dialogs arrive with Rookery spaces (M2b).",
          kind: "info",
        })
      }
    }
    return (
      <div class="dashboards" data-part="dashboard" data-editing={editing() ? "" : undefined}>
        <Show
          when={row()}
          fallback={
            <Show when={!live.loading}>
              <EmptyState
                icon="grid"
                title="This dashboard is not available"
                description="It was deleted, or it is not shared with you."
              />
            </Show>
          }
        >
          {(r) => (
            <>
              <ViewHeader class="dashboards__header">
                <Show when={editing()}>
                  <TextField
                    aria-label="Dashboard title"
                    placeholder="Dashboard title"
                    class="dashboards__title-field"
                    data-testid="dashboard-title"
                    value={title() ?? r().title}
                    onInput={(e) => {
                      setTitle(e.currentTarget.value)
                      later()
                    }}
                  />
                </Show>
                <span class="nc-meta">
                  {space()?.personal ? "Only you" : `Shared with ${space()?.name ?? "the space"}`}
                </span>
                <span class="dashboards__spacer" />
                <Show when={saving()}>
                  <span class="nc-meta" data-testid="dashboard-saving">
                    Saving…
                  </span>
                </Show>
                <Show when={!space()?.personal && space()}>
                  <IconButton label="Share the space" icon="users" onClick={shareSpace} />
                </Show>
                <Show
                  when={editing()}
                  fallback={
                    <Button
                      variant="secondary"
                      icon="edit"
                      data-testid="edit-dashboard"
                      onClick={() => setEditing(true)}
                    >
                      Edit
                    </Button>
                  }
                >
                  <Button variant="primary" icon="check" data-testid="done-dashboard" onClick={done}>
                    Done
                  </Button>
                </Show>
              </ViewHeader>
              <div class="dashboards__body">
                <Area
                  area="dashboard"
                  label={r().title}
                  instances={layout()}
                  editing={editing()}
                  onChange={change}
                />
              </div>
            </>
          )}
        </Show>
      </div>
    )
  })
})
