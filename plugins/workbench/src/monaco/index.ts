/// <reference path="./shims.d.ts" />
// Monaco, loaded only when a workbench view needs an editor: this module is reached through `import()`, so
// it and everything it imports (about 3.5 MB of script, 900 kB gzipped, in chunks) is not part of the
// plugin's entry and costs the rest of the shell nothing. The editor's core and the features the workbench
// uses are imported one by one, not `monaco-editor`'s entry: the whole entry (every basic language, every
// feature and the TypeScript service) needs more memory to bundle than a build machine has. TypeScript and
// JavaScript are highlighted by their Monarch grammars, without the language service's project-free
// diagnostics; JSON, CSS and HTML keep their formatters and workers. Grammars are chunks of their own that
// load with the first file of that language.
//
// The theme is made from Nocturne's tokens at run time, so it follows the theme, the accent and a
// deployment's or a user's own stylesheet.
import * as monaco from "monaco-editor/editor/editor.api"
// The editor's features the workbench uses. `features/register.all.js` is every one of them, and Rollup needs
// more memory than a build machine has for that graph.
import "monaco-editor/features/bracketMatching/register.js"
import "monaco-editor/features/caretOperations/register.js"
import "monaco-editor/features/clipboard/register.js"
import "monaco-editor/features/codeEditor/register.js"
import "monaco-editor/features/comment/register.js"
import "monaco-editor/features/contextmenu/register.js"
import "monaco-editor/features/cursorUndo/register.js"
import "monaco-editor/features/diffEditor/register.js"
import "monaco-editor/features/dnd/register.js"
import "monaco-editor/features/find/register.js"
import "monaco-editor/features/folding/register.js"
import "monaco-editor/features/format/register.js"
import "monaco-editor/features/gotoLine/register.js"
import "monaco-editor/features/hover/register.js"
import "monaco-editor/features/indentation/register.js"
import "monaco-editor/features/lineSelection/register.js"
import "monaco-editor/features/linesOperations/register.js"
import "monaco-editor/features/links/register.js"
import "monaco-editor/features/longLinesHelper/register.js"
import "monaco-editor/features/middleScroll/register.js"
import "monaco-editor/features/multicursor/register.js"
import "monaco-editor/features/placeholderText/register.js"
import "monaco-editor/features/readOnlyMessage/register.js"
import "monaco-editor/features/snippet/register.js"
import "monaco-editor/features/stickyScroll/register.js"
import "monaco-editor/features/suggest/register.js"
import "monaco-editor/editor/contrib/suggest/browser/suggestController.js"
import "monaco-editor/features/wordHighlighter/register.js"
import "monaco-editor/features/wordOperations/register.js"
import "monaco-editor/features/wordPartOperations/register.js"
import "monaco-editor/languages/features/json/register.js"
import "monaco-editor/languages/features/css/register.js"
import "monaco-editor/languages/features/html/register.js"
import "monaco-editor/languages/definitions/typescript/register.js"
import "monaco-editor/languages/definitions/javascript/register.js"
import "monaco-editor/languages/definitions/markdown/register.js"
import "monaco-editor/languages/definitions/yaml/register.js"
import "monaco-editor/languages/definitions/python/register.js"
import "monaco-editor/languages/definitions/rust/register.js"
import "monaco-editor/languages/definitions/shell/register.js"
import "monaco-editor/languages/definitions/sql/register.js"
import "monaco-editor/languages/definitions/go/register.js"
import "monaco-editor/languages/definitions/cpp/register.js"
import "monaco-editor/languages/definitions/java/register.js"
import "monaco-editor/languages/definitions/dockerfile/register.js"
import "monaco-editor/languages/definitions/ini/register.js"
import "monaco-editor/languages/definitions/xml/register.js"
import purify from "monaco-editor/base/browser/dompurify/dompurify"
import { marked } from "monaco-editor/base/common/marked/marked"
import editorWorker from "monaco-editor/editor/editor.worker?worker"
import cssWorker from "monaco-editor/language/css/css.worker?worker"
import htmlWorker from "monaco-editor/language/html/html.worker?worker"
import jsonWorker from "monaco-editor/language/json/json.worker?worker"

