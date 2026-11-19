// The Agents view: host picker + day-grouped session list, the conversation, the composer, and the
// context panel (context window, session details, usage/cost, changes, background tasks).
// The route path (`*rest`) is `""`, `<host>`, or `<host>/<session>`: without a session id it shows
// the new-session flow on the selected host.
import {
  Badge,
  BottomArea,
  Button,
  Callout,
  Composer,
  type ComposerItem,
  type ComposerSubmit,
  type ComposerValue,
  ContextMenu,
  type DictationState,
  type EffortLevel,
  EmptyState,
  Icon,
  IconButton,
  type IconName,
  InlineField,
  InsetGroup,
  InsetList,
  InsetRow,
  ListRow,
  type MenuEntry,
  PHONE_QUERY,
  provideScreen,
  RowList,
  ScreenOptions,
  ScreenRefresh,
  ScreenSearch,
  SectionHeading,
  Select,
  TextField,
  useViewLayout,
  ViewHeader,
  ViewLayout,
} from "@aiviarium/nocturne"
import type { ClientRookery } from "@rookery/sdk/client"
import {
  batch,
  createEffect,
  createMemo,
  createSignal,
  For,
  type JSX,
  on,
  onCleanup,
  Show,
  untrack,
} from "solid-js"
import { SessionAbout } from "./about"
import { errorMessage } from "./api"
import { Turn } from "./items"
import { busy, byDay, needsYou, relative, turns } from "./model"
import { NewSession } from "./newsession"
import {
  type Action,
  type ConfigOption,
  extractOptionChoices,
  type FileChangeItem,
  findOptionByRole,
  optionStringValue,
  type SessionSummary,
} from "./parrot"
import {
  type AgentsStore,
  formatChatPath,
  type PromptInput,
  parseChatPath,
  type SessionFollower,
} from "./store"
import { createSessionMenu, SessionMenu, TerminalPane, UnrecognisedBanner } from "./tui"

/** The chat list's width until resized: narrower than a view's default so the chat is the page. */
const LIST_WIDTH = 224

export const PHONE = PHONE_QUERY

export function useMedia(q: string) {
  const mq = typeof matchMedia === "function" ? matchMedia(q) : null
  const [m, setM] = createSignal(!!mq?.matches)
  const f = () => setM(!!mq?.matches)
  mq?.addEventListener("change", f)
  onCleanup(() => mq?.removeEventListener("change", f))
  return m
}

/**
 * What a row says about its session: an exceptional state as a coloured word, else when it last
 * moved. The open session's state is the conversation's to say, so its row shows only the time.
 */
export function rowMeta(s: SessionSummary, now: number, active: boolean): { word: string; tone?: string } {
  if (!active) {
    if (needsYou(s)) return { word: "Needs you", tone: "warn" }
    if (s.state === "running" || s.state === "starting") return { word: "Working", tone: "ai" }
    if (s.state === "lost") return { word: "Lost", tone: "error" }
  }
  return { word: relative(s.updated, now) }
}

/** The menu of a session row (context menu on desktop, action menu on phone). */
export function sessionMenu(s: SessionSummary): MenuEntry[] {
  return [
    { id: "open", label: "Open", icon: "arrow-up-right" },
    { id: "rename", label: "Rename", icon: "edit", shortcut: "F2" },
    { id: "copy", label: "Copy link", icon: "link" },
    { type: "separator" },
    s.archived
      ? { id: "unarchive", label: "Restore from the archive", icon: "folder" }
      : { id: "archive", label: "Archive", icon: "folder", danger: true },
  ]
}

/** Runs an entry of `sessionMenu`; rename is handled inline by the caller. */
export async function runSessionMenu(
  rookery: ClientRookery,
  store: AgentsStore,
  host: string,
  s: SessionSummary,
  id: string,
  open: (host: string, sessionId: string) => void,
) {
  if (id === "open") {
    open(host, s.id)
    return
  }
  if (id === "copy") {
    const path = formatChatPath(host, s.id)
    const href = rookery.views.href("agents.chat", { path }) ?? `#${path}`
    const full = typeof location !== "undefined" ? new URL(href, location.href).toString() : href
    await navigator.clipboard?.writeText(full).catch(() => {})
    rookery.workbench.toast({ title: "Link copied" })
    return
  }
  if (id === "archive" || id === "unarchive") {
    await store.archiveSession(host, s.id, id === "archive").catch((e) =>
      rookery.workbench.toast({
        title: "Could not archive it",
        body: errorMessage(e),
        kind: "danger",
      }),
    )
  }
}

