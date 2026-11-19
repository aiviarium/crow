// "Start an agent on this issue": pick the harness, the environment, a checkout of one of the project's
// repositories and whether to work in a new worktree on a branch named after the issue, then start. The
// host half (server/agents.ts) starts the session with the issue as context and links it to the issue.

import { Button, Callout, Dialog, Select, Switch, TextArea, TextField } from "@aiviarium/nocturne"
import type { ClientRookery } from "@rookery/sdk/client"
import { createEffect, createResource, createSignal, on, Show } from "solid-js"
import { branchName } from "../lib/keys"
import type { IssueRow } from "../lib/model"
import { agentsOf, entitiesOf, envCheckouts, toRookeryError } from "./sdk"
import type { ProjectStore } from "./store"

/** A session's state, live: `crow.agents` pushes every change to sessions the person may see. */
const [sessionStates, setSessionStates] = createSignal<Record<string, { state: string; title: string }>>({})
let following = false
export function sessionState(crow: ClientRookery, uri: string): { state: string; title: string } | undefined {
  const agents = agentsOf(crow)
  const id = uri.replace("session://", "")
  if (agents && !following) {
    following = true
    agents.onChanged((s) => setSessionStates((m) => ({ ...m, [s.id]: { state: s.state, title: s.title } })))
  }
  const known = sessionStates()[id]
  if (!known && agents) {
    setSessionStates((m) => ({ ...m, [id]: { state: "", title: "" } }))
    agents
      .get(id)
      .then((s) => setSessionStates((m) => ({ ...m, [id]: { state: s.state, title: s.title } })))
      .catch(() => {})
  }
  return known?.state ? known : undefined
}

/** A session's state in words. */
export const STATE_WORDS: Record<string, string> = {
  starting: "Starting",
  idle: "Idle",
  working: "Working",
  awaitingApproval: "Needs approval",
  awaitingInput: "Needs input",
  ended: "Ended",
  lost: "Lost",
  unrecognised: "Unrecognised",
}

