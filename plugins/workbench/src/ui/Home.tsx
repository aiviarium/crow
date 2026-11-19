// The workbench's start: recent workspaces (kept per person, so they follow them), then each host with its
// checkouts and worktrees, cloning a repository, a new worktree, or any folder by path.
import {
  Badge,
  Button,
  Callout,
  EmptyState,
  Icon,
  IconButton,
  StatusDot,
  TextField,
  ViewHeader,
} from "@aiviarium/nocturne"
import type { Checkout, EnvInfo } from "@rookery/client"
import type { ClientRookery, ViewHandle } from "@rookery/sdk/client"
import { createResource, createSignal, For, type JSX, Show } from "solid-js"

export interface Recent {
  env: string
  path: string
  name: string
  branch?: string | null
  at: number
}

export async function rememberWorkspace(rookery: ClientRookery, r: Omit<Recent, "at">) {
  const list = (
    (await rookery.storage.get<Recent[]>("recent", { scope: "user" }).catch(() => undefined)) ?? []
  ).filter((x) => !(x.env === r.env && x.path === r.path))
  list.unshift({ ...r, at: Date.now() })
  await rookery.storage.set("recent", list.slice(0, 12), { scope: "user" }).catch(() => {})
}

/** The view path of a workspace: `<env>/<absolute path>`, each segment encoded. */
export function workspacePath(env: string, path: string) {
  const abs = path.startsWith("/") ? path : `/${path}`
  return `${env.replace(/^env:\/\//, "")}${abs.split("/").map(encodeURIComponent).join("/")}`
}

/** The other way: `<env>/<path>` from a view path. */
export function parseWorkspacePath(viewPath: string): { env: string; path: string } {
  const dec = (s: string) => {
    try {
      return decodeURIComponent(s)
    } catch {
      return s
    }
  }
  const parts = viewPath.replace(/^\/+/, "").split("/").map(dec)
  const env = parts.shift() ?? ""
  return { env, path: `/${parts.join("/")}`.replace(/\/+$/, "") || "/" }
}

