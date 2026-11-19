// "New machine": pick one of the installation's provisioners, fill in the catalogue's profile fields and
// the provisioner's own, then save the host and ask the provisioner to make it. Making it is a job, and
// the caller follows it; the host page is where it lands when the job is done.
import {
  Badge,
  Button,
  Callout,
  Checkbox,
  Dialog,
  EmptyState,
  Select,
  Skeleton,
  TextField,
} from "@aiviarium/nocturne"
import { createMemo, createResource, createSignal, For, type JSX, onCleanup, Show } from "solid-js"
import { ArgumentFields } from "./ArgumentField"
import type { FleetApi } from "./fleetApi"
import { validateHostName } from "./format"
import { argumentDefaults, argumentProblems, argumentsOf, profileFor } from "./provisionApi"
import type { Catalogue, ProvisionerInfo } from "./types"

export interface NewMachineDialogProps {
  open: boolean
  api: FleetApi
  onClose: () => void
  /** The machine was made: follow `jobId`, then open the host. */
  onCreated: (result: { host: string; jobId: string }) => void
  /** Where to send someone who has no provisioner yet. */
  onOpenProvisioners?: () => void
  /** Where to send someone whose machine's job is worth following after it failed here. */
  onOpenJob?: (jobId: string) => void
}

function provisionerLabel(provisioner: ProvisionerInfo): string {
  return provisioner.name && provisioner.name !== provisioner.type
    ? `${provisioner.name} · ${provisioner.label}`
    : provisioner.label
}

/** The catalogue features a machine of `types` can install, grouped as the catalogue groups them. */
function featuresFor(
  catalogue: Catalogue,
  types: string[],
): Array<{ group: string; features: Catalogue["features"] }> {
  const fits = catalogue.features.filter(
    (feature) => feature.types.length === 0 || feature.types.some((type) => types.includes(type)),
  )
  const groups = new Map<string, Catalogue["features"]>()
  for (const feature of fits) {
    const group = feature.group || "Features"
    const list = groups.get(group)
    if (list) list.push(feature)
    else groups.set(group, [feature])
  }
  return Array.from(groups.entries()).map(([group, features]) => ({ group, features }))
}

