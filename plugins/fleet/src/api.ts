// The `hosts.*` calls fleet makes over `@rookery/client`'s generated wire types. The shapes the
// server writes inline, and the saved profile's own JSON, are the few written out here.
import type {
  Acted,
  Action,
  ActionList,
  ActionStep,
  Argument,
  Behind,
  HostAct,
  HostCheck,
  HostChecked,
  HostInfo,
  HostList,
  HostMachine,
  HostProfile as HostProfileResult,
  HostRef,
  HostRename,
  HostSave,
  HostSaved,
  HostType,
  JobState,
  Power,
  PowerState,
} from "@rookery/client"
import type { ClientRookery } from "@rookery/sdk/client"

export type {
  Action,
  ActionStep,
  Argument,
  Behind,
  HostChecked,
  HostInfo,
  HostMachine,
  HostType,
  JobState,
  Power,
  PowerState,
}

/** Minimal SSH access section of a saved host profile (`rookery host add` shape). */
export interface HostAccessProfile {
  address: string
  user?: string
  port?: number
  auth?: "key" | "agent" | "password" | string
  key?: string
  jump?: string
  [key: string]: unknown
}

/** Saved host profile JSON object returned by `hosts.profile` and accepted by `hosts.save`. */
export interface HostProfile {
  type?: HostType
  access?: HostAccessProfile
  builder?: Record<string, unknown>
  features?: Record<string, unknown>
  operator?: string | Record<string, unknown>
  agent?: string | Record<string, unknown>
  [key: string]: unknown
}

export type HostCapability =
  | "apply"
  | "terminal"
  | "desktop"
  | "ports"
  | "services"
  | "exec"
  | "files"
  | "agents"
  | string

// ---------------------------------------------------------------------------
// RPC method parameter and result shapes
// ---------------------------------------------------------------------------

export interface HostsProfileResult {
  profile: HostProfile
}

/**
 * `hosts.desktop.screenshot`: a picture of a workstation's desktop, as a PNG in base64. It is what `view`
 * sees of a desktop; the live one over `/env/<name>/desktop` needs `use`.
 */
export interface HostsDesktopScreenshotResult {
  base64: string
  content_type: string
}

/** Event emitted on topic `hosts.changed` when a host is added, updated, renamed, or removed. */
export interface HostChangedEvent {
  host: string
  info?: HostInfo | null
  removed?: boolean
}

/** Map of every `hosts.*` JSON-RPC method called by the fleet plugin. */
export interface FleetMethods {
  "hosts.list": { params: Record<string, never>; result: HostList }
  "hosts.get": { params: HostRef; result: HostInfo }
  "hosts.save": { params: HostSave; result: HostSaved }
  "hosts.remove": { params: HostRef; result: Record<string, never> }
  "hosts.rename": { params: HostRename; result: Acted }
  "hosts.profile": { params: HostRef; result: HostProfileResult }
  "hosts.check": { params: HostCheck; result: HostChecked }
  "hosts.actions": { params: HostRef; result: ActionList }
  "hosts.act": { params: HostAct; result: Acted }
  "hosts.desktop.screenshot": { params: HostRef; result: HostsDesktopScreenshotResult }
}

export type FleetMethodName = keyof FleetMethods

export interface HostsApi {
  call<M extends FleetMethodName>(
    method: M,
    params: FleetMethods[M]["params"],
  ): Promise<FleetMethods[M]["result"]>
  listHosts(): Promise<HostInfo[]>
  getHost(host: string): Promise<HostInfo>
  saveHost(host: string, profile: HostProfile): Promise<HostInfo>
  removeHost(host: string): Promise<void>
  renameHost(host: string, to: string): Promise<Acted>
  getProfile(host: string): Promise<HostProfile>
  checkCapability(host: string, capability: HostCapability): Promise<HostChecked>
  listActions(host: string): Promise<Action[]>
  act(params: HostAct): Promise<Acted>
  /** A PNG of the host's desktop in base64, which `view` may see. */
  screenshot(host: string): Promise<HostsDesktopScreenshotResult>
}

/** Builds a typed hosts API wrapper over a Rookery plugin client handle. */
export function createHostsApi(rookery: ClientRookery): HostsApi {
  const call = <M extends FleetMethodName>(
    method: M,
    params: FleetMethods[M]["params"],
  ): Promise<FleetMethods[M]["result"]> =>
    rookery.rpc.call<FleetMethods[M]["result"]>(method, params as Record<string, unknown>)

  return {
    call,
    async listHosts() {
      const res = await call("hosts.list", {})
      return res.hosts ?? []
    },
    getHost(host) {
      return call("hosts.get", { host })
    },
    async saveHost(host, profile) {
      const res = await call("hosts.save", { host, profile: profile as never })
      return res.host
    },
    async removeHost(host) {
      await call("hosts.remove", { host })
    },
    renameHost(host, to) {
      return call("hosts.rename", { host, to, hostname: false, token: null })
    },
    async getProfile(host) {
      const res = await call("hosts.profile", { host })
      return (res.profile ?? {}) as unknown as HostProfile
    },
    checkCapability(host, capability) {
      return call("hosts.check", { host, capability })
    },
    async listActions(host) {
      const res = await call("hosts.actions", { host })
      return res.actions ?? []
    },
    act(params) {
      return call("hosts.act", params)
    },
    screenshot(host) {
      return call("hosts.desktop.screenshot", { host })
    },
  }
}
