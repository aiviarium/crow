// The wire types of M4's methods, copied from rookery#33 (`feat/cli-client`) while Crow pins Rookery at
// main, which has none of `provisioners.*`, `resources.*`, `setup.*`, `registries.*` or
// `installation.*` yet. Each type says where it came from; a copied one is replaced by an
// `@rookery/client` import when Crow repins.
//
// The M3 `env.*` types are here too, from rookery#42 (`feat/connect`): `EnvInfo`, `EnvSupports` and
// `Grant` are the older prototype's in the pinned `@rookery/client`, and `env.changed`'s payload, the
// port URL and the file pair are not there at all.
//
// `api.ts`'s hand-written M1 `Action` stays as it is (its arguments predate the server's); everything M4
// adds uses the server's `Action` here.
import type { JobInfo, JobState } from "@rookery/client"

export type { JobInfo, JobState }

// from rookery#33 generated/Action.ts; replace with @rookery/client import after repin
/** Something that can be done to a subject: a host, the installation, a provisioner or a resource. */
export interface Action {
  name: string
  label: string
  help: string
  /** The group of the page it is listed in; `Host` when empty. */
  group: string
  arguments: Argument[]
  /** The question to answer yes to before it runs. */
  confirm?: string | null
  runs: Runs
  /** It needs a terminal session attached; only a host runs these. */
  terminal: boolean
  /** False when it only reads, and may be called at any time. */
  changes: boolean
  /** The least role that may run it. */
  role: Role
  /** False, with `why`, when the subject's state rules it out now. */
  available: boolean
  why?: string
  steps?: ActionStep[]
  /** The id of the provisioner's collection it belongs to. */
  collection?: string
}

// from rookery#33 generated/Argument.ts; replace with @rookery/client import after repin
export interface Argument {
  name: string
  label: string
  required: boolean
  default: string
  /** A command whose lines are the values to offer. */
  choices?: string
  /** `resource`, `text` or `boolean`; empty for any other argument. */
  kind?: string
  help?: string
  /** The values it takes, when it is a choice of a few. */
  values?: string[]
  /** What is given is a secret: not shown, not kept, and masked in a job's output. */
  secret?: boolean
  /** Why it keeps its default here and cannot be given another value. Empty when it can be changed. */
  fixed?: string
  /** For a yes or no: the question to answer yes to before the action runs with it on. */
  confirm?: string
}

// from rookery#33 generated/ActionStep.ts; replace with @rookery/client import after repin
export interface ActionStep {
  label: string
  help?: string
}

// from rookery#33 generated/Role.ts; replace with @rookery/client import after repin
export type Role = "view" | "operate" | "admin"

// from rookery#33 generated/Runs.ts; replace with @rookery/client import after repin
export type Runs = "rookery" | "host"

// from rookery#33 generated/ProvisionerInfo.ts; replace with @rookery/client import after repin
/** Something a plugin creates machines with, for a saved host's profile. */
export interface ProvisionerInfo {
  /** Its id, which stays when it is renamed. In the list of types, the type itself. */
  id: string
  /** The name it is registered under, such as `ovh-incus`. In the list of types, the type itself. */
  name: string
  /** The plugin's provisioner it is, as `PLUGIN/ID`, such as `incus/vm`. */
  type: string
  label: string
  description: string
  /** `seed`: the machine boots with rookery's cloud seed and sets itself up. `apply`: rookery applies the profile over SSH once the machine answers. */
  setup: string
  /** What it can do besides `create`, `status` and `destroy`: `start`, `stop`, `list`, `log`. */
  verbs: string[]
  /** The rookery secrets it is given. */
  secrets: string[]
  /** The required ones that have no value. Not looked at in a plugin's listing. */
  missing_secrets?: string[]
  /** What creating a machine takes: the provisioner's own arguments first, then those of its machines. */
  arguments: Argument[]
  /** The names of the provisioner's own arguments, which say where it is, such as an Incus server. */
  own?: string[]
  /** The values of its own arguments that are kept, by name. */
  settings?: Record<string, string>
  /** The node it lives on, when a feature of that host offered it, by name. */
  node?: string
  node_id?: string
  /** What it can make: `machine`, and kinds its plugin names. */
  kinds?: ProvisionerKind[]
  /** Its plugin's own actions, such as listing images or pruning. */
  actions?: Action[]
  /** What it holds that can be listed, such as storage pools, each with the actions of its items. */
  collections?: Collection[]
  /** Why it cannot be used here, as a sentence that says what to change. Empty when it can. */
  problem?: string
}