function filterSessions(sessions: readonly SessionSummary[], query: string): SessionSummary[] {
  const visible = sessions.filter((s) => !s.archived)
  const q = query.trim().toLowerCase()
  if (!q) return visible
  return visible.filter(
    (s) =>
      (s.title ?? "").toLowerCase().includes(q) ||
      (s.agent ?? "").toLowerCase().includes(q) ||
      (s.cwd ?? "").toLowerCase().includes(q) ||
      s.id.toLowerCase().includes(q),
  )
}

export function SessionList(props: {
  rookery: ClientRookery
  store: AgentsStore
  host: string | null
  active?: string
  onHostChange: (host: string) => void
  onOpen: (host: string, sessionId: string | null) => void
}) {
  const [query, setQuery] = createSignal("")
  const [now, setNow] = createSignal(Date.now())
  const [renaming, setRenaming] = createSignal<string | null>(null)
  const timer = setInterval(() => setNow(Date.now()), 30_000)
  onCleanup(() => clearInterval(timer))

  const runtime = createMemo(() => (props.host ? props.store.hostRuntime(props.host) : null))

  createEffect(
    on(
      () => props.host,
      (h) => {
        if (!h) return
        const rt = props.store.hostRuntime(h)
        if (rt.status() === "idle") {
          void rt.connect().catch(() => {})
        }
      },
    ),
  )

  const list = createMemo(() => filterSessions(runtime()?.sessions() ?? [], query()))
  const groups = createMemo(() => byDay(list()))

  const rename = async (s: SessionSummary, title: string) => {
    setRenaming(null)
    const next = title.trim()
    if (!next || next === s.title || !props.host) return
    await props.store.renameSession(props.host, s.id, next).catch((e) =>
      props.rookery.workbench.toast({
        title: "Could not rename it",
        body: errorMessage(e),
        kind: "danger",
      }),
    )
  }

  const move = (e: KeyboardEvent) => {
    if (e.key !== "ArrowDown" && e.key !== "ArrowUp") return
    const rows = [...(e.currentTarget as HTMLElement).querySelectorAll<HTMLElement>(".nc-lrow__main")]
    const i = rows.indexOf(document.activeElement as HTMLElement)
    if (i < 0) return
    e.preventDefault()
    rows[Math.max(0, Math.min(rows.length - 1, i + (e.key === "ArrowDown" ? 1 : -1)))]?.focus()
  }

  return (
    <aside class="ag-list" aria-label="Chats" data-part="session-list" onKeyDown={move}>
      <div class="ag-list__host" data-part="host-picker">
        <Select
          aria-label="Host"
          options={props.store.hosts().map((h) => ({
            value: h.name,
            label: h.name,
            description: `${h.kind} · ${h.state}`,
            icon: "server" as const,
            disabled: h.state === "offline",
          }))}
          value={props.host ?? ""}
          onChange={props.onHostChange}
          placeholder={props.store.hostsLoading() ? "Loading hosts…" : "Select host"}
        />
      </div>
      <div class="ag-list__head">
        <TextField
          variant="search"
          label="Search chats"
          placeholder="Search chats"
          value={query()}
          onInput={(e) => setQuery(e.currentTarget.value)}
        />
        <IconButton
          icon="plus"
          label="New chat"
          shortcut="Ctrl Alt N"
          data-part="new-chat"
          onClick={() => props.host && props.onOpen(props.host, null)}
        />
      </div>
      <Show when={runtime()?.status() === "error" && runtime()?.error()}>
        <div class="ag-list__error">
          <span class="nc-meta ag-error-text">{runtime()!.error()}</span>
          <Button
            size="sm"
            variant="ghost"
            onClick={() =>
              void runtime()
                ?.connect(true)
                .catch(() => {})
            }
          >
            Reconnect
          </Button>
        </div>
      </Show>
      <Show
        when={list().length}
        fallback={
          <p class="nc-meta ag-list__empty">
            {runtime()?.status() === "connecting"
              ? "Connecting…"
              : query()
                ? "No chats match."
                : props.host
                  ? "No chats yet."
                  : "Pick a host to view chats."}
          </p>
        }
      >
        <For each={groups()}>
          {(g) => (
            <>
              <Show when={groups().length > 1}>
                <span class="ag-list__day">{g.title}</span>
              </Show>
              <RowList label={g.title} flush>
                <For each={g.items}>
                  {(s) => {
                    const meta = () => rowMeta(s, now(), s.id === props.active)
                    const title = () => s.title || "New session"
                    const host = () => props.host ?? ""
                    const path = () => formatChatPath(host(), s.id)
                    return (
                      <ContextMenu
                        label="Session"
                        items={() => sessionMenu(s)}
                        onSelect={(id) =>
                          id === "rename"
                            ? setRenaming(s.id)
                            : runSessionMenu(props.rookery, props.store, host(), s, id, (h, sid) =>
                                props.onOpen(h, sid),
                              )
                        }
                      >
                        <Show
                          when={renaming() !== s.id}
                          fallback={
                            <div class="ag-list__rename">
                              <InlineField
                                label="Session title"
                                value={s.title || ""}
                                selectOnFocus
                                ref={(el: HTMLElement) => queueMicrotask(() => el.focus())}
                                onCommit={(v) => rename(s, v)}
                                onFocusOut={() => setRenaming(null)}
                              />
                            </div>
                          }
                        >
                          <ListRow
                            href={props.rookery.views.href("agents.chat", { path: path() }) ?? `#${path()}`}
                            title={title()}
                            selected={s.id === props.active}
                            data-session={s.id}
                            data-state={s.state}
                            meta={
                              <span class="ag-list__meta" data-tone={meta().tone}>
                                {meta().word}
                              </span>
                            }
                            onClick={(e) => {
                              if (e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey) return
                              e.preventDefault()
                              props.onOpen(host(), s.id)
                            }}
                            onKeyDown={(e: KeyboardEvent) => {
                              if (e.key === "F2") {
                                e.preventDefault()
                                setRenaming(s.id)
                              }
                            }}
                          />
                        </Show>
                      </ContextMenu>
                    )
                  }}
                </For>
              </RowList>
            </>
          )}
        </For>
      </Show>
    </aside>
  )
}

