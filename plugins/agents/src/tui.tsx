// What the chat shows for a Parrot TUI-controlled session (`binding.control === "tui"`) and for
// generic interactive/auth requests (`kind: "input" | "auth"`):
//
// - `SurfaceCard`: an `input` or `auth` request card with cleaned text, choices/free input, and
//   "Open screen" when the binding runs in TUI mode.
// - `TerminalPane`: live `session/screen` snapshot viewer with `session/keys` input for TUI
//   bindings (beside the chat, or full-screen while the state is `unrecognised`).
// - `UnrecognisedBanner`: explains why the raw screen is shown while Parrot cannot parse it.
// - `SessionMenu`: session menu to switch control (native/TUI when supported), show screen, or
//   stop the binding.
import {
  Badge,
  Button,
  Callout,
  Card,
  DropdownMenu,
  Icon,
  IconButton,
  type MenuEntry,
  type MenuItemEntry,
  TextField,
} from "@aiviarium/nocturne"
import { createEffect, createSignal, For, type JSX, onCleanup, Show } from "solid-js"
import { errorMessage } from "./api"
import { surfaceText } from "./model"
import { type Agent, formatAnswer, type Request, type Session } from "./parrot"
import type { AgentsStore } from "./store"

/** An `input` or `auth` Parrot request rendered as a generic surface card. */
export function SurfaceCard(props: {
  request: Request
  host: string
  store: AgentsStore
  canUse: () => boolean
  onOpenTerminal?: () => void
}): JSX.Element {
  const req = () => props.request
  const pending = () => req().status === "open"
  const [err, setErr] = createSignal<string | null>(null)
  const [sending, setSending] = createSignal(false)
  const [textInput, setTextInput] = createSignal("")

  const body = () =>
    surfaceText({
      title: req().title,
      text: req().description ?? "",
    })

  const pickChoice = async (choiceId: string) => {
    setErr(null)
    setSending(true)
    try {
      await props.store.answerRequest(props.host, req().id, { choice: choiceId })
    } catch (e) {
      setErr(errorMessage(e))
    } finally {
      setSending(false)
    }
  }

  const submitText = async () => {
    const val = textInput().trim()
    if (!val) return
    setErr(null)
    setSending(true)
    try {
      await props.store.answerRequest(props.host, req().id, { value: val, input: val })
      setTextInput("")
    } catch (e) {
      setErr(errorMessage(e))
    } finally {
      setSending(false)
    }
  }

  return (
    <Card
      class="ag-surface"
      data-part="surface-card"
      data-request={req().id}
      data-status={req().status}
      title={req().title || (req().kind === "auth" ? "Sign in required" : "The terminal asks")}
      action={
        <Show
          when={pending()}
          fallback={<Badge tone="neutral">{req().status === "cancelled" ? "Closed" : "Answered"}</Badge>}
        >
          <Badge tone="warning">Needs you</Badge>
        </Show>
      }
    >
      <Show when={body()}>
        <pre class="ag-surface__text nc-mono">{body()}</pre>
      </Show>
      <Show
        when={pending()}
        fallback={
          <span class="nc-meta ag-surface__answer" data-part="surface-answer">
            {formatAnswer(req())}
          </span>
        }
      >
        <Show when={(req().choices ?? []).length > 0}>
          <div class="ag-surface__options">
            <For each={req().choices ?? []}>
              {(o, idx) => (
                <Button
                  size="sm"
                  variant={o.intent === "allow" || idx() === 0 ? "primary" : "secondary"}
                  disabled={!props.canUse() || sending()}
                  onClick={() => pickChoice(o.id)}
                  data-part="surface-option"
                >
                  {o.label}
                </Button>
              )}
            </For>
          </div>
        </Show>
        <Show when={req().input != null || !(req().choices ?? []).length}>
          <div class="ag-surface__input">
            <TextField
              label={req().kind === "auth" ? "Code or token" : "Response"}
              value={textInput()}
              onInput={(e) => setTextInput(e.currentTarget.value)}
            />
            <Button
              size="sm"
              variant="primary"
              disabled={!props.canUse() || sending() || !textInput().trim()}
              onClick={submitText}
            >
              Send
            </Button>
          </div>
        </Show>
      </Show>
      <div class="ag-surface__foot">
        <Show when={props.onOpenTerminal}>
          <Button
            size="sm"
            variant="ghost"
            icon="terminal"
            onClick={props.onOpenTerminal}
            data-part="open-terminal"
          >
            Open screen
          </Button>
        </Show>
      </div>
      <Show when={err()}>
        <span class="nc-meta ag-error-text">{err()}</span>
      </Show>
    </Card>
  )
}

