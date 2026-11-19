// Open a file by name: fuzzy matching over `git ls-files` (tracked and untracked, not ignored), loaded once
// per workspace and again on refresh. `:42` after the name goes to a line.
import { Dialog, Icon, List } from "@aiviarium/nocturne"
import { createEffect, createMemo, createSignal, For, on, Show } from "solid-js"
import { fuzzyFilter } from "../fuzzy"
import type { Workspace } from "../workspace"

export function QuickOpen(props: { w: Workspace; open: boolean; onClose: () => void }) {
  const w = props.w
  const [query, setQuery] = createSignal("")
  const [active, setActive] = createSignal(0)
  const [loading, setLoading] = createSignal(false)
  const [took, setTook] = createSignal<number | null>(null)
  let input: HTMLInputElement | undefined

  createEffect(
    on(
      () => props.open,
      async (open) => {
        if (!open) return
        setQuery("")
        setActive(0)
        if (!w.files()) {
          setLoading(true)
          await w.loadFiles().catch(() => [])
          setLoading(false)
        }
      },
    ),
  )
  const parsed = createMemo(() => {
    const m = /^(.*?)(?::(\d+))?$/.exec(query().trim())
    return { q: m?.[1] ?? "", line: m?.[2] ? Number(m[2]) : undefined }
  })
  const hits = createMemo(() => {
    const t0 = performance.now()
    const r = fuzzyFilter(w.files() ?? [], parsed().q, 100)
    setTook(performance.now() - t0)
    return r
  })
  const pick = (path: string) => {
    props.onClose()
    w.openFile(path, { line: parsed().line })
  }
  return (
    <Dialog
      open={props.open}
      onClose={props.onClose}
      bare
      size="lg"
      placement="top"
      label="Open file by name"
      initialFocus={() => input}
    >
      <div class="wb-quick" data-part="quick-open">
        <div class="wb-quick__input">
          <Icon name="search" size="sm" />
          <input
            ref={input}
            class="wb-quick__field"
            placeholder={
              loading()
                ? "Listing files…"
                : `Open a file of ${w.files()?.length ?? 0} by name (name:line to go to a line)`
            }
            value={query()}
            onInput={(e) => {
              setQuery(e.currentTarget.value)
              setActive(0)
            }}
            onKeyDown={(e) => {
              if (e.key === "ArrowDown") {
                e.preventDefault()
                setActive(Math.min(hits().length - 1, active() + 1))
              } else if (e.key === "ArrowUp") {
                e.preventDefault()
                setActive(Math.max(0, active() - 1))
              } else if (e.key === "Enter") {
                e.preventDefault()
                const h = hits()[active()]
                if (h) pick(h.path)
              }
            }}
            aria-label="File name"
            data-part="quick-open-input"
          />
          <Show when={took() !== null && w.files()}>
            <span class="caption nc-muted" data-part="quick-open-time" data-ms={took()!.toFixed(1)}>
              {hits().length} of {w.files()!.length}
            </span>
          </Show>
        </div>
        <List
          items={hits()}
          itemHeight={34}
          height={Math.min(10, Math.max(1, hits().length)) * 34}
          label="Files"
          activeIndex={active()}
          onActiveChange={setActive}
          onSelect={(h) => pick(h.path)}
          getKey={(h) => h.path}
        >
          {(h) => {
            const name = h.path.split("/").pop()!
            const start = h.path.length - name.length
            const set = new Set(h.positions)
            return (
              <div class="wb-quick__row" data-quick={h.path}>
                <Icon name="file" size="sm" />
                <span class="wb-quick__name">
                  <For each={[...name]}>
                    {(ch, i) => (set.has(start + i()) ? <mark class="nc-match">{ch}</mark> : ch)}
                  </For>
                </span>
                <span class="caption nc-muted wb-quick__dir">{h.path.slice(0, Math.max(0, start - 1))}</span>
              </div>
            )
          }}
        </List>
      </div>
    </Dialog>
  )
}