export function NewMachineDialog(props: NewMachineDialogProps): JSX.Element {
  const [name, setName] = createSignal("")
  const [chosen, setChosen] = createSignal("")
  const [values, setValues] = createSignal<Record<string, string>>({})
  const [features, setFeatures] = createSignal<string[]>([])
  const [touched, setTouched] = createSignal(false)
  const [submitError, setSubmitError] = createSignal<string | null>(null)
  const [busy, setBusy] = createSignal(false)
  const [creating, setCreating] = createSignal<{ host: string; jobId: string } | null>(null)
  const [lines, setLines] = createSignal<string[]>([])
  const [failedJob, setFailedJob] = createSignal<string | null>(null)
  let stream: { close(): void } | null = null
  onCleanup(() => stream?.close())

  const [catalogue] = createResource(
    () => props.open,
    async (open) => {
      if (!open) return null
      const [cat, provisioners] = await Promise.all([
        props.api.setup.catalogue().catch(() => null),
        props.api.provisioners
          .list()
          .catch((error: unknown) => (error instanceof Error ? error : new Error(String(error)))),
      ])
      return { catalogue: cat, provisioners } as
        | { catalogue: Catalogue | null; provisioners: ProvisionerInfo[] }
        | { catalogue: Catalogue | null; provisioners: Error }
    },
  )

  const catalogueOf = () => (catalogue() && "catalogue" in catalogue()! ? catalogue()!.catalogue : null)
  const provisioners = () => {
    const loaded = catalogue()
    if (!loaded) return []
    return Array.isArray(loaded.provisioners) ? loaded.provisioners : []
  }
  const provisionersError = () => {
    const loaded = catalogue()
    return loaded && !Array.isArray(loaded.provisioners) ? (loaded.provisioners as Error).message : null
  }

  const provisioner = createMemo(
    () => provisioners().find((known) => (known.name || known.id) === chosen()) ?? null,
  )

  const choose = (key: string) => {
    setChosen(key)
    const found = provisioners().find((known) => (known.name || known.id) === key)
    setValues(found ? argumentDefaults(found.arguments, found.settings ?? {}) : {})
    setSubmitError(null)
  }

  const machineFeatures = createMemo(() => {
    const cat = catalogueOf()
    return cat ? featuresFor(cat, ["workstation"]) : []
  })

  const nameError = () => (touched() ? validateHostName(name()) : null)
  const problems = createMemo(() =>
    provisioner() ? argumentProblems(provisioner()!.arguments, values()) : {},
  )
  const blocked = () => {
    const found = provisioner()
    if (!found) return "Choose a provisioner"
    if (found.problem) return found.problem
    if ((found.missing_secrets ?? []).length > 0) {
      return `Needs the secret${found.missing_secrets!.length === 1 ? "" : "s"} ${found.missing_secrets!.join(", ")}`
    }
    return null
  }

  const reset = () => {
    stream?.close()
    stream = null
    setName("")
    setChosen("")
    setValues({})
    setFeatures([])
    setTouched(false)
    setSubmitError(null)
    setCreating(null)
    setLines([])
    setFailedJob(null)
  }

  const close = () => {
    if (busy()) return
    reset()
    props.onClose()
  }

  /** Follows the `create` job until it ends: the host is where it landed, or the job says why not. */
  const follow = async (host: string, jobId: string) => {
    setCreating({ host, jobId })
    try {
      stream = await props.api.followJob(jobId, {
        onItem: (item) => setLines((prev) => [...prev.slice(-40), item.text]),
        onDone: (end) => {
          stream = null
          if (end.state === "succeeded") {
            setBusy(false)
            reset()
            props.onCreated({ host, jobId })
            return
          }
          setBusy(false)
          setFailedJob(jobId)
          setSubmitError(
            end.error?.message
              ? `The machine was not made: ${end.error.message}`
              : `The machine was not made: the job ${end.state}.`,
          )
        },
        onError: (failure) => {
          stream = null
          setBusy(false)
          setFailedJob(jobId)
          setSubmitError(`The job's output stopped: ${failure.message}`)
        },
      })
    } catch (failure) {
      setBusy(false)
      setFailedJob(jobId)
      setSubmitError(
        failure instanceof Error ? `Could not follow the job: ${failure.message}` : String(failure),
      )
    }
  }

  const submit = async () => {
    if (busy()) return
    setTouched(true)
    setSubmitError(null)
    const found = provisioner()
    const cat = catalogueOf()
    if (!found || !cat) return
    if (nameError() || Object.keys(problems()).length > 0 || blocked()) return
    const host = name().trim()
    setBusy(true)
    setLines([])
    setFailedJob(null)
    try {
      // The machine is made for a saved host: its profile is what the machine is set up as.
      await props.api.saveHost(host, profileFor(host, cat.template, features()))
      const created = await props.api.resources.create({
        provisioner: found.name || found.id,
        kind: "machine",
        name: host,
        host,
        arguments: argumentsOf(found.arguments, values()),
      })
      await follow(host, created.job.id)
    } catch (error) {
      setBusy(false)
      setSubmitError(error instanceof Error ? error.message : String(error))
    }
  }

  return (
    <Dialog
      open={props.open}
      onClose={close}
      title="New machine"
      description="A provisioner makes the machine, and Rookery saves the host whose profile it is set up as."
      size="lg"
      closeOnBackdrop={false}
      footer={
        <>
          <Button variant="ghost" disabled={busy()} onClick={close}>
            Cancel
          </Button>
          <Show when={failedJob()}>
            {(jobId) => (
              <Button
                variant="secondary"
                data-part="new-machine-open-job"
                onClick={() => {
                  const id = jobId()
                  reset()
                  props.onClose()
                  props.onOpenJob?.(id)
                }}
              >
                Open the job
              </Button>
            )}
          </Show>
          <Button
            variant="primary"
            disabled={busy() || !!blocked()}
            data-part="new-machine-submit"
            onClick={() => void submit()}
          >
            {busy() ? "Creating…" : "Create machine"}
          </Button>
        </>
      }
    >
      <div class="fleet-form" data-part="new-machine-form">
        <Show when={creating()}>
          {(progress) => (
            <div class="fleet-progress" data-part="new-machine-progress">
              <Callout tone="info">
                Making <span class="mono">{progress().host}</span> with the provisioner, as the job{" "}
                <span class="mono">{progress().jobId}</span>. It lands on the host when the job ends.
              </Callout>
              <pre class="fleet-pre mono" data-part="new-machine-log">
                {lines().join("\n") || "Waiting for the first line…"}
              </pre>
            </div>
          )}
        </Show>

        <Show when={catalogue.loading && !catalogue()}>
          <Skeleton width="80%" />
          <Skeleton width="60%" />
        </Show>

        <Show when={provisionersError()}>
          {(error) => (
            <Callout tone="danger" data-part="new-machine-error">
              Could not list the provisioners: {error()}
            </Callout>
          )}
        </Show>

        <Show when={catalogue() && !catalogue.loading}>
          <Show
            when={provisioners().length > 0}
            fallback={
              <EmptyState
                icon="server"
                title="No provisioner is registered"
                description="Register one on the Provisioners page, then come back to make a machine with it."
              >
                <Button
                  variant="secondary"
                  onClick={() => {
                    close()
                    props.onOpenProvisioners?.()
                  }}
                >
                  Open Provisioners
                </Button>
              </EmptyState>
            }
          >
            <TextField
              id="new-machine-name"
              label="Host name"
              placeholder="build-02"
              mono
              value={name()}
              error={nameError() ?? undefined}
              help="Lowercase letters, digits, and hyphens. The machine takes this name too."
              onInput={(e) => {
                setName(e.currentTarget.value)
                setSubmitError(null)
              }}
            />

            <Select
              label="Provisioner"
              options={provisioners().map((known) => ({
                value: known.name || known.id,
                label: provisionerLabel(known),
                description: known.description || known.type,
              }))}
              value={chosen() || undefined}
              placeholder="Choose a provisioner"
              onChange={choose}
            />

            <Show when={provisioner()}>
              {(found) => (
                <>
                  <Show when={found().problem}>
                    {(problem) => (
                      <Callout tone="warning" data-part="new-machine-problem">
                        {problem()}
                      </Callout>
                    )}
                  </Show>
                  <Show when={(found().missing_secrets ?? []).length > 0}>
                    <Callout tone="warning" data-part="new-machine-secrets">
                      It needs the secret{(found().missing_secrets ?? []).length === 1 ? "" : "s"}{" "}
                      <span class="mono">{(found().missing_secrets ?? []).join(", ")}</span>. Set{" "}
                      {(found().missing_secrets ?? []).length === 1 ? "it" : "them"} in Admin, then come back.
                    </Callout>
                  </Show>

                  <div class="fleet-form__row">
                    <span class="label nc-muted">Setup</span>
                    <Badge square tone="outline">
                      {found().setup === "seed" ? "Cloud seed" : "Apply over SSH"}
                    </Badge>
                    <span class="label nc-muted">Type</span>
                    <span class="mono">{found().type}</span>
                  </div>

                  <Show when={found().arguments.length > 0}>
                    <span class="section">Its fields</span>
                    <ArgumentFields
                      arguments={found().arguments}
                      values={values()}
                      errors={touched() ? problems() : {}}
                      idPrefix="new-machine-argument"
                      onChange={(key, value) => {
                        setValues((prev) => ({ ...prev, [key]: value }))
                        setSubmitError(null)
                      }}
                    />
                  </Show>
                </>
              )}
            </Show>

            <Show when={machineFeatures().length > 0}>
              <span class="section">Features to install</span>
              <For each={machineFeatures()}>
                {(group) => (
                  <div class="fleet-form__group" data-feature-group={group.group}>
                    <span class="label nc-muted">{group.group}</span>
                    <For each={group.features}>
                      {(feature) => (
                        <div class="fleet-feature-row">
                          <Checkbox
                            checked={features().includes(feature.key)}
                            label={feature.label}
                            data-feature={feature.key}
                            onChange={(on) =>
                              setFeatures((prev) =>
                                on ? [...prev, feature.key] : prev.filter((key) => key !== feature.key),
                              )
                            }
                          />
                          <Show when={feature.help}>
                            <span class="nc-meta">{feature.help}</span>
                          </Show>
                        </div>
                      )}
                    </For>
                  </div>
                )}
              </For>
            </Show>
          </Show>
        </Show>

        <Show when={submitError()}>
          {(error) => (
            <Callout tone="danger" data-part="new-machine-submit-error">
              {error()}
            </Callout>
          )}
        </Show>
      </div>
    </Dialog>
  )
}
