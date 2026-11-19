// Provisioners: the machines' makers. The ones registered under names of their own, what the installed
// plugins offer, registering one with its own arguments (whose values are kept as its settings), changing
// those settings, removing one that made nothing kept, and running the actions its plugin gives it.
import {
  Badge,
  Button,
  Callout,
  Card,
  DataTable,
  Dialog,
  EmptyState,
  Select,
  Skeleton,
  TextField,
  ViewHeader,
  ViewLayout,
} from "@aiviarium/nocturne"
import type { ClientRookery, ViewHandle } from "@rookery/sdk/client"
import { createEffect, createResource, createSignal, For, type JSX, on, onMount, Show } from "solid-js"
import { ArgumentFields } from "./ArgumentField"
import type { FleetApi } from "./fleetApi"
import { errorMessage } from "./format"
import { argumentDefaults, argumentsOf } from "./provisionApi"
import { RunActionDialog } from "./RunAction"
import type { Action, ProvisionerInfo, ProvisionerState } from "./types"

interface Loaded {
  registered: ProvisionerInfo[]
  types: ProvisionerInfo[]
}

function isLoaded(value: Loaded | { error: string }): value is Loaded {
  return "registered" in value
}

export function ProvisionersPage(props: {
  view: ViewHandle
  rookery: ClientRookery
  api: FleetApi
}): JSX.Element {
  const [version, setVersion] = createSignal(0)
  const [list] = createResource(version, async (): Promise<Loaded | { error: string }> => {
    try {
      const [registered, types] = await Promise.all([
        props.api.provisioners.list(),
        props.api.provisioners.types(),
      ])
      return { registered, types }
    } catch (error) {
      return { error: errorMessage(error) }
    }
  })
  const loaded = () => {
    const value = list()
    return value && isLoaded(value) ? value : null
  }
  const [states, { refetch: refetchStates }] = createResource(
    () => (loaded()?.registered ?? []).map((one) => one.name || one.id),
    async (names) => {
      const found = new Map<string, ProvisionerState | string>()
      await Promise.all(
        names.map(async (name) => {
          try {
            found.set(name, await props.api.provisioners.get(name))
          } catch (error) {
            found.set(name, errorMessage(error))
          }
        }),
      )
      return found
    },
  )

  const [editing, setEditing] = createSignal<ProvisionerInfo | null>(null)
  const [registering, setRegistering] = createSignal(false)
  const [removing, setRemoving] = createSignal<ProvisionerInfo | null>(null)
  const [running, setRunning] = createSignal<{ provisioner: ProvisionerInfo; action: Action } | null>(null)
  const [busy, setBusy] = createSignal(false)
  const [notice, setNotice] = createSignal<string | null>(null)

  const registered = () => loaded()?.registered ?? []
  const types = () => loaded()?.types ?? []
  const loadError = () => {
    const value = list()
    return value && !isLoaded(value) ? value.error : null
  }

  const reload = () => {
    setVersion((n) => n + 1)
    void refetchStates()
  }

  const confirmRemove = async () => {
    const one = removing()
    if (!one || busy()) return
    setBusy(true)
    setNotice(null)
    try {
      await props.api.provisioners.remove(one.name || one.id)
      setRemoving(null)
      setNotice(`Removed ${one.name || one.id}`)
      reload()
    } catch (error) {
      props.rookery.workbench.toast({
        kind: "danger",
        title: `Could not remove ${one.name || one.id}`,
        body: errorMessage(error),
      })
    } finally {
      setBusy(false)
    }
  }

  onMount(() => props.view.setTitle("Provisioners"))

  const fleetHref = () => props.rookery.views.href("fleet.hosts") ?? "/fleet/hosts"

  return (
    <ViewLayout
      id="fleet.provisioners"
      header={
        <ViewHeader
          up
          noPin
          crumbs={[{ label: "Fleet", icon: "server", href: fleetHref() }, { label: "Provisioners" }]}
          actions={[
            { id: "refresh", label: "Refresh provisioners", icon: "refresh-cw", onClick: reload },
            {
              id: "register",
              label: "Register provisioner",
              icon: "plus",
              primary: true,
              disabled: types().length === 0,
              onClick: () => setRegistering(true),
            },
          ]}
        />
      }
    >
      <div class="fleet-page" data-part="fleet-provisioners">
        <Show when={notice()}>{(text) => <Callout tone="info">{text()}</Callout>}</Show>

        <Show when={loadError()}>
          {(error) => (
            <Callout
              tone="danger"
              data-part="provisioners-error"
              action={
                <Button size="sm" onClick={reload}>
                  Retry
                </Button>
              }
            >
              Could not list the provisioners: {error()}
            </Callout>
          )}
        </Show>

        <Show when={list.loading && !list()}>
          <Card title="Loading provisioners…">
            <Skeleton width="60%" />
            <Skeleton width="40%" />
          </Card>
        </Show>

        <Show when={!list.loading || list()}>
          <Card title="Registered" count={registered().length} data-part="provisioners-registered">
            <Show
              when={registered().length > 0}
              fallback={
                <EmptyState
                  icon="server"
                  title="No provisioner is registered"
                  description="A provisioner makes machines for hosts: an Incus virtual machine, a Docker container."
                >
                  <Button
                    variant="secondary"
                    icon="plus"
                    disabled={types().length === 0}
                    onClick={() => setRegistering(true)}
                  >
                    Register provisioner
                  </Button>
                </EmptyState>
              }
            >
              <For each={registered()}>
                {(provisioner) => {
                  const key = () => provisioner.name || provisioner.id
                  const found = () => {
                    const state = states()?.get(key())
                    return typeof state === "string" ? state : null
                  }
                  const state = () => {
                    const known = states()?.get(key())
                    return typeof known === "string" ? null : (known ?? null)
                  }
                  return (
                    <div class="fleet-provisioner-row" data-provisioner={key()}>
                      <div class="fleet-provisioner-row__info">
                        <span class="fleet-provisioner-row__name mono">{key()}</span>
                        <span class="fleet-provisioner-row__type label nc-muted">
                          {provisioner.type}
                          <Show when={provisioner.description}> · {provisioner.description}</Show>
                        </span>
                        <Show when={provisioner.problem}>
                          {(problem) => (
                            <span class="nc-meta" data-part="provisioner-problem">
                              {problem()}
                            </span>
                          )}
                        </Show>
                        <Show when={found()}>
                          {(error) => (
                            <span class="nc-meta" data-part="provisioner-unread">
                              {error()}
                            </span>
                          )}
                        </Show>
                      </div>
                      <Show when={state()}>{(known) => <ProvisionerStateBadge state={known()} />}</Show>
                      <div class="fleet-provisioner-row__actions">
                        <Button
                          size="sm"
                          variant="secondary"
                          onClick={() => setEditing(provisioner)}
                          data-part="edit-provisioner"
                        >
                          Settings and actions
                        </Button>
                        <Button
                          size="sm"
                          variant="ghost"
                          data-part="remove-provisioner"
                          onClick={() => setRemoving(provisioner)}
                        >
                          Remove
                        </Button>
                      </div>
                    </div>
                  )
                }}
              </For>
            </Show>
          </Card>

          <Card title="What the plugins offer" count={types().length} data-part="provisioners-types">
            <Show
              when={types().length > 0}
              fallback={<span class="nc-meta">No installed plugin brings a provisioner.</span>}
            >
              <DataTable
                label="Provisioner types"
                density="comfortable"
                rows={types()}
                getRowId={(type) => type.type || type.id}
                columns={[
                  {
                    id: "type",
                    header: "Type",
                    sortable: true,
                    accessor: (type) => type.type || type.id,
                    cell: (type) => <span class="mono">{type.type || type.id}</span>,
                  },
                  {
                    id: "label",
                    header: "What it makes",
                    sortable: true,
                    accessor: (type) => type.label,
                    cell: (type) => (
                      <span class="fleet-type-cell">
                        <span>{type.label}</span>
                        <Show when={type.description}>
                          <span class="nc-meta">{type.description}</span>
                        </Show>
                      </span>
                    ),
                  },
                  {
                    id: "setup",
                    header: "Setup",
                    width: "130px",
                    accessor: (type) => type.setup,
                    cell: (type) => (
                      <Badge square tone="outline">
                        {type.setup === "seed" ? "cloud seed" : "apply"}
                      </Badge>
                    ),
                  },
                ]}
              />
            </Show>
          </Card>
        </Show>

        <ProvisionerDialog
          open={registering() || editing() !== null}
          provisioner={editing()}
          types={types()}
          api={props.api}
          onClose={() => {
            setRegistering(false)
            setEditing(null)
          }}
          onSaved={(saved) => {
            setRegistering(false)
            setEditing(null)
            setNotice(`Saved ${saved.name || saved.id}`)
            reload()
          }}
          onRun={(provisioner, action) => {
            setEditing(null)
            setRunning({ provisioner, action })
          }}
        />

        <RunActionDialog
          open={running() !== null}
          action={running()?.action ?? null}
          run={(act) =>
            props.api.provisioners.act({
              name: running()!.provisioner.name || running()!.provisioner.id,
              action: act.action,
              arguments: act.arguments,
            })
          }
          onClose={() => setRunning(null)}
          onJob={(jobId) => props.rookery.workbench.openView("fleet.job", { params: { id: jobId } })}
          onResult={(text) =>
            props.rookery.workbench.toast({
              kind: "info",
              title: running()?.action.label ?? "It answered",
              body: text || "It answered.",
            })
          }
        />

        <Dialog
          open={removing() !== null}
          onClose={() => {
            if (!busy()) setRemoving(null)
          }}
          title={`Remove ${removing()?.name || removing()?.id || ""}?`}
          description="A provisioner that made nothing that is kept can be removed; the machines it made are untouched."
          footer={
            <>
              <Button variant="ghost" disabled={busy()} onClick={() => setRemoving(null)}>
                Cancel
              </Button>
              <Button
                variant="danger"
                disabled={busy()}
                data-part="confirm-remove-provisioner"
                onClick={() => void confirmRemove()}
              >
                {busy() ? "Removing…" : "Remove provisioner"}
              </Button>
            </>
          }
        >
          <Callout tone="warning">
            Remove <span class="mono">{removing()?.name || removing()?.id}</span> from Rookery. Its plugin
            stays installed.
          </Callout>
        </Dialog>
      </div>
    </ViewLayout>
  )
}

