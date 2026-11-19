// The wire types of M4's methods. `@rookery/client` carries the server's own: they are imported
// here and re-exported, so fleet's views and API import one module. The few answers the server gives
// inline, with no named type of their own, are written out below and marked as such.
//
// The host and resource actions are the server's `Action` here, as `hosts.*` and `provisioners.*` send it.
import type { JobInfo } from "@rookery/client"

export type {
  Acted,
  Action,
  ActionStep,
  Argument,
  Catalogue,
  CatalogueChoice,
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
  /** For one that is not open, the command an admin runs on the server to change it. */
  command?: string
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
export interface SetupCatalogue {
  /** The profile a new host starts from. */
  template: Record<string, unknown>
  /** What the server's plugins can install, in the order they are applied. */
  features: FeatureInfo[]
  /** The machines the plugins' provisioners offer, with what each offers to choose from. */
  machines: MachineCatalogue[]
}

/** A kind of machine a plugin's provisioner makes, with the choices its plugin declares. */
export interface MachineCatalogue {
  /** The type of provisioner that makes it, as `PLUGIN/ID`. */
  provisioner: string
  /** What it makes, such as `machine`. */
  kind: string
  label: string
  description: string
  /** Its sizes, images and regions, as sets of the kind's arguments. */
  catalogue: import("@rookery/client").Catalogue
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
// M3's env.* wire types, from `@rookery/client`
// ---------------------------------------------------------------------------

export type {
  EnvChanged,
  EnvFileWrite,
  EnvInfo,
  EnvPresence,
  EnvSupports,
  FileData,
  FileWritten,
  Grant,
  PortRef,
  PortUrl,
} from "@rookery/client"
