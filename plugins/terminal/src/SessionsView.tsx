// The terminal session list per host: the person's terminals there (with the host's text preview of the
// session's screen), the host's other terminal sessions, which a host's manager can adopt as Rookery
// terminals, and a form to open a new terminal in a directory.
//
// Ported from the prototype's `plugins/terminal/sessions.tsx`, minus the berth kind and the terminal
// sharing the prototype had: terminals are private to their owner (see `env.presence`), so a `view`
// holder sees only the counts and never another person's terminal or screen.
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
import type { EnvInfo } from "@rookery/client"
import type { ClientRookery, ViewHandle } from "@rookery/sdk/client"
import { createEffect, createResource, createSignal, For, type JSX, on, onCleanup, Show } from "solid-js"
import type { SessionSummary, Update } from "../../agents/src/parrot"
import type { AgentHostCapability } from "../../agents/src/rookery-wire"
import { formatChatPath } from "../../agents/src/store"
import { connectParrot, type ParrotConnection } from "../../agents/src/transport"
import { envName } from "./env"
import { createHostsApi, type HostsApi } from "./hosts"
import { addToPanel, openPanel } from "./panel"
import type { TerminalsApi } from "./termApi"
import type { EnvSession, TerminalInfo } from "./types"

const LAST_ENV = "crow.terminal.env"

/** A host's session in the list: the one with its id replaced, or the newest at the front. */
function upsertSession(list: readonly SessionSummary[], session: SessionSummary): SessionSummary[] {
  const at = list.findIndex((s) => s.id === session.id)
  if (at === -1) return [session, ...list]
  return [...list.slice(0, at), session, ...list.slice(at + 1)]
}

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
      />
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
  const agentHost = () => {
    const host = current()
    const supports: (EnvInfo["supports"] & AgentHostCapability) | undefined = host?.supports
    return host?.state === "online" && host.level !== "view" && supports?.agents ? host.name : undefined
  }
  const [agentSessions, setAgentSessions] = createSignal<SessionSummary[]>([])
  // One `agents.connect` stream per selected host, kept open so the index subscription pushes the
  // host's sessions as they change, instead of a new handshake on every tick.
  let agentLink: { conn: ParrotConnection; off: () => void } | null = null
  let agentTicket = 0
  const closeAgentLink = () => {
    agentTicket++
    if (!agentLink) return
    const { conn, off } = agentLink
    agentLink = null
    off()
    conn.close()
  }
  createEffect(
    on(agentHost, (name) => {
      // The previous host's stream ends with the selection, and a handshake still running when the
      // host changes is closed on arrival, so only the newest selection ever holds a stream.
      closeAgentLink()
      setAgentSessions([])
      if (!name) return
      const ticket = agentTicket
      const apply = (u: Update) => {
        if (u.type === "summary") setAgentSessions((prev) => upsertSession(prev, u.session))
        else if (u.type === "deleted" && u.kind === "session")
          setAgentSessions((prev) => prev.filter((s) => s.id !== u.id))
      }
      ;(async () => {
        let conn: ParrotConnection | undefined
        let off: (() => void) | undefined
        try {
          conn = await connectParrot(props.rookery, name)
          if (ticket !== agentTicket) return
          let subscription: string | undefined
          off = conn.client.on("update", (params) => {
            if (subscription && params.subscription !== subscription) return
            apply(params.update)
          })
          agentLink = { conn, off }
          const sub = await conn.client.subscribe({ index: true })
          if (ticket !== agentTicket) return
          subscription = sub.subscription
          if (sub.snapshot?.index) setAgentSessions(sub.snapshot.index.sessions)
          else {
            const listed = await conn.client.call("session/list", { archived: false, limit: 200 })
            if (ticket !== agentTicket) return
            setAgentSessions(listed.sessions)
          }
        } catch {
          // A host that does not answer shows the terminal state instead of the agent sessions.
          if (ticket === agentTicket) setAgentSessions([])
        } finally {
          // A handshake that finished after the host changed is closed here, never used.
          if (ticket !== agentTicket) {
            off?.()
            conn?.close()
          }
        }
      })()
    }),
  )
  const offT = props.terminals.onChanged(() => setTick(tick() + 1))
  const offE = hosts.onChanged(() => refetchEnvs())
  const timer = setInterval(() => setTick(tick() + 1), 5000)
  onCleanup(() => {
    offT()
    offE()
    clearInterval(timer)
    closeAgentLink()
  })
  const previewOf = (t: TerminalInfo) => sessions().find((s) => s.id === t.sessionId)?.preview
  // The server says which sessions are already a terminal (`adopted`) and names the one this caller may
  // see (`terminal`); a session with neither is one a manager may take over with `terminals.adopt`.
  const others = () =>
    sessions().filter((s) => s.kind === "terminal" && !s.adopted && !s.terminal && !s.ended)
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
              onOpened={() => setTick(tick() + 1)}
            />
          </Card>
          {/* With no terminals and no other sessions the list is not there at all: the form beside it makes one. */}
          <Show when={terminals().length || others().length || agentSessions().length}>
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
              <Show when={agentSessions().length}>
                <SectionHeading title="Agent sessions" />
                <For each={agentSessions()}>
                  {(session) => (
                    <Card class="term-card" data-session-row={session.id}>
                      <div class="term-card__head">
                        <button
                          type="button"
                          class="term-card__title body"
                          onClick={() =>
                            props.rookery.workbench.openView("agents.chat", {
                              path: formatChatPath(env(), session.id),
                            })
                          }
                        >
                          {session.title || session.agent || session.id}
                        </button>
                        <span class="nc-meta term-card__meta">{session.state}</span>
                      </div>
                    </Card>
                  )}
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
                        <Show
                          when={current()?.level === "manage"}
                          fallback={
                            <span class="nc-meta">
                              Taking one over needs manage on {env()}; you have{" "}
                              {current()?.level ?? "no access"}.
                            </span>
                          }
                        >
                          <Button size="sm" variant="secondary" onClick={() => adopt(s)}>
                            Open
                          </Button>
                        </Show>
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
