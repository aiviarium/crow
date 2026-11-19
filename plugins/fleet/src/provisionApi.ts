// The M4 methods of `crow/plugins/fleet`: provisioners, the resources they make, the set-up catalogue,
// the installation's settings and secrets, and its registries. Every call is typed from the server's
// M4 wire types in `./types.ts`, which `@rookery/client` will carry once Crow repins past rookery#33.
import type { ClientRookery } from "@rookery/sdk/client"
import type {
  Acted,
  Action,
  Argument,
  Checked,
  Created,
  Generate,
  Generated,
  MachineCatalogue,
  NewResource,
  ProvisionerAct,
  ProvisionerGet,
  ProvisionerInfo,
  ProvisionerSave,
  ProvisionerState,
  Registry,
  Resource,
  SecretNames,
  Setting,
  SetupCatalogue,
} from "./types"

// ---------------------------------------------------------------------------
// Arguments: what their forms start with, and what they need
// ---------------------------------------------------------------------------

/** Whether an argument is a yes or no: the server's `boolean` kind, or the two values it declares. */
export function isBooleanArgument(argument: Argument): boolean {
  if (argument.kind === "boolean") return true
  const values = (argument.values ?? []).map((value) => value.toLowerCase()).sort()
  return (
    values.length === 2 &&
    ((values[0] === "no" && values[1] === "yes") || (values[0] === "false" && values[1] === "true"))
  )
}

const ON = ["yes", "true", "on", "1"]

/** Whether a value turns a yes or no on. Empty is off. */
export function isOn(value: string): boolean {
  return ON.includes(value.trim().toLowerCase())
}

/** The values a yes or no has when on and when off: those it declares, else yes and no. */
export function switchValues(argument: Argument): { on: string; off: string } {
  const declared = (on: boolean) =>
    (argument.values ?? []).find((value) => isOn(value) === on && value.trim() !== "")
  const on = declared(true)
  const off = declared(false)
  return on !== undefined && off !== undefined ? { on, off } : { on: "yes", off: "no" }
}

/** The label of an argument, or its name when it has none. */
export function argumentLabel(argument: Argument): string {
  return argument.label || argument.name
}

/** A form's starting values: what the provisioner keeps, else the argument's default. */
export function argumentDefaults(
  arguments_: readonly Argument[],
  settings: Record<string, string> = {},
): Record<string, string> {
  const values: Record<string, string> = {}
  for (const argument of arguments_) {
    const kept = settings[argument.name]
    const value = kept !== undefined && kept !== "" ? kept : argument.default
    values[argument.name] = isBooleanArgument(argument)
      ? isOn(value)
        ? switchValues(argument).on
        : switchValues(argument).off
      : value
  }
  return values
}

/** Only the arguments with a value, as the server takes them. */
export function argumentsOf(
  arguments_: readonly Argument[],
  values: Record<string, string>,
): Record<string, string> {
  const out: Record<string, string> = {}
  for (const argument of arguments_) {
    const value = values[argument.name]
    if (value !== undefined && value !== "") out[argument.name] = value
  }
  return out
}

/** A count of CPUs, or a size with its unit, as an argument of the `resource` kind takes them. */
export function resourceProblem(argument: Argument, value: string): string | null {
  const name = argument.name.toLowerCase()
  const count = value.trim()
  if (name.includes("cpu")) {
    const number = Number(count)
    return Number.isFinite(number) && number > 0 && /^[0-9.]+$/.test(count)
      ? null
      : `${argumentLabel(argument)} must be a positive number, such as 4`
  }
  const sized = ["memory", "mem", "ram", "disk", "size", "storage", "swap"]
  if (sized.some((word) => name.includes(word))) {
    const split = count.search(/[^0-9.]/)
    const number = count.slice(0, split < 0 ? undefined : split)
    const unit = count.slice(split < 0 ? count.length : split).toLowerCase()
    const units = ["b", "k", "kb", "kib", "m", "mb", "mib", "g", "gb", "gib", "t", "tb", "tib"]
    const fits = Number(number) > 0 && /^[0-9.]+$/.test(number) && units.includes(unit)
    return fits ? null : `${argumentLabel(argument)} must be a size with its unit, such as 8GiB or 4g`
  }
  return null
}

