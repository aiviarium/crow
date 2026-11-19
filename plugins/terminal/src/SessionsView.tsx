// The terminal session list per host: the person's terminals there (with the host's text preview of the
// session's screen), the host's other terminal sessions, which can be adopted as Rookery terminals, and a
// form to open a new terminal in a directory.
//
// Ported from the prototype's `plugins/terminal/sessions.tsx`, minus the berth kind and the terminal
// sharing the prototype had: terminals are private to their owner (see `env.presence`), so a terminal is
// not shared and only its link is copied.
import {
  Button,
  Card,
  ContextMenu,
  DropdownMenu,
  EmptyState,
  IconButton,
  type MenuEntry,
  SectionHeading,
  Select,
  State,
  StatusDot,
  TextField,
  ViewHeader,
} from "@aiviarium/nocturne"
import type { Checkout, EnvInfo, EnvSession, TerminalInfo } from "@rookery/client"
import type { ClientRookery, ViewHandle } from "@rookery/sdk/client"
import { createEffect, createResource, createSignal, For, type JSX, on, onCleanup, Show } from "solid-js"
import { createHostsApi, envName, type HostsApi } from "./hosts"
import { addToPanel, openPanel } from "./panel"
import type { TerminalsApi } from "./termApi"

const LAST_ENV = "crow.terminal.env"

function ago(iso: string): string {
  const s = Math.max(0, (Date.now() - Date.parse(iso)) / 1000)
  if (!Number.isFinite(s)) return ""
  if (s < 60) return "just now"
  if (s < 3600) return `${Math.floor(s / 60)} min ago`
  if (s < 86400) return `${Math.floor(s / 3600)} h ago`
  return new Date(iso).toLocaleDateString()
}

/** Picks the host: the view's path, else the last used, else the first online. */
export function pickEnv(envs: EnvInfo[], wanted: string): string {
  const want = envName(wanted)
  if (want && envs.some((e) => e.name === want)) return want
  let last = ""
  try {
    last = localStorage.getItem(LAST_ENV) ?? ""
  } catch {}
  if (last && envs.some((e) => e.name === last)) return last
  return envs.find((e) => e.state === "online")?.name ?? envs[0]?.name ?? ""
}

export function openTerminal(rookery: ClientRookery, info: TerminalInfo) {
  rookery.workbench.openView("terminal.session", { path: info.id })
}

export function NewTerminalForm(props: {
  rookery: ClientRookery
  terminals: TerminalsApi
  env: string
  checkouts: Checkout[]
  onOpened?: (t: TerminalInfo) => void
}): JSX.Element {
  const [cwd, setCwd] = createSignal("")
  const [command, setCommand] = createSignal("")
  const [busy, setBusy] = createSignal(false)
  const open = async (e?: Event) => {
    e?.preventDefault()
    if (!props.env) return
    setBusy(true)
    try {
      const cmd = command().trim()
      const t = await props.terminals.open(props.env, {
        ...(cwd().trim() ? { cwd: cwd().trim() } : {}),
        ...(cmd ? { command: ["bash", "-lc", cmd], title: cmd } : {}),
      })
      props.onOpened?.(t)
      openTerminal(props.rookery, t)
    } catch (err: any) {
      props.rookery.workbench.toast({
        title: "Could not open a terminal",
        body: err?.message ?? String(err),
        kind: "danger",
      })
    } finally {
      setBusy(false)
    }
  }
  return (
    <form class="term-new" data-part="new-terminal" onSubmit={open}>
      <TextField
        label="Directory"
        mono
        placeholder="home folder"
        value={cwd()}
        onInput={(e) => setCwd(e.currentTarget.value)}
        list="term-checkouts"
      />
      <datalist id="term-checkouts">
        <For each={props.checkouts}>{(c) => <option value={c.path}>{c.branch ?? c.name}</option>}</For>
      </datalist>
      <TextField
        label="Command"
        mono
        placeholder="a login shell"
        value={command()}
        onInput={(e) => setCommand(e.currentTarget.value)}
      />
      <Button type="submit" variant="primary" icon="terminal" loading={busy()} disabled={!props.env}>
        Open terminal
      </Button>
      <Show when={props.checkouts.length}>
        <div class="term-new__checkouts">
          <span class="nc-meta">Checkouts</span>
          <For each={props.checkouts}>
            {(c) => (
              <Button size="sm" variant="secondary" onClick={() => setCwd(c.path)} title={c.path}>
                {c.name}
                {c.branch ? ` · ${c.branch}` : ""}
              </Button>
            )}
          </For>
        </div>
      </Show>
    </form>
  )
}

