// Theme preference (system / dark / light), synced to `document.documentElement.dataset.theme`
// and persisted in localStorage under `crow.theme`.
import { createSignal } from "solid-js"

export type ThemeChoice = "system" | "dark" | "light"
export type ShownTheme = "dark" | "light"

const STORAGE_KEY = "crow.theme"

function readStored(): ThemeChoice {
  try {
    const v = localStorage.getItem(STORAGE_KEY)
    if (v === "light" || v === "dark" || v === "system") return v
  } catch {
    // Storage unavailable.
  }
  return "dark"
}

function resolveShown(choice: ThemeChoice): ShownTheme {
  if (choice === "light" || choice === "dark") return choice
  if (typeof matchMedia === "function" && matchMedia("(prefers-color-scheme: light)").matches) {
    return "light"
  }
  return "dark"
}

function apply(choice: ThemeChoice) {
  const s = resolveShown(choice)
  if (typeof document !== "undefined") {
    document.documentElement.dataset.theme = s
  }
  return s
}

const [theme, setThemeRaw] = createSignal<ThemeChoice>(readStored())
const [shown, setShown] = createSignal<ShownTheme>(apply(theme()))

export { shown, theme }

export function setTheme(next: ThemeChoice): void {
  setThemeRaw(next)
  setShown(apply(next))
  try {
    localStorage.setItem(STORAGE_KEY, next)
  } catch {
    // Storage unavailable.
  }
}