/** What stops a form: the required arguments left empty, and the sizes that do not fit. */
export function argumentProblems(
  arguments_: readonly Argument[],
  values: Record<string, string>,
): Record<string, string> {
  const problems: Record<string, string> = {}
  for (const argument of arguments_) {
    if (argument.fixed) continue
    const value = (values[argument.name] ?? "").trim()
    if (!value) {
      if (argument.required && !isBooleanArgument(argument)) {
        problems[argument.name] = `${argumentLabel(argument)} is required`
      }
      continue
    }
    if (argument.kind === "resource") {
      const problem = resourceProblem(argument, value)
      if (problem) problems[argument.name] = problem
    }
  }
  return problems
}

/** The question to answer before an action runs: its own, or a yes or no's that was switched on. */
export function actionConfirm(action: Action, values: Record<string, string>): string | null {
  for (const argument of action.arguments) {
    if (argument.confirm && isBooleanArgument(argument) && isOn(values[argument.name] ?? "")) {
      return argument.confirm
    }
  }
  return action.confirm || null
}

/** What an action's form starts with. */
export function actionDefaults(action: Action): Record<string, string> {
  return argumentDefaults(action.arguments)
}

// ---------------------------------------------------------------------------
// Resources and profiles
// ---------------------------------------------------------------------------

/** The dot and word for a resource's state. */
export function resourceState(state: string): {
  dot: "live" | "ok" | "warn" | "error" | "idle" | "ai"
  label: string
} {
  switch (state) {
    case "running":
      return { dot: "live", label: "Running" }
    case "creating":
      return { dot: "ai", label: "Creating" }
    case "stopped":
      return { dot: "idle", label: "Stopped" }
    case "missing":
      return { dot: "error", label: "Missing" }
    case "planned":
      return { dot: "idle", label: "Planned" }
    default:
      return { dot: "warn", label: state || "Unknown" }
  }
}

/** The profile a new machine's host is saved with: the catalogue's template, with its name and features. */
export function profileFor(
  name: string,
  template: Record<string, unknown>,
  features: readonly string[],
): Record<string, unknown> {
  const profile: Record<string, unknown> = { ...template, hostname: name }
  if (!profile.builder || typeof profile.builder !== "object") profile.builder = {}
  const vars = { ...((profile.ansible_vars as Record<string, unknown> | undefined) ?? {}) }
  if (features.length > 0) vars.rookery_plugin_features = [...features]
  else delete vars.rookery_plugin_features
  profile.ansible_vars = vars
  return profile
}

/** The values the default choices of a machine's catalogue set: its size, image and region. */
export function catalogueDefaults(machine: MachineCatalogue | null | undefined): Record<string, string> {
  const values: Record<string, string> = {}
  for (const choices of [machine?.catalogue.sizes, machine?.catalogue.images, machine?.catalogue.regions]) {
    if (!choices?.length) continue
    const choice = choices.find((one) => one.default) ?? choices[0]
    if (choice) Object.assign(values, choice.values)
  }
  return values
}

/** The features a profile already has switched on, by their `PLUGIN/FEATURE` keys. */
export function profileFeatures(profile: Record<string, unknown> | null | undefined): string[] {
  const vars = profile?.ansible_vars as { rookery_plugin_features?: unknown } | undefined
  const chosen = vars?.rookery_plugin_features
  return Array.isArray(chosen) ? chosen.filter((key): key is string => typeof key === "string") : []
}

/** The text of a read-only action's answer, as a jobless `Acted` carries it. */
export function resultText(result: unknown): string {
  if (result === null || result === undefined) return ""
  if (typeof result === "string") return result
  if (typeof result === "object" && "lines" in result) {
    const lines = (result as { lines?: unknown }).lines
    if (Array.isArray(lines)) return lines.map(String).join("\n")
  }
  return JSON.stringify(result, null, 2)
}

// ---------------------------------------------------------------------------
// The calls
// ---------------------------------------------------------------------------

export interface ProvisionersApi {
  list(): Promise<ProvisionerInfo[]>
  types(): Promise<ProvisionerInfo[]>
  get(name: string, given?: Record<string, string>): Promise<ProvisionerState>
  save(save: ProvisionerSave): Promise<ProvisionerInfo>
  remove(name: string): Promise<void>
  actions(name: string): Promise<Action[]>
  act(act: ProvisionerAct): Promise<Acted>
}

export interface ResourcesApi {
  create(resource: NewResource): Promise<Created>
  list(filter?: { provisioner?: string; kind?: string; host?: string }): Promise<Resource[]>
  get(id: string): Promise<Resource>
  actions(id: string): Promise<Action[]>
  act(act: { id: string; action: string; arguments?: Record<string, string> }): Promise<Acted>
  logs(id: string, tail?: number): Promise<string>
  remove(id: string): Promise<Acted>
}

