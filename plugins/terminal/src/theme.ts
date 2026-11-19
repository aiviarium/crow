// xterm.js colours from Nocturne's tokens, read from the page so a theme or accent change restyles the
// terminal too. Nothing here is a colour of its own. Ported unchanged from the prototype.
import type { ITheme } from "@xterm/xterm"

const token = (name: string) => getComputedStyle(document.documentElement).getPropertyValue(name).trim()

export function xtermTheme(): ITheme {
  return {
    background: token("--bg-1"),
    foreground: token("--text-1"),
    cursor: token("--accent-strong") || token("--accent"),
    cursorAccent: token("--bg-1"),
    selectionBackground: token("--accent-tint"),
    selectionInactiveBackground: token("--bg-4"),
    black: token("--bg-4"),
    red: token("--danger"),
    green: token("--success"),
    yellow: token("--warning"),
    blue: token("--info"),
    magenta: token("--label-orchid"),
    cyan: token("--label-teal"),
    white: token("--text-2"),
    brightBlack: token("--text-4"),
    brightRed: token("--label-rose"),
    brightGreen: token("--label-mint"),
    brightYellow: token("--label-amber"),
    brightBlue: token("--label-sky"),
    brightMagenta: token("--syn-type"),
    brightCyan: token("--syn-string"),
    brightWhite: token("--text-1"),
  }
}

export function monoFont(): string {
  return token("--font-mono") || "monospace"
}

/** Calls `fn` whenever the theme or the accent changes. */
export function onThemeChange(fn: () => void): () => void {
  const o = new MutationObserver(fn)
  o.observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme", "style", "class"] })
  return () => o.disconnect()
}

/** The font size of Nocturne's `code` style, measured, so the terminal follows the type scale. */
export function codeFontSize(): number {
  const probe = document.createElement("span")
  probe.className = "code"
  probe.style.position = "absolute"
  probe.style.visibility = "hidden"
  document.body.appendChild(probe)
  const px = Number.parseFloat(getComputedStyle(probe).fontSize)
  probe.remove()
  return Number.isFinite(px) && px > 0 ? px : 13
}