export { monaco }
export type Monaco = typeof monaco

;(globalThis as any).MonacoEnvironment = {
  getWorker(_: string, label: string) {
    if (label === "json") return jsonWorker()
    if (label === "css" || label === "scss" || label === "less") return cssWorker()
    if (label === "html" || label === "handlebars" || label === "razor") return htmlWorker()
    return editorWorker()
  },
}

// ── Colours from tokens ──────────────────────────────────────────────────────────────────────────

let probe: HTMLSpanElement | null = null
let canvas: CanvasRenderingContext2D | null = null

/** A token's colour as #rrggbbaa, whatever CSS colour syntax the token uses (oklch, color-mix, ...). */
export function tokenColor(name: string, alpha = 1): string {
  probe ??= Object.assign(document.createElement("span"), { hidden: true })
  if (!probe.isConnected) document.body.append(probe)
  probe.style.color = `var(${name})`
  const computed = getComputedStyle(probe).color
  canvas ??= Object.assign(document.createElement("canvas"), { width: 1, height: 1 }).getContext("2d", {
    willReadFrequently: true,
  })
  if (!canvas) return "#00000000" // lint-tokens-ignore: transparent, when there is no canvas to resolve a token with
  canvas.clearRect(0, 0, 1, 1)
  canvas.fillStyle = computed
  canvas.fillRect(0, 0, 1, 1)
  const [r, g, b, a] = canvas.getImageData(0, 0, 1, 1).data
  const hex = (n: number) => Math.round(n).toString(16).padStart(2, "0")
  return `#${hex(r!)}${hex(g!)}${hex(b!)}${hex((a! / 255) * alpha * 255)}`
}

const isDark = () =>
  (document.querySelector("[data-theme]")?.getAttribute("data-theme") ?? "dark") !== "light"

let themeFlip = false
let applied = ""

/**
 * Defines and applies the theme from the tokens as they are now, when they differ from the theme applied
 * last. Setting a theme makes Monaco recolour every line of every editor, so an unchanged theme is never
 * set again.
 */
