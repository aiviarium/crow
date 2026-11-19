// A host's desktop in a view of its own (`fleet.desktop`), full size in a frame. Ported from the
// prototype's `plugins/fleet/views/desktop.tsx`: the same gates, on Rookery's `env.get` and levels.
import { Button, Callout, Card, EmptyState, Skeleton, ViewHeader } from "@aiviarium/nocturne"
import type { EnvInfo } from "@rookery/client"
import type { ClientRookery, ViewHandle } from "@rookery/sdk/client"
import { createResource, createSignal, type JSX, Show } from "solid-js"
import { allows, type Who } from "./access"
import { DesktopView } from "./DesktopView"
import { envName, envUri, type FleetEnvApi } from "./env"

/** The desktop's gates, in the order that says the most: it exists, it has a desktop, you may use it. */
export function DesktopBody(props: {
  name: string
  env: EnvInfo | undefined
  who: Who
  loading?: boolean
  error?: string
  scale?: boolean
  onStateChange?: (state: string, detail?: string) => void
}): JSX.Element {
  const name = () => envName(props.name)
  return (
    <div class="fleet-desktop__body" data-part="desktop-body" data-state={props.env?.state}>
      <Show when={!props.loading} fallback={<Skeleton height="320px" />}>
        <Show
          when={props.env}
          fallback={
            <EmptyState
              icon="server"
              title={`${name()} is not available`}
              description={props.error ?? "It does not exist, or it is not shared with you."}
            />
          }
        >
          {(env) => (
            <Show
              when={env().supports.desktop}
              fallback={
                <EmptyState
                  icon="grid"
                  title="This host has no desktop"
                  description="Its profile installs none."
                />
              }
            >
              <Show
                when={allows(props.who, "use")}
                fallback={
                  <Callout tone="info" data-part="desktop-needs-use">
                    403 · The live desktop needs use on {name()}; you have {props.who.level ?? "no access"}.
                    Ask its owner to share it with you.
                  </Callout>
                }
              >
                <Show
                  when={env().state === "online"}
                  fallback={
                    <Callout tone="danger" data-part="desktop-offline">
                      503 · {name()} is unreachable, so its desktop is too. It shows again when the host is
                      back.
                    </Callout>
                  }
                >
                  <DesktopView
                    env={name()}
                    scale={props.scale}
                    class="fleet-desktop__view"
                    onStateChange={props.onStateChange}
                  />
                </Show>
              </Show>
            </Show>
          )}
        </Show>
      </Show>
    </div>
  )
}

export function DesktopPage(props: {
  view: ViewHandle
  rookery: ClientRookery
  envs: FleetEnvApi
  /** A Rookery admin holds manage everywhere. */
  admin: boolean
  /** The host from the view's path: `env://NAME` or `NAME`. */
  host?: string
}): JSX.Element {
  const name = () => envName(props.host ?? props.view.path)
  props.view.setTitle(`Desktop of ${name()}`)
  // Best effort: a server without `env.*` still opens the page and says the host is not available.
  const [envs, { refetch }] = createResource<EnvInfo | undefined>(() =>
    props.envs.get(envUri(name())).catch(() => undefined),
  )
  const who = (): Who => ({ level: envs()?.level, admin: props.admin })
  const [state, setState] = createSignal<string>("connecting")
  const fleetHref = () => props.rookery.views.href("fleet.host", { path: name() }) ?? `/hosts/${name()}`
  return (
    <div class="fleet fleet-desktop-page" data-part="desktop-page">
      <ViewHeader
        up
        crumbs={[
          { label: "Fleet", icon: "server", href: props.rookery.views.href("fleet.hosts") ?? "/hosts" },
          { label: name() },
        ]}
        context={
          <span class="nc-meta" data-part="desktop-state">
            {state()}
          </span>
        }
        actions={[
          {
            id: "host",
            label: "Host",
            icon: "server",
            onClick: () => props.rookery.workbench.openView("fleet.host", { path: name() }),
          },
          {
            id: "refresh",
            label: "Reconnect",
            icon: "refresh-cw",
            onClick: () => void refetch(),
          },
        ]}
      />
      <Show when={envs.error}>
        <Callout tone="danger" data-part="desktop-error">
          Could not ask about {name()}: {String((envs.error as Error)?.message ?? envs.error)}
        </Callout>
      </Show>
      <Card class="fleet-desktop-page__frame">
        <DesktopBody
          name={name()}
          env={envs()}
          who={who()}
          loading={envs.loading && !envs()}
          onStateChange={(s) => setState(s)}
        />
      </Card>
      <div class="fleet-desktop-page__links">
        <Button size="sm" variant="secondary" icon="server" href={fleetHref()}>
          The host's page
        </Button>
      </div>
    </div>
  )
}
