// Hand-written API contract for `hosts.*`, which Rookery's server does not serve yet (M1 is in
// progress). Every type here is to be replaced by `@rookery/client`'s generated wire types when
// `hosts.*` lands; jobs already use those generated types, in `./jobs.ts`.
import type { JobState } from "@rookery/client"
import type { ClientRookery } from "@rookery/sdk/client"

export type { JobState }

// ---------------------------------------------------------------------------
// Host types (carried over from rookery-api and rookery local/serve/api.rs)
// ---------------------------------------------------------------------------

/** What a host can do, from plain SSH up to a full workstation (plus local). */
export type HostType = "ssh" | "managed" | "node" | "workstation" | "local"

export type PowerState = "running" | "stopped" | "unknown"

export interface Power {
  start: boolean
  stop: boolean
  state: PowerState
  start_by?: string | null
  stop_by?: string | null
}

export interface Change {
  id: string
  from: string
  to: string
}

export interface Behind {
  changes: Change[]
}

export interface HostMachine {
  resource: string
  provisioner: string
  external_id: string
  state: string
}

export interface HostInfo {
  id?: string | null
  name: string
  address: string
  reachable: boolean
  version?: string | null
  api?: number | null
  error?: string | null
  applied?: string | null
  behind?: Behind | null
  type: HostType
  seen?: HostType | null
  rotating?: boolean
  power: Power
  machine?: HostMachine | null
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

export interface HostCheckRefusal {
  why: string
  raise: string
}

export interface HostCheckResult {
  allowed: boolean
  refusal?: HostCheckRefusal | null
}

// ---------------------------------------------------------------------------
// Host actions (carried over from rookery-api/src/types.rs)
// ---------------------------------------------------------------------------

export interface Argument {
  name: string
  label: string
  required: boolean
  default: string
  choices?: string[]
  kind?: string
  help?: string | null
  values?: string[]
  secret?: boolean
  fixed?: boolean
  confirm?: boolean
}

export interface ActionStep {
  label: string
  help?: string | null
}

export type ActionRuns = "rookery" | "host"
export type ActionRole = "view" | "operate" | "admin"

export interface Action {
  name: string
  label: string
  help: string
  group: string
  arguments: Argument[]
  confirm?: string | null
  runs: ActionRuns
  terminal: boolean
  changes: boolean
  role: ActionRole
  available: boolean
  why?: string | null
  steps?: ActionStep[]
  collection?: string | null
}

// ---------------------------------------------------------------------------
// RPC method parameter and result shapes
// ---------------------------------------------------------------------------

export interface HostsListParams {
  [key: string]: never
}
export interface HostsListResult {
  hosts: HostInfo[]
}

export interface HostsGetParams {
  host: string
}
export type HostsGetResult = HostInfo

export interface HostsSaveParams {
  host: string
  profile: HostProfile
}
export interface HostsSaveResult {
  host: HostInfo
}

export interface HostsRemoveParams {
  host: string
}
export type HostsRemoveResult = Record<string, never>

export interface HostsRenameParams {
  host: string
  to: string
}
export interface HostsRenameResult {
  host: HostInfo
}

export interface HostsProfileParams {
  host: string
}
export interface HostsProfileResult {
  profile: HostProfile
}

export interface HostsCheckParams {
  host: string
  capability: HostCapability
}
export type HostsCheckResult = HostCheckResult

export interface HostsActionsParams {
  host: string
}
export interface HostsActionsResult {
  actions: Action[]
}

export interface HostsActParams {
  host: string
  action: string
  arguments?: Record<string, string>
  token?: string
  sudo_password?: string
}

/** Every host action runs as a Rookery job whose output streams via `jobs.follow`. */
export interface HostsActResult {
  job: string
  state: JobState
  result?: unknown
}

/** Event emitted on topic `hosts.changed` when a host is added, updated, renamed, or removed. */
export interface HostChangedEvent {
  host: string
  info?: HostInfo | null
  removed?: boolean
}

/** Map of every `hosts.*` JSON-RPC method called by the fleet plugin. */
export interface FleetMethods {
  "hosts.list": { params: HostsListParams; result: HostsListResult }
  "hosts.get": { params: HostsGetParams; result: HostsGetResult }
  "hosts.save": { params: HostsSaveParams; result: HostsSaveResult }
  "hosts.remove": { params: HostsRemoveParams; result: HostsRemoveResult }
  "hosts.rename": { params: HostsRenameParams; result: HostsRenameResult }
  "hosts.profile": { params: HostsProfileParams; result: HostsProfileResult }
  "hosts.check": { params: HostsCheckParams; result: HostsCheckResult }
  "hosts.actions": { params: HostsActionsParams; result: HostsActionsResult }
  "hosts.act": { params: HostsActParams; result: HostsActResult }
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
  renameHost(host: string, to: string): Promise<HostInfo>
  getProfile(host: string): Promise<HostProfile>
  checkCapability(host: string, capability: HostCapability): Promise<HostCheckResult>
  listActions(host: string): Promise<Action[]>
  act(params: HostsActParams): Promise<HostsActResult>
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
      const res = await call("hosts.save", { host, profile })
      return res.host
    },
    async removeHost(host) {
      await call("hosts.remove", { host })
    },
    async renameHost(host, to) {
      const res = await call("hosts.rename", { host, to })
      return res.host
    },
    async getProfile(host) {
      const res = await call("hosts.profile", { host })
      return res.profile ?? {}
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
  }
}
