// Pure formatting, validation, and status-mapping helpers for the fleet plugin.
import type { BadgeTone, DotStatus, LogEntry, LogLevel } from "@aiviarium/nocturne"
import type { JobInfo, JobState, LogItem } from "@rookery/client"
import type { HostInfo, HostProfile, HostType } from "./api"

export type JobProgressInfo = { done: number; total: number; message?: string }

export type HostStatusKind = "ready" | "behind" | "rotating" | "stopped" | "unreachable"

export function hostStatus(host: HostInfo): { kind: HostStatusKind; dot: DotStatus; label: string } {
  if (host.rotating) return { kind: "rotating", dot: "ai", label: "Rotating" }
  if (!host.reachable) {
    if (host.power?.state === "stopped") return { kind: "stopped", dot: "off", label: "Stopped" }
    return { kind: "unreachable", dot: "error", label: "Unreachable" }
  }
  if ((host.behind?.changes?.length ?? 0) > 0) {
    return { kind: "behind", dot: "warn", label: "Behind" }
  }
  return { kind: "ready", dot: "live", label: "Ready" }
}

export function hostNeedsAttention(host: HostInfo): boolean {
  const s = hostStatus(host).kind
  return s === "behind" || s === "unreachable"
}

export function hostTypeLabel(type: HostType): string {
  switch (type) {
    case "ssh":
      return "SSH"
    case "managed":
      return "Managed"
    case "node":
      return "Node"
    case "workstation":
      return "Workstation"
    default:
      return type
  }
}

export function hostTypeTone(type: HostType): BadgeTone {
  switch (type) {
    case "workstation":
      return "accent"
    case "node":
      return "info"
    case "managed":
      return "success"
    default:
      return "neutral"
  }
}

export function jobStatus(state: JobState): { dot: DotStatus; label: string } {
  switch (state) {
    case "queued":
      return { dot: "idle", label: "Queued" }
    case "running":
      return { dot: "live", label: "Running" }
    case "succeeded":
      return { dot: "ok", label: "Succeeded" }
    case "failed":
      return { dot: "error", label: "Failed" }
    case "cancelled":
      return { dot: "off", label: "Cancelled" }
    default:
      return { dot: "neutral", label: state }
  }
}

export function isJobActive(state: JobState): boolean {
  return state === "queued" || state === "running"
}

/** Validates a host name against Rookery's naming rules (rookery-api/src/profile.rs). */
export function validateHostName(name: string): string | null {
  const trimmed = name.trim()
  if (!trimmed) return "Enter a host name."
  if (trimmed.length > 63) return "Host name must be 63 characters or fewer."
  if (!/^[a-z0-9][a-z0-9-]*$/.test(trimmed)) {
    return "Use lowercase letters, digits, and hyphens, starting with a letter or digit."
  }
  return null
}

/** Validates a host address (hostname, IPv4, or IPv6 literal). */
export function validateHostAddress(address: string): string | null {
  const trimmed = address.trim()
  if (!trimmed) return "Enter an address or hostname."
  if (/\s/.test(trimmed)) return "Address cannot contain whitespace."
  return null
}

export function formatRelativeTime(iso: string | null | undefined, nowMs = Date.now()): string {
  if (!iso) return "—"
  const t = new Date(iso).getTime()
  if (Number.isNaN(t)) return iso
  const diffSec = Math.max(0, Math.round((nowMs - t) / 1000))
  if (diffSec < 10) return "just now"
  if (diffSec < 60) return `${diffSec}s ago`
  const diffMin = Math.round(diffSec / 60)
  if (diffMin < 60) return `${diffMin}m ago`
  const diffHr = Math.round(diffMin / 60)
  if (diffHr < 24) return `${diffHr}h ago`
  const diffDay = Math.round(diffHr / 24)
  return `${diffDay}d ago`
}

export function errorMessage(err: unknown): string {
  if (err instanceof Error) return err.message
  if (typeof err === "string") return err
  return "Request failed"
}

/** Extracts enabled feature names from a saved host profile JSON object. */
export function profileFeatures(profile: HostProfile): string[] {
  const out: string[] = []
  const raw = profile.features
  if (raw && typeof raw === "object" && !Array.isArray(raw)) {
    for (const [key, val] of Object.entries(raw)) {
      if (val !== false && val !== null && val !== undefined) out.push(key)
    }
  }
  return out.sort()
}

/** Extracts a concise user label from a string or `{ name / username }` profile section. */
export function profileUserName(value: unknown): string | null {
  if (typeof value === "string" && value.trim()) return value.trim()
  if (value && typeof value === "object") {
    const obj = value as Record<string, unknown>
    for (const key of ["username", "user", "name"]) {
      if (typeof obj[key] === "string" && (obj[key] as string).trim()) {
        return (obj[key] as string).trim()
      }
    }
  }
  return null
}

/** Returns true if a job belongs to the given host name. */
export function jobMatchesHost(job: JobInfo, hostName: string): boolean {
  const params = job.params
  if (params && typeof params === "object") {
    const p = params as Record<string, unknown>
    if (p.host === hostName || p.name === hostName) return true
  }
  // A job's subject names the resource it is about, such as `host://studio`.
  if (typeof job.subject === "string") {
    const tail = job.subject.split(/[/:]/).pop()
    if (tail === hostName) return true
  }
  return false
}

/** A job's title in a list: its kind. */
export function jobTitle(job: JobInfo): string {
  return job.kind
}

/** A job's second line: its subject, or its id when it has none. */
export function jobSubtitle(job: JobInfo): string {
  return job.subject ?? job.id
}

const LEVELS: Record<string, LogLevel> = {
  error: "error",
  err: "error",
  stderr: "error",
  warn: "warn",
  warning: "warn",
  debug: "debug",
  trace: "debug",
}

/** Maps a job log line's `level` to a Nocturne log level. */
export function logLevel(level: string | undefined): LogLevel {
  return LEVELS[(level ?? "info").toLowerCase()] ?? "info"
}

/** Converts a Rookery `LogItem` into a Nocturne `LogEntry`. */
export function jobItemToLogEntry(item: LogItem): LogEntry {
  return { id: item.seq, at: item.at, level: logLevel(item.level), text: item.text }
}

/** Reads `{ done, total, message }` out of a job's untyped `progress`, if it has that shape. */
export function jobProgress(progress: unknown): JobProgressInfo | null {
  if (!progress || typeof progress !== "object") return null
  const p = progress as Record<string, unknown>
  if (typeof p.done !== "number" || typeof p.total !== "number" || p.total <= 0) return null
  return {
    done: p.done,
    total: p.total,
    ...(typeof p.message === "string" ? { message: p.message } : {}),
  }
}
