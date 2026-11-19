// Crow's authenticated shell chrome built on Nocturne's AppShell, LinkProvider, and ToastRegion.
import { AppShell, Frame, IconButton, LinkProvider, ToastRegion } from "@aiviarium/nocturne"
import { createSignal, type JSX } from "solid-js"
import { AboutDialog } from "../auth/AccountMenu"
import { Sidebar } from "./Sidebar"
import { StatusBar } from "./StatusBar"
import type { ShellApp } from "./state"
import { ViewHost } from "./ViewHost"

export function Shell(props: { app: ShellApp }): JSX.Element {
  const [drawerOpen, setDrawerOpen] = createSignal(false)

  return (
    <LinkProvider navigate={(href) => props.app.navigate(href)}>
      <AppShell
        fill
        class="crow-shell"
        data-part="shell"
        data-connection={props.app.conn.state()}
        sidebar={<Sidebar app={props.app} onNavigate={() => setDrawerOpen(false)} />}
        sidebarLabel="Navigation"
        topbar={
          <>
            <IconButton label="Open navigation" icon="list" onClick={() => setDrawerOpen(true)} />
            <span class="label crow-topbar__title" data-part="topbar-title">
              {props.app.title()}
            </span>
          </>
        }
        statusbar={<StatusBar app={props.app} />}
        drawerOpen={drawerOpen()}
        onDrawerClose={() => setDrawerOpen(false)}
      >
        <Frame class="crow-main">
          <ViewHost app={props.app} />
        </Frame>
      </AppShell>
      <ToastRegion />
      <AboutDialog app={props.app} />
    </LinkProvider>
  )
}
