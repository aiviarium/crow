import { Badge, Button, Callout, DropdownMenu, IconButton, Select } from "@aiviarium/nocturne"
import { createResource, createSignal, type JSX, Show } from "solid-js"
import { rookery } from "../lib/app"
import { ago, clock, inFuture, plural } from "../lib/format"
import { ErrorNote, SyncState } from "./bits"

type Row = Record<string, any>

const POLL = [
  { value: "15", label: "Every 15 seconds" },
  { value: "60", label: "Every minute" },
  { value: "300", label: "Every 5 minutes" },
  { value: "900", label: "Every 15 minutes" },
  { value: "3600", label: "Every hour" },
]

/** One attached repository with its sync state: last run, next run, errors with the fix, the rate budget. */
export function RepoCard(props: {
  repo: Row
  space: string
  onOpen?: () => void
  onDetached?: () => void
}): JSX.Element {
  const c = rookery()
  const r = () => props.repo
  const [busy, setBusy] = createSignal("")
  const [error, setError] = createSignal<unknown>()
  const [confirm, setConfirm] = createSignal(false)
  // The project its issues live in.
  const [project] = createResource(
    () => (r().projectLink ? `${props.space}:${r().id}:${r().projectLink}` : undefined),
    async () =>
      (
        await c.host
          .call<{ projects: Array<{ space: string; slug: string; name: string; key: string | null }> }>(
            "projects",
            { space: props.space, repo: r().id },
          )
          .catch(() => ({ projects: [] }))
      ).projects[0] ?? null,
  )
  const hooked = () => !!r().lastWebhookAt && Date.now() - Date.parse(r().lastWebhookAt) < 86_400_000
  const stats = () =>
    r().lastSyncStats as {
      pulls: number
      issues: number
      comments: number
      requests: number
      notModified: number
    } | null

  const sync = async (full: boolean) => {
    setBusy(full ? "full" : "sync")
    setError(undefined)
    try {
      await c.jobs.enqueue("code/sync", {
        repo: r().id,
        space: props.space,
        force: true,
        full,
      })
    } catch (e) {
      setError(e)
    } finally {
      setTimeout(() => setBusy(""), 600)
    }
  }
  const setPoll = async (v: string) => {
    try {
      await c.host.call("setPoll", { repo: r().id, space: props.space, pollSecs: Number(v) })
    } catch (e) {
      setError(e)
    }
  }
  const detach = async () => {
    try {
      await c.host.call("detach", { repo: r().id, space: props.space })
      props.onDetached?.()
    } catch (e) {
      setError(e)
    }
  }

  return (
    <section class="gh-repo" data-repo={r().fullName} data-status={r().status} aria-label={r().fullName}>
      <header class="gh-repo__head">
        <button type="button" class="gh-repo__name" onClick={props.onOpen} disabled={!props.onOpen}>
          {r().fullName}
        </button>
        <Show when={r().private}>
          <Badge square>Private</Badge>
        </Show>
        <Show when={r().archived}>
          <Badge square tone="warning">
            Archived
          </Badge>
        </Show>
        <SyncState status={r().status} />
        <span class="gh-spacer" />
        <Button
          size="sm"
          icon="activity"
          loading={busy() === "sync" || r().status === "syncing"}
          onClick={() => sync(false)}
          data-testid="sync-now"
        >
          Sync now
        </Button>
        <DropdownMenu
          label={`${r().fullName} actions`}
          items={[
            { id: "resync", label: "Resync everything", icon: "archive" },
            { type: "separator" },
            { id: "detach", label: "Detach this repository", icon: "trash", danger: true },
          ]}
          onSelect={(id) => (id === "resync" ? sync(true) : setConfirm(true))}
          trigger={(p) => <IconButton {...p} label="More actions" icon="more" size="sm" />}
        />
      </header>
      <Show when={r().description}>
        <p class="nc-meta gh-repo__desc">{r().description}</p>
      </Show>
      <Show when={r().status === "error" || r().status === "gone"}>
        <ErrorNote
          error={{ message: r().lastError, details: { fix: r().errorFix, reason: r().errorCode } }}
        />
      </Show>
      <dl class="gh-facts" data-part="sync-state">
        <div>
          <dt>Last sync</dt>
          <dd data-testid="last-sync">
            {r().lastSyncAt ? ago(r().lastSyncAt) : "not yet"}
            <Show when={stats()}>
              <span class="nc-meta">
                {" "}
                · {plural(stats()!.pulls + stats()!.issues, "item")} changed ·{" "}
                {plural(stats()!.requests, "request")}, {stats()!.notModified} unchanged
              </span>
            </Show>
          </dd>
        </div>
        <div>
          <dt>Next sync</dt>
          <dd data-testid="next-sync">
            {r().nextSyncAt
              ? `${inFuture(r().nextSyncAt)} (${clock(r().nextSyncAt)})`
              : "after the first run"}
          </dd>
        </div>
        <div>
          <dt>How it follows GitHub</dt>
          <dd data-testid="sync-mode">
            {hooked() ? "Webhooks, checked every 15 minutes" : "Polling"}
            <Show when={hooked()}>
              <span class="nc-meta"> · last delivery {ago(r().lastWebhookAt)}</span>
            </Show>
          </dd>
        </div>
        <div>
          <dd>
            <Select<string>
              label="Poll interval"
              options={
                POLL.some((o) => o.value === String(r().pollSecs ?? 60))
                  ? POLL
                  : [...POLL, { value: String(r().pollSecs), label: `Every ${r().pollSecs} seconds` }].sort(
                      (a, b) => Number(a.value) - Number(b.value),
                    )
              }
              value={String(r().pollSecs ?? 60)}
              onChange={setPoll}
              class="gh-poll"
            />
          </dd>
        </div>
        <Show when={(r().openPulls ?? 0) > 0}>
          <div>
            <dt>Open</dt>
            <dd>{plural(r().openPulls ?? 0, "pull request")}</dd>
          </div>
        </Show>
        <Show when={project()}>
          {(p) => (
            <div>
              <dt>Issues</dt>
              <dd>
                <button
                  type="button"
                  class="nc-link gh-link"
                  data-testid="repo-project"
                  onClick={() =>
                    c.workbench.openView("projects.issues", {
                      context: { "rookery.space": p().slug },
                    })
                  }
                >
                  {p().name}
                </button>
              </dd>
            </div>
          )}
        </Show>
        <Show when={r().rateLimit}>
          <div>
            <dt>GitHub rate limit</dt>
            <dd data-testid="rate-limit">
              {(r().rateLimit.remaining as number).toLocaleString("en")} of{" "}
              {(r().rateLimit.limit as number).toLocaleString("en")} left
              <span class="nc-meta"> · resets {clock(r().rateLimit.resetAt)}</span>
            </dd>
          </div>
        </Show>
      </dl>
      <Show when={error()}>
        <ErrorNote error={error()} />
      </Show>
      <Show when={confirm()}>
        <Callout
          tone="warning"
          action={
            <>
              <Button size="sm" variant="ghost" onClick={() => setConfirm(false)}>
                Keep it
              </Button>
              <Button size="sm" variant="danger" onClick={detach} data-testid="detach-confirm">
                Detach
              </Button>
            </>
          }
        >
          Detaching removes {r().fullName} and its pull requests from this space; its project keeps the
          issues, which stop syncing. Nothing changes on GitHub.
        </Callout>
      </Show>
    </section>
  )
}
