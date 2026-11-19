// The workbench's client half. This entry is small on purpose: it registers the views and commands, and
// everything they show (the workspace, Monaco, the review) is loaded with import() the first time a
// workbench view opens, as chunks Vite serves beside this file.
import { EmptyState } from "@aiviarium/nocturne"
import { defineClient } from "@rookery/sdk/client"
import { lazy, Suspense } from "solid-js"
import { activeWorkspace } from "./active"
import { setRookery } from "./rookery"

const Home = lazy(() => import("./ui/Home"))
const WorkspaceView = lazy(() => import("./ui/WorkspaceView"))
const ReviewView = lazy(() => import("./ui/ReviewView"))
const EntityView = lazy(() => import("./ui/EntityView"))

const loading = () => <EmptyState icon="edit" title="Loading the workbench" />

/** Commands that act on the focused workspace. */
const WORKSPACE_COMMANDS = [
  "workbench.quickOpen",
  "workbench.save",
  "workbench.saveAll",
  "workbench.format",
  "workbench.gotoLine",
  "workbench.find",
  "workbench.splitEditor",
  "workbench.closeEditor",
  "workbench.toggleSidebar",
  "workbench.toggleTerminal",
  "workbench.togglePreview",
  "workbench.toggleAssistant",
  "workbench.toggleMinimap",
  "workbench.toggleWordWrap",
  "workbench.toggleBlame",
  "workbench.files",
  "workbench.search",
  "workbench.sourceControl",
  "workbench.revealFile",
  "workbench.refresh",
  "workbench.copyLink",
  "workbench.commit",
  "workbench.stageAll",
  "workbench.push",
  "workbench.pull",
  "workbench.fetch",
  "workbench.switchBranch",
  "workbench.newBranch",
  "workbench.stash",
  "workbench.history",
  "workbench.fileHistory",
  "workbench.openPullRequest",
] as const

export default defineClient((rookery) => {
  setRookery(rookery)
  rookery.views.register("workbench.home", (props) => (
    <Suspense fallback={loading()}>
      <Home rookery={rookery} view={props.view} />
    </Suspense>
  ))
  rookery.views.register("workbench.open", (props) => (
    <Suspense fallback={loading()}>
      <WorkspaceView rookery={rookery} view={props.view} />
    </Suspense>
  ))
  rookery.views.register("workbench.review", (props) => (
    <Suspense fallback={loading()}>
      <ReviewView rookery={rookery} view={props.view} />
    </Suspense>
  ))
  rookery.views.register("workbench.file", (props) => (
    <Suspense fallback={loading()}>
      <EntityView rookery={rookery} view={props.view} kind="file" />
    </Suspense>
  ))
  rookery.views.register("workbench.commit", (props) => (
    <Suspense fallback={loading()}>
      <EntityView rookery={rookery} view={props.view} kind="commit" />
    </Suspense>
  ))

  rookery.commands.register("workbench.openWorkspace", {
    title: "Open a workspace",
    run: (p) => {
      if (typeof p.env === "string" && typeof p.path === "string") {
        rookery.workbench.openView("workbench.open", {
          path: `${p.env.replace(/^env:\/\//, "")}${p.path}`,
        })
      } else rookery.workbench.openView("workbench.home")
    },
  })

  // The API the agents plugin (and anyone else) calls to review a range: { env, path, base, head, turns? }.
  // turns is a list of refs from base to head (an agent session's turn checkpoints), to review turn by turn.
  rookery.commands.register("workbench.review", {
    title: "Review changes",
    run: (p) => {
      const env = String(p.env ?? "").replace(/^env:\/\//, "")
      const path = String(p.path ?? "")
      if (!env || !path) {
        const w = activeWorkspace()
        if (w) return w.run("workbench.review", p)
        rookery.workbench.toast({ title: "Review needs a host and a path", kind: "warning" })
        return
      }
      const params: Record<string, string> = {}
      for (const k of ["base", "head", "kind", "title"] as const)
        if (typeof p[k] === "string") params[k] = p[k] as string
      if (Array.isArray(p.turns)) params.turns = (p.turns as string[]).join(",")
      rookery.workbench.openView("workbench.review", { path: `${env}${path}`, params, split: !!p.split })
    },
  })

  for (const id of WORKSPACE_COMMANDS) {
    rookery.commands.register(id, {
      run: (params) => {
        const w = activeWorkspace()
        if (!w) {
          if (id !== "workbench.save" && id !== "workbench.saveAll" && id !== "workbench.quickOpen")
            rookery.workbench.toast({ title: "Open a workspace first", kind: "info" })
          return
        }
        return w.run(id, params)
      },
    })
  }
})
