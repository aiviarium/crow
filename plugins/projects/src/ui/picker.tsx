// A searchable picker in a popover, as Linear's property menus: type to filter, arrows to move, Enter to
// choose (or to toggle, for labels), Escape to close. Used for state, assignee, priority, labels, cycle,
// parent, estimate and the filter builder's values.
import { Icon, Popover } from "@aiviarium/nocturne"
import { createEffect, createMemo, createSignal, For, type JSX, on, onMount, Show } from "solid-js"

export interface PickItem {
  id: string
  label: string
  /** More words to match. */
  keywords?: string
  hint?: string
  leading?: JSX.Element
  /** A key that picks it directly (digits, for priorities). */
  shortcut?: string
}

export interface PickerProps {
  open: boolean
  anchor: HTMLElement | undefined
  items: PickItem[]
  /** Ids shown with a check mark. */
  selected?: string[]
  /** Several can be chosen; Enter toggles and the picker stays open. */
  multi?: boolean
  placeholder?: string
  label: string
  onPick: (id: string) => void
  onClose: () => void
  /** Offered when what was typed matches nothing exactly: "Create label …". */
  create?: (text: string) => string | null
  onCreate?: (text: string) => void
  /** Rows shown at most (the parent picker searches thousands of issues). */
  limit?: number
}

function score(item: PickItem, q: string): number {
  if (!q) return 1
  const hay = `${item.label} ${item.keywords ?? ""}`.toLowerCase()
  const label = item.label.toLowerCase()
  if (label.startsWith(q)) return 3
  if (label.split(/\s+/).some((w) => w.startsWith(q))) return 2
  return hay.includes(q) ? 1 : 0
}

