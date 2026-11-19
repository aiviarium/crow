// A host's desktop over VNC in the browser: noVNC on the server's `/env/<name>/desktop` WebSocket, which
// carries the RFB bytes to the host's VNC server and answers its password itself, so the password never
// reaches this page. Ported from the prototype's `shell/src/env/DesktopView.tsx`; it lives in fleet now
// because Crow's shell passes no components to plugins yet.
/// <reference path="./novnc.d.ts" />
import { StreamState } from "@aiviarium/nocturne"
import RFB from "@novnc/novnc"
import { createSignal, type JSX, onCleanup, onMount, Show } from "solid-js"
import { envName } from "./env"

export type DesktopState = "connecting" | "connected" | "disconnected" | "error"

export interface DesktopViewProps {
  /** The host: `dev-01` or `env://dev-01`. */
  env: string
  /** Watch only: no keyboard or mouse. */
  viewOnly?: boolean
  /** Scale the desktop to the element (default) or show it at its size with scrolling. */
  scale?: boolean
  class?: string
  onStateChange?: (state: DesktopState, detail?: string) => void
}

/** The desktop WebSocket: the RFB stream, proxied by the server (see API.md). */
export function desktopUrl(env: string): string {
  if (typeof location === "undefined") return `/env/${encodeURIComponent(envName(env))}/desktop`
  const scheme = location.protocol === "https:" ? "wss" : "ws"
  return `${scheme}://${location.host}/env/${encodeURIComponent(envName(env))}/desktop`
}

export function DesktopView(props: DesktopViewProps): JSX.Element {
  let screen!: HTMLDivElement
  const [state, setState] = createSignal<DesktopState>("connecting")
  const [detail, setDetail] = createSignal<string>()
  const name = () => envName(props.env)
  let rfb: RFB | undefined
  let retry: ReturnType<typeof setTimeout> | undefined
  let disposed = false
  let attempts = 0

  const update = (s: DesktopState, d?: string) => {
    setState(s)
    setDetail(d)
    props.onStateChange?.(s, d)
  }

  const connect = () => {
    if (disposed) return
    update("connecting")
    const r = new RFB(screen, desktopUrl(props.env), { wsProtocols: ["binary"] })
    rfb = r
    r.scaleViewport = props.scale ?? true
    r.resizeSession = false
    r.viewOnly = !!props.viewOnly
    r.focusOnClick = true
    r.background =
      getComputedStyle(document.documentElement).getPropertyValue("--bg-0").trim() || "transparent"
    r.addEventListener("connect", () => {
      attempts = 0
      update("connected")
    })
    r.addEventListener("disconnect", (e: Event) => {
      const clean = (e as CustomEvent<{ clean: boolean }>).detail?.clean
      rfb = undefined
      if (disposed) return
      update(clean ? "disconnected" : "error", clean ? undefined : "connection lost")
      retry = setTimeout(connect, Math.min(10_000, 1000 * 2 ** attempts++))
    })
    r.addEventListener("securityfailure", (e: Event) => {
      update("error", (e as CustomEvent<{ reason?: string }>).detail?.reason ?? "refused")
    })
  }

  onMount(connect)
  onCleanup(() => {
    disposed = true
    clearTimeout(retry)
    rfb?.disconnect()
  })

  const stream = () => {
    switch (state()) {
      case "connected":
        return "live" as const
      case "connecting":
        return attempts > 0 ? ("resuming" as const) : ("connecting" as const)
      case "disconnected":
        return "ended" as const
      default:
        return "error" as const
    }
  }

  return (
    <div
      class={`fleet-desktop ${props.class ?? ""}`}
      data-part="desktop-view"
      data-env={name()}
      data-state={state()}
    >
      <div class="fleet-desktop__screen" ref={screen} />
      <Show when={state() !== "connected"}>
        <div class="fleet-desktop__overlay">
          <StreamState state={stream()} meta={detail() ?? `env://${name()}`} />
        </div>
      </Show>
    </div>
  )
}