function ProvisionerStateBadge(props: { state: ProvisionerState }): JSX.Element {
  const tone = () => {
    switch (props.state.state) {
      case "ready":
        return "success" as const
      case "unreachable":
      case "unusable":
        return "warning" as const
      default:
        return "neutral" as const
    }
  }
  return (
    <span class="fleet-provisioner-row__state" title={props.state.message || undefined}>
      <Badge square tone={tone()}>
        {props.state.state}
      </Badge>
    </span>
  )
}

/** The own arguments a provisioner's settings are: the ones that say where it is, not what a machine is. */
function ownArguments(one: ProvisionerInfo | undefined) {
  if (!one) return []
  const own = one.own ?? []
  return (one.arguments ?? []).filter((argument) => own.includes(argument.name))
}

/**
 * Registering a provisioner, changing its settings, and its plugin's actions: the dialog opens on the one
 * given, or on a new one of the first type there is.
 */
function ProvisionerDialog(props: {
  open: boolean
  provisioner: ProvisionerInfo | null
  types: ProvisionerInfo[]
  api: FleetApi
  onClose: () => void
  onSaved: (saved: ProvisionerInfo) => void
  onRun: (provisioner: ProvisionerInfo, action: Action) => void
}): JSX.Element {
  const [type, setType] = createSignal("")
  const [name, setName] = createSignal("")
  const [settings, setSettings] = createSignal<Record<string, string>>({})
  const [actions, setActions] = createSignal<Action[]>([])
  const [error, setError] = createSignal<string | null>(null)
  const [busy, setBusy] = createSignal(false)

  const chosenType = () => props.types.find((known) => (known.type || known.id) === type())
  const fields = () => ownArguments(props.provisioner ?? chosenType())

  // Each opening starts from the provisioner given, or from a new one of the first type.
  createEffect(
    on(
      () =>
        props.open ? (props.provisioner ? props.provisioner.name || props.provisioner.id : "new") : null,
      (key) => {
        if (!key) return
        const one = props.provisioner
        if (one) {
          setType(one.type || one.id)
          setName(one.name || one.id)
          setSettings(argumentDefaults(ownArguments(one), one.settings ?? {}))
          setActions([])
          void props.api.provisioners
            .actions(one.name || one.id)
            .then(setActions)
            .catch(() => setActions([]))
        } else {
          const first = props.types[0]
          setType(first?.type || first?.id || "")
          setName("")
          setSettings(argumentDefaults(ownArguments(first)))
          setActions([])
        }
        setError(null)
      },
      { defer: true },
    ),
  )

  const chooseType = (value: string) => {
    setType(value)
    const found = props.types.find((known) => (known.type || known.id) === value)
    setSettings(argumentDefaults(ownArguments(found)))
    setError(null)
  }

  const save = async () => {
    if (busy()) return
    setError(null)
    const one = props.provisioner
    const chosen = chosenType()
    const saveName = (one?.name || one?.id || name()).trim()
    if (!saveName) {
      setError("A name is required.")
      return
    }
    if (!one && !chosen) {
      setError("Choose a type.")
      return
    }
    const missing = fields().filter(
      (argument) => argument.required && !(settings()[argument.name] ?? "").trim(),
    )
    if (missing.length > 0) {
      setError(`${missing.map((argument) => argument.label || argument.name).join(", ")} is required.`)
      return
    }
    setBusy(true)
    try {
      const saved = await props.api.provisioners.save({
        name: saveName,
        type: chosen?.type || chosen?.id || one?.type || "",
        settings: argumentsOf(fields(), settings()),
      })
      props.onSaved(saved)
    } catch (failure) {
      setError(errorMessage(failure))
    } finally {
      setBusy(false)
    }
  }

  return (
    <Dialog
      open={props.open}
      onClose={() => {
        if (!busy()) props.onClose()
      }}
      title={
        props.provisioner
          ? `Provisioner ${props.provisioner.name || props.provisioner.id}`
          : "Register provisioner"
      }
      description={
        props.provisioner
          ? "Its type stays; its own arguments, such as the server it uses, are its settings."
          : "A provisioner of a type an installed plugin brings, under a name of its own."
      }
      size="lg"
      closeOnBackdrop={false}
      footer={
        <>
          <Button variant="ghost" disabled={busy()} onClick={props.onClose}>
            Close
          </Button>
          <Button
            variant="primary"
            disabled={busy()}
            data-part="save-provisioner"
            onClick={() => void save()}
          >
            {busy() ? "Saving…" : props.provisioner ? "Save settings" : "Register"}
          </Button>
        </>
      }
    >
      <div class="fleet-form" data-part="provisioner-form">
        <Show when={props.provisioner}>
          <div class="fleet-form__row">
            <span class="label nc-muted">Type</span>
            <span class="mono" data-part="provisioner-type">
              {props.provisioner!.type}
            </span>
          </div>
        </Show>
        <Show when={!props.provisioner}>
          <Select
            label="Type"
            options={props.types.map((known) => ({
              value: known.type || known.id,
              label: known.label,
              description: known.type || known.id,
            }))}
            value={type() || undefined}
            onChange={chooseType}
          />
          <TextField
            id="provisioner-name"
            label="Name"
            placeholder="lab-incus"
            mono
            value={name()}
            help="The name it is registered under; its commands and machines use it."
            onInput={(e) => {
              setName(e.currentTarget.value)
              setError(null)
            }}
          />
        </Show>

        <Show
          when={fields().length > 0}
          fallback={<span class="nc-meta">This provisioner takes nothing of its own.</span>}
        >
          <span class="section">Its settings</span>
          <ArgumentFields
            arguments={fields()}
            values={settings()}
            idPrefix="provisioner-setting"
            onChange={(key, value) => {
              setSettings((prev) => ({ ...prev, [key]: value }))
              setError(null)
            }}
          />
        </Show>

        <Show when={error()}>
          {(text) => (
            <Callout tone="danger" data-part="provisioner-error">
              {text()}
            </Callout>
          )}
        </Show>

        <Show when={props.provisioner && actions().length > 0}>
          <span class="section">Its actions</span>
          <For each={actions()}>
            {(action) => (
              <div class="fleet-action-row" data-provisioner-action={action.name}>
                <div class="fleet-action-row__info">
                  <span class="fleet-action-row__label">{action.label}</span>
                  <span class="fleet-action-row__help label nc-muted">
                    {!action.available && action.why ? action.why : action.help}
                  </span>
                </div>
                <Button
                  size="sm"
                  variant={action.changes ? "secondary" : "ghost"}
                  disabled={!action.available || busy()}
                  onClick={() => props.onRun(props.provisioner!, action)}
                >
                  {action.label}
                </Button>
              </div>
            )}
          </For>
        </Show>
      </div>
    </Dialog>
  )
}
