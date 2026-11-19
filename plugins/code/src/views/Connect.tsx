import { Badge, Button, Callout, EmptyState, Panel, State, TextField, ViewHeader } from "@aiviarium/nocturne"
import type { ViewProps } from "@rookery/sdk/client"
import { createResource, createSignal, For, onMount, Show } from "solid-js"
import { ErrorNote } from "../components/bits"
import { type ConnectionRow, describe, rookery, useMe } from "../lib/app"
import { clock } from "../lib/format"

interface Tested {
  ok: boolean
  message: string
}

const SCOPE = { user: "Just you", global: "Everyone" } as Record<string, string>

/** GitHub's connections: who they are, what they reach, how much of the rate limit is left; and creating an app. */
export function ConnectView(props: ViewProps) {
  const c = rookery()
  props.view.setTitle("Connect GitHub")
  const { admin } = useMe()
  const [list, { refetch }] = createResource(
    async () => (await c.host.call<{ connections: ConnectionRow[] }>("connections")).connections,
  )
  const [tests, setTests] = createSignal<Record<string, Tested | "running">>({})
  const [error, setError] = createSignal<unknown>()
  const [done, setDone] = createSignal<{ name: string; install: string } | null>(null)
  const [org, setOrg] = createSignal("")
  const [base, setBase] = createSignal("https://api.github.com")
  const [busy, setBusy] = createSignal(false)

  const test = async (id: string) => {
    setTests({ ...tests(), [id]: "running" })
    try {
      const r = await c.connections.test(id)
      setTests({
        ...tests(),
        [id]: { ok: r.ok, message: r.ok ? "The connection works." : r.message || "It does not work." },
      })
    } catch (e) {
      setTests({ ...tests(), [id]: { ok: false, message: describe(e).message } })
    }
    void refetch()
  }

  // GitHub sends the browser back here with a code after the app was created, and with an installation id
  // after it was installed.
  onMount(async () => {
    const p = props.view.params
    try {
      if (p.code && p.state) {
        const r = await c.host.call<{
          name: string
          install: string
          connection: Parameters<typeof c.connections.create>[0]
        }>("app.complete", { code: p.code, state: p.state })
        // A host half cannot make a connection at the pinned SDK: the admin's browser does.
        await c.connections.create(r.connection)
        setDone({ name: r.name, install: r.install })
        void refetch()
      } else if (p.installation_id) {
        const conn = (await c.host.call<{ connections: ConnectionRow[] }>("connections")).connections.find(
          (x) => x.type === "code.github-app",
        )
        if (conn) {
          const known = await c.connections.get(conn.id)
          await c.connections.update({
            id: conn.id,
            config: { ...known.config, installationId: p.installation_id },
          })
        }
        void refetch()
      }
    } catch (e) {
      setError(e)
    }
  })

  const createApp = async () => {
    setBusy(true)
    setError(undefined)
    try {
      const r = await c.host.call<{ post: string; manifest: unknown }>("app.manifest", {
        origin: location.origin,
        apiBase: base(),
        org: org() || undefined,
      })
      const form = document.createElement("form")
      form.method = "POST"
      form.action = r.post
      const input = document.createElement("input")
      input.type = "hidden"
      input.name = "manifest"
      input.value = JSON.stringify(r.manifest)
      form.append(input)
      document.body.append(form)
      form.submit()
    } catch (e) {
      setError(e)
      setBusy(false)
    }
  }

  return (
    <div class="gh-view" data-part="connect-view">
      <ViewHeader
        actions={[
          {
            id: "new-connection",
            label: "New connection",
            icon: "plus",
            onClick: () => {
              window.location.assign("/settings/connections")
            },
          },
        ]}
      />
      <Show when={error()}>
        <ErrorNote error={error()} />
      </Show>
      <Show when={done()}>
        <Callout
          tone="info"
          data-testid="app-created"
          action={
            <Button size="sm" variant="primary" href={done()!.install}>
              Install the app
            </Button>
          }
        >
          {done()!.name} was created and its credentials are stored. Install it on your organisation or
          account to give it repositories; if it is installed in one place, Crow finds the installation by
          itself.
        </Callout>
      </Show>

      <Panel title="Connections">
        <Show when={list()?.length} fallback={<EmptyState icon="link" title="No GitHub connection yet" />}>
          <ul class="gh-plain gh-conns">
            <For each={list()}>
              {(k) => (
                <li class="gh-conn" data-connection={k.name} data-type={k.type}>
                  <div class="gh-conn__head">
                    <strong>{k.name}</strong>
                    <Badge square>{k.type === "code.github-app" ? "GitHub App" : "Personal token"}</Badge>
                    <Badge square tone="outline">
                      {SCOPE[k.scope] ?? k.scope}
                    </Badge>
                    <span class="nc-meta nc-mono">{k.baseUrl}</span>
                    <span class="gh-spacer" />
                    <Button
                      size="sm"
                      loading={tests()[k.id] === "running"}
                      onClick={() => test(k.id)}
                      data-testid="test-connection"
                    >
                      Test
                    </Button>
                  </div>
                  <div class="nc-meta gh-conn__facts">
                    <Show when={k.type === "code.github-app"}>
                      <State status={k.webhooks ? "ok" : "idle"}>
                        {k.webhooks
                          ? "Webhooks verified with the stored secret"
                          : "No webhook secret: repositories are polled"}
                      </State>
                    </Show>
                    <Show when={k.rate} fallback={<span>Rate limit: shown after the first request</span>}>
                      <span data-testid="connection-rate">
                        {k.rate!.remaining.toLocaleString("en")} of {k.rate!.limit.toLocaleString("en")}{" "}
                        requests left until {clock(k.rate!.resetAt)}
                      </span>
                    </Show>
                  </div>
                  <Show when={tests()[k.id] && tests()[k.id] !== "running"}>
                    <State
                      status={(tests()[k.id] as Tested).ok ? "ok" : "error"}
                      data-testid="connection-test-result"
                    >
                      {(tests()[k.id] as Tested).message}
                    </State>
                  </Show>
                </li>
              )}
            </For>
          </ul>
        </Show>
      </Panel>

      <Show when={admin()}>
        <Panel title="Create a GitHub App from Crow">
          <div class="nc-stack" data-part="app-form">
            <TextField
              label="GitHub API URL"
              help="https://api.github.com, or https://HOST/api/v3 for GitHub Enterprise Server."
              value={base()}
              onInput={(e) => setBase(e.currentTarget.value)}
            />
            <TextField
              label="Organisation (optional)"
              help="Instead of your own account"
              value={org()}
              onInput={(e) => setOrg(e.currentTarget.value)}
            />
            <div>
              <Button
                variant="primary"
                loading={busy()}
                onClick={createApp}
                title="GitHub asks you to confirm the app (read: code, checks, statuses; write: issues, pull requests) and sends you back. Its webhook points at /hooks/code/events; where GitHub cannot reach this server, repositories are polled."
                data-testid="create-app"
              >
                Create the app on GitHub
              </Button>
            </div>
          </div>
        </Panel>
      </Show>
    </div>
  )
}