// from rookery#33 generated/ProvisionerKind.ts; replace with @rookery/client import after repin
export interface ProvisionerKind {
  /** `machine`, or a kind the plugin names, such as `deployment`. */
  id: string
  label: string
  /** For a machine: `seed` or `apply`, as for the provisioner. */
  setup?: string
  verbs: string[]
  arguments: Argument[]
  /** The specification one is made from, for a kind that has one. */
  spec?: unknown
  /** What its plugin can do to one, each run with the verb `act` and the resource's id. */
  actions?: Action[]
}

// from rookery#33 generated/Collection.ts; replace with @rookery/client import after repin
export interface Collection {
  id: string
  label: string
  plural: string
  help?: string
  group?: string
  key: string[]
  within?: string
  kinds?: string[]
  columns?: CollectionColumn[]
  new?: CollectionAction[]
  item?: CollectionAction[]
  list?: CollectionAction[]
  remove?: string
  show?: string
}

// from rookery#33 generated/CollectionAction.ts; replace with @rookery/client import after repin
export interface CollectionAction {
  action: string
  label?: string
  arguments?: Record<string, string>
}

// from rookery#33 generated/CollectionColumn.ts; replace with @rookery/client import after repin
export interface CollectionColumn {
  name: string
  label: string
}

// from rookery#33 generated/CollectionItem.ts; replace with @rookery/client import after repin
export interface CollectionItem {
  name: string
  key: Record<string, string>
  columns?: Record<string, string>
  unavailable?: Record<string, string>
}

// from rookery#33 generated/Detail.ts; replace with @rookery/client import after repin
export interface Detail {
  label: string
  value: string
}

// from rookery#33 generated/ListedResource.ts; replace with @rookery/client import after repin
export interface ListedResource {
  id: string
  kind: string
  name: string
  host?: string
  state: string
  /** rookery's id of it, when rookery has a record of it. */
  resource?: string
}

// from rookery#33 generated/ProvisionerState.ts; replace with @rookery/client import after repin
/** A provisioner's page: what it is, what it says of itself now, and what it holds. */
export interface ProvisionerState {
  provisioner: ProvisionerInfo
  /** `ready`, `unreachable` or `unusable`, or what the provisioner said. */
  state: string
  details?: Detail[]
  message?: string
  values?: Record<string, string[]>
  collections?: Record<string, CollectionItem[]>
  /** rookery's records of what it made, with what its own list says. */
  resources?: ListedResource[]
}

// from rookery#33 generated/ProvisionerSave.ts; replace with @rookery/client import after repin
export interface ProvisionerSave {
  name: string
  /** The plugin's provisioner it is, as `PLUGIN/ID`. A registered one keeps its type. */
  type: string
  /** Values of its own arguments. Empty ones are not kept. Left out, the settings it has stay. */
  settings?: Record<string, string> | null
}

// from rookery#33 generated/ProvisionerGet.ts; replace with @rookery/client import after repin
export interface ProvisionerGet {
  name: string
  /** Values of its arguments to ask it with, such as a server it would use. */
  given?: Record<string, string>
}

// from rookery#33 generated/ProvisionerAct.ts; replace with @rookery/client import after repin
export interface ProvisionerAct {
  name: string
  action: string
  arguments?: Record<string, string>
  token?: string | null
}

// from rookery#33 generated/Resource.ts; replace with @rookery/client import after repin
/** Something a provisioner made for rookery: a machine, or a kind its plugin names. */
export interface Resource {
  /** rookery's id of it, stable for the life of the record. */
  id: string
  /** The name of the provisioner that made it. */
  provisioner: string
  provisioner_id?: string
  /** `machine`, or a kind the plugin declares. */
  kind: string
  name: string
  /** `creating`, `running`, `stopped`, `missing` or `unknown`; `planned` for one saved to be made later. */
  state: string
  /** The provisioner's id of it; empty until `create` said it. */
  external_id: string
  host?: string | null
  host_id?: string
  address?: string
  endpoints?: Endpoint[]
  arguments: Record<string, string>
  secrets?: ResourceSecret[]
  spec_sha256?: string
  /** When it was asked for, RFC 3339. */
  created: string
  checked?: string
  /** What can be done to it besides being removed: `start`, `stop`, `change`, `logs`, `exec`. */
  verbs: string[]
  problem?: string
}

