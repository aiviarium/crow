// The terminal viewer: xterm.js fed by a terminal's attach stream, with resume, the size rule
// (letterboxed when another viewer's size wins), search, links, copy and paste, the unicode addon, the
// WebGL renderer with a fallback, and on a phone a row of the keys its keyboard lacks.
//
// Ported from the prototype's `plugins/terminal/viewer.tsx`. The bytes come from `terminals.attach`
// (see `termApi.ts`), which the server passes through to `rookeryd`: the screen is kept on the host, not
// emulated here or in the server.
import {
  Button,
  EmptyState,
  IconButton,
  isPhone,
  StreamState,
  TextField,
  ViewHeader,
} from "@aiviarium/nocturne"
import type { TerminalEvent, TermSize } from "@rookery/client"
import type { ClientRookery } from "@rookery/sdk/client"
import { FitAddon } from "@xterm/addon-fit"
import { SearchAddon } from "@xterm/addon-search"
import { Unicode11Addon } from "@xterm/addon-unicode11"
import { WebLinksAddon } from "@xterm/addon-web-links"
import { WebglAddon } from "@xterm/addon-webgl"
import { Terminal } from "@xterm/xterm"
import "@xterm/xterm/css/xterm.css"
import { createEffect, createSignal, For, type JSX, onCleanup, onMount, Show } from "solid-js"
import type { TerminalConnection, TerminalsApi } from "./termApi"
import { codeFontSize, monoFont, onThemeChange, xtermTheme } from "./theme"

export interface ViewerProps {
  rookery: ClientRookery
  terminals: TerminalsApi
  id: string
  /** Watch only: input is refused by the server and by the viewer. */
  readonly?: boolean
  /** Show the header with the stream state and actions (default on). */
  header?: boolean
  /** Show the phone key row: "auto" (default) on narrow or touch screens. */
  keyRow?: boolean | "auto"
  /** Focus the terminal when it mounts. */
  autofocus?: boolean
  onTitle?: (title: string) => void
  class?: string
}

const KEYS: Array<{ label: string; aria?: string; seq: (app: boolean) => string }> = [
  { label: "Esc", seq: () => "\x1b" },
  { label: "Tab", seq: () => "\t" },
  { label: "←", aria: "Left", seq: (a) => (a ? "\x1bOD" : "\x1b[D") },
  { label: "↑", aria: "Up", seq: (a) => (a ? "\x1bOA" : "\x1b[A") },
  { label: "↓", aria: "Down", seq: (a) => (a ? "\x1bOB" : "\x1b[B") },
  { label: "→", aria: "Right", seq: (a) => (a ? "\x1bOC" : "\x1b[C") },
  { label: "|", seq: () => "|" },
  { label: "~", seq: () => "~" },
  { label: "/", seq: () => "/" },
  { label: "-", seq: () => "-" },
]

