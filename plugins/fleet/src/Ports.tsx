// Port links: a port on a host's loopback, through the server's proxy at `/env/<name>/port/<n>/`. The
// card on the host's page keeps the ports a person opened there (in localStorage: a link is theirs), and
// `fleet.port` shows one in a frame of its own. Ported from the prototype's workbench preview pane.
import { Button, Callout, Card, EmptyState, IconButton, TextField, ViewHeader } from "@aiviarium/nocturne"
import type { EnvInfo } from "@rookery/client"
import type { ClientRookery, ViewHandle } from "@rookery/sdk/client"
import { createResource, createSignal, For, type JSX, Show } from "solid-js"
import { allows, type Who } from "./access"
import { envName, type FleetEnvApi, portUrl } from "./env"

export interface PortLink {
  port: number
  /** What runs there, such as "dev server". */
  label?: string
}

const KEY = "crow.fleet.ports.v1"

type Saved = Record<string, PortLink[]>

function load(): Saved {
  try {
    const s = JSON.parse(localStorage.getItem(KEY) ?? "null")
    if (s && typeof s === "object") return s as Saved
  } catch {}
  return {}
}

const [saved, setSaved] = createSignal<Saved>(load())

function save(next: Saved) {
  setSaved(next)
  try {
    localStorage.setItem(KEY, JSON.stringify(next))
  } catch {}
}

export function savedPorts(host: string): PortLink[] {
  return saved()[envName(host)] ?? []
}

export function rememberPort(host: string, link: PortLink) {
  const name = envName(host)
  const list = savedPorts(name).filter((p) => p.port !== link.port)
  save({ ...saved(), [name]: [...list, link] })
}

export function forgetPort(host: string, port: number) {
  const name = envName(host)
  const list = savedPorts(name).filter((p) => p.port !== port)
  const next = { ...saved() }
  if (list.length) next[name] = list
  else delete next[name]
  save(next)
}

/** The port from a path such as `studio/5173`, as a number, or null. */
export function portFromPath(part: string | undefined): number | null {
  if (!part) return null
  const n = Number(part.split("/").filter(Boolean).at(-1))
  return Number.isInteger(n) && n > 0 && n < 65536 ? n : null
}

/** The ports a person opened on a host, and the form that adds one. */
export function PortsCard(props: {
  host: string
  env: EnvInfo | undefined
  who: Who
  rookery: ClientRookery
}): JSX.Element {
  const name = () => envName(props.host)
  const [port, setPort] = createSignal("")
  const [label, setLabel] = createSignal("")
  const allowed = () => allows(props.who, "use")
  const links = () => savedPorts(name())
  const add = (e?: Event) => {
    e?.preventDefault()
    const n = Number(port())
    if (!Number.isInteger(n) || n <= 0 || n >= 65536) return
    rememberPort(name(), { port: n, ...(label().trim() ? { label: label().trim() } : {}) })
    setPort("")
    setLabel("")
  }
  return (
    <Card title="Ports" count={links().length} data-part="host-ports">
      <Show
        when={allowed()}
        fallback={
          <Callout tone="info" data-part="ports-need-use">
            403 · Reaching a port on {name()} needs use; you have {props.who.level ?? "no access"}.
          </Callout>
        }
      >
        <Show
          when={props.env?.supports.connect}
          fallback={
            <EmptyState
              icon="link"
              title="This host does not proxy ports"
              description="Its type has no port proxy."
            />
          }
        >
          <form class="fleet-ports__form" onSubmit={add}>
            <TextField
              label="Port"
              mono
              placeholder="5173"
              value={port()}
              onInput={(e) => setPort(e.currentTarget.value)}
            />
            <TextField
              label="What runs there"
              placeholder="dev server"
              value={label()}
              onInput={(e) => setLabel(e.currentTarget.value)}
            />
            <Button type="submit" size="sm" variant="secondary" icon="plus" disabled={!port()}>
              Add
            </Button>
          </form>
          <Show
            when={links().length}
            fallback={<span class="nc-meta">No ports saved for {name()} yet.</span>}
          >
            <ul class="fleet-ports" data-part="port-links">
              <For each={links()}>
                {(link) => (
                  <li class="fleet-ports__row" data-port={link.port}>
                    <a
                      class="fleet-ports__link mono"
                      href={portUrl(name(), link.port)}
                      target="_blank"
                      rel="noopener"
                      title={portUrl(name(), link.port)}
                    >
                      {link.port}
                    </a>
                    <span class="body fleet-ports__label">{link.label ?? ""}</span>
                    <Button
                      size="sm"
                      variant="secondary"
                      icon="eye"
                      onClick={() =>
                        props.rookery.workbench.openView("fleet.port", { path: `${name()}/${link.port}` })
                      }
                    >
                      Show here
                    </Button>
                    <IconButton
                      label={`Remove port ${link.port}`}
                      icon="close"
                      onClick={() => forgetPort(name(), link.port)}
                    />
                  </li>
                )}
              </For>
            </ul>
          </Show>
        </Show>
      </Show>
    </Card>
  )
}

