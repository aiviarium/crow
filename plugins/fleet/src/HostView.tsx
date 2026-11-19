// Host detail view (`fleet.host`): state, type, profile summary, apply, host actions (returning
// jobs), recent host jobs, remove host, and the M3 parts: the desktop, port links, and sharing the host.
import {
  Badge,
  Button,
  Callout,
  Card,
  Dialog,
  EmptyState,
  ListRow,
  type PropertyItem,
  PropertyList,
  RowList,
  Skeleton,
  State,
  ViewHeader,
  ViewLayout,
} from "@aiviarium/nocturne"
import type { JobInfo } from "@rookery/client"
import type { ClientRookery, ViewHandle } from "@rookery/sdk/client"
import { createEffect, createMemo, createResource, createSignal, For, type JSX, on, Show } from "solid-js"
import { ActionDialog } from "./ActionDialog"
import { allows, type Who } from "./access"
import type { Action, HostCheckResult, HostInfo, HostProfile } from "./api"
import { envUri } from "./env"
import type { FleetStore } from "./FleetView"
import type { FleetApi } from "./fleetApi"
import {
  errorMessage,
  formatRelativeTime,
  hostStatus,
  hostTypeLabel,
  hostTypeTone,
  jobMatchesHost,
  jobStatus,
  jobSubtitle,
  jobTitle,
  profileFeatures,
  profileUserName,
} from "./format"
import { PortsCard } from "./Ports"
import { resourceState } from "./provisionApi"
import { RunActionDialog } from "./RunAction"
import { ShareDialog } from "./ShareDialog"
import type { Action as ResourceAction } from "./types"

