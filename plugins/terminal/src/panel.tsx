// Terminals in the bottom panel: tabs, and a split showing two side by side. The open tabs are kept per
// device in localStorage: which terminals are open is a matter of the machine in front of you.
//
// Ported from the prototype's `plugins/terminal/panel.tsx`. The prototype's shell had a `panel` slot;
// Crow's shell does not draw one yet, so `terminal.panel` is registered as a panel view for that slot and
// the dock below shows the same body over the bottom of the page until the shell hosts it.
import { Button, EmptyState, IconButton, type MenuEntry, Split, TabStrip } from "@aiviarium/nocturne"
import type { EnvInfo } from "@rookery/client"
import type { ClientRookery } from "@rookery/sdk/client"
import { createMemo, createSignal, type JSX, Show } from "solid-js"
import { render } from "solid-js/web"
import { createHostsApi } from "./hosts"
import { TerminalViewer } from "./TerminalViewer"
import type { TerminalsApi } from "./termApi"

export interface PanelTab {
  id: string
  title: string
}

export interface PanelState {
  tabs: PanelTab[]
  active: string | null
  /** The terminal shown beside the active one. */
  split: string | null
}

const KEY = "crow.terminal.panel.v1"

function load(): PanelState {
  try {
    const s = JSON.parse(localStorage.getItem(KEY) ?? "null")
    if (s && Array.isArray(s.tabs)) return s
  } catch {}
  return { tabs: [], active: null, split: null }
}

export const [panel, setPanelState] = createSignal<PanelState>(load())
/** Whether the docked panel is showing. The registered `terminal.panel` view always shows its body. */
export const [panelOpen, setPanelOpen] = createSignal(false)

function save(s: PanelState) {
  setPanelState(s)
  try {
    localStorage.setItem(KEY, JSON.stringify(s))
  } catch {}
}

/** Adds a terminal to the panel and makes it the active one. */
export function addToPanel(id: string, title: string, split = false) {
  const s = panel()
  const tabs = s.tabs.some((t) => t.id === id) ? s.tabs : [...s.tabs, { id, title }]
  if (split && s.active && s.active !== id) save({ tabs, active: s.active, split: id })
  else save({ ...s, tabs, active: id })
}

/** Moves a tab to another place in the strip (a drag, or Alt+Arrow). */
function move(id: string, index: number) {
  const s = panel()
  const from = s.tabs.findIndex((t) => t.id === id)
  if (from < 0) return
  const moved = s.tabs[from]!
  const tabs = s.tabs.filter((t) => t.id !== id)
  tabs.splice(index > from ? index - 1 : index, 0, moved)
  save({ ...s, tabs })
}

function closeOthers(id: string) {
  const s = panel()
  save({ tabs: s.tabs.filter((t) => t.id === id), active: id, split: null })
}

export function closePanelTab(id: string) {
  const s = panel()
  const tabs = s.tabs.filter((t) => t.id !== id)
  const active = s.active === id ? (tabs[tabs.length - 1]?.id ?? null) : s.active
  save({ tabs, active, split: s.split === id || s.split === active ? null : s.split })
}

export interface PanelDeps {
  rookery: ClientRookery
  terminals: TerminalsApi
}

let deps: PanelDeps | undefined
let mounted = false

/** Called once by the client half: the dock shows these terminals when it is opened. */
export function registerPanelDeps(d: PanelDeps) {
  deps = d
}

/** Opens the docked panel, mounting it into the page the first time. */
export function openPanel() {
  mountDock()
  setPanelOpen(true)
}

export function togglePanel() {
  if (panelOpen()) setPanelOpen(false)
  else openPanel()
}

function mountDock() {
  if (mounted || !deps || typeof document === "undefined") return
  mounted = true
  const host = document.createElement("div")
  host.dataset.part = "terminal-panel-dock"
  document.body.append(host)
  const fixed = deps
  const dispose = render(() => <TerminalDock {...fixed} />, host)
  void dispose
}

/** A terminal in the panel, by the panel's default host: the last used one, else the first online. */
export async function openInPanel(d: PanelDeps, split = false) {
  const hosts = createHostsApi(d.rookery)
  let envs: EnvInfo[] = []
  try {
    envs = await hosts.list()
  } catch {
    d.rookery.workbench.toast({ title: "No host to open a terminal on", kind: "warning" })
    return
  }
  let last = ""
  try {
    last = localStorage.getItem("crow.terminal.env") ?? ""
  } catch {}
  const env = envs.find((e) => e.name === last) ?? envs.find((e) => e.state === "online") ?? envs[0]
  if (!env) {
    d.rookery.workbench.toast({ title: "No host to open a terminal on", kind: "warning" })
    return
  }
  try {
    const t = await d.terminals.open(env.name)
    addToPanel(t.id, t.title, split)
  } catch (e: any) {
    d.rookery.workbench.toast({
      title: "Could not open a terminal",
      body: e?.message ?? String(e),
      kind: "danger",
    })
  }
}