export function TerminalViewer(props: ViewerProps): JSX.Element {
  let host!: HTMLDivElement
  let frame!: HTMLDivElement
  let searchInput: HTMLInputElement | undefined
  const [proposed, setProposed] = createSignal<TermSize | null>(null)
  const [searching, setSearching] = createSignal(false)
  const [ctrl, setCtrl] = createSignal(false)
  const [renderer, setRenderer] = createSignal<"webgl" | "dom">("dom")
  const [phone, setPhone] = createSignal(isPhone())
  const [conn, setConn] = createSignal<TerminalConnection>()
  const [error, setError] = createSignal<string>()

  const term = new Terminal({
    allowProposedApi: true,
    fontFamily: monoFont(),
    fontSize: codeFontSize(),
    lineHeight: 1.15,
    cursorBlink: true,
    scrollback: 10000,
    theme: xtermTheme(),
    macOptionIsMeta: true,
    drawBoldTextInBrightColors: false,
  })
  const fit = new FitAddon()
  const search = new SearchAddon()
  term.loadAddon(fit)
  term.loadAddon(search)
  term.loadAddon(new WebLinksAddon((_e, uri) => window.open(uri, "_blank", "noopener")))
  term.loadAddon(new Unicode11Addon())
  term.unicode.activeVersion = "11"

  // The host's session answers the application's queries; xterm.js must not answer them too.
  term.parser.registerCsiHandler({ final: "c" }, () => true)
  term.parser.registerCsiHandler({ prefix: ">", final: "c" }, () => true)
  term.parser.registerCsiHandler({ final: "n" }, () => true)
  term.parser.registerCsiHandler({ prefix: "?", final: "n" }, () => true)
  term.parser.registerCsiHandler({ intermediates: "$", final: "p" }, () => true)
  term.parser.registerCsiHandler({ prefix: "?", intermediates: "$", final: "p" }, () => true)
  for (const osc of [4, 10, 11, 12]) term.parser.registerOscHandler(osc, (data) => data.endsWith("?"))

  const applySize = (s: TermSize | null) => {
    if (!s) return
    if (term.cols !== s.cols || term.rows !== s.rows) term.resize(s.cols, s.rows)
  }

  const send = (data: string) => {
    const c = conn()
    if (!c) return
    if (ctrl() && data.length === 1) {
      const code = data.toUpperCase().charCodeAt(0)
      if (code >= 64 && code <= 95) data = String.fromCharCode(code - 64)
      else if (data === " ") data = "\x00"
      setCtrl(false)
    }
    c.write(data)
  }

  const copy = () => {
    const sel = term.getSelection()
    if (sel) navigator.clipboard?.writeText(sel).catch(() => {})
  }
  const paste = () => {
    navigator.clipboard
      ?.readText()
      .then((t) => term.paste(t))
      .catch(() => {})
  }

  term.attachCustomKeyEventHandler((e) => {
    if (e.type !== "keydown") return true
    const mod = e.ctrlKey || e.metaKey
    if (mod && e.shiftKey && e.code === "KeyC") {
      copy()
      return false
    }
    if (mod && e.shiftKey && e.code === "KeyV") {
      paste()
      return false
    }
    if (mod && e.shiftKey && e.code === "KeyF") {
      setSearching(true)
      queueMicrotask(() => searchInput?.focus())
      return false
    }
    return true
  })
  term.onData(send)
  term.onBinary((d) => {
    const bytes = new Uint8Array(d.length)
    for (let i = 0; i < d.length; i++) bytes[i] = d.charCodeAt(i) & 0xff
    conn()?.write(bytes)
  })
  term.onTitleChange((t) => {
    if (t) props.onTitle?.(t)
  })

  onMount(() => {
    term.open(frame)
    // WebGL on desktops; touch devices get the DOM renderer, which handles their pixel ratios and
    // on-screen keyboards better.
    try {
      if (isPhone()) throw new Error("touch device")
      const webgl = new WebglAddon()
      webgl.onContextLoss(() => {
        webgl.dispose()
        setRenderer("dom")
      })
      term.loadAddon(webgl)
      setRenderer("webgl")
    } catch {
      setRenderer("dom")
    }
    const measure = (): TermSize | null => {
      const d = fit.proposeDimensions()
      if (!d || !Number.isFinite(d.cols) || !Number.isFinite(d.rows)) return null
      return { cols: Math.max(2, d.cols), rows: Math.max(2, d.rows) }
    }
    const first = measure()
    setProposed(first)
    const c = props.terminals.connect(
      props.id,
      {
        onReset: () => term.reset(),
        onData: (d) => term.write(d),
        onEvent: (e: TerminalEvent) => {
          if (e.type === "size") applySize({ cols: e.cols, rows: e.rows })
          if (e.type === "title") props.onTitle?.(e.title)
        },
      },
      { size: first ?? undefined, readonly: props.readonly },
    )
    setConn(c)
    createEffect(() => {
      const i = c.info()
      if (i) props.onTitle?.(i.title)
      if (c.state() === "error") setError("This terminal is not available.")
    })
    let pending: ReturnType<typeof setTimeout> | undefined
    const ro = new ResizeObserver(() => {
      clearTimeout(pending)
      pending = setTimeout(() => {
        setPhone(isPhone())
        const s = measure()
        if (!s) return
        const p = proposed()
        if (p && p.cols === s.cols && p.rows === s.rows) return
        setProposed(s)
        c.resize(s)
      }, 60)
    })
    ro.observe(host)
    const focusIn = () => c.activate()
    frame.addEventListener("focusin", focusIn)
    frame.addEventListener("pointerdown", focusIn)
    const offTheme = onThemeChange(() => {
      term.options.theme = xtermTheme()
    })
    if (props.autofocus) term.focus()
    onCleanup(() => {
      clearTimeout(pending)
      ro.disconnect()
      offTheme()
      frame.removeEventListener("focusin", focusIn)
      frame.removeEventListener("pointerdown", focusIn)
      c.dispose()
      term.dispose()
    })
  })

  const streamState = () => {
    const c = conn()
    if (!c) return "connecting" as const
    const s = c.state()
    return s === "error" ? ("error" as const) : s
  }
  const letterboxed = () => {
    const c = conn()
    const s = c?.size()
    const p = proposed()
    return !!(c && s && p && (s.cols !== p.cols || s.rows !== p.rows) && c.active() !== c.viewer())
  }
  const copyLink = () => {
    const href = props.rookery.views.href("terminal.session", { path: props.id }) ?? ""
    navigator.clipboard?.writeText(new URL(href, location.href).toString()).catch(() => {})
  }

  return (
    <div
      class={`term ${props.class ?? ""}`}
      data-part="terminal"
      data-terminal={props.id}
      data-state={conn()?.state() ?? "connecting"}
      data-renderer={renderer()}
      data-attach-mode={conn()?.mode() ?? undefined}
      data-attaches={conn()?.attaches() ?? 0}
      data-end={conn()?.endState() ?? undefined}
      data-size={conn()?.size() ? `${conn()!.size()!.cols}×${conn()!.size()!.rows}` : undefined}
      ref={(el) => {
        // For tests and debugging: the xterm.js instance behind the element.
        ;(el as unknown as { crowXterm: Terminal }).crowXterm = term
      }}
    >
      <Show when={props.header !== false}>
        {/* No title (the tab has it), no "Live" and no size: only a stream that is not live, and read only. */}
        <ViewHeader
          class="term__header"
          context={
            <>
              <Show when={streamState() !== "live"}>
                <StreamState
                  state={streamState()}
                  offset={conn()?.offset()}
                  exitCode={conn()?.exitCode() ?? undefined}
                  code={streamState() === "error" ? "not available" : undefined}
                  meta={conn()?.endState() === "lost" ? "lost: the host restarted" : undefined}
                />
              </Show>
              <Show when={conn()?.readonly()}>
                <span class="nc-meta">read only</span>
              </Show>
            </>
          }
          actions={[
            {
              id: "find",
              label: "Find",
              icon: "search",
              pressed: searching(),
              onClick: () => {
                setSearching(!searching())
                queueMicrotask(() => searchInput?.focus())
              },
            },
            { id: "link", label: "Copy link", icon: "link", onClick: copyLink },
          ]}
        />
      </Show>
      <Show when={searching()}>
        <div class="term__search" data-part="terminal-search">
          <TextField
            variant="search"
            placeholder="Find in the terminal"
            aria-label="Find in the terminal"
            inputRef={(el) => {
              searchInput = el
            }}
            onInput={(e) => search.findNext(e.currentTarget.value, { incremental: true })}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                if (e.shiftKey) search.findPrevious(e.currentTarget.value)
                else search.findNext(e.currentTarget.value)
              }
              if (e.key === "Escape") {
                setSearching(false)
                term.focus()
              }
            }}
          />
          <IconButton label="Close search" icon="close" onClick={() => setSearching(false)} />
        </div>
      </Show>
      <Show
        when={!error()}
        fallback={
          <div class="term__unavailable">
            <EmptyState
              icon="terminal"
              title="This terminal is not available"
              description="It was closed, or it belongs to someone else. Open a new one in Terminals."
            />
          </div>
        }
      >
        <div class="term__body" ref={host}>
          <div class="term__frame" ref={frame} data-letterboxed={letterboxed() ? "" : undefined} />
          <Show when={letterboxed()}>
            <button type="button" class="term__takeover nc-meta" onClick={() => conn()?.activate()}>
              Sized for another viewer · use this size
            </button>
          </Show>
        </div>
      </Show>
      <Show when={props.keyRow === true || (props.keyRow !== false && phone())}>
        <div class="term__keys" data-part="terminal-keys" role="toolbar" aria-label="Keys">
          <Button
            size="sm"
            variant={ctrl() ? "primary" : "secondary"}
            aria-pressed={ctrl()}
            onClick={() => {
              setCtrl(!ctrl())
              term.focus()
            }}
          >
            Ctrl
          </Button>
          <For each={KEYS}>
            {(k) => (
              <Button
                size="sm"
                variant="secondary"
                aria-label={k.aria ?? k.label}
                onClick={() => {
                  send(k.seq(term.modes.applicationCursorKeysMode))
                  term.focus()
                }}
              >
                {k.label}
              </Button>
            )}
          </For>
          <Button size="sm" variant="ghost" onClick={paste}>
            Paste
          </Button>
        </div>
      </Show>
    </div>
  )
}
