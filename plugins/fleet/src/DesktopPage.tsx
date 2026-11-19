// A host's desktop in a view of its own (`fleet.desktop`), full size in a frame. Ported from the
// prototype's `plugins/fleet/views/desktop.tsx`: the same gates, on Rookery's `env.get` and levels.
//
// The desktop is a picture below `use` and live from `use` up (rookery#42's levels): `view` gets
// `hosts.desktop.screenshot`, a PNG of the screen as it is, and the live WebSocket at
// `/env/NAME/desktop` refuses the upgrade without `use`.
import { Button, Callout, Card, EmptyState, Skeleton, ViewHeader } from "@aiviarium/nocturne"
import type { ClientRookery, ViewHandle } from "@rookery/sdk/client"
import { createResource, createSignal, type JSX, Show } from "solid-js"
import { allows, type Who } from "./access"
import type { HostsDesktopScreenshotResult } from "./api"
import { DesktopView } from "./DesktopView"
import { envName, type FleetEnvApi } from "./env"
import type { EnvInfo } from "./types"

/** One picture of a host's desktop: the base64 PNG and its type, as `hosts.desktop.screenshot` answers. */
export interface DesktopPicture {
  base64: string
  content_type: string
}

/** The desktop's gates, in the order that says the most: it exists, it has a desktop, how far you see it. */
export function DesktopBody(props: {
  name: string
  env: EnvInfo | undefined
  who: Who
  loading?: boolean
  error?: string
  /** The picture a `view` holder is shown in place of the live desktop. */
  picture?: DesktopPicture | null
  pictureLoading?: boolean
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
                  <Show when={!props.pictureLoading} fallback={<Skeleton height="320px" />}>
                    <Show
                      when={props.picture}
                      fallback={
                        <Callout tone="info" data-part="desktop-needs-use">
                          403 · The live desktop needs use on {name()}; you have{" "}
                          {props.who.level ?? "no access"}. Ask its owner to share it with you.
                        </Callout>
                      }
                    >
                      {(picture) => (
                        <>
                          <img
                            class="fleet-desktop__picture"
                            data-part="desktop-picture"
                            alt={`The desktop of ${name()}`}
                            src={`data:${picture().content_type};base64,${picture().base64}`}
                          />
                          <span class="nc-meta" data-part="desktop-picture-note">
                            A picture of the desktop. Watching it live needs use on {name()}; you have{" "}
                            {props.who.level ?? "no access"}.
                          </span>
                        </>
                      )}
                    </Show>
                  </Show>
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
  /** `hosts.desktop.screenshot`, for the picture a `view` holder sees. */
  screenshot?: (host: string) => Promise<HostsDesktopScreenshotResult>
}): JSX.Element {
  const name = () => envName(props.host ?? props.view.path)
  props.view.setTitle(`Desktop of ${name()}`)
  // Best effort: a server without `env.*` still opens the page and says the host is not available.
  const [envs, { refetch }] = createResource<EnvInfo | undefined>(() =>
    props.envs.get(name()).catch(() => undefined),
  )
  const who = (): Who => ({ level: envs()?.level, admin: props.admin })
  const [state, setState] = createSignal<string>("connecting")
  const fleetHref = () => props.rookery.views.href("fleet.host", { path: name() }) ?? `/hosts/${name()}`
  // Of a desktop, `view` sees the picture, so it is asked for once there is a desktop the caller may not
  // use. Its refusal leaves the 403 sentence, which is what a host with no picture to take says.
  const [picture, { refetch: refetchPicture }] = createResource<DesktopPicture | undefined, [string, string]>(
    () =>
      envs()?.supports.desktop && !allows(who(), "use")
        ? ([name(), "picture"] as [string, string])
        : undefined,
    ([host]) => props.screenshot?.(host).catch(() => undefined),
  )
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
            onClick: () => {
              void refetch()
              void refetchPicture()
            },
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
          picture={picture()}
          pictureLoading={picture.loading && !picture()}
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
