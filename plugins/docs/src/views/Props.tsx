// Typed page properties at the top of a page. Definitions shared by the pages under one parent (the parent's
// `schema`: what an inline database of those pages shows) come first, then the page's own (`localSchema`).
// Values are saved on the page with its `links` (relations and people, for the reference index).
import { Checkbox, Icon, Menu, Popover } from "@aiviarium/nocturne"
import { createSignal, For, type JSX, Show } from "solid-js"
import {
  display,
  formatDate,
  HUES,
  type Hue,
  linksOf,
  newId,
  PROP_TYPES,
  type PropDef,
  type Props,
  type PropType,
  setProps,
} from "../lib/props"
import type { ClientRookeryWithDocs } from "../types"
import type { Page } from "./api"
import { ask, confirmAsk } from "./ask"
import { EntityChip, EntityMentionPicker } from "./Entity"

export interface PropsModel {
  page: () => Page
  /** The parent page, when the page has one the caller can see. */
  parent: () => Page | null
  shared: () => PropDef[]
  local: () => PropDef[]
  readOnly: () => boolean
}

const typeIcon = (t: PropType) => PROP_TYPES.find((x) => x.type === t)?.icon ?? "tag"

export function OptionChip(props: { name: string; hue?: Hue | null | undefined }): JSX.Element {
  return (
    <span class="docs-opt label" data-hue={props.hue && props.hue !== "neutral" ? props.hue : undefined}>
      {props.name}
    </span>
  )
}

