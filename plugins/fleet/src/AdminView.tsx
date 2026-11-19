// Admin, at /fleet/admin and for admins alone: the installation's settings, its secrets (names only;
// their values never leave the server), the registries hosts are given logins and mirrors of, and the
// installation's own actions. It is the prototype's config layout: a list of sections on the left and the
// chosen one's rows on the right. No admin area of the shell exists yet, so it lives with fleet.
import {
  Badge,
  Button,
  Callout,
  Card,
  DataTable,
  Dialog,
  EmptyState,
  type IconName,
  Nav,
  NavItem,
  Select,
  Skeleton,
  TextField,
  ViewHeader,
  ViewLayout,
} from "@aiviarium/nocturne"
import type { PluginInfo } from "@rookery/client"
import type { ClientRookery, ViewHandle } from "@rookery/sdk/client"
import { createEffect, createResource, createSignal, For, type JSX, on, onMount, Show } from "solid-js"
import type { FleetApi } from "./fleetApi"
import { errorMessage } from "./format"
import { canActivate, PLUGIN_STATE, type PluginNewer, type PluginReport } from "./pluginsApi"
import { RunActionDialog } from "./RunAction"
import type { Acted, Action, Registry, Setting } from "./types"

type Section = "settings" | "secrets" | "registries" | "installation" | "plugins"

const SECTIONS: Array<{ id: Section; label: string; icon: IconName }> = [
  { id: "settings", label: "Server settings", icon: "settings" },
  { id: "secrets", label: "Secrets", icon: "lock" },
  { id: "registries", label: "Registries", icon: "link" },
  { id: "plugins", label: "Plugins", icon: "layers" },
  { id: "installation", label: "Installation", icon: "server" },
]

const REGISTRY_TYPES = [
  { value: "raw", label: "Raw", description: "A folder of packages and files" },
  { value: "npm", label: "npm", description: "An npm registry" },
  { value: "docker", label: "Docker", description: "A container image registry" },
  { value: "nexus", label: "Nexus", description: "A Nexus server with repositories" },
]

export function AdminView(props: { view: ViewHandle; rookery: ClientRookery; api: FleetApi }): JSX.Element {
  const [section, setSection] = createSignal<Section>(
    SECTIONS.some((known) => known.id === props.view.path)
      ? (props.view.path as Section)
      : props.view.params.section && SECTIONS.some((known) => known.id === props.view.params.section)
        ? (props.view.params.section as Section)
        : "settings",
  )
  onMount(() => props.view.setTitle("Admin"))
  const fleetHref = () => props.rookery.views.href("fleet.hosts") ?? "/fleet/hosts"

  return (
    <ViewLayout
      id="fleet.admin"
      sidebarLabel="Admin sections"
      sidebar={
        <Nav label="Admin sections" class="fleet-admin__nav">
          <For each={SECTIONS}>
            {(known) => (
              <NavItem
                label={known.label}
                icon={known.icon}
                current={section() === known.id}
                data-section={known.id}
                onClick={() => setSection(known.id)}
              />
            )}
          </For>
        </Nav>
      }
      header={
        <ViewHeader
          up
          noPin
          crumbs={[{ label: "Fleet", icon: "server", href: fleetHref() }, { label: "Admin" }]}
        />
      }
    >
      <div class="fleet-page fleet-admin" data-part="fleet-admin" data-section={section()}>
        <Show
          when={props.api.isAdmin()}
          fallback={
            <Callout tone="warning" data-part="admin-denied">
              <strong>403 · Admins only.</strong> Server settings, secrets and registries are the
              installation's, and only an admin may read or change them.
            </Callout>
          }
        >
          <Show when={section() === "settings"}>
            <SettingsSection api={props.api} rookery={props.rookery} />
          </Show>
          <Show when={section() === "secrets"}>
            <SecretsSection api={props.api} rookery={props.rookery} />
          </Show>
          <Show when={section() === "registries"}>
            <RegistriesSection api={props.api} rookery={props.rookery} />
          </Show>
          <Show when={section() === "plugins"}>
            <PluginsSection api={props.api} rookery={props.rookery} />
          </Show>
          <Show when={section() === "installation"}>
            <InstallationSection api={props.api} rookery={props.rookery} />
          </Show>
        </Show>
      </div>
    </ViewLayout>
  )
}

function LoadingCard(props: { title: string }): JSX.Element {
  return (
    <Card title={props.title}>
      <Skeleton width="55%" />
      <Skeleton width="35%" />
    </Card>
  )
}

// ---------------------------------------------------------------------------
// Server settings
// ---------------------------------------------------------------------------

function SettingsSection(props: { api: FleetApi; rookery: ClientRookery }): JSX.Element {
  const [settings, { refetch }] = createResource(() => props.api.installation.settings())
  const reload = () => void refetch()

  return (
    <div class="fleet-admin__section" data-part="admin-settings">
      <Card
        title="Server settings"
        count={settings()?.length}
        action={
          <Button size="sm" variant="ghost" icon="refresh-cw" onClick={reload}>
            Refresh
          </Button>
        }
      >
        <Show when={settings.error}>
          {(error) => (
            <Callout tone="danger" data-part="settings-error">
              Could not read the settings: {errorMessage(error())}
            </Callout>
          )}
        </Show>
        <Show when={settings.loading && !settings()}>
          <Skeleton width="60%" />
          <Skeleton width="40%" />
        </Show>
        <Show when={settings()}>
          <p class="nc-meta">
            The installation's own settings. A value left empty goes back to its default. Values marked as
            kept on the server are that server's to change, not Crow's.
          </p>
          <For each={settings() ?? []}>
            {(setting) => (
              <SettingRow setting={setting} api={props.api} rookery={props.rookery} onSaved={reload} />
            )}
          </For>
        </Show>
      </Card>
    </div>
  )
}

