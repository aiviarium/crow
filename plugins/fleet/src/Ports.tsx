// Port links: a port on a host's loopback, reached through Rookery at `/env/<name>/port/<n>/`, which
// mints a one-use ticket and redirects to the port's own origin. The card on the host's page keeps the
// ports a person opened there (in localStorage: a link is theirs), and `fleet.port` opens one at the top
// level in a tab of its own. Its cookie is SameSite=Lax, so it is a navigation, never an iframe.
import { Button, Callout, Card, EmptyState, IconButton, TextField, ViewHeader } from "@aiviarium/nocturne"
import type { ClientRookery, ViewHandle } from "@rookery/sdk/client"
import { createEffect, createResource, createSignal, For, type JSX, Show } from "solid-js"
import { allows, type Who } from "./access"
import { envName, type FleetEnvApi, portPath } from "./env"
import type { EnvInfo } from "./types"

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
  /** Opens the port at the top level: its cookie is SameSite=Lax and an iframe would not send it. */
  const open = async (port: number) => {
    const href = await props.rookery.env
      .portUrl(name(), port)
      .then((one: { url: string }) => one.url)
      .catch(() => portPath(name(), port))
    window.open(href, "_blank", "noopener,noreferrer")
  }
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
                      href={portPath(name(), link.port)}
                      target="_blank"
                      rel="noopener"
                      title={portPath(name(), link.port)}
                    >
                      {link.port}
                    </a>
                    <span class="body fleet-ports__label">{link.label ?? ""}</span>
                    <Button
                      size="sm"
                      variant="secondary"
                      icon="arrow-up-right"
                      onClick={() => void open(link.port)}
                    >
                      Open
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
  const [opened, setOpened] = createSignal<string | null>(null)
  const [env] = createResource(() => props.envs.get(host()).catch(() => undefined))
  const who = (): Who => ({ level: env()?.level, admin: props.admin })
  props.view.setTitle(port() ? `Port ${port()} on ${host()}` : `Ports on ${host()}`)
  // The tab goes to `env.portUrl`'s one-use address on the ports' own origin. A server without it, or
  // a refusal, falls back to Rookery's own `/env/<name>/port/<n>/`, which mints the ticket itself.
  const [address] = createResource(
    () => (port() && allows(who(), "use") ? ([host(), port()!] as const) : null),
    ([h, p]) =>
      props.envs
        .portUrl(h, p)
        .then((u) => u.url)
        .catch(() => portPath(h, p)),
  )
  const open = (url: string | undefined) => {
    if (!url) return
    window.open(url, "_blank", "noopener,noreferrer")
  }
  // A top-level tab, once per address: the port's cookie is SameSite=Lax, so an iframe would not work.
  createEffect(() => {
    const url = address()
    const key = `${port()}:${url}`
    if (url && port() && opened() !== key) {
      setOpened(key)
      open(url)
    }
  })
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
        <Show when={port() && allows(who(), "use")}>
          <Button
            size="sm"
            variant="secondary"
            icon="arrow-up-right"
            data-part="open-port"
            onClick={() => {
              void props.envs
                .portUrl(host(), port()!)
                .then((one) => open(one.url))
                .catch(() => open(portPath(host(), port()!)))
            }}
          >
            Open again
          </Button>
        </Show>
      </form>
      <Show
        when={address()}
        fallback={
          <EmptyState
            icon="link"
            title="A port on the host"
            description={`A dev server on ${host()}, through the server's proxy at /env/${host()}/port/<n>/.`}
          />
        }
      >
        {(url) => (
          <Callout tone="info" data-part="port-opened">
            <span class="mono">{url()}</span> opens in a tab of its own. Its cookie is SameSite=Lax, so it is
            not shown in a frame.
          </Callout>
        )}
      </Show>
    </div>
  )
}
