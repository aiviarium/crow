// The wire types of M4's methods. `@rookery/client` carries the server's own: they are imported
// here and re-exported, so fleet's views and API import one module. The few answers the server gives
// inline, with no named type of their own, are written out below and marked as such.
//
// The M3 `env.*` types are still copies, from rookery#42 (`feat/connect`): `EnvInfo`, `EnvSupports` and
// `Grant` are the older prototype's in the pinned `@rookery/client`, and `env.changed`'s payload, the port
// URL and the file pair are not there at all.
//
// `api.ts`'s hand-written M1 `Action` stays as it is (its arguments predate the server's); everything M4
// adds uses the server's `Action` here.
import type { JobInfo } from "@rookery/client"

export type {
  Acted,
  Action,
  ActionStep,
  Argument,
  Collection,
  CollectionAction,
  CollectionColumn,
  CollectionItem,
  Detail,
  Endpoint,
  JobInfo,
  JobState,
  ListedResource,
  NewResource,
  ProvisionerAct,
  ProvisionerGet,
  ProvisionerInfo,
  ProvisionerKind,
  ProvisionerSave,
  ProvisionerState,
  Resource,
  ResourceSecret,
  Role,
  Runs,
} from "@rookery/client"

// The answer of `installation.secrets.list`, which the server writes inline: the global secrets' names,
// the addresses of those that belong to something, and the global secrets with their ids. It is not the
// `secrets.*` facility's `SecretNames`.
export interface Named {
  /** Its id, which stays when it is renamed. */
  id: string
  name: string
}

export interface SecretNames {
  /** The global secrets' names, and the addresses of those that belong to something. */
  names: string[]
  /** The global secrets, by name, with their ids. */
  secrets: Named[]
}

// The result of `resources.create`, which the server writes inline: the record and the job that makes
// or checks it.
export interface Created {
  resource: import("@rookery/client").Resource
  job: JobInfo
}

// A `Setting` of `installation.settings.list`, which the server writes inline. It is not the
// `settings.*` facility's `Setting`.
export interface Setting {
  key: string
  /** Empty when it is not set, and for a token. */
  value: string
  meaning: string
  /** Whether `installation.settings.set` takes it. */
  open: boolean
}

// The result of `registries.check`, which the server writes inline.
export interface Checked {
  /** One line per thing checked, starting with ✓, ! or ✗. */
  lines: string[]
}

// An entry of `registries.list`, which the server writes inline: a connection of the `registry` type.
// The id is rookery's, and is left out of what is saved.
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

// The result of `setup.catalogue`, which the server writes inline.
export interface Catalogue {
  /** The profile a new host starts from. */
  template: Record<string, unknown>
  /** What the server's plugins can install, in the order they are applied. */
  features: FeatureInfo[]
}

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

// `setup.generate` and its answer, which the server writes inline.
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