export function SessionsView(props: {
  view: ViewHandle
  rookery: ClientRookery
  terminals: TerminalsApi
  hosts?: HostsApi
}): JSX.Element {
  const hosts = props.hosts ?? createHostsApi(props.rookery)
  props.view.setTitle("Terminals")
  // Best effort: a server without `env.*` shows the empty state instead of failing the view.
  const [envs, { refetch: refetchEnvs }] = createResource(() => hosts.list().catch(() => []), {
    initialValue: [],
  })
  const [env, setEnv] = createSignal("")
  createEffect(
    on(envs, (list) => {
      if (!env() || !list.some((e) => e.name === env())) setEnv(pickEnv(list, props.view.path))
    }),
  )
  createEffect(() => {
    if (env())
      try {
        localStorage.setItem(LAST_ENV, env())
      } catch {}
  })
  const current = () => envs().find((e) => e.name === env())
  const [tick, setTick] = createSignal(0)
  const [terminals] = createResource(
    () => (env() ? [env(), tick()] : null),
    ([e]) => props.terminals.list({ env: e as string, ended: true }).catch(() => []),
    { initialValue: [] as TerminalInfo[] },
  )
  const [sessions] = createResource(
    () => (env() ? [env(), tick()] : null),
    ([e]) => props.terminals.sessions(e as string, { preview: true }).catch(() => [] as EnvSession[]),
    { initialValue: [] as EnvSession[] },
  )
  const [checkouts] = createResource(
    () => (current()?.level === "use" || current()?.level === "manage" ? env() : null),
    (e) => hosts.checkouts(e as string).catch(() => [] as Checkout[]),
    { initialValue: [] as Checkout[] },
  )
  const offT = props.terminals.onChanged(() => setTick(tick() + 1))
  const offE = hosts.onChanged(() => refetchEnvs())
  const timer = setInterval(() => setTick(tick() + 1), 5000)
  onCleanup(() => {
    offT()
    offE()
    clearInterval(timer)
  })
  const previewOf = (t: TerminalInfo) => sessions().find((s) => s.id === t.sessionId)?.preview
  const others = () =>
    sessions().filter(
      (s) =>
        s.kind === "terminal" && !s.terminal && !s.ended && !terminals().some((t) => t.sessionId === s.id),
    )
  const adopt = async (s: EnvSession) => {
    try {
      openTerminal(props.rookery, await props.terminals.adopt(env(), s.id))
    } catch (e: any) {
      props.rookery.workbench.toast({
        title: "Could not open the session",
        body: e?.message ?? String(e),
        kind: "danger",
      })
    }
  }
  return (
    <div class="term-sessions" data-part="terminal-sessions">
      <ViewHeader class="term-sessions__header">
        <Show when={current() && current()!.state !== "online" && current()}>
          {(e) => (
            <span class="nc-state" data-env-state={e().state}>
              <StatusDot
                status={e().state === "online" ? "ok" : e().state === "offline" ? "error" : "warn"}
              />
              {e().state}
            </span>
          )}
        </Show>
        <span class="term__spacer" />
        <Show when={current()?.supports.desktop}>
          <Button
            size="sm"
            variant="secondary"
            icon="grid"
            onClick={() => props.rookery.workbench.openView("fleet.desktop", { path: env() })}
          >
            Desktop
          </Button>
        </Show>
        <Select
          aria-label="Host"
          options={envs().map((e) => ({ value: e.name, label: e.name, description: e.kind }))}
          value={env()}
          onChange={setEnv}
        />
      </ViewHeader>
      <Show
        when={envs().length}
        fallback={
          // Nothing is drawn until the list has come: an empty state that flashes and goes moves the page.
          <Show when={!envs.loading}>
            <EmptyState icon="server" title="No hosts" description="Nothing to open a terminal on yet." />
          </Show>
        }
      >
        <div class="term-sessions__body">
          <Card class="term-sessions__new" title={`New terminal on ${env()}`}>
            <NewTerminalForm
              rookery={props.rookery}
              terminals={props.terminals}
              env={env()}
              checkouts={checkouts()}
              onOpened={() => setTick(tick() + 1)}
            />
          </Card>
          {/* With no terminals and no other sessions the list is not there at all: the form beside it makes one. */}
          <Show when={terminals().length || others().length}>
            <section class="term-sessions__list" data-part="terminal-list">
              <Show when={terminals().length}>
                {/* The tab says "Terminals": the heading is only there to tell them from the other sessions. */}
                <Show when={others().length}>
                  <SectionHeading title="Yours" />
                </Show>
                <For each={terminals()}>
                  {(t) => {
                    const canUse = () => t.level === "use" || t.level === "manage"
                    const menu = (): MenuEntry[] => [
                      { id: "open", label: "Open", icon: "arrow-up-right" },
                      { id: "panel", label: "Open in the panel", icon: "terminal" },
                      { id: "screen", label: "Host screen", icon: "eye" },
                      { id: "copy", label: "Copy link", icon: "link" },
                      ...(t.state === "running" && canUse()
                        ? [
                            { type: "separator" as const },
                            { id: "close", label: "Close", icon: "close" as const, danger: true },
                          ]
                        : []),
                    ]
                    const run = (id: string) => {
                      if (id === "open") openTerminal(props.rookery, t)
                      else if (id === "panel") {
                        addToPanel(t.id, t.title)
                        openPanel()
                      } else if (id === "screen") {
                        props.rookery.workbench.openView("terminal.screen", { path: t.id })
                      } else if (id === "copy") {
                        const href = props.rookery.views.href("terminal.session", { path: t.id }) ?? ""
                        navigator.clipboard
                          ?.writeText(new URL(href, location.href).toString())
                          .catch(() => {})
                      } else if (id === "close") props.terminals.close(t.id).then(() => setTick(tick() + 1))
                    }
                    return (
                      <ContextMenu items={menu} onSelect={run} label="Terminal">
                        <Card class="term-card" data-terminal-row={t.id} data-state={t.state}>
                          <div class="term-card__head">
                            <button
                              type="button"
                              class="term-card__title body"
                              title={t.title}
                              onClick={() => openTerminal(props.rookery, t)}
                            >
                              {t.title}
                            </button>
                            {/* Running is the normal state: only an ended or lost terminal says so. */}
                            <Show when={t.state !== "running"}>
                              <State status={t.state === "lost" ? "warn" : "off"}>
                                {t.state === "lost" ? "Lost" : "Exited"}
                              </State>
                            </Show>
                            <span class="nc-meta term-card__meta">
                              {t.viewers > 0 ? `${t.viewers} viewing · ` : ""}
                              {ago(t.createdAt)}
                            </span>
                            <DropdownMenu
                              label="Terminal"
                              items={menu()}
                              onSelect={run}
                              placement="bottom-end"
                              trigger={(tp) => <IconButton {...tp} label="More" icon="more" />}
                            />
                          </div>
                          <Show when={previewOf(t)}>
                            <pre class="term-card__preview mono">{previewOf(t)}</pre>
                          </Show>
                          <Show when={t.lastInput}>
                            {(i) => (
                              <span class="nc-meta">
                                Last typed by {i().name ?? i().principal}{" "}
                                {ago(new Date(i().at).toISOString())}
                              </span>
                            )}
                          </Show>
                        </Card>
                      </ContextMenu>
                    )
                  }}
                </For>
              </Show>
              <Show when={others().length}>
                <SectionHeading title={`Other sessions on ${env()}`} />
                <For each={others()}>
                  {(s) => (
                    <Card class="term-card" data-session-row={s.id}>
                      <div class="term-card__head">
                        <span class="term-card__title body">{s.title || s.command.join(" ")}</span>
                        <span class="nc-meta term-card__meta">
                          {s.user} · {ago(s.started)}
                        </span>
                        <Button size="sm" variant="secondary" onClick={() => adopt(s)}>
                          Open
                        </Button>
                      </div>
                      <Show when={s.preview}>
                        <pre class="term-card__preview mono">{s.preview}</pre>
                      </Show>
                    </Card>
                  )}
                </For>
              </Show>
            </section>
          </Show>
        </div>
      </Show>
    </div>
  )
}
