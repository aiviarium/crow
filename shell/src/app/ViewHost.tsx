// Hosts the active route's view: Crow's Home view, a loaded plugin view (inside an ErrorBoundary),
// or a clean not-found / loading state.
import { Button, Callout, EmptyState } from "@aiviarium/nocturne"
import { ErrorBoundary, type JSX, Match, Show, Switch } from "solid-js"
import { InboxView } from "../inbox/InboxView"
import { JobsView } from "../jobs/JobsView"
import { Home } from "./Home"
import { HOME_VIEW, INBOX_ITEM_VIEW, INBOX_VIEW, JOB_VIEW, JOBS_VIEW, type ShellApp } from "./state"

export function ViewHost(props: { app: ShellApp }): JSX.Element {
  const match = () => props.app.routeMatch()
  const viewEntry = () => {
    const m = match()
    return m ? props.app.loader.views()[m.view] : undefined
  }
  const pluginClient = () => {
    const m = match()
    return m ? props.app.loader.clients[m.plugin] : undefined
  }

  return (
    <div class="crow-view-host" data-part="view-host">
      <Switch>
        <Match when={match()?.view === HOME_VIEW}>
          <Home app={props.app} />
        </Match>
        <Match when={match()?.view === JOBS_VIEW || match()?.view === JOB_VIEW}>
          <JobsView app={props.app} jobId={match()?.params.id} />
        </Match>
        <Match when={match()?.view === INBOX_VIEW || match()?.view === INBOX_ITEM_VIEW}>
          <InboxView app={props.app} notificationId={match()?.params.id} />
        </Match>
        <Match when={match() && viewEntry()}>
          <Show when={{ match: match()!, entry: viewEntry()! }} keyed>
            {(current) => {
              const Comp = current.entry.component
              return (
                <ErrorBoundary
                  fallback={(err) => (
                    <div class="crow-home">
                      <Callout tone="danger" data-part="view-error">
                        View {current.match.view} failed to render:{" "}
                        {err instanceof Error ? err.message : String(err)}
                      </Callout>
                    </div>
                  )}
                >
                  <Comp
                    view={{
                      id: current.match.view,
                      plugin: current.entry.plugin,
                      path: current.match.path,
                      params: current.match.params,
                      setTitle: (t) => props.app.setViewTitle(t),
                      setDirty: () => {},
                      setLoading: () => {},
                    }}
                  />
                </ErrorBoundary>
              )
            }}
          </Show>
        </Match>
        <Match when={match() && pluginClient()?.status === "failed"}>
          <div class="crow-home">
            <Callout tone="danger" data-part="plugin-error">
              Plugin {match()!.plugin} failed to load: {pluginClient()?.error ?? "unknown error"}
            </Callout>
          </div>
        </Match>
        <Match when={match() && (!props.app.loader.loaded() || pluginClient()?.status === "loading")}>
          <div class="crow-home" data-part="view-loading">
            <span class="nc-meta">Loading view…</span>
          </div>
        </Match>
        <Match when={true}>
          <div class="crow-home" data-part="view-not-found">
            <EmptyState
              title="Page not found"
              description={`No view is registered for ${props.app.currentUrl().pathname}.`}
            >
              <Button variant="secondary" href="/">
                Back to Home
              </Button>
            </EmptyState>
          </div>
        </Match>
      </Switch>
    </div>
  )
}