/** The tabs and the terminals of the panel. Shared by the `terminal.panel` view and the docked panel. */
export function PanelBody(props: PanelDeps & { onClose?: () => void }): JSX.Element {
  const rename = (id: string, title: string) => {
    if (panel().tabs.find((t) => t.id === id)?.title === title) return
    save({ ...panel(), tabs: panel().tabs.map((t) => (t.id === id ? { ...t, title } : t)) })
  }
  // The viewers are keyed by terminal id only, so renaming a tab does not remount them.
  const active = createMemo(() => panel().active)
  const split = createMemo(() => panel().split)
  let body!: HTMLDivElement
  const [width, setWidth] = createSignal(960)
  const onMount = (el: HTMLDivElement) => {
    body = el
    if (typeof ResizeObserver === "undefined") return
    const ro = new ResizeObserver(() => setWidth(body.clientWidth || 960))
    ro.observe(body)
  }
  const viewer = (id: string) => (
    <TerminalViewer
      rookery={props.rookery}
      terminals={props.terminals}
      id={id}
      header={false}
      autofocus
      onTitle={(t) => rename(id, t)}
    />
  )
  return (
    <div class="term-panel" data-part="terminal-panel">
      {/* With no terminal there is nothing to tab between: the empty state below is the one place to start. */}
      <Show when={panel().tabs.length}>
        <TabStrip
          class="term-panel__tabs"
          label="Terminals"
          items={panel().tabs.map((t) => ({ id: t.id, label: t.title, icon: "terminal" as const }))}
          value={panel().active ?? ""}
          onChange={(id) => save({ ...panel(), active: id })}
          onClose={closePanelTab}
          closeLabel={(t) => `Close ${t.label}`}
          dragGroup="crow.terminal.panel"
          onDrop={(d) => move(d.tabId, d.index)}
          onNewTab={() => void openInPanel(props)}
          menu={(id): MenuEntry[] => [
            { id: "main", label: "Open in the main area", icon: "arrow-up-right" },
            {
              id: "split",
              label: panel().split === id ? "Unsplit" : "Show beside the active one",
              icon: "sidebar",
              disabled: panel().active === id && !panel().split,
            },
            { id: "copy", label: "Copy link", icon: "link" },
            { type: "separator" },
            { id: "close-others", label: "Close the others", disabled: panel().tabs.length < 2 },
            { id: "close", label: "Close", icon: "close", shortcut: "Middle click" },
          ]}
          onMenuSelect={(id, entry) => {
            if (entry === "main") props.rookery.workbench.openView("terminal.session", { path: id })
            else if (entry === "split") {
              const s = panel()
              save({ ...s, split: s.split === id ? null : id })
            } else if (entry === "copy") {
              const href = props.rookery.views.href("terminal.session", { path: id }) ?? ""
              navigator.clipboard?.writeText(new URL(href, location.href).toString()).catch(() => {})
            } else if (entry === "close-others") closeOthers(id)
            else if (entry === "close") closePanelTab(id)
          }}
          actions={
            <>
              <IconButton label="New terminal" icon="plus" onClick={() => void openInPanel(props)} />
              <IconButton
                label={panel().split ? "Unsplit" : "Split"}
                icon="sidebar"
                pressed={!!panel().split}
                onClick={() => {
                  const s = panel()
                  if (s.split) save({ ...s, split: null })
                  else {
                    const other = s.tabs.find((t) => t.id !== s.active)
                    if (other) save({ ...s, split: other.id })
                    else void openInPanel(props, true)
                  }
                }}
              />
              <IconButton
                label="Open in the main area"
                icon="arrow-up-right"
                disabled={!panel().active}
                onClick={() =>
                  panel().active &&
                  props.rookery.workbench.openView("terminal.session", { path: panel().active! })
                }
              />
              <Show when={props.onClose}>
                <IconButton label="Hide the panel" icon="close" onClick={() => props.onClose?.()} />
              </Show>
            </>
          }
        />
      </Show>
      <div class="term-panel__body" ref={onMount}>
        <Show
          when={active()}
          keyed
          fallback={
            <EmptyState icon="terminal" title="No terminals here">
              <Button size="sm" variant="secondary" icon="plus" onClick={() => void openInPanel(props)}>
                New terminal
              </Button>
            </EmptyState>
          }
        >
          {(activeId) => (
            <Show when={split()} keyed fallback={viewer(activeId)}>
              {(splitId) => (
                <Split
                  orientation="horizontal"
                  defaultSize={Math.round(width() / 2)}
                  min={200}
                  max={Math.max(240, width() - 200)}
                  label="Resize the terminals"
                  first={viewer(activeId)}
                  second={viewer(splitId)}
                />
              )}
            </Show>
          )}
        </Show>
      </div>
    </div>
  )
}

/** The `terminal.panel` view: the same body, for a shell that draws the panel slot. */
export function PanelView(props: PanelDeps): JSX.Element {
  return <PanelBody {...props} />
}

/** The dock over the bottom of the page, until the shell draws a panel slot. */
export function TerminalDock(props: PanelDeps): JSX.Element {
  return (
    <Show when={panelOpen()}>
      <div class="term-dock" data-part="terminal-dock">
        <PanelBody {...props} onClose={() => setPanelOpen(false)} />
      </div>
    </Show>
  )
}
