// Dialog for running a host action that takes arguments or requires confirmation.
import { Button, Callout, Dialog } from "@aiviarium/nocturne"
import { createEffect, createSignal, For, type JSX, Show } from "solid-js"
import { ArgumentField } from "./ArgumentField"
import type { Action } from "./api"
import type { FleetApi } from "./fleetApi"
import { errorMessage } from "./format"

export interface ActionDialogProps {
  host: string
  action: Action | null
  api: FleetApi
  onClose: () => void
  onStarted: (jobId: string) => void
}

function initialValues(action: Action): Record<string, string> {
  const out: Record<string, string> = {}
  for (const arg of action.arguments) {
    out[arg.name] = arg.default ?? ""
  }
  return out
}

export function ActionDialog(props: ActionDialogProps): JSX.Element {
  const [values, setValues] = createSignal<Record<string, string>>({})
  const [error, setError] = createSignal<string | null>(null)
  const [busy, setBusy] = createSignal(false)

  createEffect(() => {
    const act = props.action
    if (act) {
      setValues(initialValues(act))
      setError(null)
    }
  })

  const setField = (name: string, val: string) => {
    setValues((prev) => ({ ...prev, [name]: val }))
    setError(null)
  }

  const submit = async (e?: Event) => {
    e?.preventDefault()
    const act = props.action
    if (!act || busy()) return

    const current = values()
    for (const arg of act.arguments) {
      const val = (current[arg.name] ?? "").trim()
      if (arg.required && !val) {
        setError(`${arg.label || arg.name} is required.`)
        return
      }
      if (arg.confirm && arg.default && val !== arg.default) {
        setError(`Type "${arg.default}" to confirm.`)
        return
      }
    }

    const args: Record<string, string> = {}
    for (const arg of act.arguments) {
      const val = current[arg.name]
      if (val !== undefined && val !== "") args[arg.name] = val
    }

    setBusy(true)
    setError(null)
    try {
      const acted = await props.api.act({
        host: props.host,
        action: act.name,
        arguments: args,
      })
      if (acted.job) props.onStarted(acted.job)
    } catch (err) {
      setError(errorMessage(err))
    } finally {
      setBusy(false)
    }
  }

  return (
    <Dialog
      open={props.action !== null}
      onClose={() => {
        if (!busy()) props.onClose()
      }}
      title={props.action?.label ?? "Run action"}
      description={props.action?.help}
      closeOnBackdrop={false}
      footer={
        <>
          <Button variant="ghost" disabled={busy()} onClick={() => props.onClose()}>
            Cancel
          </Button>
          <Button
            variant={props.action?.confirm ? "danger" : "primary"}
            disabled={busy()}
            data-part="action-dialog-submit"
            onClick={() => void submit()}
          >
            {busy() ? "Starting…" : (props.action?.label ?? "Run")}
          </Button>
        </>
      }
    >
      <Show when={props.action}>
        {(act) => (
          <form class="fleet-form" data-part="action-dialog-form" onSubmit={(e) => void submit(e)}>
            <Show when={act().confirm}>
              {(confirmText) => (
                <Callout tone="warning" data-part="action-dialog-confirm">
                  {confirmText()}
                </Callout>
              )}
            </Show>

            <Show when={error()}>
              {(err) => (
                <Callout tone="danger" data-part="action-dialog-error">
                  {err()}
                </Callout>
              )}
            </Show>

            <For each={act().arguments}>
              {(arg) => (
                <ArgumentField
                  argument={arg}
                  value={values()[arg.name] ?? ""}
                  error={error() ?? undefined}
                  idPrefix="action-arg"
                  onChange={(v) => setField(arg.name, v)}
                />
              )}
            </For>
          </form>
        )}
      </Show>
    </Dialog>
  )
}
