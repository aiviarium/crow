// Starting a session on Parrot: pick a host, pick an installed agent driver (Claude Code, Codex, …),
// optionally choose a workspace directory or git worktree, configure model/mode/effort from the
// agent's Parrot `ConfigOption`s, and send the first prompt (`session/new` + `session/prompt`).
import { Button, Callout, Select, TextField } from "@aiviarium/nocturne"
import { createEffect, createMemo, createSignal, For, on, Show } from "solid-js"
import { errorMessage } from "./api"
import { SessionComposer } from "./chat"
import { findOptionByRole, optionStringValue } from "./parrot"
import type { AgentsStore, PromptInput } from "./store"

const SUGGESTIONS = [
  { label: "Find and fix a bug", text: "Find the most likely bug in this repository and fix it." },
  { label: "Explain this codebase", text: "Explain how this codebase is organised, briefly." },
  { label: "Write a project brief", text: "Write a short project brief from the README." },
]

export function NewSession(props: {
  store: AgentsStore
  initialHost?: string | null
  onHostChange?: (host: string) => void
  onStarted: (host: string, sessionId: string) => void
}) {
  const [host, setHost] = createSignal<string>(props.initialHost ?? props.store.selectedHost() ?? "")
  const [agentId, setAgentId] = createSignal<string>("")
  const [workspaceMode, setWorkspaceMode] = createSignal<"default" | "dir" | "worktree">("default")
  const [workspacePath, setWorkspacePath] = createSignal("")
  const [branch, setBranch] = createSignal("")
  const [optionValues, setOptionValues] = createSignal<Record<string, unknown>>({})
  const [busy, setBusy] = createSignal(false)
  const [err, setErr] = createSignal<string | null>(null)

  // Keep host in sync with parent selection or first available host.
  createEffect(() => {
    if (props.initialHost && props.initialHost !== host()) {
      setHost(props.initialHost)
      return
    }
    const list = props.store.hosts()
    if (!host() && list.length > 0) {
      const preferred = list.find((h) => h.state === "online") ?? list[0]!
      setHost(preferred.name)
    }
  })

  const runtime = createMemo(() => (host() ? props.store.hostRuntime(host()) : null))

  // Connect to the chosen host so its agents and workspaces load.
  createEffect(
    on(host, (h) => {
      if (!h) return
      props.store.setSelectedHost(h)
      props.onHostChange?.(h)
      setAgentId("")
      setOptionValues({})
      setErr(null)
      void props.store
        .hostRuntime(h)
        .connect()
        .catch(() => {
          // Connection error is surfaced via `runtime().error()`.
        })
    }),
  )

  const agents = createMemo(() => runtime()?.agents() ?? [])
  const selectedAgent = createMemo(() => agents().find((a) => a.id === agentId()) ?? null)

  // Pick the first usable agent on the host automatically.
  createEffect(() => {
    const list = agents()
    if (!list.length) return
    if (!agentId() || !list.some((a) => a.id === agentId())) {
      const usable = list.find((a) => a.usable) ?? list[0]!
      setAgentId(usable.id)
    }
  })

  // Seed default option values when agent changes.
  createEffect(
    on(agentId, () => {
      setOptionValues({})
    }),
  )

  const agentOptions = createMemo(() => {
    const base = selectedAgent()?.options ?? []
    const overrides = optionValues()
    return base.map((o) => (o.id in overrides ? { ...o, value: overrides[o.id] } : o))
  })

  const setOption = (roleOrId: string, value: string) => {
    const opt =
      findOptionByRole(agentOptions(), roleOrId as "model" | "mode" | "effort") ??
      agentOptions().find((o) => o.id === roleOrId)
    const id = opt?.id ?? roleOrId
    setOptionValues((prev) => ({ ...prev, [id]: value }))
  }

  const canStart = () => !busy() && !!host() && !!agentId() && runtime()?.status() === "connected"

  const start = async (input: PromptInput) => {
    const h = host()
    const a = agentId()
    if (!h || !a) return
    setErr(null)
    setBusy(true)
    try {
      const pathTrim = workspacePath().trim()
      const workspace =
        workspaceMode() === "dir" && pathTrim
          ? ({ kind: "dir", path: pathTrim } as const)
          : workspaceMode() === "worktree" && pathTrim
            ? ({
                kind: "worktree",
                repo: pathTrim,
                ...(branch().trim() ? { branch: branch().trim() } : {}),
              } as const)
            : undefined

      const res = await props.store.startSession(h, {
        agent: a,
        workspace,
        options: optionValues(),
        prompt: input.text,
        context: input.context,
        attachments: input.attachments,
      })
      props.onStarted(res.host, res.session.id)
    } catch (e) {
      setErr(errorMessage(e))
    } finally {
      setBusy(false)
    }
  }

  const modelOpt = () => findOptionByRole(agentOptions(), "model")
  const modeOpt = () => findOptionByRole(agentOptions(), "mode")
  const effortOpt = () => findOptionByRole(agentOptions(), "effort")

  return (
    <main class="ag-main ag-new" data-part="new-session">
      <div class="ag-new__inner">
        <h1 class="ag-new__title title">What should we work on?</h1>
        <div class="ag-new__fields">
          <Select
            label="Host"
            options={props.store.hosts().map((h) => ({
              value: h.name,
              label: h.name,
              description: `${h.kind} · ${h.state}`,
              icon: "server" as const,
              disabled: h.state === "offline",
            }))}
            value={host()}
            onChange={setHost}
            placeholder={props.store.hostsLoading() ? "Loading hosts…" : "No hosts available"}
          />
          <Select
            label="Agent"
            options={agents().map((a) => ({
              value: a.id,
              label: a.name,
              description: [
                a.harness?.version ? `v${a.harness.version}` : a.driver.name,
                !a.installed
                  ? "not installed"
                  : a.auth === "signed_out"
                    ? "signed out"
                    : (a.detail ?? undefined),
              ]
                .filter(Boolean)
                .join(" · "),
              icon: "sparkle" as const,
              disabled: !a.usable,
            }))}
            value={agentId()}
            onChange={setAgentId}
            placeholder={
              runtime()?.status() === "connecting"
                ? "Connecting to host…"
                : agents().length === 0
                  ? "No agent drivers"
                  : "Pick an agent"
            }
          />
          <Select
            label="Workspace"
            options={[
              { value: "default", label: "Host default", description: "Use the host's default workspace" },
              { value: "dir", label: "Directory", description: "Work directly in a path on the host" },
              {
                value: "worktree",
                label: "New worktree",
                description: "Create a git worktree on its own branch",
              },
            ]}
            value={workspaceMode()}
            onChange={(v) => setWorkspaceMode(v as "default" | "dir" | "worktree")}
          />
          <Show when={workspaceMode() !== "default"}>
            <TextField
              label={workspaceMode() === "worktree" ? "Repository path" : "Working directory"}
              mono
              placeholder="/home/user/project"
              value={workspacePath()}
              onInput={(e) => setWorkspacePath(e.currentTarget.value)}
            />
          </Show>
          <Show when={workspaceMode() === "worktree"}>
            <TextField
              label="Branch"
              mono
              placeholder="crow/<session>"
              value={branch()}
              onInput={(e) => setBranch(e.currentTarget.value)}
            />
          </Show>
        </div>

        <Show when={runtime()?.status() === "error" && runtime()?.error()}>
          <Callout tone="danger" data-part="host-error">
            <div class="ag-unrec">
              <span>
                Could not connect to {host()}: {runtime()!.error()}
              </span>
              <Button
                size="sm"
                variant="secondary"
                onClick={() =>
                  void runtime()
                    ?.connect(true)
                    .catch(() => {})
                }
              >
                Retry
              </Button>
            </div>
          </Callout>
        </Show>

        <Show when={runtime()?.status() === "connected" && agents().length === 0 && runtime()?.agentsHint()}>
          <Callout tone="info" data-part="agents-hint">
            {runtime()!.agentsHint()}
          </Callout>
        </Show>

        <SessionComposer
          rookery={props.store.rookery}
          contributions={props.store.composerContributions()}
          options={agentOptions()}
          actions={selectedAgent()?.actions ?? []}
          onSend={start}
          disabled={!canStart()}
          placeholder="Describe the task…"
          model={optionStringValue(modelOpt())}
          mode={optionStringValue(modeOpt())}
          effort={optionStringValue(effortOpt())}
          onModel={(id) => setOption("model", id)}
          onMode={(id) => setOption("mode", id)}
          onEffort={(id) => setOption("effort", id)}
        />

        <Show when={err()}>
          <p class="nc-meta ag-error-text">{err()}</p>
        </Show>

        <div class="ag-new__suggestions">
          <For each={SUGGESTIONS}>
            {(s) => (
              <Button
                size="sm"
                variant="ghost"
                icon="sparkle"
                disabled={!canStart()}
                onClick={() => void start({ text: s.text })}
              >
                {s.label}
              </Button>
            )}
          </For>
        </div>
      </div>
    </main>
  )
}
