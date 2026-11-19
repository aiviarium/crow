import { Button, Callout, Dialog, Select, Switch, TextArea, TextField } from "@aiviarium/nocturne"
import { createMemo, createResource, createSignal, For, type JSX, Show } from "solid-js"
import { type ConnectionRow, rookery } from "../lib/app"
import { ErrorNote } from "./bits"

type Row = Record<string, any>

// ── Attaching a repository ──────────────────────────────────────────────────────────────────────────

export function AttachDialog(props: {
  open: boolean
  onClose: () => void
  onAttached: (repo: Row) => void
}): JSX.Element {
  const [conns] = createResource(
    () => props.open || undefined,
    async () => (await rookery().host.call<{ connections: ConnectionRow[] }>("connections")).connections,
  )
  const [conn, setConn] = createSignal("")
  const [repo, setRepo] = createSignal("")
  // Its issues are Projects issues: a new project named after it, or one the person manages.
  const [project, setProject] = createSignal("new")
  const [projects] = createResource(
    () => props.open || undefined,
    async () =>
      (
        await rookery()
          .spaces.list()
          .catch(() => [])
      )
        .filter((s) => s.kind === "projects.project" && (s.level as unknown as string) === "manage")
        .sort((a, b) => a.name.localeCompare(b.name)),
  )
  const [busy, setBusy] = createSignal(false)
  const [error, setError] = createSignal<unknown>()
  const chosen = () => conn() || conns()?.[0]?.id || ""
  const [reach] = createResource(
    () => (props.open && chosen() ? chosen() : undefined),
    async (c) => {
      try {
        return await rookery().host.call<{
          total: number
          repositories: Array<{ fullName: string; private: boolean }>
        }>("candidates", { connection: c })
      } catch {
        return null
      }
    },
  )
  const submit = async (e: Event) => {
    e.preventDefault()
    setBusy(true)
    setError(undefined)
    try {
      const r = await rookery().host.call<Row>("attach", {
        repo: repo(),
        connection: chosen() || undefined,
        project: project() === "new" ? null : project(),
      })
      setRepo("")
      props.onAttached(r)
      props.onClose()
    } catch (err) {
      setError(err)
    } finally {
      setBusy(false)
    }
  }
  const scopeWord = (c: ConnectionRow) => (c.scope === "user" ? "yours" : "everyone")
  return (
    <Dialog
      open={props.open}
      onClose={props.onClose}
      title="Attach a repository"
      footer={
        <>
          <Button variant="ghost" onClick={props.onClose}>
            Cancel
          </Button>
          <Button
            variant="primary"
            type="submit"
            form="gh-attach"
            loading={busy()}
            disabled={!repo().trim() || !chosen()}
            data-testid="attach-submit"
          >
            Attach
          </Button>
        </>
      }
    >
      <form id="gh-attach" class="nc-stack" onSubmit={submit} data-part="attach-form">
        <Show
          when={(conns()?.length ?? 1) > 0}
          fallback={
            <Callout
              tone="warning"
              action={
                <Button size="sm" onClick={() => rookery().workbench.openView("code.connect")}>
                  Connect GitHub
                </Button>
              }
            >
              There is no GitHub connection yet.
            </Callout>
          }
        >
          <Select
            label="Connection"
            options={(conns() ?? []).map((c) => ({
              value: c.id,
              label: c.name,
              description: `${c.type === "code.github-app" ? "GitHub App" : "Personal token"} · ${scopeWord(c)}`,
            }))}
            value={chosen()}
            onChange={setConn}
          />
        </Show>
        <TextField
          label="Repository"
          placeholder="owner/name or the repository's URL"
          value={repo()}
          onInput={(e) => setRepo(e.currentTarget.value)}
          data-testid="attach-repo"
          help={
            reach()?.total
              ? `This connection reaches ${reach()!.total} ${reach()!.total === 1 ? "repository" : "repositories"}.`
              : undefined
          }
        />
        <Show when={reach()?.repositories.length}>
          <div class="gh-suggest">
            <For each={reach()!.repositories.slice(0, 8)}>
              {(r) => (
                <button type="button" class="gh-chip-btn" onClick={() => setRepo(r.fullName)}>
                  {r.fullName}
                </button>
              )}
            </For>
          </div>
        </Show>
        <Select
          label="Issues"
          options={[
            { value: "new", label: "A new project" },
            ...(projects() ?? []).map((s) => ({ value: s.id, label: s.name })),
          ]}
          value={project()}
          onChange={setProject}
          data-testid="attach-project"
        />
        <Show when={error()}>
          <ErrorNote error={error()} />
        </Show>
      </form>
    </Dialog>
  )
}