export function applyTheme() {
  const c = tokenColor
  const strip = (hex: string) => hex.slice(1, 7)
  const rule = (token: string, name: string, extra: Partial<monaco.editor.ITokenThemeRule> = {}) => ({
    token,
    foreground: strip(c(name)),
    ...extra,
  })
  const theme: monaco.editor.IStandaloneThemeData = {
    base: isDark() ? "vs-dark" : "vs",
    inherit: true,
    rules: [
      rule("", "--syn-plain"),
      rule("keyword", "--syn-keyword"),
      rule("keyword.control", "--syn-keyword"),
      rule("storage", "--syn-keyword"),
      rule("string", "--syn-string"),
      rule("string.escape", "--syn-number"),
      rule("regexp", "--syn-string"),
      rule("number", "--syn-number"),
      rule("constant", "--syn-number"),
      rule("type", "--syn-type"),
      rule("type.identifier", "--syn-type"),
      rule("class", "--syn-type"),
      rule("interface", "--syn-type"),
      rule("function", "--syn-function"),
      rule("identifier", "--syn-plain"),
      rule("variable", "--syn-plain"),
      rule("comment", "--syn-comment", { fontStyle: "italic" }),
      rule("delimiter", "--syn-punct"),
      rule("operator", "--syn-punct"),
      rule("tag", "--syn-keyword"),
      rule("attribute.name", "--syn-function"),
      rule("attribute.value", "--syn-string"),
      rule("metatag", "--syn-type"),
      rule("key", "--syn-function"),
      rule("string.key.json", "--syn-function"),
      rule("string.value.json", "--syn-string"),
      rule("emphasis", "--text-1", { fontStyle: "italic" }),
      rule("strong", "--text-1", { fontStyle: "bold" }),
      rule("keyword.md", "--syn-keyword"),
      rule("invalid", "--danger"),
    ],
    colors: {
      "editor.background": c("--bg-0"),
      "editor.foreground": c("--syn-plain"),
      "editorGutter.background": c("--bg-0"),
      "editorLineNumber.foreground": c("--text-4"),
      "editorLineNumber.activeForeground": c("--text-2"),
      "editor.lineHighlightBackground": c("--bg-2", 0.6),
      "editor.lineHighlightBorder": c("--bg-0", 0),
      "editor.selectionBackground": c("--accent-tint"),
      "editor.inactiveSelectionBackground": c("--accent-subtle"),
      "editor.selectionHighlightBackground": c("--accent-subtle"),
      "editor.wordHighlightBackground": c("--accent-subtle"),
      "editor.findMatchBackground": c("--warning-tint"),
      "editor.findMatchHighlightBackground": c("--warning-tint", 0.6),
      "editor.findMatchBorder": c("--warning"),
      "editorCursor.foreground": c("--accent-strong"),
      "editorWhitespace.foreground": c("--line"),
      "editorIndentGuide.background1": c("--line-soft"),
      "editorIndentGuide.activeBackground1": c("--line-strong"),
      "editorRuler.foreground": c("--line-soft"),
      "editorBracketMatch.background": c("--accent-subtle"),
      "editorBracketMatch.border": c("--accent-line"),
      "editorLink.activeForeground": c("--accent-text"),
      "editorError.foreground": c("--danger"),
      "editorWarning.foreground": c("--warning"),
      "editorInfo.foreground": c("--info"),
      "editorGutter.addedBackground": c("--success"),
      "editorGutter.modifiedBackground": c("--info"),
      "editorGutter.deletedBackground": c("--danger"),
      "editorOverviewRuler.border": c("--bg-0", 0),
      "editorWidget.background": c("--bg-2"),
      "editorWidget.foreground": c("--text-1"),
      "editorWidget.border": c("--line"),
      "editorHoverWidget.background": c("--bg-2"),
      "editorHoverWidget.border": c("--line"),
      "editorSuggestWidget.background": c("--bg-2"),
      "editorSuggestWidget.border": c("--line"),
      "editorSuggestWidget.selectedBackground": c("--accent-tint"),
      "editorSuggestWidget.highlightForeground": c("--accent-text"),
      "editorStickyScroll.background": c("--bg-0"),
      "editorStickyScrollHover.background": c("--bg-2"),
      "input.background": c("--bg-1"),
      "input.border": c("--line"),
      "input.foreground": c("--text-1"),
      "inputOption.activeBorder": c("--accent"),
      "inputOption.activeBackground": c("--accent-tint"),
      focusBorder: c("--accent"),
      "list.activeSelectionBackground": c("--accent-tint"),
      "list.activeSelectionForeground": c("--text-1"),
      "list.hoverBackground": c("--bg-3"),
      "list.focusBackground": c("--accent-tint"),
      "list.highlightForeground": c("--accent-text"),
      "quickInput.background": c("--bg-2"),
      "minimap.background": c("--bg-0"),
      "minimapSlider.background": c("--bg-4", 0.5),
      "scrollbar.shadow": c("--bg-0", 0),
      "scrollbarSlider.background": c("--bg-4", 0.6),
      "scrollbarSlider.hoverBackground": c("--bg-4"),
      "scrollbarSlider.activeBackground": c("--line-strong"),
      "diffEditor.insertedLineBackground": c("--diff-add"),
      "diffEditor.removedLineBackground": c("--diff-del"),
      "diffEditor.insertedTextBackground": c("--diff-add-word"),
      "diffEditor.removedTextBackground": c("--diff-del-word"),
      "diffEditorGutter.insertedLineBackground": c("--diff-add"),
      "diffEditorGutter.removedLineBackground": c("--diff-del"),
      "diffEditor.diagonalFill": c("--line-soft"),
      "diffEditor.unchangedRegionBackground": c("--bg-1"),
      "diffEditor.unchangedRegionForeground": c("--text-3"),
      "diffEditor.border": c("--line-soft"),
      "widget.shadow": "#00000040", // lint-tokens-ignore: a black shadow, as --shadow-overlay is; Monaco needs a colour
    },
  }
  const key = JSON.stringify(theme)
  if (key === applied) return
  applied = key
  // Monaco keeps a theme it has seen by name, so a changed theme is defined under the other of two names.
  themeFlip = !themeFlip
  const name = themeFlip ? "crow-a" : "crow-b"
  monaco.editor.defineTheme(name, theme)
  monaco.editor.setTheme(name)
}

