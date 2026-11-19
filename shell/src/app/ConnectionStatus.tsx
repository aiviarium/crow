// Status bar indicator for Rookery WebSocket connection health: quiet while connected, surfaces
// reconnecting / offline (with retry countdown and manual retry) / back online transitions.
import { Button, State } from "@aiviarium/nocturne"
import { createSignal, type JSX, onCleanup, Show } from "solid-js"
import type { ShellApp } from "./state"

export function ConnectionStatus(props: { app: ShellApp }): JSX.Element {
  const [now, setNow] = createSignal(Date.now())
  const tick = setInterval(() => setNow(Date.now()), 1000)
  onCleanup(() => clearInterval(tick))

  const retryIn = () => {
    const at = props.app.conn.retryAt()
    return at ? Math.max(0, Math.ceil((at - now()) / 1000)) : 0
  }

  return (
    <Show when={props.app.phase() !== "ok"}>
      <span class="crow-conn" data-part="connection-status" data-phase={props.app.phase()} role="status">
        <Show when={props.app.phase() === "reconnecting"}>
          <State status="warn">Reconnecting…</State>
        </Show>
        <Show when={props.app.phase() === "offline"}>
          <State status="error">Offline</State>
          <span class="nc-meta">Connection lost.{retryIn() ? ` Retrying in ${retryIn()} s.` : ""}</span>
          <Button variant="ghost" size="sm" data-part="retry" onClick={() => props.app.conn.retryNow()}>
            Retry now
          </Button>
        </Show>
        <Show when={props.app.phase() === "back"}>
          <State status="ok">Back online</State>
        </Show>
      </span>
    </Show>
  )
}