// ── Reviewing ───────────────────────────────────────────────────────────────────────────────────────

export function ReviewDialog(props: {
  open: boolean
  onClose: () => void
  uri: string
  own: boolean
  onDone: () => void
}): JSX.Element {
  const [event, setEvent] = createSignal<"APPROVE" | "REQUEST_CHANGES" | "COMMENT">("COMMENT")
  const [body, setBody] = createSignal("")
  const [busy, setBusy] = createSignal(false)
  const [error, setError] = createSignal<unknown>()
  const needsBody = () => event() !== "APPROVE"
  const submit = async (e: Event) => {
    e.preventDefault()
    setBusy(true)
    setError(undefined)
    try {
      await rookery().host.call("pr.review", { uri: props.uri, event: event(), body: body() })
      setBody("")
      props.onDone()
      props.onClose()
    } catch (err) {
      setError(err)
    } finally {
      setBusy(false)
    }
  }
  const options = [
    { value: "COMMENT", label: "Comment", description: "General feedback without approving or blocking." },
    { value: "APPROVE", label: "Approve", description: "Looks good to merge." },
    {
      value: "REQUEST_CHANGES",
      label: "Request changes",
      description: "It must change before it can be merged.",
    },
  ] as const
  return (
    <Dialog
      open={props.open}
      onClose={props.onClose}
      title="Review this pull request"
      footer={
        <>
          <Button variant="ghost" onClick={props.onClose}>
            Cancel
          </Button>
          <Button
            variant={event() === "REQUEST_CHANGES" ? "danger" : "primary"}
            type="submit"
            form="gh-review"
            loading={busy()}
            disabled={needsBody() && !body().trim()}
            data-testid="review-submit"
          >
            {event() === "APPROVE"
              ? "Approve"
              : event() === "REQUEST_CHANGES"
                ? "Request changes"
                : "Comment"}
          </Button>
        </>
      }
    >
      <form id="gh-review" class="nc-stack" onSubmit={submit} data-part="review-form">
        <Show when={props.own}>
          <Callout tone="info">You cannot approve your own pull request.</Callout>
        </Show>
        <Select
          label="Your review"
          options={options.map((o) => ({ ...o, disabled: o.value !== "COMMENT" && props.own }))}
          value={event()}
          onChange={(v) => setEvent(v as typeof event extends () => infer T ? T : never)}
        />
        <TextArea
          label={needsBody() ? "What do you think?" : "Say something (optional)"}
          rows={5}
          value={body()}
          onInput={(e) => setBody(e.currentTarget.value)}
          data-testid="review-body"
        />
        <Show when={error()}>
          <ErrorNote error={error()} />
        </Show>
      </form>
    </Dialog>
  )
}

// ── Merging ─────────────────────────────────────────────────────────────────────────────────────────

interface MergeInfo {
  allowed: Array<"merge" | "squash" | "rebase">
  blockers: string[]
  title: string
  number: number
  canWrite: boolean
}

const METHOD = {
  merge: { label: "Create a merge commit", description: "All commits are kept, with a merge commit." },
  squash: { label: "Squash and merge", description: "One commit on the base branch." },
  rebase: { label: "Rebase and merge", description: "Each commit is replayed on the base branch." },
} as const