/** Shows a TUI-controlled Parrot session's screen (`session/screen`) and sends keystrokes (`session/keys`). */
export function TerminalPane(props: {
  host: string
  session: Session
  store: AgentsStore
  onClose?: () => void
  /** In place of the chat (when state is `unrecognised`), not beside it. */
  full?: boolean
}): JSX.Element {
  const [screen, setScreen] = createSignal("")
  const [err, setErr] = createSignal<string | null>(null)
  const [input, setInput] = createSignal("")

  const poll = async () => {
    try {
      const res = await props.store.getScreen(props.host, props.session.id)
      setScreen(res.text)
      setErr(null)
    } catch (e) {
      setErr(errorMessage(e))
    }
  }

  createEffect(() => {
    const _id = props.session.id
    void poll()
    const timer = setInterval(() => void poll(), 1000)
    onCleanup(() => clearInterval(timer))
  })

  const send = async (keys: { text?: string; press?: string[] }) => {
    try {
      await props.store.sendKeys(props.host, props.session.id, keys)
      await poll()
    } catch (e) {
      setErr(errorMessage(e))
    }
  }

  return (
    <section
      class={props.full ? "ag-term ag-term--full" : "ag-term"}
      aria-label="Terminal"
      data-part="session-terminal"
    >
      <Show when={!props.full}>
        <header class="ag-term__head">
          <Icon name="terminal" size="sm" />
          <span class="ag-term__title">Terminal</span>
          <span class="nc-meta">{props.session.binding?.agent ?? ""}</span>
          <span class="crow-push" />
          <Show when={props.onClose}>
            <IconButton label="Hide the terminal" icon="close" onClick={props.onClose} />
          </Show>
        </header>
      </Show>
      <div class="ag-term__body">
        <Show when={screen()} fallback={<p class="nc-meta ag-thread-pad">{err() ?? "Loading screen…"}</p>}>
          <pre class="ag-term__screen nc-mono">{screen()}</pre>
        </Show>
        <div class="ag-term__controls">
          <TextField
            label="Send keys"
            placeholder="Type text and press Send…"
            value={input()}
            onInput={(e) => setInput(e.currentTarget.value)}
          />
          <Button
            size="sm"
            variant="secondary"
            onClick={async () => {
              const t = input()
              if (!t) return
              setInput("")
              await send({ text: t, press: ["Enter"] })
            }}
          >
            Send
          </Button>
          <Button size="sm" variant="ghost" onClick={() => send({ press: ["Enter"] })}>
            Enter
          </Button>
          <Button size="sm" variant="ghost" onClick={() => send({ press: ["Escape"] })}>
            Esc
          </Button>
        </div>
      </div>
    </section>
  )
}

/** Shown while Parrot's state is `unrecognised`: the chat makes way for the live screen. */
export function UnrecognisedBanner(props: { session: Session }): JSX.Element {
  return (
    <Callout tone="warning" data-part="unrecognised">
      <div class="ag-unrec">
        <span>
          Parrot cannot recognise this screen of {props.session.binding?.agent ?? "the agent"}. Carry on in
          the terminal below, and the chat returns once the screen is recognised again.
        </span>
      </div>
    </Callout>
  )
}

const CONTROL_LABEL: Record<string, string> = { native: "Native protocol", tui: "Terminal UI" }

interface SessionMenuProps {
  host: string
  session: Session
  agent?: Agent
  store: AgentsStore
  busy: boolean
  canUse: boolean
  onShowTerminal: () => void
  onError: (message: string) => void
}

/** The entries of the session's menu (control mode, TUI screen, stop binding). */
export function createSessionMenu(props: SessionMenuProps) {
  const items = (): MenuEntry[] => {
    const out: MenuEntry[] = []
    const controls = props.agent?.controls ?? []
    const currentControl = props.session.binding?.control
    if (controls.length > 1) {
      out.push({ type: "label", label: props.busy ? "Runs as (after this turn)" : "Runs as" })
      for (const c of controls) {
        out.push({
          id: `control:${c}`,
          label: CONTROL_LABEL[c] ?? c,
          description: c === "tui" ? "The CLI's own terminal UI" : "The CLI's protocol",
          icon: c === "tui" ? "terminal" : "sparkle",
          checked: c === currentControl,
          disabled: props.busy || !props.canUse || c === currentControl,
        })
      }
    }
    if (currentControl === "tui") {
      if (out.length) out.push({ type: "separator" })
      out.push({ id: "terminal", label: "Show the screen", icon: "terminal" })
    }
    if (props.canUse && props.session.state !== "stopped") {
      if (out.length) out.push({ type: "separator" })
      out.push({ id: "stop", label: "Stop session", icon: "close", danger: true })
    }
    return out
  }

  const select = async (id: string) => {
    if (id === "terminal") return props.onShowTerminal()
    if (id === "stop") {
      try {
        await props.store.stopSession(props.host, props.session.id)
      } catch (e) {
        props.onError(errorMessage(e))
      }
      return
    }
    if (id.startsWith("control:")) {
      const control = id.slice("control:".length) as "native" | "tui"
      try {
        await props.store.rebindSession(props.host, props.session.id, { control })
      } catch (e) {
        props.onError(errorMessage(e))
      }
    }
  }

  const actions = () =>
    items().flatMap((e) => {
      if ((e.type ?? "item") !== "item") return []
      const it = e as MenuItemEntry
      const isControl = it.id.startsWith("control:")
      if (isControl && it.checked) return []
      return [
        {
          id: it.id,
          label: isControl ? `Switch to ${it.label}` : it.label,
          icon: it.icon,
          overflow: true,
          disabled: it.disabled,
          onClick: () => queueMicrotask(() => select(it.id)),
        },
      ]
    })

  return { items, select, actions }
}

/** The session's menu: control mode, terminal screen, and stop action. */
export function SessionMenu(props: SessionMenuProps): JSX.Element {
  const menu = createSessionMenu(props)
  return (
    <Show when={menu.items().length}>
      <DropdownMenu
        label="Session"
        items={menu.items()}
        onSelect={(id) => queueMicrotask(() => menu.select(id))}
        placement="bottom-end"
        trigger={(t) => <IconButton {...t} label="Session menu" icon="more" data-part="session-menu" />}
      />
    </Show>
  )
}
