// Resolved entities, opening an entity in the view its plugin declares, and the `<EntityChip>` and
// `<MentionPicker>` components the shell hands to plugins through `rookery.entities`.
import { ICON_PATHS, Icon, type IconName, Popover } from "@aiviarium/nocturne"
import type { Connection, EntityInfo, EntityList, PluginInfo, SpaceInfo } from "@rookery/client"
import type { EntityChipProps, MentionPickerProps } from "@rookery/sdk/client"
import { createEffect, createResource, createSignal, For, type JSX, onCleanup, Show } from "solid-js"
import type { ShellApp } from "./state"

export function splitUri(uri: string): { scheme: string; id: string } {
  const at = uri.indexOf("://")
  return at < 0 ? { scheme: "", id: uri } : { scheme: uri.slice(0, at), id: uri.slice(at + 3) }
}

export function entityType(plugins: Readonly<Record<string, PluginInfo>>, scheme: string) {
  for (const p of Object.values(plugins)) {
    const t = p?.manifest?.contributes?.entityTypes?.find((e) => e.scheme === scheme)
    if (t) return { plugin: p.id, type: t }
  }
  return undefined
}

const KERNEL_ICONS: Record<string, IconName> = {
  user: "user",
  group: "users",
  space: "layers",
  env: "server",
  terminal: "terminal",
  session: "agent",
  job: "activity",
  document: "file",
  connection: "link",
  plugin: "grid",
}

const isIcon = (name: string) => Object.hasOwn(ICON_PATHS, name)

export function iconFor(plugins: Readonly<Record<string, PluginInfo>>, scheme: string): IconName {
  return (entityType(plugins, scheme)?.type.icon as IconName | undefined) ?? KERNEL_ICONS[scheme] ?? "link"
}

export function typeTitle(plugins: Readonly<Record<string, PluginInfo>>, scheme: string): string {
  return entityType(plugins, scheme)?.type.title ?? scheme
}

export interface EntityStore {
  resolve(uri: string): Promise<EntityInfo | null>
  invalidate(uri?: string): void
  open(uri: string): void
  EntityChip(props: EntityChipProps): JSX.Element
  MentionPicker(props: MentionPickerProps): JSX.Element
}