/** The size of Nocturne's `code` style (12.5px on 20px), measured, so the editor follows the type scale. */
export function codeFont(): { fontFamily: string; fontSize: number; lineHeight: number } {
  const p = document.createElement("span")
  p.className = "code"
  p.style.position = "absolute"
  p.style.visibility = "hidden"
  document.body.appendChild(p)
  const cs = getComputedStyle(p)
  const out = {
    fontFamily: cs.fontFamily || "monospace",
    fontSize: Number.parseFloat(cs.fontSize) || 12.5,
    lineHeight: Number.parseFloat(cs.lineHeight) || 20,
  }
  p.remove()
  return out
}

let observing = false
/**
 * Applies the theme once and again on every theme, accent or stylesheet change. The theme and the accent
 * are attributes of the root element (the shell's theme.ts), and a deployment's or a user's stylesheet is
 * an element in the head, so those are what is watched. Not the whole document: Monaco writes inline styles
 * on its own elements all the time, and so does the colour probe above, and each would apply the theme
 * again, which recoloured every editor on every frame.
 */
export function followTheme() {
  applyTheme()
  if (observing) return
  observing = true
  let pending = 0
  const again = () => {
    cancelAnimationFrame(pending)
    pending = requestAnimationFrame(() => applyTheme())
  }
  const o = new MutationObserver(again)
  o.observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme", "style", "class"] })
  o.observe(document.head, { childList: true, subtree: true, characterData: true })
  matchMedia("(prefers-color-scheme: dark)").addEventListener("change", again)
}

// ── Languages ────────────────────────────────────────────────────────────────────────────────────

/** Monaco's language for a file, by name, then extension, else plain text. */
export function languageFor(path: string): string {
  const name = path.split("/").pop() ?? path
  const lower = name.toLowerCase()
  let best: string | null = null
  for (const l of monaco.languages.getLanguages()) {
    if (l.filenames?.some((f) => f.toLowerCase() === lower)) return l.id
    if (!best && l.extensions?.some((e) => lower.endsWith(e.toLowerCase()))) best = l.id
  }
  if (best) return best
  if (/^(makefile|gnumakefile)$/i.test(name)) return "shell"
  if (/^\.(bashrc|zshrc|profile|env.*)$/i.test(name)) return "shell"
  return "plaintext"
}

/** Markdown as sanitised HTML, for the preview. */
export function renderMarkdown(text: string): string {
  const html = marked.parse(text, { async: false, gfm: true }) as string
  return purify.sanitize(html, { USE_PROFILES: { html: true } }) as unknown as string
}

export const editorDefaults = (): monaco.editor.IStandaloneEditorConstructionOptions => ({
  ...codeFont(),
  automaticLayout: true,
  minimap: { enabled: true, renderCharacters: false, scale: 1 },
  scrollBeyondLastLine: false,
  smoothScrolling: true,
  renderLineHighlight: "all",
  fixedOverflowWidgets: true,
  padding: { top: 8 },
  stickyScroll: { enabled: true },
  bracketPairColorization: { enabled: false },
  guides: { indentation: true },
  tabSize: 2,
  unicodeHighlight: { ambiguousCharacters: false },
  scrollbar: { verticalScrollbarSize: 10, horizontalScrollbarSize: 10 },
})
