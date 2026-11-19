// Small formatting helpers for the views: times, counts, and how GitHub's states map to Nocturne's.
import type { BadgeTone, DotStatus, LabelHue } from "@aiviarium/nocturne"

export function ago(iso: string | null | undefined, now = Date.now()): string {
  if (!iso) return ""
  const s = Math.max(0, (now - Date.parse(iso)) / 1000)
  if (s < 45) return "just now"
  if (s < 3600) return `${Math.max(1, Math.round(s / 60))} min ago`
  if (s < 86400) return `${Math.round(s / 3600)} h ago`
  if (s < 86400 * 30) return `${Math.round(s / 86400)} d ago`
  return new Date(iso).toLocaleDateString("en", { month: "short", day: "numeric", year: "numeric" })
}

/** "in 2 min", for the next sync. */
export function inFuture(iso: string | null | undefined, now = Date.now()): string {
  if (!iso) return ""
  const s = (Date.parse(iso) - now) / 1000
  if (s < 5) return "due now"
  if (s < 90) return `in ${Math.round(s)} s`
  if (s < 5400) return `in ${Math.round(s / 60)} min`
  if (s < 86400) return `in ${Math.round(s / 3600)} h`
  return `in ${Math.round(s / 86400)} d`
}

export const plural = (n: number, one: string, many = `${one}s`) =>
  `${n.toLocaleString("en")} ${n === 1 ? one : many}`

export function clock(iso: string | null | undefined): string {
  return iso ? new Date(iso).toLocaleTimeString("en", { hour: "2-digit", minute: "2-digit" }) : ""
}

/** The label hue nearest to a GitHub label colour (a hex like `d73a4a`), so labels use Nocturne's palette. */
export function hueOf(hex: string | undefined | null): LabelHue {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex ?? "")
  if (!m) return "accent"
  const n = Number.parseInt(m[1]!, 16)
  const r = ((n >> 16) & 255) / 255
  const g = ((n >> 8) & 255) / 255
  const b = (n & 255) / 255
  const max = Math.max(r, g, b)
  const min = Math.min(r, g, b)
  const d = max - min
  if (d < 0.12) return "accent"
  let h = max === r ? ((g - b) / d) % 6 : max === g ? (b - r) / d + 2 : (r - g) / d + 4
  h = (h * 60 + 360) % 360
  if (h < 15 || h >= 335) return "rose"
  if (h < 40) return "ember"
  if (h < 70) return "amber"
  if (h < 150) return "mint"
  if (h < 200) return "teal"
  if (h < 255) return "sky"
  return "orchid"
}

export const STATE_TONE: Record<string, BadgeTone> = { open: "success", merged: "accent", closed: "danger" }

export const CHECKS: Record<string, { status: DotStatus; word: string }> = {
  success: { status: "ok", word: "Checks passed" },
  failure: { status: "error", word: "Checks failing" },
  pending: { status: "live", word: "Checks running" },
  none: { status: "off", word: "No checks" },
}

export const REVIEWS: Record<string, { tone: BadgeTone; word: string }> = {
  approved: { tone: "success", word: "Approved" },
  changes_requested: { tone: "danger", word: "Changes requested" },
  pending: { tone: "warning", word: "Review required" },
  commented: { tone: "info", word: "Commented" },
  none: { tone: "neutral", word: "No reviews" },
}

export const SYNC: Record<string, { status: DotStatus; word: string }> = {
  ok: { status: "ok", word: "Up to date" },
  syncing: { status: "live", word: "Syncing" },
  pending: { status: "idle", word: "Waiting for the first sync" },
  error: { status: "error", word: "Not syncing" },
  gone: { status: "error", word: "Not found on GitHub" },
}
