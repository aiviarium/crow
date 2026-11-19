// The Terminal plugin's client half: a terminal as a main view, terminals in the bottom panel with tabs
// and a split, the session list per host, and the host's screen. There is no host half and no emulation
// in the server: a terminal is a session on the host, and this half speaks `terminals.*` (see API.md).
import { defineClient } from "@rookery/sdk/client"
import { createSignal } from "solid-js"
import { InspectorView } from "./InspectorView"
import { addToPanel, openInPanel, openPanel, PanelView, panel, registerPanelDeps, togglePanel } from "./panel"
import { SessionsView } from "./SessionsView"
import { TerminalViewer } from "./TerminalViewer"
import { createTerminalsApi } from "./termApi"
import "./terminal.css"

export default defineClient((rookery) => {
  const terminals = createTerminalsApi(rookery)
  const deps = { rookery, terminals }
  registerPanelDeps(deps)

  rookery.views.register("terminal.sessions", (props) => (
    <SessionsView view={props.view} rookery={rookery} terminals={terminals} />
  ))
  rookery.views.register("terminal.session", (props) => {
    const [title, setTitle] = createSignal("Terminal")
    props.view.setTitle(title())
    return (
      <TerminalViewer
        rookery={rookery}
        terminals={terminals}
        id={props.view.path}
        readonly={props.view.params.readonly === "1"}
        autofocus
        onTitle={(t) => {
          setTitle(t)
          props.view.setTitle(t)
        }}
      />
    )
  })
  rookery.views.register("terminal.screen", (props) => (
    <InspectorView view={props.view} rookery={rookery} terminals={terminals} />
  ))
  rookery.views.register("terminal.panel", () => <PanelView {...deps} />)

  rookery.commands.register("terminal.new", {
    title: "New terminal",
    run: () => rookery.workbench.openView("terminal.sessions"),
  })
  rookery.commands.register("terminal.sessions", {
    title: "Terminal sessions",
    run: () => rookery.workbench.openView("terminal.sessions"),
  })
  rookery.commands.register("terminal.panel", {
    title: "Terminals in the panel",
    run: async (params) => {
      if (typeof params.id === "string") {
        addToPanel(params.id, String(params.title ?? "Terminal"))
        openPanel()
      } else if (typeof params.env === "string") {
        const t = await terminals.open(params.env)
        addToPanel(t.id, t.title)
        openPanel()
      } else if (params.open === false) {
        togglePanel()
      } else if (panel().tabs.length) {
        openPanel()
      } else {
        await openInPanel(deps)
        openPanel()
      }
    },
  })
})