// from rookery#33 generated/Endpoint.ts; replace with @rookery/client import after repin
export interface Endpoint {
  name: string
  address: string
  port: number
  protocol: string
  hint?: string
  local?: boolean
}

// from rookery#33 generated/ResourceSecret.ts; replace with @rookery/client import after repin
export interface ResourceSecret {
  name: string
  env?: string
}

// from rookery#33 generated/NewResource.ts; replace with @rookery/client import after repin
export interface NewResource {
  /** The provisioner, by name or id. */
  provisioner: string
  /** `machine` when empty. */
  kind: string
  /** The host's name for a host's machine when empty. */
  name: string
  /** The saved host a machine is made for, and set up as. */
  host?: string | null
  arguments: Record<string, string>
  spec?: string | null
  secrets?: ResourceSecret[]
  token?: string | null
}

// from rookery#33 generated/Created.ts (the result of `resources.create`); replace with @rookery/client import after repin
export interface Created {
  resource: Resource
  job: JobInfo
}

// from rookery#33 generated/Acted.ts; replace with @rookery/client import after repin
/** What running an action came to: a job, a host session, or what an action that answers at once said. */
export interface Acted {
  job: string | null
  state: JobState | null
  info: JobInfo | null
  session: unknown | null
  result: unknown | null
}

// from rookery#33 `crates/rookery-hosts/src/serve/setup.rs` (`Setting`, the result of
// `installation.settings.list`); replace with @rookery/client import after repin
export interface Setting {
  key: string
  /** Empty when it is not set, and for a token. */
  value: string
  meaning: string
  /** Whether `installation.settings.set` takes it. */
  open: boolean
}

// from rookery#33 generated/Named.ts; replace with @rookery/client import after repin
export interface Named {
  id: string
  name: string
}

// from rookery#33 generated/SecretNames.ts; replace with @rookery/client import after repin
export interface SecretNames {
  /** The global secrets' names, and the addresses of those that belong to something. */
  names: string[]
  /** The global secrets, by name, with their ids. */
  secrets: Named[]
}

// from rookery#33 generated/Checked.ts (the result of `registries.check`); replace with @rookery/client import after repin
export interface Checked {
  /** One line per thing checked, starting with ✓, ! or ✗. */
  lines: string[]
}

// from rookery#33 `crates/rookery-hosts/src/serve/setup.rs` (`registries.list`'s entries, by name)
/** A configured registry: a connection of the `registry` type. The id is rookery's, and is left out of what is saved. */
export interface Registry {
  id?: string
  type: string
  url: string
  username?: string
  /** A Nexus server's repositories, each with its `format`, `name` and `address`. */
  repositories?: Array<{ format?: string; name?: string; address?: string }>
  requiresSignature?: boolean
  error?: string
}

// from rookery#33 `crates/rookery-hosts/src/serve/setup.rs` (`Catalogue`, the result of `setup.catalogue`); replace with @rookery/client import after repin
export interface Catalogue {
  /** The profile a new host starts from. */
  template: Record<string, unknown>
  /** What the server's plugins can install, in the order they are applied. */
  features: FeatureInfo[]
}

// from rookery#33 `crates/rookery-hosts/src/serve/setup.rs` (`FeatureInfo`)
export interface FeatureInfo {
  /** `PLUGIN/FEATURE`, as a profile's `rookery_plugin_features` names it. */
  key: string
  label: string
  /** The group of the Features page it is listed in. */
  group: string
  help: string
  /** The types of host it is for, such as `workstation` or `node`. */
  types: string[]
}

