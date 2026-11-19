// Asking the user in a dialog from anywhere: a confirmation (for discarding and deleting) or a line of text
// (a file name, a branch name). Rendered into the themed root so they look like the rest of Crow.
import { Button, Dialog, TextField } from "@aiviarium/nocturne"
import { createSignal } from "solid-js"
import { render } from "solid-js/web"

function mount<T>(build: (done: (v: T) => void) => import("solid-js").JSX.Element): Promise<T> {
  return new Promise<T>((resolve) => {
    const host = document.createElement("div")
    ;(document.querySelector("[data-theme]") ?? document.body).append(host)
    let dispose = () => {}
    const done = (v: T) => {
      dispose()
      host.remove()
      resolve(v)
    }
    dispose = render(() => build(done), host)
  })
}

export function confirmAction(o: {
  title: string
  body?: string
  confirm: string
  danger?: boolean
}): Promise<boolean> {
  return mount<boolean>((done) => (
    <Dialog
      open
      onClose={() => done(false)}
      title={o.title}
      description={o.body}
      size="sm"
      footer={
        <>
          <Button variant="ghost" onClick={() => done(false)}>
            Cancel
          </Button>
          <Button variant={o.danger ? "danger" : "primary"} onClick={() => done(true)} data-part="confirm">
            {o.confirm}
          </Button>
        </>
      }
    />
  ))
}

export function promptText(o: {
  title: string
  label: string
  value?: string
  confirm?: string
  placeholder?: string
  mono?: boolean
}): Promise<string | null> {
  return mount<string | null>((done) => {
    const [v, setV] = createSignal(o.value ?? "")
    let input: HTMLInputElement | undefined
    return (
      <Dialog
        open
        onClose={() => done(null)}
        title={o.title}
        size="sm"
        initialFocus={() => input}
        footer={
          <>
            <Button variant="ghost" onClick={() => done(null)}>
              Cancel
            </Button>
            <Button
              variant="primary"
              disabled={!v().trim()}
              onClick={() => done(v().trim())}
              data-part="confirm"
            >
              {o.confirm ?? "OK"}
            </Button>
          </>
        }
      >
        <form
          onSubmit={(e) => {
            e.preventDefault()
            if (v().trim()) done(v().trim())
          }}
        >
          <TextField
            label={o.label}
            value={v()}
            mono={o.mono}
            placeholder={o.placeholder}
            inputRef={(el) => {
              input = el
              queueMicrotask(() => {
                el.focus()
                const dot = el.value.lastIndexOf(".")
                el.setSelectionRange(0, dot > 0 ? dot : el.value.length)
              })
            }}
            onInput={(e) => setV(e.currentTarget.value)}
          />
        </form>
      </Dialog>
    )
  })
}
