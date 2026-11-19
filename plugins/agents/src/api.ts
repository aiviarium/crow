// Rookery host discovery helpers for the Agents plugin. Uses `env.list` (Rookery's environment
// listing) with a fallback to `hosts.list` for pre-env servers, and normalizes host names and
// `env://<name>` URIs.
import type { ClientRookery } from "@rookery/sdk/client"
import type { AgentHostCapability } from "./rookery-wire"

export type AgentHostState = "online" | "offline" | "connecting" | "unknown"

export interface AgentHost {
  name: string
  /** Canonical environment URI (`env://<name>`). */
  env: string
  state: AgentHostState
  kind: string
  address?: string | null
  error?: string | null
  /** Whether the host explicitly advertises Parrot / agent support, if known. */
  agentsSupported?: boolean | null
}

interface LegacyHostInfo extends AgentHostCapability {
  name: string
  address?: string | null
  reachable?: boolean
  error?: string | null
  type?: string
}

export function hostNameFromEnv(hostOrEnv: string): string {
  const trimmed = hostOrEnv.trim()
  return trimmed.startsWith("env://") ? trimmed.slice("env://".length) : trimmed
}

export function toEnvUri(hostOrEnv: string): string {
  const name = hostNameFromEnv(hostOrEnv)
  return name ? `env://${name}` : ""
}

export function errorMessage(err: unknown): string {
  if (err instanceof Error && err.message) return err.message
  if (
    err &&
    typeof err === "object" &&
    "message" in err &&
    typeof (err as { message: unknown }).message === "string"
  ) {
    return (err as { message: string }).message
  }
  return String(err)
}

export function isMethodMissing(err: unknown): boolean {
  if (!err || typeof err !== "object") return false
  const code = (err as { code?: unknown }).code
  if (code === "NOT_FOUND" || code === "UNIMPLEMENTED" || code === -32601) return true
  const msg = errorMessage(err).toLowerCase()
  return msg.includes("method not found") || msg.includes("unknown method")
}

function normalizeState(state: string | undefined): AgentHostState {
  if (state === "online" || state === "offline" || state === "connecting") return state
  return "unknown"
}

function sortHosts(list: AgentHost[]): AgentHost[] {
  return [...list].sort((a, b) => {
    const aOn = a.state === "online" ? 0 : 1
    const bOn = b.state === "online" ? 0 : 1
    if (aOn !== bOn) return aOn - bOn
    return a.name.localeCompare(b.name)
  })
}

/**
 * Lists hosts that can run Parrot agent sessions. Calls `env.list` first and falls back to
 * `hosts.list` if the server only exposes Fleet's host registry.
 */
export async function listAgentHosts(rookery: ClientRookery): Promise<AgentHost[]> {
  try {
    const envs = await rookery.env.list()
    const legacy = envs.some((e) => (e.supports as AgentHostCapability | undefined)?.agents === undefined)
      ? await listLegacyAgentHosts(rookery).catch(() => [])
      : []
    const flags = new Map(legacy.map((h) => [h.name, h.agentsSupported]))
    return sortHosts(
      envs.map((e) => {
        const supports: typeof e.supports & AgentHostCapability = e.supports
        const agentsSupported = supports?.agents ?? flags.get(e.name) ?? null
        return {
          name: e.name,
          env: e.uri || toEnvUri(e.name),
          state: normalizeState(e.state),
          kind: e.kind,
          error: e.error ?? null,
          agentsSupported,
        }
      }),
    )
  } catch (err) {
    if (!isMethodMissing(err)) throw err
  }

  return listLegacyAgentHosts(rookery)
}

export async function listLegacyAgentHosts(rookery: ClientRookery): Promise<AgentHost[]> {
  const res = await rookery.rpc.call<{ hosts?: LegacyHostInfo[] }>("hosts.list", {})
  const hosts = res?.hosts ?? []
  return sortHosts(
    hosts.map((h) => ({
      name: h.name,
      env: toEnvUri(h.name),
      state: h.reachable ? "online" : "offline",
      kind: h.type ?? "host",
      address: h.address ?? null,
      error: h.error ?? null,
      agentsSupported: h.agents ?? null,
    })),
  )
}