export function AgentDialog(props: {
  crow: ClientRookery
  open: boolean
  onClose: () => void
  issue: IssueRow
  store: ProjectStore
}) {
  const crow = props.crow
  const [available] = createResource(
    () => props.open,
    async (open) =>
      open
        ? (
            await crow.host
              .call<{ available: boolean }>("agentsAvailable", {})
              .catch(() => ({ available: false }))
          ).available
        : false,
  )
  const [drivers] = createResource(
    () => props.open && available(),
    async (ok) =>
      ok
        ? ((await agentsOf(crow)
            ?.drivers?.()
            .catch(() => [])) ?? [])
        : [],
  )
  const [envs] = createResource(
    () => props.open,
    async (open) => (open ? await crow.env.list().catch(() => []) : []),
  )
  const [repos] = createResource(
    () => props.open,
    async (open) =>
      open
        ? (
            await crow.host
              .call<{ repositories: Array<{ url: string; name: string }> }>("repositories", {
                space: props.store.space,
              })
              .catch(() => ({ repositories: [] }))
          ).repositories
        : [],
  )
  const [driver, setDriver] = createSignal("")
  const [env, setEnv] = createSignal("")
  const [checkout, setCheckout] = createSignal("")
  const [worktree, setWorktree] = createSignal(true)
  const [branch, setBranch] = createSignal("")
  const [instructions, setInstructions] = createSignal("")
  const [busy, setBusy] = createSignal(false)
  const [problem, setProblem] = createSignal<string | null>(null)

  createEffect(
    on(
      () => props.open,
      (o) => {
        if (!o) return
        setBranch(branchName(props.issue.key, props.issue.title))
        setProblem(null)
      },
    ),
  )
  createEffect(() => {
    const list = envs() ?? []
    if (!env() && list.length) setEnv((list.find((e: any) => e.state === "online") ?? list[0]!).name)
  })
  createEffect(() => {
    const d = drivers() ?? []
    if (!driver() && d.length) setDriver(d[0]!.id)
  })
  const [checkouts] = createResource(env, async (e) => (e ? await envCheckouts(crow, e).catch(() => []) : []))
  // A checkout of one of the project's repositories comes first.
  const sortedCheckouts = () => {
    const urls = new Set((repos() ?? []).map((r) => r.url.replace(/\.git$/, "")))
    return [...(checkouts() ?? [])]
      .filter((c) => !c.worktreeOf)
      .sort(
        (a, b) =>
          Number(urls.has((b.url ?? "").replace(/\.git$/, ""))) -
          Number(urls.has((a.url ?? "").replace(/\.git$/, ""))),
      )
  }
  createEffect(() => {
    const list = sortedCheckouts()
    if (!checkout() && list.length) setCheckout(list[0]!.path)
  })

  const start = async () => {
    setBusy(true)
    setProblem(null)
    try {
      const r = await crow.host.call<{ session: string | null; branch: string; moved: boolean }>(
        "startAgent",
        {
          space: props.store.space,
          id: props.issue.id,
          ...(driver() ? { driver: driver() } : {}),
          env: env(),
          ...(checkout() ? { checkout: checkout() } : {}),
          worktree: worktree(),
          branch: branch(),
          ...(instructions().trim() ? { instructions: instructions() } : {}),
        },
      )
      crow.workbench.toast({
        title: "Agent started",
        body: `${props.issue.key} on ${worktree() && checkout() ? r.branch : env()}`,
        kind: "success",
      })
      props.onClose()
      if (r.session) entitiesOf(crow).open(r.session)
    } catch (e) {
      setProblem(toRookeryError(e).message)
    } finally {
      setBusy(false)
    }
  }

  return (
    <Dialog
      open={props.open}
      onClose={props.onClose}
      title={`Start an agent on ${props.issue.key}`}
      description="The agent gets the issue, its comments and linked docs as context. The session is linked to the issue and the issue moves to started."
      size="md"
      footer={
        <>
          <Button variant="ghost" onClick={props.onClose}>
            Cancel
          </Button>
          <Button
            variant="accent"
            icon="agent"
            loading={busy()}
            disabled={!env() || available() === false}
            onClick={start}
            data-testid="agent-start"
          >
            Start agent
          </Button>
        </>
      }
      data-part="agent-dialog"
    >
      <div class="projects__form">
        <Show when={available() === false}>
          <Callout tone="info">
            <span class="label">Agent sessions are not on this server yet.</span> Everything below is ready:
            the branch name, the worktree and the link to the issue are made when sessions arrive.
          </Callout>
        </Show>
        <Select
          label="Harness"
          value={driver()}
          disabled={!drivers()?.length}
          placeholder={available() ? "No harness installed" : "Not available"}
          options={(drivers() ?? []).map((d) => ({ value: d.id, label: d.title ?? d.id }))}
          onChange={setDriver}
        />
        <Select
          label="Environment"
          value={env()}
          placeholder="No environment"
          options={(envs() ?? []).map((e: any) => ({
            value: e.name,
            label: `${e.name}${e.state && e.state !== "online" ? ` (${e.state})` : ""}`,
          }))}
          onChange={(v) => {
            setEnv(v)
            setCheckout("")
          }}
        />
        <Select
          label="Repository checkout"
          value={checkout()}
          placeholder={checkouts.loading ? "Looking…" : "No checkout: the environment's workspaces"}
          options={sortedCheckouts().map((c) => ({
            value: c.path,
            label: `${c.name}${c.branch ? ` · ${c.branch}` : ""}`,
          }))}
          onChange={setCheckout}
          mono
        />
        <div class="projects__switch-row">
          <Switch
            checked={worktree()}
            onChange={setWorktree}
            disabled={!checkout()}
            aria-label="New worktree"
          />
          <span>Work in a new worktree on its own branch</span>
        </div>
        <Show when={worktree() && checkout()}>
          <TextField
            label="Branch"
            value={branch()}
            onInput={(e) => setBranch(e.currentTarget.value)}
            class="mono"
            data-testid="agent-branch"
          />
        </Show>
        <TextArea
          label="Instructions"
          placeholder="Implement it, test it, and summarise what you changed."
          value={instructions()}
          onInput={(e) => setInstructions(e.currentTarget.value)}
          rows={3}
        />
        <Show when={problem()}>
          <Callout tone="danger">
            <span class="label">The agent did not start.</span> {problem()}
          </Callout>
        </Show>
      </div>
    </Dialog>
  )
}