export default function Home(props: { rookery: ClientRookery; view: ViewHandle }): JSX.Element {
  const rookery = props.rookery
  props.view.setTitle("Workbench")
  const [recent, { refetch: refetchRecent }] = createResource(
    async () =>
      (await rookery.storage.get<Recent[]>("recent", { scope: "user" }).catch(() => undefined)) ?? [],
  )
  const [envs] = createResource(() => rookery.env.list())
  const [picked, setPicked] = createSignal<string | null>(null)
  const env = () => picked() ?? envs()?.find((e) => e.state === "online")?.name ?? null
  const [checkouts, { refetch }] = createResource(env, (e) => rookery.env.checkouts(e))
  const open = (envName: string, path: string) =>
    rookery.workbench.openView("workbench.open", { path: workspacePath(envName, path) })

  const [url, setUrl] = createSignal("")
  const [cloning, setCloning] = createSignal(false)
  const [error, setError] = createSignal<string | null>(null)
  const clone = async (e: Event) => {
    e.preventDefault()
    const env0 = env()
    if (!env0 || !url().trim()) return
    setCloning(true)
    setError(null)
    try {
      const c = await rookery.env.clone(env0, url().trim())
      setUrl("")
      refetch()
      open(env0, c.path)
    } catch (err) {
      setError((err as Error).message)
    } finally {
      setCloning(false)
    }
  }
  const [folder, setFolder] = createSignal("")
  const [wt, setWt] = createSignal<{ checkout: string; branch: string } | null>(null)
  const worktree = async (e: Event) => {
    e.preventDefault()
    const w = wt()
    const env0 = env()
    if (!w || !env0 || !w.branch.trim()) return
    try {
      const c = await rookery.env.worktree(env0, w.checkout, w.branch.trim())
      setWt(null)
      refetch()
      open(env0, c.path)
    } catch (err) {
      setError((err as Error).message)
    }
  }

  return (
    <div class="wb-home" data-part="workbench-home">
      <ViewHeader class="wb-home__head" />

      <Show when={(recent() ?? []).length}>
        <section class="wb-home__section" aria-label="Recent workspaces">
          <h2 class="label nc-muted">Recent</h2>
          <div class="wb-home__list">
            <For each={recent()}>
              {(r) => (
                <button
                  type="button"
                  class="wb-home__row"
                  data-recent={`${r.env}:${r.path}`}
                  onClick={() => open(r.env, r.path)}
                >
                  <Icon name="folder" />
                  <span class="wb-home__name" title={r.name}>
                    {r.name}
                  </span>
                  <Show when={r.branch}>
                    <span class="wb-home__branch mono" title={r.branch ?? undefined}>
                      <Icon name="branch" size="sm" />
                      {r.branch}
                    </span>
                  </Show>
                  <span class="wb-home__where mono nc-muted" title={`${r.env}:${r.path}`}>
                    {r.env}:{r.path}
                  </span>
                </button>
              )}
            </For>
          </div>
          <Button
            size="sm"
            variant="ghost"
            onClick={async () => {
              await rookery.storage.set("recent", [], { scope: "user" })
              refetchRecent()
            }}
          >
            Clear recent
          </Button>
        </section>
      </Show>

      <section class="wb-home__section" aria-label="Hosts">
        <h2 class="label nc-muted">Hosts</h2>
        <div class="wb-home__envs" role="tablist" aria-label="Host">
          <For each={envs() ?? []} fallback={<span class="body nc-muted">No hosts you may use.</span>}>
            {(e: EnvInfo) => (
              <button
                type="button"
                role="tab"
                class="wb-home__env"
                aria-selected={env() === e.name}
                data-env={e.name}
                onClick={() => setPicked(e.name)}
              >
                <StatusDot status={e.state === "online" ? "ok" : e.state === "offline" ? "off" : "warn"} />
                <span>{e.name}</span>
                <span class="nc-muted mono">{e.kind}</span>
              </button>
            )}
          </For>
        </div>

        <Show when={env()}>
          <div class="wb-home__list" data-part="checkouts">
            <For
              each={checkouts() ?? []}
              fallback={
                <EmptyState
                  icon="folder"
                  title={checkouts.loading ? "Looking for checkouts" : "No checkouts here yet"}
                  description="Clone a repository below."
                />
              }
            >
              {(c: Checkout) => (
                <div class="wb-home__row wb-home__row--checkout" data-checkout={c.path}>
                  <button type="button" class="wb-home__open" onClick={() => open(env()!, c.path)}>
                    <Icon name={c.worktreeOf ? "layers" : "folder"} />
                    <span class="wb-home__name" title={c.name}>
                      {c.name}
                    </span>
                    <Show when={c.branch}>
                      <span class="wb-home__branch mono" title={c.branch ?? undefined}>
                        <Icon name="branch" size="sm" />
                        {c.branch}
                      </span>
                    </Show>
                    <Show when={c.worktreeOf}>
                      <Badge tone="outline">worktree</Badge>
                    </Show>
                    <span class="wb-home__where mono nc-muted" title={c.path}>
                      {c.path}
                    </span>
                  </button>
                  <Show when={!c.worktreeOf}>
                    <IconButton
                      label="New worktree"
                      icon="plus"
                      onClick={() => setWt({ checkout: c.path, branch: "" })}
                    />
                  </Show>
                </div>
              )}
            </For>
          </div>

          <Show when={wt()}>
            <form class="wb-home__form" onSubmit={worktree} aria-label="New worktree">
              <TextField
                label={`New worktree of ${wt()!.checkout.split("/").pop()}`}
                placeholder="Branch name"
                mono
                value={wt()!.branch}
                onInput={(e) => setWt({ ...wt()!, branch: e.currentTarget.value })}
              />
              <Button type="submit" variant="primary">
                Create
              </Button>
              <Button variant="ghost" onClick={() => setWt(null)}>
                Cancel
              </Button>
            </form>
          </Show>

          <form class="wb-home__form" onSubmit={clone} aria-label="Clone a repository">
            <TextField
              label="Clone a repository"
              placeholder="https://github.com/org/repo.git or git@…"
              mono
              value={url()}
              onInput={(e) => setUrl(e.currentTarget.value)}
            />
            <Button type="submit" variant="secondary" loading={cloning()} disabled={!url().trim()}>
              Clone into {env()}
            </Button>
          </form>
          <form
            class="wb-home__form"
            aria-label="Open a folder"
            onSubmit={(e) => {
              e.preventDefault()
              if (folder().trim()) open(env()!, folder().trim())
            }}
          >
            <TextField
              label="Open a folder by path"
              placeholder="/srv/agent/workspaces/…"
              mono
              value={folder()}
              onInput={(e) => setFolder(e.currentTarget.value)}
            />
            <Button type="submit" variant="ghost">
              Open
            </Button>
          </form>
          <Show when={error()}>
            <Callout tone="danger">{error()}</Callout>
          </Show>
        </Show>
      </section>
    </div>
  )
}
