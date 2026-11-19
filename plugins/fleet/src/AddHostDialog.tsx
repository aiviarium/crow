// Dialog for adding an existing machine (`rookery host add` in the UI): collects name, address,
// SSH user/port/auth, host type, saves via `hosts.save`, and optionally starts first contact via
// `hosts.act` (`trust-key`).
import { Button, Callout, Checkbox, Dialog, Select, TextField } from "@aiviarium/nocturne"
import { createSignal, type JSX, Show } from "solid-js"
import type { FleetApi, HostInfo, HostProfile, HostType } from "./api"
import { errorMessage, validateHostAddress, validateHostName } from "./format"

const HOST_TYPE_OPTIONS: Array<{ value: HostType; label: string; description: string }> = [
  { value: "workstation", label: "Workstation", description: "Full desktop, services, and agents" },
  { value: "node", label: "Node", description: "Headless server with rookeryd and services" },
  { value: "managed", label: "Managed", description: "SSH host configured by Rookery apply" },
  { value: "ssh", label: "SSH", description: "Plain SSH host without Rookery apply" },
]

const AUTH_OPTIONS = [
  { value: "key", label: "SSH key" },
  { value: "agent", label: "SSH agent" },
  { value: "password", label: "Password" },
]

export interface AddHostDialogProps {
  open: boolean
  api: FleetApi
  onClose: () => void
  onAdded: (result: { host: HostInfo; jobId?: string }) => void
}

export function AddHostDialog(props: AddHostDialogProps): JSX.Element {
  const [name, setName] = createSignal("")
  const [address, setAddress] = createSignal("")
  const [user, setUser] = createSignal("root")
  const [port, setPort] = createSignal("")
  const [auth, setAuth] = createSignal("key")
  const [hostType, setHostType] = createSignal<HostType>("workstation")
  const [firstContact, setFirstContact] = createSignal(true)
  const [password, setPassword] = createSignal("")
  const [nameError, setNameError] = createSignal<string | null>(null)
  const [addressError, setAddressError] = createSignal<string | null>(null)
  const [portError, setPortError] = createSignal<string | null>(null)
  const [submitError, setSubmitError] = createSignal<string | null>(null)
  const [busy, setBusy] = createSignal(false)

  const reset = () => {
    setName("")
    setAddress("")
    setUser("root")
    setPort("")
    setAuth("key")
    setHostType("workstation")
    setFirstContact(true)
    setPassword("")
    setNameError(null)
    setAddressError(null)
    setPortError(null)
    setSubmitError(null)
  }

  const close = () => {
    if (busy()) return
    reset()
    props.onClose()
  }

  const submit = async (e?: Event) => {
    e?.preventDefault()
    if (busy()) return

    const nErr = validateHostName(name())
    const aErr = validateHostAddress(address())
    let pErr: string | null = null
    let parsedPort: number | undefined
    const portText = port().trim()
    if (portText) {
      const n = Number(portText)
      if (!Number.isInteger(n) || n < 1 || n > 65535) {
        pErr = "Port must be between 1 and 65535."
      } else if (n !== 22) {
        parsedPort = n
      }
    }

    setNameError(nErr)
    setAddressError(aErr)
    setPortError(pErr)
    setSubmitError(null)
    if (nErr || aErr || pErr) return

    const cleanName = name().trim()
    const cleanAddr = address().trim()
    const cleanUser = user().trim()
    const chosenType = hostType()

    const profile: HostProfile = {
      access: {
        address: cleanAddr,
        ...(cleanUser ? { user: cleanUser } : {}),
        ...(parsedPort !== undefined ? { port: parsedPort } : {}),
        auth: auth(),
      },
    }
    if (chosenType === "workstation") {
      profile.builder = {}
    } else {
      profile.type = chosenType
    }

    setBusy(true)
    try {
      const saved = await props.api.saveHost(cleanName, profile)
      let jobId: string | undefined
      if (firstContact()) {
        const args: Record<string, string> = {}
        if (password()) args.password = password()
        const acted = await props.api.act({
          host: cleanName,
          action: "trust-key",
          arguments: Object.keys(args).length > 0 ? args : undefined,
        })
        jobId = acted.job
      }
      reset()
      props.onAdded({ host: saved, jobId })
    } catch (err) {
      setSubmitError(errorMessage(err))
    } finally {
      setBusy(false)
    }
  }

  return (
    <Dialog
      open={props.open}
      onClose={close}
      title="Add existing host"
      description="Save an existing machine's SSH details and optionally trust its host key."
      closeOnBackdrop={false}
      footer={
        <>
          <Button variant="ghost" disabled={busy()} onClick={close}>
            Cancel
          </Button>
          <Button
            variant="primary"
            disabled={busy()}
            data-part="add-host-submit"
            onClick={() => void submit()}
          >
            {busy() ? "Adding…" : firstContact() ? "Save and connect" : "Save host"}
          </Button>
        </>
      }
    >
      <form class="fleet-form" data-part="add-host-form" onSubmit={(e) => void submit(e)}>
        <Show when={submitError()}>
          {(err) => (
            <Callout tone="danger" data-part="add-host-error">
              {err()}
            </Callout>
          )}
        </Show>

        <div class="fleet-form__row">
          <TextField
            id="fleet-add-name"
            label="Host name"
            placeholder="studio"
            mono
            value={name()}
            error={nameError() ?? undefined}
            help="Lowercase letters, digits, and hyphens."
            onInput={(e) => {
              setName(e.currentTarget.value)
              setNameError(null)
            }}
          />
          <TextField
            id="fleet-add-address"
            label="Address"
            placeholder="192.0.2.10"
            mono
            value={address()}
            error={addressError() ?? undefined}
            help="IP address or DNS hostname."
            onInput={(e) => {
              setAddress(e.currentTarget.value)
              setAddressError(null)
            }}
          />
        </div>

        <div class="fleet-form__row">
          <TextField
            id="fleet-add-user"
            label="SSH user"
            placeholder="root"
            mono
            value={user()}
            onInput={(e) => setUser(e.currentTarget.value)}
          />
          <TextField
            id="fleet-add-port"
            label="SSH port"
            placeholder="22"
            mono
            value={port()}
            error={portError() ?? undefined}
            onInput={(e) => {
              setPort(e.currentTarget.value)
              setPortError(null)
            }}
          />
        </div>

        <div class="fleet-form__row">
          <Select
            label="Host type"
            options={HOST_TYPE_OPTIONS}
            value={hostType()}
            onChange={(v) => setHostType(v)}
          />
          <Select label="SSH auth" options={AUTH_OPTIONS} value={auth()} onChange={(v) => setAuth(v)} />
        </div>

        <Checkbox
          checked={firstContact()}
          onChange={setFirstContact}
          label="Run first contact (trust host key and install Rookery key)"
          data-part="add-host-first-contact"
        />

        <Show when={firstContact()}>
          <TextField
            id="fleet-add-password"
            label="One-time SSH password (optional)"
            type="password"
            autocomplete="off"
            value={password()}
            help="Used only for first contact; never saved to the host profile."
            onInput={(e) => setPassword(e.currentTarget.value)}
          />
        </Show>
      </form>
    </Dialog>
  )
}
