// Crow's authenticated shell chrome built on Nocturne's AppShell, LinkProvider, and ToastRegion.
import { AppShell, Count, Frame, IconButton, LinkProvider, ToastRegion } from "@aiviarium/nocturne"
import { createEffect, createSignal, type JSX, Show } from "solid-js"
import { AboutDialog } from "../auth/AccountMenu"
import { Sidebar } from "./Sidebar"
import { StatusBar } from "./StatusBar"
import { ShareDialogHost } from "./share"
import type { ShellApp } from "./state"
import { ViewHost } from "./ViewHost"

export function Shell(props: { app: ShellApp }): JSX.Element {
  const [drawerOpen, setDrawerOpen] = createSignal(false)

  createEffect(() => {
    if (typeof document === "undefined") return
    const unread = props.app.inbox.unread()
    const base = `${props.app.title()} — Crow`
    document.title = unread > 0 ? `(${unread}) ${base}` : base
  })

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
            <Show when={props.app.inbox.unread() > 0}>
              <a
                class="crow-topbar__inbox"
                data-part="topbar-inbox-count"
                href="/inbox"
                aria-label={`Inbox, ${props.app.inbox.unread()} unread`}
                onClick={(e) => {
                  e.preventDefault()
                  props.app.navigate("/inbox")
                }}
              >
                <Count value={props.app.inbox.unread()} />
              </a>
            </Show>
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
      <ShareDialogHost app={props.app} />
    </LinkProvider>
  )
}
