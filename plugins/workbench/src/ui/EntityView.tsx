// Links to files and commits from elsewhere in Crow: code://<env>/<absolute path> and
// commit://<env>/<absolute path of the repository>@<sha>. The view gets the id as its route's rest and
// opens the workspace that holds it: the file in the editor, the commit in a review of it.
import { Button, EmptyState } from "@aiviarium/nocturne"
import type { ClientRookery, ViewHandle } from "@rookery/sdk/client"
import { createSignal, onMount, Show } from "solid-js"
import type { WsInfo } from "../api"
import { workspacePath } from "./Home"

export function parseEntityId(
  id: string,
  kind: "file" | "commit",
): { env: string; path: string; sha?: string } | null {
  const raw = id.replace(/^\/+/, "")
  const slash = raw.indexOf("/")
  if (slash <= 0) return null
  const env = raw.slice(0, slash)
  let path = raw.slice(slash)
  if (kind === "commit") {
    const at = path.lastIndexOf("@")
    if (at < 0) return null
    return { env, path: path.slice(0, at), sha: path.slice(at + 1) }
  }
  path = path.replace(/\/+$/, "")
  return { env, path }
}

export default function EntityView(props: {
  rookery: ClientRookery
  view: ViewHandle
  kind: "file" | "commit"
}) {
  const [error, setError] = createSignal<string | null>(null)
  onMount(async () => {
    const e = parseEntityId(props.view.path, props.kind)
    if (!e) return setError(`${props.view.path} is not a ${props.kind} link`)
    try {
      const dir = props.kind === "file" ? e.path.slice(0, e.path.lastIndexOf("/")) || "/" : e.path
      const info = await props.rookery.host.call<WsInfo>("ws.info", { env: e.env, path: dir })
      if (props.kind === "file") {
        const rel = e.path.startsWith(`${info.root}/`) ? e.path.slice(info.root.length + 1) : e.path
        props.rookery.workbench.openView("workbench.open", {
          path: workspacePath(e.env, info.root),
          params: { file: rel },
        })
      } else {
        props.rookery.workbench.openView("workbench.review", {
          path: workspacePath(e.env, info.root),
          params: { base: `${e.sha}^`, head: e.sha!, title: `Commit ${e.sha!.slice(0, 7)}` },
        })
      }
    } catch (err) {
      setError((err as Error).message)
    }
  })
  return (
    <Show
      when={error()}
      fallback={
        <EmptyState icon={props.kind === "file" ? "file" : "branch"} title="Opening the link">
          <Button variant="ghost" onClick={() => props.rookery.workbench.openView("workbench.home")}>
            All workspaces
          </Button>
        </EmptyState>
      }
    >
      <EmptyState icon="file" title="This link cannot be opened" description={error()!}>
        <Button variant="ghost" onClick={() => props.rookery.workbench.openView("workbench.home")}>
          All workspaces
        </Button>
      </EmptyState>
    </Show>
  )
}