/** A value shown read-only, as tables and cards show it. */
export function PropValue(props: {
  rookery: ClientRookeryWithDocs
  def: PropDef
  value: unknown
}): JSX.Element {
  const v = () => props.value
  return (
    <Show
      when={v() !== undefined && v() !== null && v() !== ""}
      fallback={<span class="docs-prop__empty">Empty</span>}
    >
      {(() => {
        switch (props.def.type) {
          case "select": {
            const o = () => props.def.options?.find((x) => x.id === v())
            return <OptionChip name={o()?.name ?? String(v())} hue={o()?.hue} />
          }
          case "multi":
            return (
              <span class="docs-prop__chips">
                <For each={(Array.isArray(v()) ? v() : [v()]) as string[]}>
                  {(id) => {
                    const o = props.def.options?.find((x) => x.id === id)
                    return <OptionChip name={o?.name ?? id} hue={o?.hue} />
                  }}
                </For>
              </span>
            )
          case "checkbox":
            return <Checkbox checked={v() === true} disabled aria-label={props.def.name} />
          case "date":
            return <span class="docs-prop__text">{formatDate(String(v()))}</span>
          case "url":
            return (
              <a class="docs-prop__link" href={String(v())} target="_blank" rel="noreferrer">
                {String(v()).replace(/^https?:\/\//, "")}
              </a>
            )
          case "person":
          case "relation":
            return (
              <span class="docs-prop__chips">
                <For each={(Array.isArray(v()) ? v() : [v()]) as string[]}>
                  {(uri) => <EntityChip rookery={props.rookery} uri={uri} />}
                </For>
              </span>
            )
          case "number":
            return <span class="docs-prop__text docs-num">{display(props.def, v())}</span>
          default:
            return <span class="docs-prop__text">{String(v())}</span>
        }
      })()}
    </Show>
  )
}

/** Picks an entity (a person, or anything) for a person or relation property. */
function EntityPick(props: {
  rookery: ClientRookeryWithDocs
  schemes?: string[]
  onPick: (uri: string) => void
  onClose: () => void
}): JSX.Element {
  const [q, setQ] = createSignal("")
  const [input, setInput] = createSignal<HTMLInputElement>()
  return (
    <div class="docs-pick">
      <input
        ref={(el) => {
          setInput(el)
          queueMicrotask(() => el.focus())
        }}
        class="nc-input docs-pick__input"
        placeholder={props.schemes?.includes("user") ? "Find a person" : "Find a page, issue, person…"}
        aria-label="Search"
        value={q()}
        onInput={(e) => setQ(e.currentTarget.value)}
        onKeyDown={(e) => e.key === "Escape" && props.onClose()}
      />
      <EntityMentionPicker
        rookery={props.rookery}
        query={q()}
        anchor={input()}
        open={true}
        {...(props.schemes ? { schemes: props.schemes } : {})}
        onPick={(e) => props.onPick(e.uri)}
        onClose={props.onClose}
      />
    </div>
  )
}

/** Edits one value in place. */
export function PropEditor(props: {
  rookery: ClientRookeryWithDocs
  def: PropDef
  value: unknown
  readOnly: boolean
  onChange: (v: unknown) => void
  onDefChange: (def: PropDef) => void
}): JSX.Element {
  const [open, setOpen] = createSignal(false)
  const [editing, setEditing] = createSignal(false)
  let anchor!: HTMLButtonElement
  const v = () => props.value
  const list = () => (Array.isArray(v()) ? (v() as string[]) : v() ? [String(v())] : [])

  if (props.def.type === "checkbox")
    return (
      <Checkbox
        checked={v() === true}
        disabled={props.readOnly}
        aria-label={props.def.name}
        onChange={(c: boolean) => props.onChange(c)}
      />
    )

  const textLike =
    props.def.type === "text" ||
    props.def.type === "number" ||
    props.def.type === "url" ||
    props.def.type === "date"
  if (textLike)
    return (
      <Show
        when={editing() && !props.readOnly}
        fallback={
          <button
            type="button"
            class="docs-prop__value"
            disabled={props.readOnly}
            onClick={() => setEditing(true)}
            aria-label={`Edit ${props.def.name}`}
          >
            <PropValue rookery={props.rookery} def={props.def} value={v()} />
          </button>
        }
      >
        <input
          class="nc-input docs-prop__input"
          type={
            props.def.type === "number"
              ? "number"
              : props.def.type === "date"
                ? "date"
                : props.def.type === "url"
                  ? "url"
                  : "text"
          }
          aria-label={props.def.name}
          value={v() === undefined || v() === null ? "" : String(v())}
          ref={(el) => queueMicrotask(() => el.focus())}
          onKeyDown={(e) => {
            if (e.key === "Enter") e.currentTarget.blur()
            if (e.key === "Escape") setEditing(false)
          }}
          onBlur={(e) => {
            setEditing(false)
            const next = e.currentTarget.value
            if (next !== String(v() ?? "")) props.onChange(next)
          }}
        />
      </Show>
    )

  const optionMenu = () => {
    const items = (props.def.options ?? []).map((o) => ({
      id: o.id,
      label: o.name,
      checked: list().includes(o.id),
    }))
    return [
      ...items,
      ...(items.length ? [{ type: "separator" as const }] : []),
      { id: "__new", label: "New option…", icon: "plus" as const },
      ...(list().length ? [{ id: "__clear", label: "Clear", icon: "close" as const }] : []),
    ]
  }

  return (
    <>
      <button
        ref={anchor}
        type="button"
        class="docs-prop__value"
        disabled={props.readOnly}
        aria-haspopup="menu"
        aria-label={`Edit ${props.def.name}`}
        onClick={() => setOpen(true)}
      >
        <PropValue rookery={props.rookery} def={props.def} value={v()} />
      </button>
      <Popover open={open()} anchor={anchor} onClose={() => setOpen(false)} placement="bottom-start">
        <Show
          when={props.def.type === "select" || props.def.type === "multi"}
          fallback={
            <div class="docs-pick__wrap">
              <Show when={list().length}>
                <div class="docs-pick__current">
                  <For each={list()}>
                    {(uri) => (
                      <button
                        type="button"
                        class="docs-pick__remove nc-chip"
                        aria-label={`Remove ${uri}`}
                        onClick={() =>
                          props.onChange(props.def.type === "person" ? null : list().filter((x) => x !== uri))
                        }
                      >
                        <EntityChip rookery={props.rookery} uri={uri} plain />
                        <Icon name="close" size="sm" />
                      </button>
                    )}
                  </For>
                </div>
              </Show>
              <EntityPick
                rookery={props.rookery}
                {...(props.def.type === "person"
                  ? { schemes: ["user"] }
                  : props.def.schemes?.length
                    ? { schemes: props.def.schemes }
                    : {})}
                onPick={(uri) => {
                  if (props.def.type === "person") {
                    props.onChange(uri)
                    setOpen(false)
                  } else if (!list().includes(uri)) props.onChange([...list(), uri])
                }}
                onClose={() => setOpen(false)}
              />
            </div>
          }
        >
          <Menu
            label={props.def.name}
            items={optionMenu()}
            onSelect={async (id) => {
              if (id === "__clear") {
                props.onChange(null)
                setOpen(false)
                return
              }
              if (id === "__new") {
                const name = (
                  await ask(`A new option for ${props.def.name}`, {
                    placeholder: "Option",
                    confirm: "Add option",
                  })
                )?.trim()
                if (!name) return
                const opt = {
                  id: newId("o"),
                  name,
                  hue: HUES[((props.def.options?.length ?? 0) % (HUES.length - 1)) + 1]!,
                }
                props.onDefChange({ ...props.def, options: [...(props.def.options ?? []), opt] })
                props.onChange(props.def.type === "multi" ? [...list(), opt.id] : opt.id)
                setOpen(false)
                return
              }
              if (props.def.type === "select") {
                props.onChange(list()[0] === id ? null : id)
                setOpen(false)
              } else props.onChange(list().includes(id) ? list().filter((x) => x !== id) : [...list(), id])
            }}
            onRequestClose={() => setOpen(false)}
            minWidth="200px"
          />
        </Show>
      </Popover>
    </>
  )
}

/** The property table of a page. */
export function PropsTable(props: { rookery: ClientRookeryWithDocs; model: PropsModel }): JSX.Element {
  const m = props.model
  const pages = () => props.rookery.data.space(m.page().spaceId).pages
  const all = () => [...m.shared(), ...m.local()]
  const save = async (patch: Props) => {
    const defs = all()
    const next = setProps(defs, m.page().props as Props, patch)
    try {
      await pages().update(m.page().id, { props: next, links: linksOf(defs, next) } as never)
    } catch (e: any) {
      props.rookery.workbench.toast({
        title: "The property was not saved",
        body: String(e?.message ?? e),
        kind: "danger",
      })
    }
  }
  /** Saves a changed definition where it lives. */
  const saveDef = async (def: PropDef | null, id: string) => {
    const shared = m.shared().some((d) => d.id === id)
    const target = shared ? m.parent() : m.page()
    if (!target) return
    const list = shared ? m.shared() : m.local()
    const next = def
      ? list.some((d) => d.id === id)
        ? list.map((d) => (d.id === id ? def : d))
        : [...list, def]
      : list.filter((d) => d.id !== id)
    await pages().update(target.id, (shared ? { schema: next } : { localSchema: next }) as never)
  }
  const [adding, setAdding] = createSignal(false)
  const [defMenu, setDefMenu] = createSignal<{ def: PropDef; el: HTMLElement } | null>(null)
  let addBtn!: HTMLButtonElement

  const addProperty = async (type: PropType, sharedScope: boolean) => {
    setAdding(false)
    const label = PROP_TYPES.find((t) => t.type === type)!.label
    const name = (await ask("Name the property", { value: label, confirm: "Add property" }))?.trim()
    if (!name) return
    const def: PropDef = {
      id: newId(),
      name,
      type,
      ...(type === "select" || type === "multi" ? { options: [] } : {}),
    }
    const parent = m.parent()
    if (sharedScope && parent) await pages().update(parent.id, { schema: [...m.shared(), def] } as never)
    else await pages().update(m.page().id, { localSchema: [...m.local(), def] } as never)
  }

  return (
    <div class="docs-props" data-part="properties">
      <For each={all()}>
        {(def) => (
          <div class="docs-prop" data-prop={def.name}>
            <button
              type="button"
              class="docs-prop__name"
              disabled={m.readOnly()}
              onClick={(e) => setDefMenu({ def, el: e.currentTarget })}
              title={
                m.shared().some((d) => d.id === def.id)
                  ? `Shared by the pages in ${m.parent()?.title ?? "this database"}`
                  : "This page's own"
              }
            >
              <Icon name={typeIcon(def.type) as never} size="sm" />
              <span>{def.name}</span>
            </button>
            <div class="docs-prop__cell">
              <PropEditor
                rookery={props.rookery}
                def={def}
                value={(m.page().props as Props | null | undefined)?.[def.id]}
                readOnly={m.readOnly()}
                onChange={(v) => save({ [def.id]: v })}
                onDefChange={(d) => saveDef(d, def.id)}
              />
            </div>
          </div>
        )}
      </For>
      <Show when={!m.readOnly()}>
        <button
          ref={addBtn}
          type="button"
          class="docs-props__add nc-meta"
          onClick={() => setAdding(true)}
          data-part="add-property"
        >
          <Icon name="plus" size="sm" /> Add a property
        </button>
        <Popover open={adding()} anchor={addBtn} onClose={() => setAdding(false)} placement="bottom-start">
          <Menu
            label="Property type"
            minWidth="240px"
            items={[
              ...(m.parent()
                ? [{ type: "label" as const, label: `For every page in ${m.parent()!.title}` }]
                : [{ type: "label" as const, label: "Type" }]),
              ...PROP_TYPES.map((t) => ({
                id: `${m.parent() ? "shared" : "local"}:${t.type}`,
                label: t.label,
                icon: t.icon as never,
              })),
              ...(m.parent()
                ? [
                    { type: "separator" as const },
                    { type: "label" as const, label: "For this page only" },
                    ...PROP_TYPES.slice(0, 4).map((t) => ({
                      id: `local:${t.type}`,
                      label: t.label,
                      icon: t.icon as never,
                    })),
                  ]
                : []),
            ]}
            onSelect={(id) => {
              const [scope, type] = id.split(":") as [string, PropType]
              void addProperty(type, scope === "shared")
            }}
            onRequestClose={() => setAdding(false)}
          />
        </Popover>
      </Show>
      <Popover
        open={!!defMenu()}
        anchor={defMenu()?.el}
        onClose={() => setDefMenu(null)}
        placement="bottom-start"
      >
        <Menu
          label="Property"
          minWidth="220px"
          items={[
            { type: "label", label: defMenu()?.def.name ?? "" },
            { id: "rename", label: "Rename", icon: "edit" },
            ...PROP_TYPES.filter((t) => t.type !== defMenu()?.def.type).map((t) => ({
              id: `type:${t.type}`,
              label: `Change to ${t.label.toLowerCase()}`,
              icon: t.icon as never,
            })),
            { type: "separator" },
            { id: "delete", label: "Delete the property", icon: "trash", danger: true },
          ]}
          onSelect={async (id) => {
            const cur = defMenu()?.def
            setDefMenu(null)
            if (!cur) return
            if (id === "rename") {
              const name = (await ask("Rename the property", { value: cur.name }))?.trim()
              if (name) await saveDef({ ...cur, name }, cur.id)
            } else if (id.startsWith("type:")) {
              const type = id.slice(5) as PropType
              await saveDef(
                {
                  ...cur,
                  type,
                  ...(type === "select" || type === "multi" ? { options: cur.options ?? [] } : {}),
                },
                cur.id,
              )
            } else if (id === "delete") {
              if (
                await confirmAsk(`Delete ${cur.name}?`, {
                  description: "Its values go with it on every page that has it.",
                  confirm: "Delete property",
                  danger: true,
                })
              )
                await saveDef(null, cur.id)
            }
          }}
          onRequestClose={() => setDefMenu(null)}
        />
      </Popover>
    </div>
  )
}