export interface SetupApi {
  catalogue(): Promise<SetupCatalogue>
  generate(generate: Generate): Promise<Generated>
}

export interface InstallationApi {
  settings(): Promise<Setting[]>
  setSetting(name: string, value: string): Promise<void>
  secrets(): Promise<SecretNames>
  setSecret(name: string, value: string): Promise<void>
  renameSecret(name: string, to: string): Promise<void>
  removeSecret(name: string): Promise<void>
  actions(): Promise<Action[]>
  act(act: { action: string; arguments?: Record<string, string> }): Promise<Acted>
}

export interface RegistriesApi {
  list(): Promise<Record<string, Registry>>
  save(name: string, registry: Registry): Promise<void>
  check(name: string): Promise<string[]>
  rename(name: string, to: string): Promise<void>
  remove(name: string): Promise<void>
}

/** The admin half of fleet's API: everything M4 adds, all of it `admin` level on the server. */
export interface AdminApi {
  provisioners: ProvisionersApi
  resources: ResourcesApi
  setup: SetupApi
  installation: InstallationApi
  registries: RegistriesApi
}

/** Builds the M4 calls over a Rookery plugin client handle. */
export function createAdminApi(rookery: ClientRookery): AdminApi {
  const call = <T>(method: string, params: Record<string, unknown> = {}): Promise<T> =>
    rookery.rpc.call<T>(method, params)

  return {
    provisioners: {
      list: () => call<ProvisionerInfo[]>("provisioners.list"),
      types: () => call<ProvisionerInfo[]>("provisioners.types"),
      get: (name, given) => {
        const params: ProvisionerGet = { name, given: given ?? {} }
        return call<ProvisionerState>("provisioners.get", params as unknown as Record<string, unknown>)
      },
      save: (save) => call<ProvisionerInfo>("provisioners.save", save as unknown as Record<string, unknown>),
      async remove(name) {
        await call("provisioners.remove", { name })
      },
      async actions(name) {
        const res = await call<{ actions?: Action[] }>("provisioners.actions", { name })
        return res.actions ?? []
      },
      act: (act) => call<Acted>("provisioners.act", act as unknown as Record<string, unknown>),
    },
    resources: {
      create: (resource) => call<Created>("resources.create", resource as unknown as Record<string, unknown>),
      list: (filter = {}) => {
        const params: Record<string, unknown> = {}
        if (filter.provisioner) params.provisioner = filter.provisioner
        if (filter.kind) params.kind = filter.kind
        if (filter.host) params.host = filter.host
        return call<Resource[]>("resources.list", params)
      },
      get: (id) => call<Resource>("resources.get", { id }),
      async actions(id) {
        const res = await call<{ actions?: Action[] }>("resources.actions", { id })
        return res.actions ?? []
      },
      act: (act) => call<Acted>("resources.act", act as unknown as Record<string, unknown>),
      async logs(id, tail) {
        const res = await call<{ text?: string }>(
          "resources.logs",
          tail === undefined ? { id } : { id, tail },
        )
        return res.text ?? ""
      },
      remove: (id) => call<Acted>("resources.remove", { id, token: null }),
    },
    setup: {
      catalogue: () => call<SetupCatalogue>("setup.catalogue"),
      generate: (generate) =>
        call<Generated>("setup.generate", generate as unknown as Record<string, unknown>),
    },
    installation: {
      settings: () => call<Setting[]>("installation.settings.list"),
      async setSetting(name, value) {
        await call("installation.settings.set", { name, value })
      },
      secrets: () => call<SecretNames>("installation.secrets.list"),
      async setSecret(name, value) {
        await call("installation.secrets.set", { name, value })
      },
      async renameSecret(name, to) {
        await call("installation.secrets.rename", { name, value: to })
      },
      async removeSecret(name) {
        await call("installation.secrets.remove", { name })
      },
      async actions() {
        const res = await call<{ actions?: Action[] }>("installation.actions")
        return res.actions ?? []
      },
      act: (act) => call<Acted>("installation.act", act as unknown as Record<string, unknown>),
    },
    registries: {
      async list() {
        const res = await call<{ registries?: Record<string, Registry> }>("registries.list")
        return res.registries ?? {}
      },
      async save(name, registry) {
        await call("registries.save", { name, value: registry })
      },
      async check(name) {
        const res = await call<Checked>("registries.check", { name })
        return res.lines ?? []
      },
      async rename(name, to) {
        await call("registries.rename", { name, value: to })
      },
      async remove(name) {
        await call("registries.remove", { name })
      },
    },
  }
}
