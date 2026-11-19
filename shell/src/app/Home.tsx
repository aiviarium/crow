// Empty M0 home screen built with Nocturne's EmptyState.
import { EmptyState } from "@aiviarium/nocturne"
import { createMemo, type JSX } from "solid-js"
import type { ShellApp } from "./state"

export function Home(props: { app: ShellApp }): JSX.Element {
  const activePlugins = createMemo(
    () => Object.values(props.app.loader.plugins).filter((p) => p && p.state === "active").length,
  )

  return (
    <div class="crow-home" data-part="home">
      <EmptyState
        icon="home"
        title="Welcome to Crow"
        description={
          activePlugins() > 0
            ? `${activePlugins()} ${activePlugins() === 1 ? "plugin" : "plugins"} connected. Pick a destination from the sidebar.`
            : "Connected to Rookery. Views will appear in the sidebar once plugins are installed."
        }
      />
    </div>
  )
}