export function createEntityStore(getApp: () => ShellApp, conn: Connection): EntityStore {
  const cache = new Map<string, Promise<EntityInfo | null>>()
  let batch = new Map<string, (e: EntityInfo | null) => void>()
  let timer: ReturnType<typeof setTimeout> | undefined

  const flush = async () => {
    timer = undefined
    const pending = batch
    batch = new Map()
    const uris = [...pending.keys()]
    if (!uris.length) return
    try {
      const { entities } = await conn.call<EntityList>("entities.resolveMany", { uris })
      const byUri = new Map((entities ?? []).map((e) => [e.uri, e]))
      for (const [uri, resolve] of pending) resolve(byUri.get(uri) ?? null)
    } catch {
      for (const [uri, resolve] of pending) {
        cache.delete(uri)
        resolve(null)
      }
    }
  }

  const resolve = (uri: string): Promise<EntityInfo | null> => {
    const hit = cache.get(uri)
    if (hit) return hit
    const p = new Promise<EntityInfo | null>((res) => {
      batch.set(uri, res)
      if (!timer) timer = setTimeout(() => void flush(), 5)
    })
    cache.set(uri, p)
    return p
  }

  const invalidate = (uri?: string) => {
    if (uri) cache.delete(uri)
    else cache.clear()
  }

  const open = (uri: string) => {
    const app = getApp()
    if (/^https?:\/\//.test(uri)) {
      app.goExternal(uri)
      return
    }
    const { scheme, id } = splitUri(uri)
    if (!scheme || !id) return
    if (scheme === "job") {
      app.navigate(`/jobs/${encodeURIComponent(id)}`)
      return
    }
    const decl = entityType(app.loader.plugins, scheme)?.type
    const view = decl?.view
    if (!view) {
      app.navigate(`/e/${scheme}/${encodeURIComponent(id)}`)
      return
    }
    void resolve(uri)
      .then(async (e) => {
        if (e?.spaceId && app.spaces.current()?.id !== e.spaceId) {
          const existing = app.spaces.list().find((s) => s.id === e.spaceId)
          const target =
            existing ?? (await conn.call<SpaceInfo>("spaces.get", { space: e.spaceId }).catch(() => null))
          if (target) await app.spaces.enter(target)
        }
      })
      .catch(() => {})
      .finally(() => {
        app.openView(view, { path: id })
      })
  }

  const EntityChip = (props: EntityChipProps): JSX.Element => {
    const [entity] = createResource(() => props.uri, resolve)
    const parts = () => splitUri(props.uri)
    const missing = () => !entity.loading && !entity()
    const title = () => entity()?.title || props.label || props.uri
    const icon = () => {
      const own = entity()?.icon
      const plugins = getApp().loader.plugins
      return own && isIcon(own) ? (own as IconName) : iconFor(plugins, parts().scheme)
    }
    const inner = () => (
      <>
        <Icon name={icon()} size="sm" />
        <span class="crow-entity-chip__title">{missing() && props.label ? props.label : title()}</span>
      </>
    )
    return (
      <Show
        when={!props.plain && !missing()}
        fallback={
          <span
            class="nc-chip crow-entity-chip"
            data-entity={props.uri}
            data-state={missing() ? "dangling" : "plain"}
            title={missing() ? "Not available: deleted, or not shared with you" : undefined}
          >
            {inner()}
          </span>
        }
      >
        <a
          class="nc-chip crow-entity-chip"
          data-entity={props.uri}
          href={`/e/${parts().scheme}/${encodeURIComponent(parts().id)}`}
          onClick={(ev) => {
            ev.preventDefault()
            open(props.uri)
          }}
        >
          {inner()}
        </a>
      </Show>
    )
  }

  const MentionPicker = (props: MentionPickerProps): JSX.Element => {
    const [active, setActive] = createSignal(0)
    const [results] = createResource(
      () => (props.open ? { text: props.query, schemes: props.schemes } : null),
      async (q) => {
        const r = await conn.call<EntityList>("entities.search", {
          text: q.text,
          ...(q.schemes ? { schemes: q.schemes } : {}),
          limit: 8,
        })
        return r?.entities ?? []
      },
    )
    const items = () => results.latest ?? []
    createEffect(() => {
      items()
      setActive(0)
    })
    const pick = (e: EntityInfo | undefined) => {
      if (e) props.onPick(e)
    }
    const onKey = (ev: KeyboardEvent) => {
      if (!props.open) return
      const n = items().length
      if (ev.key === "ArrowDown" && n) setActive((a) => (a + 1) % n)
      else if (ev.key === "ArrowUp" && n) setActive((a) => (a - 1 + n) % n)
      else if ((ev.key === "Enter" || ev.key === "Tab") && n) pick(items()[active()])
      else if (ev.key === "Escape") props.onClose()
      else return
      ev.preventDefault()
      ev.stopPropagation()
    }
    if (typeof document !== "undefined") {
      document.addEventListener("keydown", onKey, true)
      onCleanup(() => document.removeEventListener("keydown", onKey, true))
    }
    return (
      <Popover
        open={props.open}
        anchor={props.anchor}
        onClose={props.onClose}
        placement="bottom-start"
        class="crow-mention-picker"
        data-part="mention-picker"
      >
        <div role="listbox" aria-label="Mention" class="crow-mention-picker__list">
          <Show
            when={items().length}
            fallback={
              <span class="nc-meta crow-mention-picker__empty">
                {results.loading
                  ? "Searching…"
                  : props.query.trim()
                    ? "Nothing matches"
                    : "Nothing to suggest yet"}
              </span>
            }
          >
            <For each={items()}>
              {(e, i) => (
                <button
                  type="button"
                  role="option"
                  class="crow-mention-picker__item"
                  aria-selected={i() === active()}
                  data-entity={e.uri}
                  onMouseEnter={() => setActive(i())}
                  onMouseDown={(ev) => ev.preventDefault()}
                  onClick={() => pick(e)}
                >
                  <Icon name={iconFor(getApp().loader.plugins, e.scheme)} size="sm" />
                  <span class="crow-mention-picker__title label">{e.title}</span>
                  <span class="nc-meta">{typeTitle(getApp().loader.plugins, e.scheme)}</span>
                </button>
              )}
            </For>
          </Show>
        </div>
      </Popover>
    )
  }

  return { resolve, invalidate, open, EntityChip, MentionPicker }
}