function SettingRow(props: {
  setting: Setting
  api: FleetApi
  rookery: ClientRookery
  onSaved: () => void
}): JSX.Element {
  const [value, setValue] = createSignal(props.setting.value)
  const [busy, setBusy] = createSignal(false)
  const [saved, setSaved] = createSignal(false)
  createEffect(
    on(
      () => props.setting.value,
      (next) => setValue(next),
    ),
  )
  const changed = () => value() !== props.setting.value

  const save = async () => {
    if (busy() || !props.setting.open) return
    setBusy(true)
    try {
      await props.api.installation.setSetting(props.setting.key, value())
      setSaved(true)
      setTimeout(() => setSaved(false), 2000)
      props.onSaved()
    } catch (error) {
      props.rookery.workbench.toast({
        kind: "danger",
        title: `Could not set ${props.setting.key}`,
        body: errorMessage(error),
      })
    } finally {
      setBusy(false)
    }
  }

  return (
    <div class="fleet-admin__row" data-setting={props.setting.key}>
      <div class="fleet-admin__row-main">
        <span class="mono fleet-admin__key">{props.setting.key}</span>
        <span class="nc-meta">{props.setting.meaning}</span>
      </div>
      <div class="fleet-admin__row-control">
        <Show
          when={props.setting.open}
          fallback={
            <span class="nc-meta" data-part="setting-fixed">
              Set on the server
            </span>
          }
        >
          <TextField
            label={`Value of ${props.setting.key}`}
            mono
            value={value()}
            onInput={(e) => {
              setValue(e.currentTarget.value)
              setSaved(false)
            }}
          />
        </Show>
      </div>
      <div class="fleet-admin__row-actions">
        <Show when={saved()}>
          <Badge square tone="success">
            Saved
          </Badge>
        </Show>
        <Button
          size="sm"
          variant="secondary"
          disabled={!props.setting.open || busy() || !changed()}
          data-part="save-setting"
          onClick={() => void save()}
        >
          {busy() ? "Saving…" : "Save"}
        </Button>
      </div>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Secrets
// ---------------------------------------------------------------------------

function SecretsSection(props: { api: FleetApi; rookery: ClientRookery }): JSX.Element {
  const [secrets, { refetch }] = createResource(() => props.api.installation.secrets())
  const [name, setName] = createSignal("")
  const [value, setValue] = createSignal("")
  const [busy, setBusy] = createSignal(false)
  const [error, setError] = createSignal<string | null>(null)
  const [renaming, setRenaming] = createSignal<string | null>(null)
  const [to, setTo] = createSignal("")
  const [removing, setRemoving] = createSignal<string | null>(null)

  const save = async () => {
    const key = name().trim()
    if (!key || busy()) return
    if (!value()) {
      setError("A value is required.")
      return
    }
    setBusy(true)
    setError(null)
    try {
      await props.api.installation.setSecret(key, value())
      // The value is never read back, and is dropped from the form as soon as it is kept.
      setName("")
      setValue("")
      props.rookery.workbench.toast({ kind: "success", title: `Set the secret ${key}` })
      void refetch()
    } catch (failure) {
      setError(errorMessage(failure))
    } finally {
      setBusy(false)
    }
  }

  const rename = async () => {
    const from = renaming()
    const next = to().trim()
    if (!from || !next || busy()) return
    setBusy(true)
    setError(null)
    try {
      await props.api.installation.renameSecret(from, next)
      setRenaming(null)
      setTo("")
      void refetch()
    } catch (failure) {
      setError(errorMessage(failure))
    } finally {
      setBusy(false)
    }
  }

  const remove = async () => {
    const key = removing()
    if (!key || busy()) return
    setBusy(true)
    setError(null)
    try {
      await props.api.installation.removeSecret(key)
      setRemoving(null)
      void refetch()
    } catch (failure) {
      setError(errorMessage(failure))
    } finally {
      setBusy(false)
    }
  }

  const named = () => secrets()?.secrets ?? []
  const other = () => (secrets()?.names ?? []).filter((key) => !named().some((secret) => secret.name === key))

  return (
    <div class="fleet-admin__section" data-part="admin-secrets">
      <Show when={secrets.error}>
        {(error) => (
          <Callout tone="danger" data-part="secrets-error">
            Could not read the secrets: {errorMessage(error())}
          </Callout>
        )}
      </Show>
      <Show when={secrets.loading && !secrets()}>
        <LoadingCard title="Loading secrets…" />
      </Show>
      <Show when={secrets()}>
        <Callout tone="info" data-part="secrets-write-only">
          Rookery keeps the values and never sends one back: this page shows names only. A secret is used by a
          host's apply, a provisioner or a registry login.
        </Callout>

        <Card title="Set a secret" data-part="secret-set">
          <div class="fleet-form__row">
            <TextField
              id="secret-name"
              label="Name"
              placeholder="incus_token"
              mono
              value={name()}
              help="Its own name, or `registry/NAME`, `ssh/HOST` or `provisioner/NAME/SECRET`."
              onInput={(e) => {
                setName(e.currentTarget.value)
                setError(null)
              }}
            />
            <TextField
              id="secret-value"
              label="Value"
              type="password"
              autocomplete="off"
              value={value()}
              help="Write-only: it is never shown again, nor sent to this page."
              onInput={(e) => {
                setValue(e.currentTarget.value)
                setError(null)
              }}
            />
          </div>
          <Show when={error()}>
            {(text) => (
              <Callout tone="danger" data-part="secret-error">
                {text()}
              </Callout>
            )}
          </Show>
          <Button
            variant="primary"
            size="sm"
            disabled={busy() || !name().trim() || !value()}
            data-part="save-secret"
            onClick={() => void save()}
          >
            {busy() ? "Saving…" : "Set secret"}
          </Button>
        </Card>

        <Card title="Global secrets" count={named().length} data-part="secret-list">
          <Show when={named().length > 0} fallback={<span class="nc-meta">No global secret is kept.</span>}>
            <For each={named()}>
              {(secret) => (
                <div class="fleet-admin__row" data-secret={secret.name}>
                  <div class="fleet-admin__row-main">
                    <span class="mono fleet-admin__key">{secret.name}</span>
                    <span class="nc-meta">
                      Value kept by the server · {secret.id ? `id ${secret.id}` : "no id"}
                    </span>
                  </div>
                  <div class="fleet-admin__row-actions">
                    <Button
                      size="sm"
                      variant="ghost"
                      data-part="rename-secret"
                      onClick={() => {
                        setRenaming(secret.name)
                        setTo(secret.name)
                        setError(null)
                      }}
                    >
                      Rename
                    </Button>
                    <Button
                      size="sm"
                      variant="ghost"
                      data-part="remove-secret"
                      onClick={() => setRemoving(secret.name)}
                    >
                      Remove
                    </Button>
                  </div>
                </div>
              )}
            </For>
          </Show>
        </Card>

        <Show when={other().length > 0}>
          <Card
            title="Secrets of hosts, registries and provisioners"
            count={other().length}
            data-part="secret-derived"
          >
            <p class="nc-meta">
              Each belongs to what it is for: `ssh/HOST` and `sudo/HOST` to a host, `registry/NAME` to a
              registry, `provisioner/NAME/SECRET` to a provisioner.
            </p>
            <For each={other()}>
              {(key) => (
                <div class="fleet-admin__row" data-secret={key}>
                  <div class="fleet-admin__row-main">
                    <span class="mono fleet-admin__key">{key}</span>
                    <span class="nc-meta">Kept with what it is for</span>
                  </div>
                </div>
              )}
            </For>
          </Card>
        </Show>
      </Show>

      <Dialog
        open={renaming() !== null}
        onClose={() => {
          if (!busy()) setRenaming(null)
        }}
        title={`Rename ${renaming() ?? ""}`}
        footer={
          <>
            <Button variant="ghost" disabled={busy()} onClick={() => setRenaming(null)}>
              Cancel
            </Button>
            <Button
              variant="primary"
              disabled={busy() || !to().trim()}
              data-part="confirm-rename-secret"
              onClick={() => void rename()}
            >
              {busy() ? "Renaming…" : "Rename"}
            </Button>
          </>
        }
      >
        <TextField
          id="secret-rename-to"
          label="New name"
          mono
          value={to()}
          onInput={(e) => setTo(e.currentTarget.value)}
        />
      </Dialog>

      <Dialog
        open={removing() !== null}
        onClose={() => {
          if (!busy()) setRemoving(null)
        }}
        title={`Remove ${removing() ?? ""}?`}
        description="What used it stops having it: a host's apply, a provisioner or a registry login."
        footer={
          <>
            <Button variant="ghost" disabled={busy()} onClick={() => setRemoving(null)}>
              Cancel
            </Button>
            <Button
              variant="danger"
              disabled={busy()}
              data-part="confirm-remove-secret"
              onClick={() => void remove()}
            >
              {busy() ? "Removing…" : "Remove secret"}
            </Button>
          </>
        }
      >
        <Callout tone="warning">
          The value of <span class="mono">{removing()}</span> is gone, and cannot be read again.
        </Callout>
      </Dialog>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Registries
// ---------------------------------------------------------------------------

function RegistriesSection(props: { api: FleetApi; rookery: ClientRookery }): JSX.Element {
  const [registries, { refetch }] = createResource(() => props.api.registries.list())
  const [editing, setEditing] = createSignal<{ name: string; registry: Registry | null } | null>(null)
  const [renaming, setRenaming] = createSignal<string | null>(null)
  const [to, setTo] = createSignal("")
  const [removing, setRemoving] = createSignal<string | null>(null)
  const [checked, setChecked] = createSignal<{ name: string; lines: string[] } | null>(null)
  const [busy, setBusy] = createSignal(false)
  const [error, setError] = createSignal<string | null>(null)

  const names = () => Object.keys(registries() ?? {})

  const check = async (name: string) => {
    try {
      setChecked({ name, lines: await props.api.registries.check(name) })
    } catch (failure) {
      setChecked({ name, lines: [`✗ ${errorMessage(failure)}`] })
    }
  }

  const rename = async () => {
    const from = renaming()
    const next = to().trim()
    if (!from || !next || busy()) return
    setBusy(true)
    setError(null)
    try {
      await props.api.registries.rename(from, next)
      setRenaming(null)
      setTo("")
      void refetch()
    } catch (failure) {
      setError(errorMessage(failure))
    } finally {
      setBusy(false)
    }
  }

  const remove = async () => {
    const name = removing()
    if (!name || busy()) return
    setBusy(true)
    setError(null)
    try {
      await props.api.registries.remove(name)
      setRemoving(null)
      void refetch()
    } catch (failure) {
      setError(errorMessage(failure))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div class="fleet-admin__section" data-part="admin-registries">
      <Show when={registries.error}>
        {(failure) => (
          <Callout tone="danger" data-part="registries-error">
            Could not read the registries: {errorMessage(failure())}
          </Callout>
        )}
      </Show>
      <Show when={registries.loading && !registries()}>
        <LoadingCard title="Loading registries…" />
      </Show>
      <Show when={registries()}>
        <Card
          title="Registries"
          count={names().length}
          data-part="registry-list"
          action={
            <Button
              size="sm"
              variant="secondary"
              icon="plus"
              onClick={() => setEditing({ name: "", registry: null })}
              data-part="add-registry"
            >
              Add registry
            </Button>
          }
        >
          <p class="nc-meta">
            A registry is a connection of the declaration's `registry` type: its login is a secret named
            `registry/NAME`, and a host's apply is given both.
          </p>
          <Show when={names().length === 0}>
            <EmptyState
              icon="link"
              title="No registry"
              description="Add the package or image registry your hosts pull from."
            />
          </Show>
          <Show when={names().length > 0}>
            <DataTable
              label="Registries"
              density="comfortable"
              rows={names().map((name) => ({ name, ...registries()![name] }))}
              getRowId={(row) => row.name}
              columns={[
                {
                  id: "name",
                  header: "Name",
                  sortable: true,
                  accessor: (row) => row.name,
                  cell: (row) => <span class="mono">{row.name}</span>,
                },
                {
                  id: "type",
                  header: "Type",
                  width: "90px",
                  accessor: (row) => row.type,
                  cell: (row) => (
                    <Badge square tone="outline">
                      {row.type}
                    </Badge>
                  ),
                },
                {
                  id: "url",
                  header: "Address",
                  sortable: true,
                  accessor: (row) => row.url,
                  cell: (row) => <span class="mono">{row.url}</span>,
                },
                {
                  id: "username",
                  header: "User",
                  accessor: (row) => row.username ?? "",
                  cell: (row) =>
                    row.username ? <span class="mono">{row.username}</span> : <span class="nc-meta">—</span>,
                },
                {
                  id: "actions",
                  header: "",
                  width: "240px",
                  cell: (row) => (
                    <span class="fleet-row-actions">
                      <Button
                        size="sm"
                        variant="ghost"
                        data-part="check-registry"
                        onClick={() => void check(row.name)}
                      >
                        Check
                      </Button>
                      <Button
                        size="sm"
                        variant="ghost"
                        data-part="edit-registry"
                        onClick={() => setEditing({ name: row.name, registry: registries()![row.name] })}
                      >
                        Edit
                      </Button>
                      <Button
                        size="sm"
                        variant="ghost"
                        data-part="rename-registry"
                        onClick={() => {
                          setRenaming(row.name)
                          setTo(row.name)
                          setError(null)
                        }}
                      >
                        Rename
                      </Button>
                      <Button
                        size="sm"
                        variant="ghost"
                        data-part="remove-registry"
                        onClick={() => setRemoving(row.name)}
                      >
                        Remove
                      </Button>
                    </span>
                  ),
                },
              ]}
            />
          </Show>
          <Show when={error()}>
            {(text) => (
              <Callout tone="danger" data-part="registry-error">
                {text()}
              </Callout>
            )}
          </Show>
        </Card>
      </Show>

      <RegistryDialog
        open={editing() !== null}
        editing={editing()}
        api={props.api}
        onClose={() => setEditing(null)}
        onSaved={(name) => {
          setEditing(null)
          props.rookery.workbench.toast({ kind: "success", title: `Saved the registry ${name}` })
          void refetch()
        }}
      />

      <Dialog
        open={renaming() !== null}
        onClose={() => {
          if (!busy()) setRenaming(null)
        }}
        title={`Rename ${renaming() ?? ""}`}
        description="The registry's login moves with it."
        footer={
          <>
            <Button variant="ghost" disabled={busy()} onClick={() => setRenaming(null)}>
              Cancel
            </Button>
            <Button
              variant="primary"
              disabled={busy() || !to().trim()}
              data-part="confirm-rename-registry"
              onClick={() => void rename()}
            >
              {busy() ? "Renaming…" : "Rename"}
            </Button>
          </>
        }
      >
        <TextField
          id="registry-rename-to"
          label="New name"
          mono
          value={to()}
          onInput={(e) => setTo(e.currentTarget.value)}
        />
      </Dialog>

      <Dialog
        open={removing() !== null}
        onClose={() => {
          if (!busy()) setRemoving(null)
        }}
        title={`Remove ${removing() ?? ""}?`}
        description="This removes the registry with its login. Hosts applied afterwards no longer get it."
        footer={
          <>
            <Button variant="ghost" disabled={busy()} onClick={() => setRemoving(null)}>
              Cancel
            </Button>
            <Button
              variant="danger"
              disabled={busy()}
              data-part="confirm-remove-registry"
              onClick={() => void remove()}
            >
              {busy() ? "Removing…" : "Remove registry"}
            </Button>
          </>
        }
      >
        <Callout tone="warning">
          Remove <span class="mono">{removing()}</span> with the secret{" "}
          <span class="mono">registry/{removing()}</span>.
        </Callout>
      </Dialog>

      <Dialog
        open={checked() !== null}
        onClose={() => setChecked(null)}
        title={`Check ${checked()?.name ?? ""}`}
        description="Whether the registry answers, and takes its login."
        footer={
          <Button variant="primary" onClick={() => setChecked(null)}>
            Close
          </Button>
        }
      >
        <pre class="fleet-pre mono" data-part="registry-check-lines">
          {(checked()?.lines ?? []).join("\n")}
        </pre>
      </Dialog>
    </div>
  )
}

function RegistryDialog(props: {
  open: boolean
  editing: { name: string; registry: Registry | null } | null
  api: FleetApi
  onClose: () => void
  onSaved: (name: string) => void
}): JSX.Element {
  const [name, setName] = createSignal("")
  const [type, setType] = createSignal("raw")
  const [url, setUrl] = createSignal("")
  const [username, setUsername] = createSignal("")
  const [password, setPassword] = createSignal("")
  const [busy, setBusy] = createSignal(false)
  const [error, setError] = createSignal<string | null>(null)

  createEffect(
    on(
      () => props.open,
      (open) => {
        if (!open) return
        const one = props.editing?.registry
        setName(props.editing?.name ?? "")
        setType(one?.type ?? "raw")
        setUrl(one?.url ?? "")
        setUsername(one?.username ?? "")
        setPassword("")
        setError(null)
      },
      { defer: true },
    ),
  )

  const save = async () => {
    if (busy()) return
    const registryName = name().trim()
    if (!registryName) {
      setError("A name is required.")
      return
    }
    if (!url().trim()) {
      setError("An address is required.")
      return
    }
    setBusy(true)
    setError(null)
    try {
      await props.api.registries.save(registryName, {
        ...(props.editing?.registry ?? {}),
        type: type(),
        url: url().trim(),
        ...(username().trim() ? { username: username().trim() } : {}),
      })
      // Its login is the secret `registry/NAME`, set apart from the registry itself.
      if (password()) await props.api.installation.setSecret(`registry/${registryName}`, password())
      props.onSaved(registryName)
    } catch (failure) {
      setError(errorMessage(failure))
    } finally {
      setBusy(false)
    }
  }

  return (
    <Dialog
      open={props.open}
      onClose={() => {
        if (!busy()) props.onClose()
      }}
      title={props.editing?.registry ? `Registry ${props.editing.name}` : "Add registry"}
      description="A registry hosts pull packages and images from, with the login Rookery keeps for it."
      size="lg"
      closeOnBackdrop={false}
      footer={
        <>
          <Button variant="ghost" disabled={busy()} onClick={props.onClose}>
            Cancel
          </Button>
          <Button variant="primary" disabled={busy()} data-part="save-registry" onClick={() => void save()}>
            {busy() ? "Saving…" : "Save registry"}
          </Button>
        </>
      }
    >
      <div class="fleet-form" data-part="registry-form">
        <TextField
          id="registry-name"
          label="Name"
          placeholder="packages"
          mono
          value={name()}
          disabled={!!props.editing?.registry}
          help="Its login is the secret registry/NAME."
          onInput={(e) => {
            setName(e.currentTarget.value)
            setError(null)
          }}
        />
        <div class="fleet-form__row">
          <Select label="Type" options={REGISTRY_TYPES} value={type()} onChange={(value) => setType(value)} />
          <TextField
            id="registry-url"
            label="Address"
            placeholder="https://packages.example.test"
            mono
            value={url()}
            onInput={(e) => {
              setUrl(e.currentTarget.value)
              setError(null)
            }}
          />
        </div>
        <div class="fleet-form__row">
          <TextField
            id="registry-username"
            label="User"
            mono
            value={username()}
            onInput={(e) => setUsername(e.currentTarget.value)}
          />
          <TextField
            id="registry-password"
            label="Password or token"
            type="password"
            autocomplete="off"
            value={password()}
            help="Kept as the secret registry/NAME, and never read back. Leave it empty to keep the one it has."
            onInput={(e) => setPassword(e.currentTarget.value)}
          />
        </div>
        <Show
          when={
            (props.editing?.registry?.repositories ?? []).length > 0
              ? props.editing!.registry!.repositories
              : undefined
          }
        >
          {(repositories) => (
            <div class="fleet-form__group">
              <span class="label nc-muted">Repositories</span>
              <For each={repositories()}>
                {(repository) => (
                  <span class="mono nc-meta">
                    {repository.format} {repository.name}
                  </span>
                )}
              </For>
            </div>
          )}
        </Show>
        <Show when={error()}>
          {(text) => (
            <Callout tone="danger" data-part="registry-error">
              {text()}
            </Callout>
          )}
        </Show>
      </div>
    </Dialog>
  )
}

// ---------------------------------------------------------------------------
// Installation actions
// ---------------------------------------------------------------------------

function InstallationSection(props: { api: FleetApi; rookery: ClientRookery }): JSX.Element {
  const [actions] = createResource(() => props.api.installation.actions())
  const [running, setRunning] = createSignal<Action | null>(null)
  return (
    <div class="fleet-admin__section" data-part="admin-installation">
      <Show when={actions.error}>
        {(error) => (
          <Callout tone="danger" data-part="installation-error">
            Could not read the installation's actions: {errorMessage(error())}
          </Callout>
        )}
      </Show>
      <Show when={actions.loading && !actions()}>
        <LoadingCard title="Loading installation actions…" />
      </Show>
      <Show when={actions()}>
        <Card title="The installation's actions" count={actions()?.length} data-part="installation-actions">
          <p class="nc-meta">
            What the server does to itself: upgrading, rekeying its secrets, and the checks that say what it
            needs. Each changing one runs as a job.
          </p>
          <Show
            when={(actions() ?? []).length > 0}
            fallback={<span class="nc-meta">The server offers no installation action.</span>}
          >
            <For each={actions()}>
              {(action) => (
                <div class="fleet-action-row" data-installation-action={action.name}>
                  <div class="fleet-action-row__info">
                    <span class="fleet-action-row__label">{action.label}</span>
                    <span class="fleet-action-row__help label nc-muted">
                      {!action.available && action.why ? action.why : action.help}
                    </span>
                  </div>
                  <Button
                    size="sm"
                    variant={action.changes ? "secondary" : "ghost"}
                    disabled={!action.available}
                    onClick={() => setRunning(action)}
                  >
                    {action.label}
                  </Button>
                </div>
              )}
            </For>
          </Show>
        </Card>
      </Show>

      <RunActionDialog
        open={running() !== null}
        action={running()}
        run={(act): Promise<Acted> => props.api.installation.act(act)}
        onClose={() => setRunning(null)}
        onJob={(jobId) => props.rookery.workbench.openView("fleet.job", { params: { id: jobId } })}
        onResult={(text) =>
          props.rookery.workbench.toast({
            kind: "info",
            title: running()?.label ?? "It answered",
            body: text || "It answered.",
          })
        }
      />
    </div>
  )
}

// ---------------------------------------------------------------------------
// Plugins
// ---------------------------------------------------------------------------

/**
 * The plugin system, for admins: what the server has installed and where each came from, the registries
 * it installs from, and installing, updating, removing and starting one. The prototype's admin page is
 * the layout: one row a plugin, its state beside its name, and the actions on the right.
 */
function PluginsSection(props: { api: FleetApi; rookery: ClientRookery }): JSX.Element {
  const [installed, { refetch }] = createResource(() => props.api.listPlugins())
  const [registries, { refetch: refetchRegistries }] = createResource(() => props.api.pluginRegistries())
  const [updates, setUpdates] = createSignal<PluginNewer[] | null>(null)
  const [adding, setAdding] = createSignal(false)
  const [removing, setRemoving] = createSignal<PluginInfo | null>(null)
  const [busy, setBusy] = createSignal<string | null>(null)
  const [error, setError] = createSignal<string | null>(null)

  const reload = () => {
    void refetch()
    void refetchRegistries()
  }

  /** Runs one change, keeping what it reports and what it failed with. */
  const change = async (what: string, run: () => Promise<PluginReport | PluginInfo>) => {
    setBusy(what)
    setError(null)
    try {
      const done = await run()
      const lines = "lines" in done ? done.lines : [`${done.id} ${done.state}`]
      props.rookery.workbench.toast({
        kind: "success",
        title: `${what} done`,
        body: lines.join("\n") || undefined,
      })
      setUpdates(null)
      reload()
    } catch (failure) {
      setError(`${what} failed: ${errorMessage(failure)}`)
    } finally {
      setBusy(null)
    }
  }

  return (
    <div class="fleet-admin__section" data-part="admin-plugins">
      <Show when={error()}>
        {(text) => (
          <Callout tone="danger" data-part="plugins-error">
            {text()}
          </Callout>
        )}
      </Show>
      <Show when={installed.error}>
        {(failure) => (
          <Callout tone="danger" data-part="plugins-error">
            Could not read the plugins: {errorMessage(failure())}
          </Callout>
        )}
      </Show>
      <Show when={installed.loading && !installed()}>
        <LoadingCard title="Loading plugins…" />
      </Show>
      <Show when={installed()}>
        <Card
          title="Installed"
          count={installed()?.plugins.length}
          data-part="plugin-list"
          action={
            <span class="fleet-row-actions">
              <Button
                size="sm"
                variant="ghost"
                icon="refresh-cw"
                disabled={!!busy()}
                onClick={reload}
                data-part="refresh-plugins"
              >
                Refresh
              </Button>
              <label class="nc-btn nc-btn--secondary nc-btn--sm" data-part="upload-plugin">
                Upload egg
                <input
                  type="file"
                  accept=".egg,application/gzip"
                  class="nc-visually-hidden"
                  onChange={(e) => {
                    const file = e.currentTarget.files?.[0]
                    e.currentTarget.value = ""
                    if (file) void change(`Installing ${file.name}`, () => props.api.uploadPlugin(file))
                  }}
                />
              </label>
              <Button
                size="sm"
                variant="secondary"
                icon="plus"
                disabled={!!busy()}
                data-part="add-plugin"
                onClick={() => setAdding(true)}
              >
                Add plugin
              </Button>
            </span>
          }
        >
          <p class="nc-meta">
            A plugin is a package with a `rookery` target: host features, provisioners, and the client half
            this page's shell loads. Installing one runs none of its code; its tasks run when a host is
            applied.
          </p>
          <Show
            when={(installed()?.plugins ?? []).length > 0}
            fallback={
              <EmptyState
                icon="layers"
                title="No plugin installed"
                description="Add one from a registry, or upload an egg."
              />
            }
          >
            <For each={installed()?.plugins ?? []}>
              {(plugin) => (
                <PluginRow
                  plugin={plugin}
                  busy={!!busy()}
                  onStart={() =>
                    void change(`Starting ${plugin.label || plugin.id}`, () =>
                      props.api.activatePlugin(plugin.id),
                    )
                  }
                  onRemove={setRemoving}
                />
              )}
            </For>
          </Show>
          <Show when={(installed()?.missing ?? []).length > 0}>
            <Callout tone="warning" data-part="plugins-missing">
              The database records {installed()?.missing?.join(", ")} as installed, and the plugin folder does
              not have them. Reload the plugins to read the folder again.
            </Callout>
          </Show>
        </Card>

        <Card
          title="Updates"
          data-part="plugin-updates"
          action={
            <Button
              size="sm"
              variant="secondary"
              icon="refresh-cw"
              disabled={!!busy()}
              data-part="check-plugins"
              onClick={() =>
                void props.api
                  .checkPlugins()
                  .then(setUpdates)
                  .catch((failure) => setError(`Checking for updates failed: ${errorMessage(failure)}`))
              }
            >
              Check for updates
            </Button>
          }
        >
          <p class="nc-meta">
            Asks every registry whether a newer version of each plugin is there. A version younger than the
            registry's minimum release age waits, and is named with that reason.
          </p>
          <Show when={updates()} fallback={<span class="nc-meta">Not checked yet.</span>}>
            {(found) => (
              <Show
                when={found().some((one) => one.latest)}
                fallback={<span class="nc-meta">Every plugin is at its newest version.</span>}
              >
                <For each={found().filter((one) => one.latest)}>
                  {(one) => (
                    <div class="fleet-admin__row" data-plugin-update={one.id}>
                      <div class="fleet-admin__row-main">
                        <span class="mono fleet-admin__key">{one.package}</span>
                        <span class="nc-meta">
                          {one.version} → {one.latest}
                          {one.note ? ` · ${one.note}` : ""}
                        </span>
                      </div>
                      <div class="fleet-admin__row-actions">
                        <Button
                          size="sm"
                          variant="secondary"
                          disabled={!!busy()}
                          data-part="update-plugin"
                          onClick={() =>
                            void change(`Updating ${one.package}`, () => props.api.updatePlugin(one.id))
                          }
                        >
                          Update to {one.latest}
                        </Button>
                      </div>
                    </div>
                  )}
                </For>
              </Show>
            )}
          </Show>
        </Card>

        <Card
          title="Registries"
          count={registries()?.registries.length}
          data-part="plugin-registries"
          action={
            <Button
              size="sm"
              variant="ghost"
              icon="refresh-cw"
              disabled={!!busy()}
              onClick={() => void refetchRegistries()}
            >
              Refresh
            </Button>
          }
        >
          <p class="nc-meta">
            Rookery searches the registry named `rookery` first, then these in order. They are the lines of{" "}
            <span class="mono">{registries()?.file ?? "hatchery.kdl"}</span>.
          </p>
          <Show when={registries.error}>
            {(failure) => (
              <Callout tone="danger" data-part="plugin-registries-error">
                Could not read the plugin registries: {errorMessage(failure())}
              </Callout>
            )}
          </Show>
          <Show
            when={(registries()?.registries ?? []).length > 0}
            fallback={<span class="nc-meta">No plugin registry is added.</span>}
          >
            <For each={registries()?.registries ?? []}>
              {(registry) => (
                <div class="fleet-admin__row" data-plugin-registry={registry.location}>
                  <div class="fleet-admin__row-main">
                    <span class="fleet-admin__key">
                      {registry.name}{" "}
                      {registry.builtin ? (
                        <Badge square tone="outline">
                          built in
                        </Badge>
                      ) : null}
                    </span>
                    <span class="mono nc-meta">
                      {registry.kind} {registry.location}
                    </span>
                  </div>
                  <div class="fleet-admin__row-actions">
                    <Show when={registry.only.length > 0}>
                      <span class="nc-meta">Only {registry.only.join(", ")}</span>
                    </Show>
                  </div>
                </div>
              )}
            </For>
          </Show>
        </Card>
      </Show>

      <AddPluginDialog
        open={adding()}
        busy={!!busy()}
        onClose={() => setAdding(false)}
        onAdd={(spec, options) => {
          setAdding(false)
          void change(`Installing ${spec || options.git}`, () => props.api.addPlugin(spec, options))
        }}
      />

      <Dialog
        open={removing() !== null}
        onClose={() => {
          if (!busy()) setRemoving(null)
        }}
        title={`Remove ${removing()?.label || removing()?.id || ""}?`}
        description="Its settings, secrets and data stay with the server. Its host features stop being offered when a host is applied again."
        footer={
          <>
            <Button variant="ghost" disabled={!!busy()} onClick={() => setRemoving(null)}>
              Cancel
            </Button>
            <Button
              variant="danger"
              disabled={!!busy()}
              data-part="confirm-remove-plugin"
              onClick={() => {
                const plugin = removing()
                setRemoving(null)
                if (plugin) void change(`Removing ${plugin.id}`, () => props.api.removePlugin(plugin.id))
              }}
            >
              Remove plugin
            </Button>
          </>
        }
      >
        <Callout tone="warning">
          Remove <span class="mono">{removing()?.package || removing()?.id}</span> and its files from the
          server.
        </Callout>
      </Dialog>
    </div>
  )
}

/** One installed plugin: what it is, its state and why it is not usable, and what can be done with it. */
function PluginRow(props: {
  plugin: PluginInfo
  busy: boolean
  onStart(): void
  onRemove(plugin: PluginInfo): void
}): JSX.Element {
  const state = () => PLUGIN_STATE[props.plugin.state]
  const problem = () => props.plugin.problem || props.plugin.error?.message || ""
  return (
    <div class="fleet-admin__row" data-plugin={props.plugin.id}>
      <div class="fleet-admin__row-main">
        <span class="fleet-admin__key">
          {props.plugin.label || props.plugin.id} <span class="mono nc-muted">{props.plugin.version}</span>{" "}
          <Badge square tone={state().tone}>
            {state().label}
          </Badge>
        </span>
        <Show when={props.plugin.description}>
          <span class="nc-meta">{props.plugin.description}</span>
        </Show>
        <span class="mono nc-meta">
          {[props.plugin.package, props.plugin.origin, props.plugin.source].filter(Boolean).join(" · ")}
        </span>
        <Show when={props.plugin.dir}>
          <span class="mono nc-meta">{props.plugin.dir}</span>
        </Show>
        <Show when={problem()}>
          <Callout tone="danger" code={props.plugin.error?.code} data-part="plugin-problem">
            {problem()}
          </Callout>
        </Show>
      </div>
      <div class="fleet-admin__row-actions">
        <Show when={canActivate(props.plugin.state)}>
          <Button
            size="sm"
            variant="secondary"
            disabled={props.busy}
            data-part="activate-plugin"
            onClick={props.onStart}
          >
            Start
          </Button>
        </Show>
        <Button
          size="sm"
          variant="ghost"
          disabled={props.busy}
          data-part="remove-plugin"
          onClick={() => props.onRemove(props.plugin)}
        >
          Remove
        </Button>
      </div>
    </div>
  )
}

/** Installing a plugin: a package of the registries, an egg's address, or one folder of a git repository. */
function AddPluginDialog(props: {
  open: boolean
  busy: boolean
  onClose: () => void
  onAdd(spec: string, options: { git?: string; path?: string; ref?: string }): void
}): JSX.Element {
  const [spec, setSpec] = createSignal("")
  const [git, setGit] = createSignal("")
  const [path, setPath] = createSignal("")
  const [ref, setRef] = createSignal("")

  createEffect(
    on(
      () => props.open,
      (open) => {
        if (!open) return
        setSpec("")
        setGit("")
        setPath("")
        setRef("")
      },
      { defer: true },
    ),
  )

  const ready = () => (git().trim() ? !spec().trim() : !!spec().trim())

  return (
    <Dialog
      open={props.open}
      onClose={() => {
        if (!props.busy) props.onClose()
      }}
      title="Add a plugin"
      description="A package of the plugin registries, an egg's https address, or one folder of a git repository."
      size="lg"
      closeOnBackdrop={false}
      footer={
        <>
          <Button variant="ghost" disabled={props.busy} onClick={props.onClose}>
            Cancel
          </Button>
          <Button
            variant="primary"
            disabled={props.busy || !ready()}
            data-part="install-plugin"
            onClick={() =>
              props.onAdd(spec().trim(), {
                ...(git().trim() ? { git: git().trim() } : {}),
                ...(path().trim() ? { path: path().trim() } : {}),
                ...(ref().trim() ? { ref: ref().trim() } : {}),
              })
            }
          >
            {props.busy ? "Installing…" : "Install"}
          </Button>
        </>
      }
    >
      <div class="fleet-form" data-part="plugin-form">
        <TextField
          id="plugin-spec"
          label="Package or egg"
          placeholder="crow/fleet"
          mono
          value={spec()}
          disabled={!!git().trim()}
          help="`GROUP/ID`, `ID`, `ID@^1.2`, or the https address of an egg. Leave it empty with a git repository."
          onInput={(e) => setSpec(e.currentTarget.value)}
        />
        <TextField
          id="plugin-git"
          label="Git repository"
          placeholder="https://github.com/aiviarium/crow.git"
          mono
          value={git()}
          help="Installs one folder of it, at a tag, a branch or a commit."
          onInput={(e) => setGit(e.currentTarget.value)}
        />
        <div class="fleet-form__row">
          <TextField
            id="plugin-git-path"
            label="Folder"
            placeholder="plugins/fleet"
            mono
            value={path()}
            help="The package's folder in the repository; its root when empty."
            onInput={(e) => setPath(e.currentTarget.value)}
          />
          <TextField
            id="plugin-git-ref"
            label="Tag or branch"
            placeholder="v0.1.0"
            mono
            value={ref()}
            onInput={(e) => setRef(e.currentTarget.value)}
          />
        </div>
      </div>
    </Dialog>
  )
}
