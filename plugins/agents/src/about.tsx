// At the top of a conversation: what started the session when no human client did (a hook,
// wake, parent session, or remote peer).
import { Icon } from "@aiviarium/nocturne"
import { type JSX, Show } from "solid-js"
import type { Session } from "./parrot"

const ORIGIN_LABEL: Record<string, string> = {
  hook: "a hook",
  session: "another session",
  wake: "a wake",
  remote: "a linked runtime",
  harness: "the harness",
  runtime: "the runtime",
}

export function SessionAbout(props: { session: Session | null }): JSX.Element {
  const origin = () => {
    const o = props.session?.origin
    if (!o || o.kind === "client") return null
    return o
  }
  return (
    <Show when={origin()}>
      {(o) => (
        <div class="ag-about nc-meta" data-part="session-origin">
          <Icon name="clock" size="sm" />
          <span>
            Started by {ORIGIN_LABEL[o().kind] ?? o().kind}
            {o().name ? ` “${o().name}”` : ""}
            {o().principal ? ` for ${o().principal}` : ""}
          </span>
        </div>
      )}
    </Show>
  )
}
