// The GitHub plugin's client half: the repositories attached to a space with their sync state, the pull
// request list with filters, a pull request (conversation, files changed, commits, checks) with review and
// merge, the connection view, and three widgets. Issues are Projects issues: "Issues" opens the project the
// space's repositories are linked to. Everything the lists show is a live query over the rows the host half
// keeps in sync; the host half is asked only for what is fetched on demand (files, logs, the timeline) and
// for actions on GitHub.
import { defineClient } from "@rookery/sdk/client"
import { setRookery } from "./lib/app"
import { registerWidget } from "./lib/widgets"
import { ConnectView } from "./views/Connect"
import { IssuesView, PullsView } from "./views/Lists"
import { PullView } from "./views/Pull"
import { RepoView } from "./views/Repo"
import { ReposView } from "./views/Repos"
import { FailingChecks, MyPulls, ReviewRequests } from "./views/widgets"
import "./client.css"

export default defineClient((rookery) => {
  setRookery(rookery)
  rookery.views.register("code.repos", ReposView)
  rookery.views.register("code.repo", RepoView)
  rookery.views.register("code.pulls", PullsView)
  rookery.views.register("code.pull", PullView)
  rookery.views.register("code.issues", IssuesView)
  rookery.views.register("code.connect", ConnectView)
  registerWidget(rookery, "code.myPulls", MyPulls)
  registerWidget(rookery, "code.reviewRequests", ReviewRequests)
  registerWidget(rookery, "code.failingChecks", FailingChecks)
  // Commands that only open views run in the browser; the others are the host half's.
  rookery.commands.register("code.pulls", { run: () => rookery.workbench.openView("code.pulls") })
  rookery.commands.register("code.issues", { run: () => rookery.workbench.openView("code.issues") })
  rookery.commands.register("code.repos", { run: () => rookery.workbench.openView("code.repos") })
})
