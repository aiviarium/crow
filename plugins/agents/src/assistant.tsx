// The workbench's assistant pane (`agents.assistant`): the Parrot session active on this host,
// compact, or a composer that starts one there.
import { Button, EmptyState, IconButton } from "@aiviarium/nocturne"
import type { ClientRookery } from "@rookery/sdk/client"
import { createEffect, createMemo, createSignal, Show } from "solid-js"
import { errorMessage, hostNameFromEnv } from "./api"
import { Conversation, SessionComposer } from "./chat"
import type { SessionSummary } from "./parrot"
import { type AgentsStore, formatChatPath, type PromptInput } from "./store"

const LIVE = new Set(["starting", "running", "idle", "requires_action"])

export function AssistantView(rookery: ClientRookery, store: AgentsStore) {
  return (props: { view: { params: Readonly<Record<string, string>> } }) => {
    const host = () => {
      const raw = props.view.params.env ?? props.view.params.host ?? store.selectedHost() ?? ""
      return hostNameFromEnv(raw)
    }
    const path = () => props.view.params.path ?? ""

    const runtime = createMemo(() => (host() ? store.hostRuntime(host()) : null))
    createEffect(() => {
      const rt = runtime()
      if (rt && rt.status() === "idle") {
        void rt.connect().catch(() => {})
      }
    })

    const [fresh, setFresh] = createSignal(false)
    const [err, setErr] = createSignal<string | null>(null)

    const current = createMemo<SessionSummary | undefined>(() => {
      if (fresh()) return undefined
      const list = [...(runtime()?.sessions() ?? [])]
        .filter((s) => !s.archived)
        .sort((a, b) => Date.parse(b.updated) - Date.parse(a.updated))
      return list.find((s) => LIVE.has(s.state)) ?? list[0]
    })

    const start = async (input: PromptInput) => {
      const h = host()
      const rt = runtime()
      if (!h || !rt) return
      const agent = rt.agents().find((a) => a.usable) ?? rt.agents()[0]
      if (!agent) {
        setErr("No agent drivers available on this host.")
        return
      }
      setErr(null)
      try {
        await store.startSession(h, {
          agent: agent.id,
          ...(path() ? { workspace: { kind: "dir", path: path() } } : {}),
          prompt: input.text,
          context: input.context,
          attachments: input.attachments,
        })
        setFresh(false)
      } catch (e) {
        setErr(errorMessage(e))
      }
    }

    return (
      <div class="ag-assistant" data-part="agents-assistant" data-host={host()} data-path={path()}>
        <Show
          when={current()}
          keyed
          fallback={
            <div class="ag-assistant__start" data-part="assistant-start">
              <EmptyState
                icon="sparkle"
                title="An agent on this host"
                description={path() || host() || "Select a host first"}
              />
              <SessionComposer
                rookery={rookery}
                contributions={store.composerContributions()}
                options={runtime()?.agents()[0]?.options ?? []}
                actions={runtime()?.agents()[0]?.actions ?? []}
                onSend={start}
                disabled={!host() || runtime()?.status() !== "connected"}
                placeholder="What should it do here?"
              />
              <Show when={err()}>
                <p class="nc-meta ag-error-text">{err()}</p>
              </Show>
            </div>
          }
        >
          {(s) => (
            <>
              <div class="ag-assistant__bar">
                <span class="label ag-assistant__title">{s.title || "Agent session"}</span>
                <span class="crow-push" />
                <IconButton
                  label="New session"
                  icon="plus"
                  onClick={() => setFresh(true)}
                  data-part="assistant-new"
                />
                <Button
                  size="sm"
                  variant="ghost"
                  icon="arrow-up-right"
                  onClick={() =>
                    rookery.workbench.openView("agents.chat", {
                      path: formatChatPath(host(), s.id),
                    })
                  }
                >
                  Open
                </Button>
              </div>
              <Conversation rookery={rookery} store={store} host={host()} id={s.id} phone />
            </>
          )}
        </Show>
      </div>
    )
  }
}
