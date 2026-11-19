// Client-half entry for the Fleet plugin against @rookery/sdk's defineClient contract.
import { defineClient } from "@rookery/sdk/client"
import { createSignal } from "solid-js"
import type { HostChangedEvent, HostInfo } from "./api"
import { DesktopPage } from "./DesktopPage"
import { type FleetStore, FleetView } from "./FleetView"
import { createFleetApi } from "./fleetApi"
import { errorMessage, hostNeedsAttention } from "./format"
import { HostView } from "./HostView"
import { JobView } from "./JobView"
import type { CurrentUser } from "./me"
import { PortPage } from "./Ports"
import "./fleet.css"

export default defineClient(async (rookery) => {
  const [me, setMe] = createSignal<CurrentUser | null>(null)
  const api = createFleetApi(rookery, me)
  const [hosts, setHosts] = createSignal<HostInfo[]>([])
  const [loading, setLoading] = createSignal(false)
  const [error, setError] = createSignal<string | null>(null)
  const [addOpen, setAddOpen] = createSignal(false)

  const refresh = async () => {
    setLoading(true)
    setError(null)
    try {
      const list = await api.listHosts()
      setHosts(list)
    } catch (err) {
      setError(errorMessage(err))
    } finally {
      setLoading(false)
    }
  }

  const store: FleetStore = {
    hosts,
    loading,
    error,
    addOpen,
    setAddOpen,
    refresh,
  }

  rookery.views.register("fleet.hosts", (props) => (
    <FleetView view={props.view} rookery={rookery} api={api} store={store} />
  ))

  rookery.views.register("fleet.host", (props) => (
    <HostView view={props.view} rookery={rookery} api={api} store={store} />
  ))

  rookery.views.register("fleet.job", (props) => <JobView view={props.view} rookery={rookery} api={api} />)

  rookery.views.register("fleet.desktop", (props) => (
    <DesktopPage view={props.view} rookery={rookery} envs={api.env} admin={api.isAdmin()} />
  ))
  rookery.views.register("fleet.port", (props) => (
    <PortPage view={props.view} rookery={rookery} envs={api.env} admin={api.isAdmin()} />
  ))

  rookery.commands.register("fleet.hosts", {
    title: "Open Fleet",
    run: () => {
      rookery.workbench.openView("fleet.hosts")
    },
  })

  rookery.commands.register("fleet.addHost", {
    title: "Add host",
    run: () => {
      setAddOpen(true)
      rookery.workbench.openView("fleet.hosts")
    },
  })

  rookery.nav.badge("fleet.hosts", () => {
    const attention = hosts().filter(hostNeedsAttention).length
    return attention > 0 ? attention : undefined
  })

  // Best-effort live host updates; falls back cleanly if the server doesn't emit `hosts.changed`.
  // A name without a `/` is the plugin's own, so the server's is asked for in full.
  try {
    await rookery.events.subscribe("rookery/hosts.changed", (raw) => {
      const payload = raw as HostChangedEvent | undefined
      if (!payload?.host) {
        void refresh()
        return
      }
      if (payload.removed) {
        setHosts((prev) => prev.filter((h) => h.name !== payload.host))
      } else if (payload.info) {
        const info = payload.info
        setHosts((prev) => {
          const exists = prev.some((h) => h.name === info.name)
          return exists ? prev.map((h) => (h.name === info.name ? info : h)) : [...prev, info]
        })
      } else {
        void refresh()
      }
    })
  } catch {
    // Live event topic is optional.
  }

  // Initial background load so the sidebar badge reflects hosts needing attention.
  void refresh()
  // Who is signed in, for the role that holds manage on every host (sharing, the desktop gates).
  void api.fetchMe().then(setMe)
})
