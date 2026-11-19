// Fleet host list view (`fleet.hosts`): searchable, state-filtered table of hosts with quick Apply
// and Add Host dialog.
import {
  Badge,
  Button,
  type DataColumn,
  DataTable,
  FilterBar,
  FilterCount,
  State,
  Tabs,
  TextField,
  ViewHeader,
  ViewLayout,
} from "@aiviarium/nocturne"
import type { ClientRookery, ViewHandle } from "@rookery/sdk/client"
import { type Accessor, createEffect, createMemo, createSignal, type JSX, onMount, Show } from "solid-js"
import { AddHostDialog } from "./AddHostDialog"
import type { HostInfo } from "./api"
import type { FleetApi } from "./fleetApi"
import { errorMessage, type HostStatusKind, hostStatus, hostTypeLabel, hostTypeTone } from "./format"
import { NewMachineDialog } from "./NewMachineDialog"

export interface FleetStore {
  readonly hosts: Accessor<HostInfo[]>
  readonly loading: Accessor<boolean>
  readonly error: Accessor<string | null>
  readonly addOpen: Accessor<boolean>
  readonly machineOpen: Accessor<boolean>
  setAddOpen(open: boolean): void
  setMachineOpen(open: boolean): void
  refresh(): Promise<void>
}

type FilterKey = "all" | HostStatusKind

const FILTER_TABS: Array<{ id: FilterKey; label: string }> = [
  { id: "all", label: "All" },
  { id: "ready", label: "Ready" },
  { id: "behind", label: "Behind" },
  { id: "stopped", label: "Stopped" },
  { id: "unreachable", label: "Unreachable" },
]

