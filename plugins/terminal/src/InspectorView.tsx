// The host's screen for one terminal: what `rookeryd` keeps for the session, asked for as escape
// sequences and drawn read-only. Not a second viewer, so what it shows and what the attach stream
// carries are the same screen.
//
// Ported from the prototype's `plugins/terminal/inspector.tsx`, without the labelled TUI tree: TUI trees
// and screen automation are Parrot's (plans/design.md, the decisions), and no `terminals.*` method here
// automates a screen. This keeps the part the server does provide: `terminals.screen`.
import { Badge, Card, EmptyState, StatusDot, StreamState, ViewHeader } from "@aiviarium/nocturne"
import type { ScreenInfo } from "@rookery/client"
import type { ClientRookery, ViewHandle } from "@rookery/sdk/client"
import { Terminal } from "@xterm/xterm"
import "@xterm/xterm/css/xterm.css"
import { createSignal, type JSX, onCleanup, onMount, Show } from "solid-js"
import type { TerminalsApi } from "./termApi"
import { codeFontSize, monoFont, onThemeChange, xtermTheme } from "./theme"

const POLL_MS = 2000

export function InspectorView(props: {
  view: ViewHandle
  rookery: ClientRookery
  terminals: TerminalsApi
}): JSX.Element {
  props.view.setTitle("Host screen")
  const id = () => props.view.path
  let screenEl!: HTMLDivElement
  const [screen, setScreen] = createSignal<ScreenInfo | null>(null)
  const [error, setError] = createSignal<string>()
  const [live, setLive] = createSignal(false)

  const term = new Terminal({
    disableStdin: true,
    fontFamily: monoFont(),
    fontSize: codeFontSize(),
    theme: xtermTheme(),
    scrollback: 0,
    cursorBlink: false,
  })
  const offTheme = onThemeChange(() => {
    term.options.theme = xtermTheme()
  })

  let refreshing = false
  let again = false

  const refresh = async () => {
    if (refreshing) {
      again = true
      return
    }
    refreshing = true
    try {
      const sc = await props.terminals.screen(id(), { ansi: true })
      setScreen(sc)
      setLive(true)
      setError(undefined)
      if (term.cols !== sc.size.cols || term.rows !== sc.size.rows) term.resize(sc.size.cols, sc.size.rows)
      term.reset()
      term.write(sc.ansi ?? "")
    } catch (e: any) {
      setLive(false)
      setError(e?.message ?? String(e))
    } finally {
      refreshing = false
      if (again) {
        again = false
        queueMicrotask(refresh)
      }
    }
  }

  onMount(() => {
    term.open(screenEl)
    void refresh()
    // The host's screen moves without telling us: a slow poll shows the result.
    const poll = setInterval(refresh, POLL_MS)
    onCleanup(() => clearInterval(poll))
  })
  onCleanup(() => {
    offTheme()
    term.dispose()
  })

  return (
    <div class="term-screen" data-part="terminal-screen" data-terminal={id()}>
      <ViewHeader
        context={
          <Show when={!live()}>
            <StreamState state={error() ? "error" : "connecting"} code={error()} />
          </Show>
        }
      >
        <Show when={screen()}>
          {(sc) => (
            <span class="nc-meta term-screen__meta">
              {sc().size.cols}×{sc().size.rows} · line {sc().cursor.row + 1}, column {sc().cursor.col + 1} ·
              offset {sc().offset}
              <Show when={sc().altScreen}>
                {" · "}
                <Badge tone="outline">alternate screen</Badge>
              </Show>
            </span>
          )}
        </Show>
      </ViewHeader>
      <Show when={screen()?.title}>
        <span class="nc-meta term-screen__title">
          <StatusDot status={live() ? "live" : "idle"} /> {screen()!.title}
        </span>
      </Show>
      <Show when={error()}>
        <p class="body term-screen__error">{error()}</p>
      </Show>
      <Card class="term-screen__card" aria-label="The host's screen" padding="none">
        <div class="term-screen__inner">
          {/* xterm.js renders into an element of its own: Solid clears a parent whose only child it manages. */}
          <div ref={screenEl} />
        </div>
      </Card>
      <Show when={!screen() && !error()}>
        <EmptyState icon="eye" title="No screen yet" description="It appears once the host answers." />
      </Show>
    </div>
  )
}
