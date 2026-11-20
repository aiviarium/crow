// Root Crow component switching between initial session check, SignInPage, authenticated Shell,
// and an ended-session overlay keeping the mounted Shell underneath.
import { type JSX, Match, Show, Switch } from "solid-js"
import { SignInPage } from "../auth/SignInPage"
import { CrowEditorServices } from "./editor"
import { Shell } from "./Shell"
import type { ShellApp } from "./state"

export function App(props: { app: ShellApp }): JSX.Element {
  return (
    <Switch>
      <Match when={props.app.authPhase() === "checking"}>
        <main class="crow-signin" data-part="checking">
          <span class="nc-meta">Connecting…</span>
        </main>
      </Match>
      <Match when={props.app.authPhase() === "signed-out"}>
        <SignInPage app={props.app} options={props.app.signInOptions()} />
      </Match>
      <Match when={props.app.authPhase() === "ready" || props.app.authPhase() === "ended"}>
        <CrowEditorServices app={props.app}>
          <Shell app={props.app} />
        </CrowEditorServices>
        <Show when={props.app.authPhase() === "ended"}>
          <SignInPage app={props.app} options={props.app.signInOptions()} ended />
        </Show>
      </Match>
    </Switch>
  )
}