// from rookery#33 `crates/rookery-hosts/src/serve/setup.rs` (`Generate` and `Generated`)
export interface Generate {
  /** `hostname` or `password`. */
  what: string
  /** For `password`: the password to hash. Without it one is made up and kept for the host. */
  password?: string | null
  host?: string | null
  user?: string | null
}

export interface Generated {
  value: string
  note: string
  /** A password that was made up, for whoever asked to write down. */
  password?: string | null
}

// ---------------------------------------------------------------------------
// M3's env.* wire types, copied from rookery#42 (`feat/connect`)
// ---------------------------------------------------------------------------

// from rookery#42 generated/EnvChanged.ts; replace with @rookery/client import after repin
/**
 * The event `rookery/env.changed`: a host's state, type or access changed, or it was removed.
 * `environment` is as `env.get` gives it to the subscriber, and absent once it is removed.
 */
export interface EnvChanged {
  /** `env://<name>`. */
  env: string
  environment?: EnvInfo
  removed?: boolean
}

// from rookery#42 generated/EnvInfo.ts; replace with @rookery/client import after repin
/**
 * `env.list`, `env.get`: a host as an environment. The pinned `@rookery/client` type is the older
 * prototype's, with a `provider`, `metadata` and `connector` no `env.*` answer carries any more.
 */
export interface EnvInfo {
  name: string
  /** `env://<name>`. */
  uri: string
  /** The host's type: `ssh`, `managed`, `node`, `workstation` or `local`. */
  kind: string
  state: "online" | "offline" | "starting" | "degraded"
  /** The owner's user id. */
  owner?: string
  /** The caller's level on it: `view`, `use` or `manage`. */
  level?: Grant
  os?: string
  /** The version of its controller. */
  version?: string
  supports: EnvSupports
  /** Why it is offline, starting or degraded. */
  error?: string
}

// from rookery#42 generated/EnvSupports.ts; replace with @rookery/client import after repin
/** What a host can do, from its type and what its controller was seen to be. */
export interface EnvSupports {
  terminal: boolean
  process: boolean
  files: boolean
  connect: boolean
  checkouts: boolean
  /** A desktop on a virtual display (VNC on the host's loopback). */
  desktop: boolean
  /** Sessions as `operator` or `root`, which need manage. */
  privileged: boolean
  /** Sessions outlive the controller's connection and can be attached again. */
  persistentSessions: boolean
  /** Plugins' app services can be placed on it. */
  deploy: boolean
}

// from rookery#42 generated/Grant.ts; replace with @rookery/client import after repin
/** A level on a resource. Each includes those before it. */
export type Grant = "view" | "use" | "manage"

// from rookery#42 generated/PortRef.ts; replace with @rookery/client import after repin
/** `env.portUrl`: where a browser opens a port of a host. */
export interface PortRef {
  env: string
  port: number
  /** The path under the port, `/` when absent. */
  path?: string
}

// from rookery#42 generated/PortUrl.ts; replace with @rookery/client import after repin
/**
 * The result of `env.portUrl`: an address on the ports' own origin that signs the browser in to
 * that one port once, within a minute, and then shows `path`.
 */
export interface PortUrl {
  url: string
  /** The origin the port is served on. */
  origin: string
}

// from rookery#42 generated/FileData.ts; replace with @rookery/client import after repin
/** The result of `env.readFile`. */
export interface FileData {
  base64: string
  size: number
  /** SHA-256 of the content, lower-case hex: the version `env.writeFile` can name in `ifMatch`. */
  sha256: string
}

// from rookery#42 generated/EnvFileWrite.ts; replace with @rookery/client import after repin
/** `env.writeFile`. Missing folders are made. */
export interface EnvFileWrite {
  env: string
  path: string
  base64: string
  /** Replace a file that is there; otherwise one that is there is a `CONFLICT`. */
  overwrite?: boolean
  /**
   * Write only while the file's SHA-256 is this, as `env.readFile` gave it; otherwise, or when the
   * file is gone, `CONFLICT`. Implies `overwrite`.
   */
  ifMatch?: string
}

// from rookery#42 generated/FileWritten.ts; replace with @rookery/client import after repin
/** The result of `env.writeFile`. */
export interface FileWritten {
  /** SHA-256 of what was written, the file's version from now on. */
  sha256: string
  size: number
}