/**
 * The session list on a phone: host picker, pull-to-refresh, search, and day-grouped sessions.
 */
export function PhoneSessionList(props: {
  rookery: ClientRookery
  store: AgentsStore
  host: string | null
  onHostChange: (host: string) => void
  onOpen: (host: string, sessionId: string) => void
}) {
  const [query, setQuery] = createSignal("")
  const runtime = createMemo(() => (props.host ? props.store.hostRuntime(props.host) : null))
  const list = createMemo(() => filterSessions(runtime()?.sessions() ?? [], query()))
  const groups = createMemo(() => byDay(list()))
  const [now, setNow] = createSignal(Date.now())
  const timer = setInterval(() => setNow(Date.now()), 30_000)
  onCleanup(() => clearInterval(timer))

  provideScreen(() => ({
    actions: [
      {
        id: "new",
        label: "New chat",
        icon: "plus",
        onClick: () => props.rookery.workbench.openView("agents.new"),
      },
    ],
  }))

  return (
    <div class="ag-phone-list" data-part="session-list">
      <ScreenRefresh onRefresh={() => runtime()?.refresh() ?? props.store.refreshHosts()} />
      <div class="ag-phone-list__host">
        <Select
          aria-label="Host"
          options={props.store.hosts().map((h) => ({
            value: h.name,
            label: h.name,
            description: `${h.kind} · ${h.state}`,
            icon: "server" as const,
            disabled: h.state === "offline",
          }))}
          value={props.host ?? ""}
          onChange={props.onHostChange}
          placeholder="Select host"
        />
      </div>
      <ScreenSearch label="Search chats" placeholder="Search chats" value={query()} onInput={setQuery} />
      <Show
        when={list().length}
        fallback={
          <p class="nc-meta ag-phone-list__empty">
            {runtime()?.status() === "connecting"
              ? "Connecting…"
              : query()
                ? "No chats match."
                : "No chats yet."}
          </p>
        }
      >
        <InsetList>
          <For each={groups()}>
            {(g) => (
              <InsetGroup title={groups().length > 1 ? g.title : undefined}>
                <For each={g.items}>
                  {(s) => {
                    const meta = () => rowMeta(s, now(), false)
                    const host = () => props.host ?? ""
                    const path = () => formatChatPath(host(), s.id)
                    return (
                      <InsetRow
                        data-session={s.id}
                        data-state={s.state}
                        label={s.title || "New session"}
                        value={
                          <span class="ag-list__meta" data-tone={meta().tone}>
                            {meta().word}
                          </span>
                        }
                        href={props.rookery.views.href("agents.chat", { path: path() }) ?? undefined}
                        onClick={() => props.onOpen(host(), s.id)}
                        menu={sessionMenu(s).filter((e) => !("id" in e) || e.id !== "rename")}
                        menuLabel="Session"
                        onMenuSelect={(id) =>
                          runSessionMenu(props.rookery, props.store, host(), s, id, props.onOpen)
                        }
                        trailingActions={
                          !s.archived
                            ? [
                                {
                                  id: "archive",
                                  label: "Archive",
                                  icon: "folder",
                                  tone: "danger",
                                  onAction: () =>
                                    runSessionMenu(
                                      props.rookery,
                                      props.store,
                                      host(),
                                      s,
                                      "archive",
                                      props.onOpen,
                                    ),
                                },
                              ]
                            : undefined
                        }
                      />
                    )
                  }}
                </For>
              </InsetGroup>
            )}
          </For>
        </InsetList>
      </Show>
    </div>
  )
}