export function MergeDialog(props: {
  open: boolean
  onClose: () => void
  uri: string
  onDone: () => void
}): JSX.Element {
  const [info] = createResource(
    () => (props.open ? props.uri : undefined),
    (uri) => rookery().host.call<MergeInfo>("pr.mergeInfo", { uri }),
  )
  const [method, setMethod] = createSignal<"merge" | "squash" | "rebase" | "">("")
  const [title, setTitle] = createSignal("")
  const [busy, setBusy] = createSignal(false)
  const [error, setError] = createSignal<unknown>()
  const chosen = createMemo(() =>
    method() && info()?.allowed.includes(method() as never)
      ? (method() as "merge")
      : (info()?.allowed[0] ?? ""),
  )
  const submit = async (e: Event) => {
    e.preventDefault()
    if (!chosen()) return
    setBusy(true)
    setError(undefined)
    try {
      await rookery().host.call("pr.merge", { uri: props.uri, method: chosen(), title: title() || undefined })
      props.onDone()
      props.onClose()
    } catch (err) {
      setError(err)
    } finally {
      setBusy(false)
    }
  }
  return (
    <Dialog
      open={props.open}
      onClose={props.onClose}
      title="Merge this pull request"
      footer={
        <>
          <Button variant="ghost" onClick={props.onClose}>
            Cancel
          </Button>
          <Button
            variant="primary"
            type="submit"
            form="gh-merge"
            loading={busy()}
            disabled={!chosen()}
            data-testid="merge-submit"
          >
            {chosen() ? METHOD[chosen() as "merge"].label : "Merge"}
          </Button>
        </>
      }
    >
      <form id="gh-merge" class="nc-stack" onSubmit={submit} data-part="merge-form">
        <Show when={info()?.blockers.length}>
          <Callout tone="warning">
            {info()!.blockers.join(" ")} You can still merge if GitHub allows it.
          </Callout>
        </Show>
        <Show when={info()} fallback={<span class="nc-muted">Reading what the repository allows…</span>}>
          <Show
            when={info()!.allowed.length > 0}
            fallback={
              <Callout tone="danger">The repository allows no merge method for this connection.</Callout>
            }
          >
            <Select
              label="Merge method"
              options={info()!.allowed.map((m) => ({
                value: m,
                label: METHOD[m].label,
                description: METHOD[m].description,
              }))}
              value={chosen() as string}
              onChange={(v) => setMethod(v as "merge")}
            />
            <Show when={chosen() === "squash"}>
              <TextField
                label="Commit title (optional)"
                placeholder={`${info()!.title} (#${info()!.number})`}
                value={title()}
                onInput={(e) => setTitle(e.currentTarget.value)}
              />
            </Show>
          </Show>
        </Show>
        <Show when={error()}>
          <ErrorNote error={error()} />
        </Show>
      </form>
    </Dialog>
  )
}

// ── Labels and people ───────────────────────────────────────────────────────────────────────────────

/** Choose from a list (labels, people) and save what was chosen. */
export function PickDialog(props: {
  open: boolean
  onClose: () => void
  title: string
  uri: string
  kind: "labels" | "assignees" | "reviewers"
  current: string[]
  onDone: () => void
}): JSX.Element {
  const [choices] = createResource(
    () => (props.open ? props.uri : undefined),
    (uri) =>
      rookery().host.call<{ labels: Array<{ name: string; color: string }>; people: string[] }>(
        "item.labels",
        { uri },
      ),
  )
  const [picked, setPicked] = createSignal<string[] | null>(null)
  const [busy, setBusy] = createSignal(false)
  const [error, setError] = createSignal<unknown>()
  const options = () =>
    props.kind === "labels" ? (choices()?.labels ?? []).map((l) => l.name) : (choices()?.people ?? [])
  const value = () => picked() ?? props.current.filter((c) => !c.startsWith("team:"))
  const toggle = (n: string, on: boolean) => setPicked(on ? [...value(), n] : value().filter((x) => x !== n))
  const save = async () => {
    setBusy(true)
    setError(undefined)
    try {
      const now = value()
      const was = props.current.filter((c) => !c.startsWith("team:"))
      if (props.kind === "labels")
        await rookery().host.call("item.setLabels", { uri: props.uri, labels: now })
      else if (props.kind === "assignees")
        await rookery().host.call("item.assign", {
          uri: props.uri,
          add: now.filter((n) => !was.includes(n)),
          remove: was.filter((n) => !now.includes(n)),
        })
      else
        await rookery().host.call("pr.reviewers", {
          uri: props.uri,
          add: now.filter((n) => !was.includes(n)),
          remove: was.filter((n) => !now.includes(n)),
        })
      setPicked(null)
      props.onDone()
      props.onClose()
    } catch (err) {
      setError(err)
    } finally {
      setBusy(false)
    }
  }
  return (
    <Dialog
      open={props.open}
      onClose={() => {
        setPicked(null)
        props.onClose()
      }}
      title={props.title}
      size="sm"
      footer={
        <>
          <Button variant="ghost" onClick={props.onClose}>
            Cancel
          </Button>
          <Button variant="primary" loading={busy()} onClick={save} data-testid="pick-save">
            Save
          </Button>
        </>
      }
    >
      <div class="nc-stack" data-part="pick-form">
        <Show when={choices.loading}>
          <span class="nc-muted">Loading…</span>
        </Show>
        <For each={options()}>
          {(n) => (
            <Switch label={n} checked={value().includes(n)} onChange={(on) => toggle(n, on)} data-name={n} />
          )}
        </For>
        <Show when={error()}>
          <ErrorNote error={error()} />
        </Show>
      </div>
    </Dialog>
  )
}
