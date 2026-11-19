// Client-half entry for Crow's Agents plugin on Parrot against @rookery/sdk's defineClient contract.
// Connections to `parrot serve` run over Rookery's authorised `agents.connect` binary stream.
import { defineClient } from "@rookery/sdk/client"
import { ArtifactsView, NeedsYouView } from "./artifacts"
import { AssistantView } from "./assistant"
import { ChatView } from "./chat"
import { NewSession } from "./newsession"
import { createAgentsStore, formatChatPath } from "./store"
import "./client.css"

export default defineClient(async (rookery) => {
  const store = createAgentsStore(rookery)

  rookery.views.register("agents.chat", ChatView(rookery, store), { followsPath: true })

  rookery.views.register("agents.new", (props) => {
    props.view.setTitle("New chat")
    return (
      <div class="ag-layout">
        <NewSession
          store={store}
          onStarted={(host, id) =>
            rookery.workbench.openView("agents.chat", { path: formatChatPath(host, id) })
          }
        />
      </div>
    )
  })

  rookery.views.register("agents.artifacts", ArtifactsView(rookery, store))
  rookery.views.register("agents.home", NeedsYouView(rookery, store))
  rookery.views.register("agents.assistant", AssistantView(rookery, store))

  rookery.commands.register("agents.new", {
    title: "New chat",
    run: () => {
      const host = store.selectedHost()
      rookery.workbench.openView("agents.chat", host ? { path: formatChatPath(host) } : {})
    },
  })

  rookery.commands.register("agents.open", {
    title: "Open agents",
    run: () => rookery.workbench.openView("agents.chat"),
  })

  rookery.commands.register("agents.artifacts", {
    title: "Open artifacts",
    run: () => rookery.workbench.openView("agents.artifacts"),
  })

  rookery.nav.badge("agents.chat", () => {
    const waiting = store.needsYouCount()
    return waiting > 0 ? waiting : undefined
  })

  // Best-effort live host updates when the server emits `hosts.changed`: a name with a `/` is the
  // server's, taken as it is, where a bare one would be this plugin's own.
  try {
    await rookery.events.subscribe("rookery/hosts.changed", () => {
      void store.refreshHosts()
    })
  } catch {
    // Live event topic is optional.
  }

  // Initial background host discovery.
  void store.refreshHosts()
})