const effortLevels: EffortLevel[] = ["low", "medium", "high", "max"]

/** The composer wired to Parrot `ConfigOption`s (model/mode/effort) and `Action`s (commands/skills). */
export function SessionComposer(props: {
  options?: readonly ConfigOption[]
  actions?: readonly Action[]
  onSend: (input: PromptInput, submit: ComposerSubmit) => void | Promise<void>
  onAction?: (action: Action, args: string) => void | Promise<void>
  onStop?: () => void
  /** Working, and the harness accepts steering messages while running. */
  working?: boolean
  placeholder?: string
  running?: boolean
  disabled?: boolean
  onModel?: (id: string) => void
  onMode?: (id: string) => void
  onEffort?: (e: string) => void
  model?: string
  mode?: string
  effort?: string
  dictation?: DictationState
}) {
  const [value, setValue] = createSignal<ComposerValue>([])
  const phone = useMedia(PHONE)

  const opts = () => props.options ?? []
  const modelOpt = createMemo(() => findOptionByRole(opts(), "model"))
  const modeOpt = createMemo(() => findOptionByRole(opts(), "mode"))
  const effortOpt = createMemo(() => findOptionByRole(opts(), "effort"))

  const modelChoices = createMemo(() => extractOptionChoices(modelOpt(), opts()))
  const modeChoices = createMemo(() => extractOptionChoices(modeOpt(), opts()))
  const effortChoices = createMemo(() => extractOptionChoices(effortOpt(), opts()))

  const commands = createMemo<ComposerItem[]>(() =>
    (props.actions ?? [])
      .filter((a) => a.source !== "skill")
      .map((a) => ({
        id: `action:${a.id}`,
        label: (a.name || a.label).replace(/^\//, ""),
        description: a.description ?? undefined,
        group: a.source,
      })),
  )

  const skills = createMemo<ComposerItem[]>(() =>
    (props.actions ?? [])
      .filter((a) => a.source === "skill")
      .map((a) => ({
        id: `action:${a.id}`,
        label: (a.name || a.label).replace(/^\$/, ""),
        description: a.description ?? undefined,
        group: "Skills",
      })),
  )

  const send = async (s: ComposerSubmit) => {
    const chips = s.value.filter((v) => v.type === "chip") as Array<
      Extract<ComposerValue[number], { type: "chip" }>
    >
    const actionChip = chips.find((c) => c.id.startsWith("action:"))
    if (actionChip && props.onAction) {
      const actionId = actionChip.id.slice("action:".length)
      const action = (props.actions ?? []).find((a) => a.id === actionId)
      if (action) {
        const rest = s.text.replace(`${actionChip.trigger}${actionChip.label}`, "").trim()
        await props.onAction(action, rest)
        setValue([])
        return
      }
    }

    await props.onSend({ text: s.text }, s)
    setValue([])
  }

  const effort = (): EffortLevel | undefined => {
    const raw = props.effort ?? optionStringValue(effortOpt())
    if (!raw) return undefined
    return (
      effortLevels.includes(raw as EffortLevel) ? raw : raw === "xhigh" ? "high" : "medium"
    ) as EffortLevel
  }

  return (
    <div class="ag-composer" data-part="composer">
      <Composer
        value={value()}
        onValueChange={setValue}
        onSubmit={send}
        placeholder={
          props.placeholder ??
          (props.running
            ? "Queue a follow-up…"
            : props.working
              ? phone()
                ? "Steer it…"
                : "Steer it, or press Esc to stop…"
              : "Ask anything…")
        }
        commands={commands()}
        skills={skills()}
        models={modelChoices().length ? modelChoices() : undefined}
        model={props.model ?? optionStringValue(modelOpt())}
        onModelChange={(id) => props.onModel?.(id)}
        modes={modeChoices().length ? modeChoices() : undefined}
        mode={props.mode ?? optionStringValue(modeOpt())}
        onModeChange={(id) => props.onMode?.(id)}
        effort={effort()}
        onEffortChange={effortChoices().length ? (e) => props.onEffort?.(e) : undefined}
        running={props.running}
        working={props.working}
        runningLabel="Working…"
        onStop={props.onStop}
        disabled={props.disabled}
        dictation={props.dictation}
      />
    </div>
  )
}

function ContextPanel(props: { host: string; follower: SessionFollower; phone: boolean }) {
  const session = () => props.follower.session()
  const usage = () => props.follower.usage()
  const fileChanges = createMemo(
    () =>
      props.follower.items().filter((i) => i.kind === "file_change") as Array<
        FileChangeItem & { kind: "file_change" }
      >,
  )

  const pct = () => {
    const ctx = usage()?.context
    if (!ctx?.used || !ctx.window) return null
    return Math.min(100, Math.round((ctx.used / ctx.window) * 100))
  }

  const Row = (p: { icon: string; name: string; meta?: string; onClick?: () => void }) => (
    <ListRow
      icon={p.icon as IconName}
      title={p.name}
      meta={p.meta}
      onClick={p.onClick ? () => p.onClick!() : undefined}
    />
  )

  return (
    <div class="ag-ctx" data-part="context-panel">
      <div class="ag-ctx__body">
        <Show when={(pct() ?? 0) >= 50}>
          <section class="ag-ctx__section">
            <div class="ag-ctx__window nc-meta">
              <span>Context window</span>
              <span class="nc-mono">{pct()}%</span>
            </div>
            <div class="ag-ctx__bar">
              <span style={{ width: `${pct()}%` }} />
            </div>
          </section>
        </Show>
        <section class="ag-ctx__section">
          <SectionHeading title="Session" />
          <RowList label="Session" flush>
            <Show
              when={props.phone}
              fallback={<Row icon="sparkle" name={session()?.binding?.agent ?? "Agent"} />}
            >
              <Row icon="server" name={props.host} meta={session()?.binding?.agent ?? undefined} />
            </Show>
            <Show when={session()?.cwd}>
              <Row icon="folder" name={session()!.cwd} meta={session()?.binding?.level ?? undefined} />
            </Show>
            <Show when={usage()?.tokens}>
              {(tok) => (
                <Row
                  icon="activity"
                  name={`${(tok().input + tok().output).toLocaleString()} tokens`}
                  meta={
                    usage()?.cost
                      ? `${usage()!.cost!.currency === "USD" ? "$" : `${usage()!.cost!.currency} `}${usage()!.cost!.amount.toFixed(4)}`
                      : undefined
                  }
                />
              )}
            </Show>
          </RowList>
        </section>

        <Show when={props.follower.background().length > 0}>
          <section class="ag-ctx__section" data-part="background-tasks">
            <SectionHeading title="Background" />
            <RowList label="Background" flush>
              <For each={props.follower.background()}>
                {(bg) => <Row icon="activity" name={bg.title} meta={bg.kind} />}
              </For>
            </RowList>
          </section>
        </Show>

        <Show when={fileChanges().length > 0}>
          <section class="ag-ctx__section" data-part="changes">
            <SectionHeading title="Changes" />
            <RowList label="Changes" flush>
              <For each={fileChanges()}>
                {(fc) => (
                  <Row
                    icon="branch"
                    name={
                      fc.changes.length === 1 ? fc.changes[0]!.path : `${fc.changes.length} files changed`
                    }
                    meta={fc.status}
                    onClick={() =>
                      document
                        .querySelector(`[data-part="file-change"][data-item="${fc.id}"]`)
                        ?.scrollIntoView({ behavior: "smooth" })
                    }
                  />
                )}
              </For>
            </RowList>
          </section>
        </Show>
      </div>
    </div>
  )
}

function LayoutHandle(props: { set: (l: ReturnType<typeof useViewLayout>) => void }) {
  props.set(useViewLayout())
  return null
}

export function Conversation(props: {
  rookery: ClientRookery
  store: AgentsStore
  host: string
  id: string
  phone: boolean
  onBack?: () => void
  setTitle?: (t: string) => void
  sidebar?: JSX.Element
  onReady?: () => void
}): JSX.Element {
  const f = props.store.followSession(props.host, props.id)
  onCleanup(() => f.dispose())
  createEffect(() => (f.ready() || f.error()) && props.onReady?.())

  const [term, setTerm] = createSignal(false)
  let layout: ReturnType<typeof useViewLayout> | undefined
  let asideBefore = false

  const showTerminal = () => {
    if (term()) return
    asideBefore = !!layout?.asideOpen()
    if (asideBefore) layout?.toggleAside()
    setTerm(true)
  }

  const hideTerminal = () => {
    setTerm(false)
    if (asideBefore && !layout?.asideOpen()) layout?.toggleAside()
    asideBefore = false
  }

  const session = () => f.session()
  const isTui = () => session()?.binding?.control === "tui"
  const unrecognised = () => f.state() === "unrecognised" && isTui()

  createEffect(() => {
    if (session() && !isTui() && untrack(term)) hideTerminal()
  })

  const [err, setErr] = createSignal<string | null>(null)
  createEffect(() => props.setTitle?.(session()?.title || "Agents"))

  const hostAgent = createMemo(() => {
    const id = session()?.binding?.agent
    if (!id) return undefined
    return props.store
      .hostRuntime(props.host)
      .agents()
      .find((a) => a.id === id)
  })

  const canUse = () => {
    const grant = session()?.grant
    if (!grant || grant.length === 0) return true
    return grant.includes("prompt") || grant.includes("manage") || grant.includes("answer")
  }

  const groups = createMemo(() => turns(f.items(), f.requests()))

  let scroller: HTMLDivElement | undefined
  let stick = true
  const onScroll = () => {
    if (!scroller) return
    stick = scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight < 80
  }

  createEffect(
    on(
      () => {
        const its = f.items()
        const last = its[its.length - 1]
        const text = last && "text" in last ? last.text : undefined
        return [its.length, text, f.requests().length, f.state()] as const
      },
      () =>
        queueMicrotask(() => {
          if (stick && scroller) scroller.scrollTop = scroller.scrollHeight
        }),
    ),
  )

  const act = async (fn: () => Promise<unknown>) => {
    setErr(null)
    try {
      await fn()
    } catch (e) {
      setErr(errorMessage(e))
    }
  }

  const setOption = (role: "model" | "mode" | "effort", value: string) => {
    const opt = findOptionByRole(f.options(), role)
    const id = opt?.id ?? role
    return act(() => props.store.setOptions(props.host, props.id, { [id]: value }))
  }

  const send = (input: PromptInput) =>
    act(async () => {
      const t = input.text.trim()
      if (t === "/diff" || t.startsWith("/diff ")) {
        document
          .querySelector('[data-part="file-change"]:last-of-type')
          ?.scrollIntoView({ behavior: "smooth" })
        return
      }
      if (t.startsWith("/rename ")) {
        await props.store.renameSession(props.host, props.id, t.slice(8).trim())
        return
      }
      if (t === "/new") {
        props.onBack?.()
        return
      }
      await props.store.sendPrompt(props.host, props.id, {
        ...input,
        delivery: busy(f.state()) ? "auto" : undefined,
      })
    })

  const menu = createSessionMenu({
    host: props.host,
    get session() {
      return session()!
    },
    get agent() {
      return hostAgent()
    },
    store: props.store,
    get busy() {
      return busy(f.state())
    },
    get canUse() {
      return canUse()
    },
    onShowTerminal: showTerminal,
    onError: setErr,
  })

  const header = () => (
    <ViewHeader
      context={
        <>
          <Show when={!props.phone && session()}>
            {(s) => (
              <span class="ag-where nc-meta" data-part="session-where" title={s().cwd}>
                <Icon name="server" size="sm" />
                {props.host}
                <Show when={s().binding?.agent}>
                  <Icon name="sparkle" size="sm" />
                  <span>{hostAgent()?.name ?? s().binding!.agent}</span>
                </Show>
              </span>
            )}
          </Show>
          <Show when={!props.phone && session()}>
            {(s) => (
              <SessionMenu
                host={props.host}
                session={s()}
                agent={hostAgent()}
                store={props.store}
                busy={busy(f.state())}
                canUse={canUse()}
                onShowTerminal={showTerminal}
                onError={setErr}
              />
            )}
          </Show>
        </>
      }
      actions={[
        ...(busy(f.state()) && canUse()
          ? [
              {
                id: "stop",
                label: "Stop",
                icon: "close" as const,
                onClick: () => void act(() => props.store.cancelSession(props.host, props.id)),
              },
            ]
          : []),
        ...(props.phone && session() ? menu.actions() : []),
      ]}
    />
  )

  const composer = () => (
    <div class="ag-thread-pad">
      <SessionComposer
        options={f.options()}
        actions={f.actions()}
        onSend={send}
        onAction={(action, args) =>
          act(() => props.store.invokeAction(props.host, props.id, action.id, args))
        }
        disabled={!session()}
        running={busy(f.state())}
        onStop={() => act(() => props.store.cancelSession(props.host, props.id))}
        onModel={(id) => void setOption("model", id)}
        onMode={(id) => void setOption("mode", id)}
        onEffort={(id) => void setOption("effort", id)}
      />
    </div>
  )

  return (
    <ViewLayout
      id="agents.chat"
      sidebar={props.sidebar}
      sidebarLabel="Chats"
      header={header()}
      aside={<ContextPanel host={props.host} follower={f} phone={props.phone} />}
      asideLabel="Context"
      asideCollapsed
      sidebarWidth={LIST_WIDTH}
      scroll={false}
      minMain={600}
    >
      <LayoutHandle set={(l) => (layout = l)} />
      <Show when={props.phone}>
        <ScreenOptions mode="full" />
      </Show>
      <div class="ag-split">
        <div class="ag-main" data-part="conversation" data-state={f.state()}>
          <Show when={unrecognised() && session()}>
            <div class="ag-thread-pad">
              <UnrecognisedBanner session={session()!} />
            </div>
            <TerminalPane host={props.host} session={session()!} store={props.store} full />
          </Show>
          <div class="ag-scroll" ref={scroller} onScroll={onScroll} hidden={unrecognised()}>
            <div class="ag-thread">
              <SessionAbout session={session()} />
              <Show
                when={f.ready()}
                fallback={
                  <Show when={f.error()} fallback={<p class="nc-meta">Loading…</p>}>
                    {(e) => <Callout tone="danger">{e()}</Callout>}
                  </Show>
                }
              >
                <Show
                  when={groups().length}
                  fallback={
                    <EmptyState
                      icon="sparkle"
                      title={f.state() === "starting" ? "The agent is starting" : "Ready"}
                      description="Write what it should do."
                    />
                  }
                >
                  <For each={groups()}>
                    {(t, i) => (
                      <Turn
                        turn={t}
                        last={i() === groups().length - 1}
                        ctx={{
                          rookery: props.rookery,
                          store: props.store,
                          host: props.host,
                          session,
                          canUse,
                          openTerminal: isTui() ? showTerminal : undefined,
                        }}
                      />
                    )}
                  </For>
                </Show>
              </Show>
              <Show when={f.state() === "stopped" || f.state() === "lost"}>
                <div class="ag-ended nc-meta" data-part="ended">
                  {f.state() === "lost"
                    ? `The session was lost${f.detail() ? `: ${f.detail()}` : "."}`
                    : "The session stopped."}
                  <Show when={canUse()}>
                    <Button
                      size="sm"
                      variant="ghost"
                      onClick={() => act(() => props.store.startBinding(props.host, props.id))}
                    >
                      Continue it
                    </Button>
                  </Show>
                </div>
              </Show>
            </div>
          </div>
          <Show when={err()}>
            <p class="nc-meta ag-error-text ag-thread-pad">{err()}</p>
          </Show>
          <Show
            when={!session() || (canUse() && !session()?.archived)}
            fallback={
              <p class="nc-meta ag-thread-pad">
                {session()?.archived ? "Archived." : "You can read this session."}
              </p>
            }
          >
            <Show when={!unrecognised()}>
              <Show when={props.phone} fallback={composer()}>
                <BottomArea>{composer()}</BottomArea>
              </Show>
            </Show>
          </Show>
        </div>
        <Show when={term() && !unrecognised() && isTui() && session()}>
          <TerminalPane host={props.host} session={session()!} store={props.store} onClose={hideTerminal} />
        </Show>
      </div>
    </ViewLayout>
  )
}

interface ChatSlot {
  host: string
  id: string
  timer?: ReturnType<typeof setTimeout>
}

const NEXT_CHAT_WAIT_MS = 1200

export function ChatView(rookery: ClientRookery, store: AgentsStore) {
  return (props: { view: { path: string; setTitle(t: string): void } }) => {
    const phone = useMedia(PHONE)
    const parsed = createMemo(() => parseChatPath(props.view.path || ""))

    const activeHost = createMemo(() => parsed().host ?? store.selectedHost())
    const activeSession = createMemo(() => parsed().sessionId)

    createEffect(() => {
      const h = parsed().host
      if (h) store.setSelectedHost(h)
    })

    // Ensure host list has been loaded at least once.
    createEffect(() => {
      if (store.hosts().length === 0 && !store.hostsLoading() && !store.hostsError()) {
        void store.refreshHosts()
      }
    })

    const open = (host: string, sessionId: string | null) => {
      store.setSelectedHost(host)
      const path = formatChatPath(host, sessionId)
      rookery.workbench.openView("agents.chat", { path })
    }

    const changeHost = (host: string) => {
      store.setSelectedHost(host)
      rookery.workbench.openView("agents.chat", { path: formatChatPath(host) })
    }

    createEffect(() => {
      if (!activeSession()) props.view.setTitle("Agents")
    })

    const desktopList = createMemo(() =>
      phone() ? undefined : (
        <SessionList
          rookery={rookery}
          store={store}
          host={activeHost()}
          active={activeSession() ?? undefined}
          onHostChange={changeHost}
          onOpen={open}
        />
      ),
    )

    const [slots, setSlots] = createSignal<ChatSlot[]>([])
    const [front, setFront] = createSignal<ChatSlot | null>(null)

    const show = (slot: ChatSlot) => {
      if (untrack(front) === slot || !untrack(slots).includes(slot)) return
      clearTimeout(slot.timer)
      batch(() => {
        setFront(slot)
        setSlots([slot])
      })
    }

    createEffect(
      on(
        () => [activeHost(), activeSession()] as const,
        ([host, id]) => {
          const shown = untrack(front)
          for (const s of untrack(slots)) if (s !== shown) clearTimeout(s.timer)
          if (!host || !id) {
            clearTimeout(shown?.timer)
            batch(() => {
              setSlots([])
              setFront(null)
            })
            return
          }
          if (shown?.host === host && shown?.id === id) return setSlots([shown])
          const slot: ChatSlot = { host, id }
          if (!shown) {
            batch(() => {
              setSlots([slot])
              setFront(slot)
            })
            return
          }
          slot.timer = setTimeout(() => show(slot), NEXT_CHAT_WAIT_MS)
          setSlots([shown, slot])
        },
      ),
    )

    onCleanup(() => {
      for (const s of untrack(slots)) clearTimeout(s.timer)
    })

    return (
      <div class="ag-layout" classList={{ "ag-layout--phone": phone() }} data-part="agents">
        <Show
          when={activeHost() && activeSession()}
          fallback={
            <ViewLayout
              id="agents.chat"
              sidebar={
                phone() ? (
                  <PhoneSessionList
                    rookery={rookery}
                    store={store}
                    host={activeHost()}
                    onHostChange={changeHost}
                    onOpen={(h, sid) => open(h, sid)}
                  />
                ) : (
                  desktopList()
                )
              }
              sidebarLabel="Chats"
              sidebarWidth={LIST_WIDTH}
              minMain={600}
            >
              <NewSession store={store} initialHost={activeHost()} onStarted={(h, sid) => open(h, sid)} />
            </ViewLayout>
          }
        >
          <For each={slots()}>
            {(slot) => (
              <div class="ag-slot" classList={{ "ag-slot--hidden": front() !== slot }}>
                <Conversation
                  rookery={rookery}
                  store={store}
                  host={slot.host}
                  id={slot.id}
                  phone={phone()}
                  onBack={() => open(slot.host, null)}
                  setTitle={front() === slot ? (t) => props.view.setTitle(t) : undefined}
                  sidebar={phone() || front() !== slot ? undefined : desktopList()}
                  onReady={() => show(slot)}
                />
              </div>
            )}
          </For>
        </Show>
      </div>
    )
  }
}

export { Badge }
