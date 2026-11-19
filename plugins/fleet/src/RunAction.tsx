// One of the server's actions as a form: the arguments it declares, the question to answer before a
// changing one runs, and the two ways it can answer — a job to follow, or a value it said at once.
import { Button, Callout, Dialog } from "@aiviarium/nocturne"
import { createEffect, createSignal, type JSX, on, Show } from "solid-js"
import { ArgumentFields } from "./ArgumentField"
import { actionConfirm, actionDefaults, argumentProblems, argumentsOf, resultText } from "./provisionApi"
import type { Acted, Action } from "./types"

export function RunActionDialog(props: {
  open: boolean
  action: Action | null
  /** What runs it: `provisioners.act`, `resources.act` or `installation.act`. */
  run(act: { action: string; arguments: Record<string, string> }): Promise<Acted>
  onClose(): void
  onJob(jobId: string): void
  /** What it answered, for an action that only reads. */
  onResult(text: string): void
}): JSX.Element {
  const [values, setValues] = createSignal<Record<string, string>>({})
  const [errors, setErrors] = createSignal<Record<string, string>>({})
  const [error, setError] = createSignal<string | null>(null)
  const [busy, setBusy] = createSignal(false)

  createEffect(
    on(
      () => props.action,
      (action) => {
        if (!action) return
        setValues(actionDefaults(action))
        setErrors({})
        setError(null)
      },
      { defer: true },
    ),
  )

  const submit = async () => {
    const action = props.action
    if (!action || busy()) return
    const problems = argumentProblems(action.arguments, values())
    setErrors(problems)
    if (Object.keys(problems).length > 0) return
    setBusy(true)
    setError(null)
    try {
      const acted = await props.run({
        action: action.name,
        arguments: argumentsOf(action.arguments, values()),
      })
      if (acted.job) {
        props.onJob(acted.job)
      } else {
        props.onResult(resultText(acted.result))
      }
      props.onClose()
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : String(failure))
    } finally {
      setBusy(false)
    }
  }

  const question = () => (props.action ? actionConfirm(props.action, values()) : null)

  return (
    <Dialog
      open={props.open}
      onClose={() => {
        if (!busy()) props.onClose()
      }}
      title={props.action?.label ?? "Run action"}
      description={props.action?.help}
      closeOnBackdrop={false}
      footer={
        <>
          <Button variant="ghost" disabled={busy()} onClick={props.onClose}>
            Cancel
          </Button>
          <Button
            variant={question() ? "danger" : "primary"}
            disabled={busy()}
            data-part="run-action-submit"
            onClick={() => void submit()}
          >
            {busy() ? "Starting…" : (props.action?.label ?? "Run")}
          </Button>
        </>
      }
    >
      <div class="fleet-form" data-part="run-action-form">
        <Show when={question()}>
          {(text) => (
            <Callout tone="warning" data-part="run-action-confirm">
              {text()}
            </Callout>
          )}
        </Show>
        <Show when={props.action}>
          {(action) => (
            <ArgumentFields
              arguments={action().arguments}
              values={values()}
              errors={errors()}
              idPrefix="run-action-argument"
              onChange={(key, value) => {
                setValues((prev) => ({ ...prev, [key]: value }))
                setError(null)
              }}
            />
          )}
        </Show>
        <Show when={error()}>
          {(text) => (
            <Callout tone="danger" data-part="run-action-error">
              {text()}
            </Callout>
          )}
        </Show>
      </div>
    </Dialog>
  )
}