export function HostView(props: {
  view: ViewHandle
  rookery: ClientRookery
  api: FleetApi
  store: FleetStore
}): JSX.Element {
  const hostName = () => props.view.params.name ?? props.view.path ?? ""

  const [host, setHost] = createSignal<HostInfo | null>(null)
  const [profile, setProfile] = createSignal<HostProfile | null>(null)
  const [actions, setActions] = createSignal<Action[]>([])
  const [applyCheck, setApplyCheck] = createSignal<HostCheckResult | null>(null)
  const [recentJobs, setRecentJobs] = createSignal<JobInfo[]>([])
  const [loading, setLoading] = createSignal(true)
  const [error, setError] = createSignal<string | null>(null)
  const [activeAction, setActiveAction] = createSignal<Action | null>(null)
  const [runningAction, setRunningAction] = createSignal<string | null>(null)
  const [removeOpen, setRemoveOpen] = createSignal(false)
  const [removing, setRemoving] = createSignal(false)
  const [shareOpen, setShareOpen] = createSignal(false)
  // The machine a provisioner made for this host: what it is, and what its provisioner can do to it.
  const [machineActions, setMachineActions] = createSignal<ResourceAction[]>([])
  const [machineAction, setMachineAction] = createSignal<ResourceAction | null>(null)
  const [destroyOpen, setDestroyOpen] = createSignal(false)
  const [destroying, setDestroying] = createSignal(false)
  // The host as an environment: its level, state and what it supports (`env.get`). Best effort: a server
  // without `env.*` still shows the M1 host page, without the M3 parts.
  const [env, { refetch: refetchEnv }] = createResource(
    () => (hostName() ? envUri(hostName()) : undefined),
    (uri) => props.api.env.get(uri).catch(() => undefined),
  )
  const who = (): Who => ({ level: env()?.level, admin: props.api.isAdmin() })
  // Who has terminals running on the host: `view` is enough, and it shows nobody's terminal.
  const [presence, { refetch: refetchPresence }] = createResource(
    () => (hostName() ? envUri(hostName()) : undefined),
    (uri) => props.api.env.presence(uri).catch(() => undefined),
  )
  const presenceText = () => {
    const p = presence()
    if (!p) return null
    if (!p.users.length) return "Nobody"
    return `${p.users.length} (${p.users.map((u) => u.name).join(", ")})`
  }

  const load = async (name: string) => {
    if (!name) return
    void refetchEnv()
    void refetchPresence()
    setLoading(true)
    setError(null)
    try {
      const [infoRes, profileRes, actionsRes, checkRes, jobsRes] = await Promise.allSettled([
        props.api.getHost(name),
        props.api.getProfile(name),
        props.api.listActions(name),
        props.api.checkCapability(name, "apply"),
        props.api.listJobs({ limit: 20 }),
      ])

      if (infoRes.status === "rejected") {
        throw infoRes.reason
      }
      setHost(infoRes.value)
      props.view.setTitle(infoRes.value.name)

      setProfile(profileRes.status === "fulfilled" ? profileRes.value : null)
      setActions(actionsRes.status === "fulfilled" ? actionsRes.value : [])
      setApplyCheck(checkRes.status === "fulfilled" ? checkRes.value : null)
      if (jobsRes.status === "fulfilled") {
        setRecentJobs(jobsRes.value.filter((j) => jobMatchesHost(j, name)).slice(0, 8))
      } else {
        setRecentJobs([])
      }
      const machine = infoRes.value.machine
      if (machine?.resource) {
        void props.api.resources
          .actions(machine.resource)
          .then(setMachineActions)
          .catch(() => setMachineActions([]))
      } else {
        setMachineActions([])
      }
    } catch (err) {
      setError(errorMessage(err))
      setHost(null)
    } finally {
      setLoading(false)
    }
  }

  createEffect(
    on(hostName, (name) => {
      if (name) {
        props.view.setTitle(name)
        void load(name)
      }
    }),
  )

  const openJob = (jobId: string) => {
    props.rookery.workbench.openView("fleet.job", { params: { id: jobId, host: hostName() } })
  }

  // M1 scope: hide interactive terminal actions (M3).
  const m1Actions = createMemo(() => actions().filter((a) => !a.terminal))

  const applyAction = createMemo(() => m1Actions().find((a) => a.name === "apply") ?? null)

  const groupedActions = createMemo(() => {
    const groups = new Map<string, Action[]>()
    for (const act of m1Actions()) {
      const key = act.group || "General"
      const list = groups.get(key)
      if (list) list.push(act)
      else groups.set(key, [act])
    }
    return Array.from(groups.entries())
  })

  const runAction = async (act: Action) => {
    if (act.arguments.length > 0 || act.confirm) {
      setActiveAction(act)
      return
    }
    if (runningAction()) return
    setRunningAction(act.name)
    try {
      const acted = await props.api.act({ host: hostName(), action: act.name })
      openJob(acted.job)
    } catch (err) {
      props.rookery.workbench.toast({
        kind: "danger",
        title: `${act.label} failed`,
        body: errorMessage(err),
      })
    } finally {
      setRunningAction(null)
    }
  }

  const runApply = async () => {
    const act = applyAction()
    if (act) {
      await runAction(act)
      return
    }
    if (runningAction()) return
    setRunningAction("apply")
    try {
      const acted = await props.api.act({ host: hostName(), action: "apply" })
      openJob(acted.job)
    } catch (err) {
      props.rookery.workbench.toast({
        kind: "danger",
        title: "Apply failed",
        body: errorMessage(err),
      })
    } finally {
      setRunningAction(null)
    }
  }

  const confirmRemove = async () => {
    if (removing()) return
    setRemoving(true)
    try {
      await props.api.removeHost(hostName())
      setRemoveOpen(false)
      void props.store.refresh()
      props.rookery.workbench.openView("fleet.hosts")
    } catch (err) {
      props.rookery.workbench.toast({
        kind: "danger",
        title: `Could not remove ${hostName()}`,
        body: errorMessage(err),
      })
    } finally {
      setRemoving(false)
    }
  }

  // Deleting the machine is its provisioner's job; the host's profile is what stays.
  const destroyMachine = async () => {
    const machine = host()?.machine
    if (!machine || destroying()) return
    setDestroying(true)
    try {
      const acted = await props.api.resources.remove(machine.resource)
      setDestroyOpen(false)
      void load(hostName())
      if (acted.job) openJob(acted.job)
    } catch (err) {
      props.rookery.workbench.toast({
        kind: "danger",
        title: `Could not delete the machine of ${hostName()}`,
        body: errorMessage(err),
      })
    } finally {
      setDestroying(false)
    }
  }

  const canApply = () => {
    const h = host()
    if (!h) return false
    const act = applyAction()
    if (act) return act.available
    const check = applyCheck()
    if (check) return check.allowed
    return h.type !== "ssh"
  }

  const statusProperties = createMemo<PropertyItem[]>(() => {
    const h = host()
    if (!h) return []
    const s = hostStatus(h)
    const items: PropertyItem[] = [
      { id: "state", label: "State", value: <State status={s.dot}>{s.label}</State> },
      {
        id: "type",
        label: "Type",
        value: (
          <span class="fleet-version-cell">
            <Badge square tone={hostTypeTone(h.type)}>
              {hostTypeLabel(h.type)}
            </Badge>
            <Show when={h.seen && h.seen !== h.type}>
              <span class="nc-meta">(seen as {hostTypeLabel(h.seen!)})</span>
            </Show>
          </span>
        ),
      },
      { id: "address", label: "Address", value: <span class="mono">{h.address}</span> },
      {
        id: "version",
        label: "Version",
        value: h.version ? <span class="mono">{h.version}</span> : null,
      },
      {
        id: "applied",
        label: "Applied",
        value: h.applied ? <span class="mono">{h.applied}</span> : null,
      },
      {
        id: "power",
        label: "Power",
        value: h.power?.state ?? "unknown",
      },
      { id: "presence", label: "On it now", value: presenceText() },
    ]
    return items
  })

  const profileProperties = createMemo<PropertyItem[]>(() => {
    const p = profile()
    if (!p) return []
    const access = p.access
    const features = profileFeatures(p)
    const operator = profileUserName(p.operator)
    const agent = profileUserName(p.agent)
    const items: PropertyItem[] = [
      {
        id: "ssh-address",
        label: "SSH target",
        value: access?.address ? (
          <span class="mono">
            {access.user ? `${access.user}@` : ""}
            {access.address}
            {access.port && access.port !== 22 ? `:${access.port}` : ""}
          </span>
        ) : null,
      },
      {
        id: "ssh-auth",
        label: "SSH auth",
        value: access?.auth ?? null,
      },
      {
        id: "operator",
        label: "Operator",
        value: operator ? <span class="mono">{operator}</span> : null,
      },
      {
        id: "agent",
        label: "Agent user",
        value: agent ? <span class="mono">{agent}</span> : null,
      },
      {
        id: "features",
        label: "Features",
        value:
          features.length > 0 ? (
            <span class="fleet-feature-chips">
              <For each={features}>{(f) => <Badge square>{f}</Badge>}</For>
            </span>
          ) : null,
      },
    ]
    return items
  })

  const fleetHref = () => props.rookery.views.href("fleet.hosts") ?? "/fleet/hosts"

  return (
    <ViewLayout
      id="fleet.host"
      header={
        <ViewHeader
          up
          noPin
          crumbs={[
            { label: "Fleet", icon: "server", href: fleetHref() },
            { label: host()?.name ?? hostName() },
          ]}
          context={
            <Show when={host()}>
              {(h) => <State status={hostStatus(h()).dot}>{hostStatus(h()).label}</State>}
            </Show>
          }
          actions={[
            {
              id: "refresh",
              label: "Refresh host",
              icon: "refresh-cw",
              onClick: () => void load(hostName()),
            },
            {
              id: "desktop",
              label: "Desktop",
              icon: "grid",
              disabled: !env()?.supports.desktop || !allows(who(), "view"),
              onClick: () => props.rookery.workbench.openView("fleet.desktop", { path: hostName() }),
            },
            {
              id: "share",
              label: "Share…",
              icon: "users",
              disabled: !allows(who(), "manage"),
              onClick: () => setShareOpen(true),
            },
            {
              id: "remove",
              label: "Remove host",
              icon: "trash",
              overflow: true,
              danger: true,
              disabled: !host(),
              onClick: () => setRemoveOpen(true),
            },
            {
              id: "apply",
              label: runningAction() === "apply" ? "Applying…" : "Apply",
              icon: "play",
              primary: true,
              disabled: !canApply() || runningAction() !== null,
              onClick: () => void runApply(),
            },
          ]}
        />
      }
    >
      <div class="fleet-page" data-part="fleet-host" data-host={hostName()}>
        <Show when={loading() && !host()}>
          <Card title="Loading host…">
            <Skeleton width="60%" />
            <Skeleton width="40%" />
          </Card>
        </Show>

        <Show when={!loading() && error()}>
          {(err) => (
            <Callout
              tone="danger"
              data-part="host-error"
              action={
                <Button size="sm" onClick={() => void load(hostName())}>
                  Retry
                </Button>
              }
            >
              Could not load host {hostName()}: {err()}
            </Callout>
          )}
        </Show>

        <Show when={host()}>
          {(h) => (
            <>
              <Show when={h().error}>
                {(err) => (
                  <Callout tone="danger" data-part="host-status-error">
                    {err()}
                  </Callout>
                )}
              </Show>

              <Show when={(h().behind?.changes?.length ?? 0) > 0}>
                <Callout
                  tone="warning"
                  data-part="host-behind"
                  action={
                    <Button
                      size="sm"
                      variant="primary"
                      disabled={!canApply() || runningAction() !== null}
                      onClick={() => void runApply()}
                    >
                      Apply changes
                    </Button>
                  }
                >
                  <div>
                    Configuration is behind by {h().behind!.changes.length}{" "}
                    {h().behind!.changes.length === 1 ? "change" : "changes"}.
                  </div>
                  <ul class="fleet-changes">
                    <For each={h().behind!.changes}>
                      {(change) => (
                        <li class="fleet-changes__item mono">
                          <span>{change.id}:</span>
                          <span>
                            {change.from || "∅"} → {change.to || "∅"}
                          </span>
                        </li>
                      )}
                    </For>
                  </ul>
                </Callout>
              </Show>

              <Show when={applyCheck() && !applyCheck()!.allowed && applyCheck()!.refusal}>
                {(refusal) => (
                  <Callout tone="info" data-part="host-capability-note">
                    {refusal().why} {refusal().raise}
                  </Callout>
                )}
              </Show>

              <div class="fleet-grid">
                <Card title="Overview" data-part="host-overview">
                  <PropertyList items={statusProperties()} />
                </Card>

                <Card title="Profile summary" data-part="host-profile">
                  <Show
                    when={profile()}
                    fallback={<span class="nc-meta">No profile details available.</span>}
                  >
                    <PropertyList items={profileProperties()} />
                  </Show>
                </Card>
              </div>

              <Show when={h().machine}>
                {(machine) => {
                  const state = () => resourceState(machine().state)
                  const started = () =>
                    machineActions().filter((act) => act.name === "start" || act.name === "stop")
                  return (
                    <Card title="Machine" data-part="host-machine">
                      <PropertyList
                        items={[
                          {
                            id: "machine-state",
                            label: "State",
                            value: <State status={state().dot}>{state().label}</State>,
                          },
                          {
                            id: "machine-provisioner",
                            label: "Provisioner",
                            value: <span class="mono">{machine().provisioner}</span>,
                          },
                          {
                            id: "machine-external",
                            label: "Its id there",
                            value: <span class="mono">{machine().external_id || "Not made yet"}</span>,
                          },
                        ]}
                      />
                      <div class="fleet-form__row">
                        <For each={started()}>
                          {(act) => (
                            <Button
                              size="sm"
                              variant={act.changes ? "secondary" : "ghost"}
                              disabled={!act.available || !machine().external_id}
                              title={!act.available ? act.why : undefined}
                              data-machine-action={act.name}
                              onClick={() => setMachineAction(act)}
                            >
                              {act.label}
                            </Button>
                          )}
                        </For>
                        <Button
                          size="sm"
                          variant="danger"
                          disabled={destroying()}
                          data-part="destroy-machine"
                          onClick={() => setDestroyOpen(true)}
                        >
                          Delete machine
                        </Button>
                      </div>
                    </Card>
                  )
                }}
              </Show>

              <Card title="Actions" count={m1Actions().length} data-part="host-actions">
                <Show
                  when={groupedActions().length > 0}
                  fallback={
                    <EmptyState
                      title="No actions available"
                      description="This host did not advertise any M1 actions."
                    />
                  }
                >
                  <div class="fleet-action-groups">
                    <For each={groupedActions()}>
                      {([group, list]) => (
                        <div class="fleet-action-group" data-action-group={group}>
                          <span class="section fleet-action-group__title">{group}</span>
                          <div class="fleet-action-list">
                            <For each={list}>
                              {(act) => (
                                <div class="fleet-action-row" data-host-action={act.name}>
                                  <div class="fleet-action-row__info">
                                    <span class="fleet-action-row__label">{act.label}</span>
                                    <span class="fleet-action-row__help label">
                                      {!act.available && act.why ? act.why : act.help}
                                    </span>
                                  </div>
                                  <Button
                                    size="sm"
                                    variant={act.name === "apply" ? "primary" : "secondary"}
                                    disabled={!act.available || runningAction() !== null}
                                    data-part="run-host-action"
                                    data-action-name={act.name}
                                    onClick={() => void runAction(act)}
                                  >
                                    {runningAction() === act.name ? "Starting…" : act.label}
                                  </Button>
                                </div>
                              )}
                            </For>
                          </div>
                        </div>
                      )}
                    </For>
                  </div>
                </Show>
              </Card>

              <Card title="Recent jobs" count={recentJobs().length} data-part="host-jobs">
                <Show
                  when={recentJobs().length > 0}
                  fallback={<span class="nc-meta">No recent jobs for {h().name}.</span>}
                >
                  <RowList variant="inset" label={`Recent jobs for ${h().name}`}>
                    <For each={recentJobs()}>
                      {(job) => {
                        const s = jobStatus(job.state)
                        return (
                          <ListRow
                            title={jobTitle(job)}
                            secondary={jobSubtitle(job)}
                            meta={formatRelativeTime(job.createdAt)}
                            leading={<State status={s.dot}>{s.label}</State>}
                            onClick={() => openJob(job.id)}
                          />
                        )
                      }}
                    </For>
                  </RowList>
                </Show>
              </Card>

              <Show when={env()}>
                <PortsCard host={hostName()} env={env()} who={who()} rookery={props.rookery} />
              </Show>
            </>
          )}
        </Show>

        <Show when={shareOpen()}>
          <ShareDialog host={hostName()} rookery={props.rookery} onClose={() => setShareOpen(false)} />
        </Show>

        <ActionDialog
          host={hostName()}
          action={activeAction()}
          api={props.api}
          onClose={() => setActiveAction(null)}
          onStarted={(jobId) => {
            setActiveAction(null)
            openJob(jobId)
          }}
        />

        <RunActionDialog
          open={machineAction() !== null}
          action={machineAction()}
          run={(act) =>
            act.action === "remove"
              ? props.api.resources.remove(host()?.machine?.resource ?? "")
              : props.api.resources.act({
                  id: host()?.machine?.resource ?? "",
                  action: act.action,
                  arguments: act.arguments,
                })
          }
          onClose={() => setMachineAction(null)}
          onJob={(jobId) => {
            openJob(jobId)
            void load(hostName())
          }}
          onResult={(text) =>
            props.rookery.workbench.toast({
              kind: "info",
              title: machineAction()?.label ?? "It answered",
              body: text || "It answered.",
            })
          }
        />

        <Dialog
          open={destroyOpen()}
          onClose={() => {
            if (!destroying()) setDestroyOpen(false)
          }}
          title={`Delete the machine of ${hostName()}?`}
          description="The provisioner destroys the machine and Rookery forgets it. The host's profile stays, and so does its node on a tailnet."
          footer={
            <>
              <Button variant="ghost" disabled={destroying()} onClick={() => setDestroyOpen(false)}>
                Cancel
              </Button>
              <Button
                variant="danger"
                disabled={destroying()}
                data-part="confirm-destroy-machine"
                onClick={() => void destroyMachine()}
              >
                {destroying() ? "Deleting…" : "Delete machine"}
              </Button>
            </>
          }
        >
          <Callout tone="warning">
            What is on <span class="mono">{hostName()}</span> is gone. Its profile is kept, so it can be made
            again.
          </Callout>
        </Dialog>

        <Dialog
          open={removeOpen()}
          onClose={() => {
            if (!removing()) setRemoveOpen(false)
          }}
          title={`Remove ${hostName()}?`}
          description="Removes the host record from Rookery. The machine itself is not destroyed."
          footer={
            <>
              <Button variant="ghost" disabled={removing()} onClick={() => setRemoveOpen(false)}>
                Cancel
              </Button>
              <Button
                variant="danger"
                disabled={removing()}
                data-part="confirm-remove-host"
                onClick={() => void confirmRemove()}
              >
                {removing() ? "Removing…" : "Remove host"}
              </Button>
            </>
          }
        >
          <Callout tone="warning">
            You can add <span class="mono">{hostName()}</span> back later with Add host.
          </Callout>
        </Dialog>
      </div>
    </ViewLayout>
  )
}