export function Picker(props: PickerProps) {
  const [query, setQuery] = createSignal("")
  const [active, setActive] = createSignal(0)
  let input: HTMLInputElement | undefined
  const shown = createMemo(() => {
    const q = query().trim().toLowerCase()
    return props.items
      .map((i, n) => ({ i, n, s: score(i, q) }))
      .filter((x) => x.s > 0)
      .sort((a, b) => b.s - a.s || a.n - b.n)
      .slice(0, props.limit ?? 200)
      .map((x) => x.i)
  })
  const creating = () => (props.create && query().trim() ? props.create(query().trim()) : null)
  const count = () => shown().length + (creating() ? 1 : 0)
  createEffect(on(query, () => setActive(0)))
  createEffect(
    on(
      () => props.open,
      (open) => {
        if (!open) return
        setQuery("")
        // Start on the current value.
        const at = props.items.findIndex((i) => props.selected?.includes(i.id))
        setActive(at >= 0 && !props.multi ? at : 0)
        queueMicrotask(() => input?.focus())
      },
    ),
  )
  const choose = (at: number) => {
    const list = shown()
    if (at < list.length) {
      props.onPick(list[at]!.id)
      if (!props.multi) props.onClose()
    } else if (creating()) {
      props.onCreate?.(query().trim())
      setQuery("")
    }
  }
  const onKey = (e: KeyboardEvent) => {
    if (e.key === "ArrowDown" || (e.ctrlKey && e.key === "n"))
      setActive((a) => (count() ? (a + 1) % count() : 0))
    else if (e.key === "ArrowUp" || (e.ctrlKey && e.key === "p"))
      setActive((a) => (count() ? (a - 1 + count()) % count() : 0))
    else if (e.key === "Enter") choose(active())
    else if (e.key === "Escape") props.onClose()
    else if (!query() && !e.ctrlKey && !e.metaKey && !e.altKey && e.key.length === 1) {
      const hit = props.items.findIndex((i) => i.shortcut === e.key)
      if (hit < 0) return
      props.onPick(props.items[hit]!.id)
      if (!props.multi) props.onClose()
    } else return
    e.preventDefault()
    e.stopPropagation()
  }
  return (
    <Popover
      open={props.open}
      anchor={props.anchor}
      onClose={props.onClose}
      placement="bottom-start"
      class="projects__picker"
      data-part="picker"
    >
      <div class="projects__picker-search">
        <input
          ref={input}
          class="projects__picker-input"
          aria-label={props.label}
          placeholder={props.placeholder ?? "Search…"}
          value={query()}
          onInput={(e) => setQuery(e.currentTarget.value)}
          onKeyDown={onKey}
          role="combobox"
          aria-expanded="true"
          aria-controls="projects-picker-list"
        />
      </div>
      <div
        id="projects-picker-list"
        role="listbox"
        aria-label={props.label}
        aria-multiselectable={props.multi}
        class="projects__picker-list"
      >
        <For each={shown()}>
          {(item, n) => {
            const on = () => !!props.selected?.includes(item.id)
            return (
              // biome-ignore lint/a11y/useKeyWithClickEvents lint/a11y/useFocusableInteractive: the search field above handles the keys (arrows, Enter)
              <div
                role="option"
                aria-selected={on()}
                data-active={active() === n() ? "" : undefined}
                data-id={item.id}
                class="projects__picker-row"
                onPointerMove={() => setActive(n())}
                onMouseDown={(e) => e.preventDefault()}
                onClick={() => choose(n())}
              >
                <Show when={props.multi}>
                  <span
                    class="nc-check projects__picker-check"
                    data-on={on() ? "" : undefined}
                    aria-hidden="true"
                  >
                    <Show when={on()}>
                      <Icon name="check" size="sm" />
                    </Show>
                  </span>
                </Show>
                <Show when={item.leading}>
                  <span class="projects__picker-lead">{item.leading}</span>
                </Show>
                <span class="projects__picker-label">{item.label}</span>
                <Show when={item.hint}>
                  <span class="nc-meta">{item.hint}</span>
                </Show>
                <Show when={!props.multi && on()}>
                  <Icon name="check" size="sm" class="projects__picker-tick" />
                </Show>
                <Show when={item.shortcut}>
                  <span class="nc-kbd">{item.shortcut}</span>
                </Show>
              </div>
            )
          }}
        </For>
        <Show when={creating()}>
          {/* biome-ignore lint/a11y/useKeyWithClickEvents lint/a11y/useFocusableInteractive: the search field above handles the keys */}
          <div
            role="option"
            aria-selected="false"
            class="projects__picker-row"
            data-active={active() === shown().length ? "" : undefined}
            onMouseDown={(e) => e.preventDefault()}
            onClick={() => choose(shown().length)}
          >
            <Icon name="plus" size="sm" />
            <span class="projects__picker-label">{creating()}</span>
          </div>
        </Show>
        <Show when={!count()}>
          <span class="nc-meta projects__picker-empty">Nothing matches</span>
        </Show>
      </div>
    </Popover>
  )
}

/** A button that opens a picker, for a property of an issue (or of a draft). */
export function PickerButton(props: {
  label: string
  children: JSX.Element
  picker: Omit<PickerProps, "open" | "anchor" | "onClose" | "label">
  class?: string
  disabled?: boolean
  /** Opens the picker from outside (a keyboard shortcut). */
  openSignal?: () => number
  title?: string
  "data-prop"?: string
}) {
  const [open, setOpen] = createSignal(false)
  let btn: HTMLButtonElement | undefined
  onMount(() => {
    if (!props.openSignal) return
    createEffect(on(props.openSignal, (n) => n && setOpen(true), { defer: true }))
  })
  return (
    <>
      <button
        ref={btn}
        type="button"
        class={`projects__prop ${props.class ?? ""}`}
        aria-label={props.label}
        aria-haspopup="listbox"
        aria-expanded={open()}
        title={props.title ?? props.label}
        disabled={props.disabled}
        data-prop={props["data-prop"]}
        onClick={(e) => {
          e.stopPropagation()
          setOpen((o) => !o)
        }}
      >
        {props.children}
      </button>
      {/* Built only while open: a list of thousands of rows has six of these per row. */}
      <Show when={open()}>
        <Picker {...props.picker} label={props.label} open anchor={btn} onClose={() => setOpen(false)} />
      </Show>
    </>
  )
}