/** `fleet.port`: one port on a host, in a frame, with the address bar to change it. */
export function PortPage(props: {
  view: ViewHandle
  rookery: ClientRookery
  envs: FleetEnvApi
  /** A Rookery admin holds manage everywhere. */
  admin: boolean
  host?: string
  port?: string
}): JSX.Element {
  const host = () => envName(props.host ?? props.view.path.split("/")[0] ?? "")
  const [port, setPort] = createSignal<number | null>(
    portFromPath(props.port ?? props.view.params.port ?? props.view.path),
  )
  const [draft, setDraft] = createSignal(port() ? String(port()) : "")
  const [nonce, setNonce] = createSignal(0)
  const [env] = createResource(() => props.envs.get(`env://${host()}`).catch(() => undefined))
  const who = (): Who => ({ level: env()?.level, admin: props.admin })
  props.view.setTitle(port() ? `Port ${port()} on ${host()}` : `Ports on ${host()}`)
  const url = () => (port() ? portUrl(host(), port()!) : null)
  const go = (e?: Event) => {
    e?.preventDefault()
    const n = Number(draft())
    if (!Number.isInteger(n) || n <= 0 || n >= 65536) return
    setPort(n)
    rememberPort(host(), { port: n })
  }
  return (
    <div class="fleet fleet-port-page" data-part="port-page" data-port={port() ?? undefined}>
      <ViewHeader
        up
        crumbs={[
          { label: "Fleet", icon: "server", href: props.rookery.views.href("fleet.hosts") ?? "/hosts" },
          { label: host() },
        ]}
        actions={[
          {
            id: "host",
            label: "The host's page",
            icon: "server",
            onClick: () => props.rookery.workbench.openView("fleet.host", { path: host() }),
          },
        ]}
      />
      <Show when={env() && !allows(who(), "use")}>
        <Callout tone="info" data-part="port-needs-use">
          403 · Reaching a port on {host()} needs use; you have {who().level ?? "no access"}.
        </Callout>
      </Show>
      <form class="fleet-port-page__bar" onSubmit={go}>
        <TextField
          aria-label="Port"
          mono
          placeholder="Port, e.g. 5173"
          value={draft()}
          onInput={(e) => setDraft(e.currentTarget.value)}
        />
        <Button type="submit" size="sm">
          Show
        </Button>
        <Show when={url()}>
          {(u) => (
            <>
              <IconButton label="Reload" icon="activity" onClick={() => setNonce(nonce() + 1)} />
              <Button size="sm" variant="secondary" href={u()}>
                Open in a new tab
              </Button>
            </>
          )}
        </Show>
      </form>
      <Show
        when={url()}
        fallback={
          <EmptyState
            icon="link"
            title="A port on the host"
            description={`A dev server on ${host()}, through the server's proxy at /env/${host()}/port/<n>/.`}
          />
        }
      >
        {(u) => (
          <Show when={{ src: u(), reload: nonce() }} keyed>
            {(frame) => (
              <iframe
                class="fleet-port-page__frame"
                title={`Port ${port()} on ${host()}`}
                src={frame.src}
                data-part="port-frame"
              />
            )}
          </Show>
        )}
      </Show>
    </div>
  )
}