export function FleetView(props: {
  view: ViewHandle
  rookery: ClientRookery
  api: FleetApi
  store: FleetStore
}): JSX.Element {
  const [query, setQuery] = createSignal("")
  const [stateFilter, setStateFilter] = createSignal<FilterKey>("all")
  const [applying, setApplying] = createSignal<string | null>(null)

  onMount(() => {
    props.view.setTitle("Fleet")
    void props.store.refresh()
  })

  createEffect(() => {
    if (props.view.params.add === "1") {
      props.store.setAddOpen(true)
    }
  })

  const filtered = createMemo(() => {
    const q = query().trim().toLowerCase()
    const filter = stateFilter()
    return props.store.hosts().filter((host) => {
      if (filter !== "all" && hostStatus(host).kind !== filter) return false
      if (!q) return true
      return (
        host.name.toLowerCase().includes(q) ||
        host.address.toLowerCase().includes(q) ||
        host.type.toLowerCase().includes(q) ||
        (host.error ?? "").toLowerCase().includes(q)
      )
    })
  })

  const openHost = (host: { name: string }) => {
    props.rookery.workbench.openView("fleet.host", { params: { name: host.name } })
  }

  const openJob = (jobId: string, hostName?: string) => {
    props.rookery.workbench.openView("fleet.job", {
      params: hostName ? { id: jobId, host: hostName } : { id: jobId },
    })
  }

  const triggerApply = async (host: HostInfo, e: MouseEvent) => {
    e.stopPropagation()
    if (applying()) return
    setApplying(host.name)
    try {
      const acted = await props.api.act({ host: host.name, action: "apply" })
      openJob(acted.job, host.name)
    } catch (err) {
      props.rookery.workbench.toast({
        kind: "danger",
        title: `Apply failed for ${host.name}`,
        body: errorMessage(err),
      })
    } finally {
      setApplying(null)
    }
  }

  const columns: DataColumn<HostInfo>[] = [
    {
      id: "name",
      header: "Host",
      sortable: true,
      accessor: (h) => h.name,
      cell: (h) => (
        <div class="fleet-host-cell">
          <span class="fleet-host-cell__name">{h.name}</span>
          <span class="fleet-host-cell__addr mono">{h.address}</span>
        </div>
      ),
    },
    {
      id: "state",
      header: "State",
      sortable: true,
      accessor: (h) => hostStatus(h).label,
      cell: (h) => {
        const s = hostStatus(h)
        return <State status={s.dot}>{s.label}</State>
      },
    },
    {
      id: "type",
      header: "Type",
      sortable: true,
      accessor: (h) => h.type,
      cell: (h) => (
        <Badge square tone={hostTypeTone(h.type)}>
          {hostTypeLabel(h.type)}
        </Badge>
      ),
    },
    {
      id: "version",
      header: "Version",
      sortable: true,
      accessor: (h) => h.version ?? "",
      cell: (h) => {
        const changes = h.behind?.changes?.length ?? 0
        return (
          <span class="fleet-version-cell">
            <span class="mono">{h.version ?? "—"}</span>
            <Show when={changes > 0}>
              <Badge square tone="warning">
                {changes} {changes === 1 ? "change" : "changes"}
              </Badge>
            </Show>
          </span>
        )
      },
    },
    {
      id: "actions",
      header: "",
      width: "96px",
      cell: (h) => (
        <Show when={h.type !== "ssh" && h.reachable}>
          <Button
            size="sm"
            variant={(h.behind?.changes?.length ?? 0) > 0 ? "primary" : "ghost"}
            disabled={applying() === h.name}
            data-part="host-quick-apply"
            data-host={h.name}
            onClick={(e) => void triggerApply(h, e)}
          >
            {applying() === h.name ? "Applying…" : "Apply"}
          </Button>
        </Show>
      ),
    },
  ]

  const hasFilters = () => query().trim() !== "" || stateFilter() !== "all"

  return (
    <ViewLayout
      id="fleet.hosts"
      header={
        <ViewHeader
          crumbs={[{ label: "Fleet", icon: "server" }]}
          noPin
          actions={[
            {
              id: "refresh",
              label: "Refresh hosts",
              icon: "refresh-cw",
              onClick: () => void props.store.refresh(),
            },
            {
              id: "new-machine",
              label: "New machine",
              icon: "plus",
              onClick: () => props.store.setMachineOpen(true),
            },
            {
              id: "provisioners",
              label: "Provisioners",
              icon: "package",
              overflow: true,
              onClick: () => props.rookery.workbench.openView("fleet.provisioners"),
            },
            {
              id: "add-host",
              label: "Add host",
              icon: "plus",
              primary: true,
              onClick: () => props.store.setAddOpen(true),
            },
          ]}
        />
      }
    >
      <div class="fleet-page" data-part="fleet-hosts">
        <FilterBar
          label="Filter hosts"
          search={
            <TextField
              variant="search"
              label="Search hosts"
              placeholder="Filter by name, address, or type…"
              value={query()}
              onInput={(e) => setQuery(e.currentTarget.value)}
            />
          }
          end={<FilterCount value={filtered().length} icon="server" unit="Hosts" />}
        >
          <Tabs
            label="Host state"
            items={FILTER_TABS}
            value={stateFilter()}
            onChange={(id) => setStateFilter(id as FilterKey)}
          />
        </FilterBar>

        <DataTable
          label="Fleet hosts"
          density="comfortable"
          rows={filtered()}
          columns={columns}
          getRowId={(h) => h.name}
          loading={props.store.loading() && props.store.hosts().length === 0}
          error={
            props.store.error()
              ? {
                  message: "Could not load hosts",
                  detail: props.store.error() ?? undefined,
                  onRetry: () => void props.store.refresh(),
                }
              : undefined
          }
          empty={
            hasFilters()
              ? {
                  title: "No hosts match",
                  description: "Adjust your search or state filter to see other hosts.",
                  onClearFilters: () => {
                    setQuery("")
                    setStateFilter("all")
                  },
                }
              : {
                  title: "No hosts yet",
                  description: "Add an existing machine to start managing it with Rookery.",
                }
          }
          onRowClick={openHost}
        />

        <AddHostDialog
          open={props.store.addOpen()}
          api={props.api}
          onClose={() => props.store.setAddOpen(false)}
          onAdded={({ host, jobId }) => {
            props.store.setAddOpen(false)
            void props.store.refresh()
            if (jobId) {
              openJob(jobId, host.name)
            } else {
              openHost(host)
            }
          }}
        />

        <NewMachineDialog
          open={props.store.machineOpen()}
          api={props.api}
          onClose={() => props.store.setMachineOpen(false)}
          onCreated={({ host }) => {
            props.store.setMachineOpen(false)
            void props.store.refresh()
            openHost({ name: host })
          }}
          onOpenProvisioners={() => props.rookery.workbench.openView("fleet.provisioners")}
          onOpenJob={(jobId) => openJob(jobId)}
        />
      </div>
    </ViewLayout>
  )
}
