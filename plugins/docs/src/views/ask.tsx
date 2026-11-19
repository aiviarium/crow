// Small questions as dialogs (a name, a yes or no), so views can `await ask(...)` instead of building a dialog
// each time. <AskHost /> renders the open one; the workspace and blocks mount it once.
import { Button, Dialog } from "@aiviarium/nocturne"
import { createSignal, type JSX, onCleanup, Show } from "solid-js"

interface Question {
  title: string
  description?: string
  /** Asks for text when set (the initial value). */
  value?: string
  placeholder?: string
  confirm: string
  danger?: boolean
  resolve: (v: string | null) => void
}

const [question, setQuestion] = createSignal<Question | null>(null)

/** Asks for a line of text; null when cancelled. */
export function ask(
  title: string,
  opts: { value?: string; placeholder?: string; confirm?: string; description?: string } = {},
) {
  return new Promise<string | null>((resolve) => {
    question()?.resolve(null)
    setQuestion({
      title,
      value: opts.value ?? "",
      placeholder: opts.placeholder,
      description: opts.description,
      confirm: opts.confirm ?? "Save",
      resolve,
    })
  })
}

/** Asks to confirm something; true when confirmed. */
export async function confirmAsk(
  title: string,
  opts: { description?: string; confirm: string; danger?: boolean },
) {
  return new Promise<boolean>((resolve) => {
    question()?.resolve(null)
    setQuestion({
      title,
      description: opts.description,
      confirm: opts.confirm,
      danger: opts.danger,
      resolve: (v) => resolve(v !== null),
    })
  })
}

let next = 0
const [hosts, setHosts] = createSignal<number[]>([])

export function AskHost(): JSX.Element {
  // Several hosts may be on a page (workspace, blocks in other plugins' documents): the oldest one renders.
  const me = ++next
  setHosts((h) => [...h, me])
  onCleanup(() => setHosts((h) => h.filter((x) => x !== me)))
  const first = () => hosts()[0] === me
  const done = (v: string | null) => {
    const q = question()
    setQuestion(null)
    q?.resolve(v)
  }
  let input: HTMLInputElement | undefined
  return (
    <Show when={first() && question()}>
      {(q) => (
        <Dialog
          open={true}
          onClose={() => done(null)}
          title={q().title}
          description={q().description}
          size="sm"
          initialFocus={() => input}
          footer={
            <>
              <Button variant="secondary" onClick={() => done(null)}>
                Cancel
              </Button>
              <Button
                variant={q().danger ? "danger" : "primary"}
                data-part="ask-confirm"
                onClick={() => done(q().value === undefined ? "" : (input?.value ?? ""))}
              >
                {q().confirm}
              </Button>
            </>
          }
        >
          <Show when={q().value !== undefined}>
            <input
              ref={input}
              class="nc-input docs-ask__input"
              value={q().value}
              placeholder={q().placeholder ?? ""}
              aria-label={q().title}
              data-part="ask-input"
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  e.preventDefault()
                  done(e.currentTarget.value)
                }
              }}
            />
          </Show>
        </Dialog>
      )}
    </Show>
  )
}
