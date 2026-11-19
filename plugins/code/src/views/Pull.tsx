import {
  Badge,
  Button,
  Callout,
  CodeBlock,
  DiffView,
  EmptyState,
  Icon,
  IconButton,
  Panel,
  Skeleton,
  State,
  TabPanel,
  Tabs,
  ViewHeader,
} from "@aiviarium/nocturne"
import type { ViewProps } from "@rookery/sdk/client"
import { createEffect, createMemo, createResource, createSignal, For, on, Show } from "solid-js"
import {
  ChecksState,
  EntityChip,
  ErrorNote,
  Labels,
  Person,
  ReviewBadge,
  StateBadge,
} from "../components/bits"
import { MergeDialog, PickDialog, ReviewDialog } from "../components/dialogs"
import { Thread } from "../components/Thread"
import { openEntity, openIssue, rookery, useMe } from "../lib/app"
import { same } from "../lib/filters"
import { ago, plural } from "../lib/format"

type Row = Record<string, any>

interface FileEntry {
  filename: string
  previous_filename?: string
  status: string
  additions: number
  deletions: number
  patch?: string
}

interface CommitEntry {
  sha: string
  message: string
  author: string
  date: string
  url: string
}

interface Runs {
  sha: string
  runs: Array<{
    id: number
    name: string
    status: string
    conclusion: string | null
    url: string
    startedAt: string | null
    completedAt: string | null
    app: string
    summary: string
  }>
}

const patchOf = (f: FileEntry) =>
  `--- a/${f.previous_filename ?? f.filename}\n+++ b/${f.filename}\n${f.patch ?? ""}`

export function PullView(props: ViewProps) {
  const c = rookery()
  const uri = `gh-pr://${props.view.path}`
  const live = c.data.prs.live({ where: { id: props.view.path }, limit: 1 })
  const row = () => live()[0] as Row | undefined
  const { logins } = useMe()
  const [tab, setTab] = createSignal("conversation")
  const [review, setReview] = createSignal(false)
  const [merge, setMerge] = createSignal(false)
  const [pick, setPick] = createSignal<"" | "labels" | "assignees" | "reviewers">("")
  const [busy, setBusy] = createSignal(false)
  const [error, setError] = createSignal<unknown>()

  createEffect(() => {
    const r = row()
    if (r) props.view.setTitle(`#${r.number} ${r.title}`)
  })
  // Read the pull request from GitHub when it is opened: mergeability and checks are not final in a sync.
  // Once per id: `on` runs again whenever the live row changes, and a refresh changes it.
  const id = createMemo(() => row()?.id)
  createEffect(
    on(id, (id) => {
      if (id) void c.host.call("item.refresh", { uri }).catch((e) => setError(e))
    }),
  )
  const refresh = () => void c.host.call("item.refresh", { uri }).catch((e) => setError(e))
  const own = () => !!row() && logins().some((l) => same(l, row()!.author))
  const run = async (fn: () => Promise<unknown>) => {
    setBusy(true)
    setError(undefined)
    try {
      await fn()
    } catch (e) {
      setError(e)
    } finally {
      setBusy(false)
    }
  }
  const setState = (state: "open" | "closed") => run(() => c.host.call("item.setState", { uri, state }))

  const [files] = createResource(
    () => (tab() === "files" && row() ? `${row()!.headSha}` : undefined),
    () => c.host.call<FileEntry[]>("pr.files", { uri }),
  )
  const [commits] = createResource(
    () => (tab() === "commits" && row() ? `${row()!.headSha}` : undefined),
    () => c.host.call<CommitEntry[]>("pr.commits", { uri }),
  )
  const [runs, { refetch: refetchRuns }] = createResource(
    () => (tab() === "checks" && row() ? `${row()!.headSha}:${row()!.checksState}` : undefined),
    () => c.host.call<Runs>("pr.checks", { uri }),
  )
  const [logOf, setLogOf] = createSignal<number | null>(null)
  const [log] = createResource(logOf, (run) =>
    c.host.call<{ log: string; unavailable?: string }>("pr.checkLog", { uri, run }),
  )

  const reviews = () => (row()?.reviews ?? []) as Array<{ login: string; state: string }>
  const people = (kind: "assignees" | "reviewers") =>
    ((row()?.[kind] ?? []) as string[]).filter((p) => !p.startsWith("team:"))
  // `#212` in the conversation: a pull request of the repository, or the Projects issue its issue is.
  const openRef = async (n: number) => {
    const repoId = String(row()?.repo ?? "").replace("gh-repo://", "")
    const hit = await c.host
      .call<{ uri: string; key?: string; slug?: string } | null>("resolveNumber", { repo: repoId, number: n })
      .catch(() => null)
    if (hit?.uri.startsWith("gh-pr://")) openEntity(hit.uri)
    else if (hit) void openIssue(hit)
    else c.workbench.toast({ title: `#${n} is not synced here`, kind: "warning" })
  }

  return (
    <div class="gh-view" data-part="pull-view">
      <Show
        when={row()}
        fallback={
          <Show when={!live.loading} fallback={<Skeleton style={{ height: "var(--control-lg)" }} />}>
            <EmptyState
              icon="branch"
              title="This pull request is not here"
              description="It may have been deleted, its repository detached, or you may not have access to it."
            />
          </Show>
        }
      >
        {(r) => (
          <>
            <ViewHeader
              context={
                <span class="nc-meta">
                  <StateBadge state={r().state} draft={r().draft} />
                  <Person login={r().author} /> wants to merge <code class="gh-code">{r().head}</code> into{" "}
                  <code class="gh-code">{r().base}</code> · {ago(r().ghUpdatedAt)}
                </span>
              }
              actions={[
                ...(r().state === "open"
                  ? [
                      {
                        id: "review",
                        label: "Review",
                        icon: "eye" as const,
                        onClick: () => setReview(true),
                      },
                      {
                        id: "merge",
                        label: "Merge",
                        icon: "branch" as const,
                        primary: true,
                        disabled: !!r().draft,
                        onClick: () => setMerge(true),
                      },
                      {
                        id: "close",
                        label: "Close",
                        overflow: true,
                        danger: true,
                        onClick: () => setState("closed"),
                      },
                    ]
                  : [
                      {
                        id: "reopen",
                        label: "Reopen",
                        onClick: () => setState("open"),
                      },
                    ]),
                {
                  id: "github",
                  label: "Open on GitHub",
                  icon: "arrow-up-right" as const,
                  onClick: () => window.open(r().htmlUrl, "_blank", "noopener"),
                },
                {
                  id: "refresh",
                  label: "Refresh from GitHub",
                  icon: "activity" as const,
                  onClick: refresh,
                },
              ]}
            />
            <h1 class="nc-panel-title" data-testid="pull-title">
              {r().title} <span class="nc-muted">#{r().number}</span>
            </h1>
            <Show when={error()}>
              <ErrorNote error={error()} />
            </Show>
            <Show when={r().removed}>
              <Callout tone="warning">
                This pull request is {r().removed} on GitHub. The copy here is kept for reference.
              </Callout>
            </Show>

            <Tabs
              label="Pull request"
              variant="underline"
              idPrefix="gh-pull"
              value={tab()}
              onChange={setTab}
              items={[
                { id: "conversation", label: "Conversation", count: r().commentCount ?? 0 },
                { id: "files", label: "Files changed", count: r().changedFiles ?? 0 },
                { id: "commits", label: "Commits", count: r().commits ?? 0 },
                { id: "checks", label: "Checks", count: r().checks?.total ?? 0 },
              ]}
            />

            <div class="gh-cols">
              <div class="gh-main">
                <TabPanel idPrefix="gh-pull" id="conversation" value={tab()}>
                  <Thread uri={uri} row={r()} kind="pr" onRef={openRef} />
                </TabPanel>

                <TabPanel idPrefix="gh-pull" id="files" value={tab()}>
                  <div class="gh-files" data-part="files">
                    <Show when={files()} fallback={<Skeleton style={{ height: "var(--control-lg)" }} />}>
                      <p class="nc-meta">
                        {plural(files()!.length, "file")} changed,{" "}
                        <span class="gh-add">+{r().additions}</span>{" "}
                        <span class="gh-del">−{r().deletions}</span>
                      </p>
                      <For each={files()}>
                        {(f) => (
                          <Show
                            when={f.patch}
                            fallback={
                              <Panel title={<span class="nc-mono">{f.filename}</span>}>
                                <span class="nc-muted">
                                  {f.status === "renamed"
                                    ? "Renamed without changes."
                                    : "GitHub does not show a diff for this file (binary or too large)."}
                                </span>
                              </Panel>
                            }
                          >
                            <DiffView patch={patchOf(f)} path={f.filename} />
                          </Show>
                        )}
                      </For>
                    </Show>
                  </div>
                </TabPanel>

                <TabPanel idPrefix="gh-pull" id="commits" value={tab()}>
                  <Show when={commits()} fallback={<Skeleton style={{ height: "var(--control-lg)" }} />}>
                    <ul class="gh-plain" data-part="commits">
                      <For each={commits()}>
                        {(m) => (
                          <li class="gh-commit">
                            <span class="nc-mono gh-sha">{m.sha.slice(0, 7)}</span>
                            <span class="gh-commit__msg">{m.message.split("\n")[0]}</span>
                            <span class="nc-meta">
                              {m.author} · {ago(m.date)}
                            </span>
                          </li>
                        )}
                      </For>
                    </ul>
                  </Show>
                </TabPanel>

                <TabPanel idPrefix="gh-pull" id="checks" value={tab()}>
                  <div class="gh-checks" data-part="checks">
                    <div class="gh-checks__bar">
                      <ChecksState state={r().checksState} checks={r().checks} />
                      <IconButton
                        label="Read the checks again"
                        icon="activity"
                        onClick={() => void refetchRuns()}
                      />
                    </div>
                    <Show when={runs()} fallback={<Skeleton style={{ height: "var(--control-lg)" }} />}>
                      <Show
                        when={runs()!.runs.length}
                        fallback={
                          <EmptyState
                            icon="check"
                            title="No check runs"
                            description="This commit has no checks, or only commit statuses."
                          />
                        }
                      >
                        <ul class="gh-plain">
                          <For each={runs()!.runs}>
                            {(k) => (
                              <li class="gh-run" data-run={k.name} data-conclusion={k.conclusion ?? k.status}>
                                <State
                                  status={
                                    k.status !== "completed"
                                      ? "live"
                                      : k.conclusion === "success" ||
                                          k.conclusion === "skipped" ||
                                          k.conclusion === "neutral"
                                        ? "ok"
                                        : "error"
                                  }
                                >
                                  {k.name}
                                </State>
                                <span class="nc-meta">
                                  {k.status === "completed"
                                    ? (k.conclusion ?? "done").replace("_", " ")
                                    : k.status.replace("_", " ")}
                                </span>
                                <span class="gh-run__spacer" />
                                <Show
                                  when={
                                    k.conclusion &&
                                    ["failure", "timed_out", "cancelled", "action_required"].includes(
                                      k.conclusion,
                                    )
                                  }
                                >
                                  <Button
                                    size="sm"
                                    variant="ghost"
                                    onClick={() => setLogOf(logOf() === k.id ? null : k.id)}
                                    data-testid="show-log"
                                  >
                                    {logOf() === k.id ? "Hide log" : "Show log"}
                                  </Button>
                                </Show>
                                <Show when={k.url}>
                                  <a
                                    class="nc-meta gh-link"
                                    href={k.url}
                                    target="_blank"
                                    rel="noopener noreferrer"
                                  >
                                    Details
                                  </a>
                                </Show>
                                <Show when={logOf() === k.id}>
                                  <div class="gh-run__log">
                                    <Show
                                      when={log()}
                                      fallback={<Skeleton style={{ height: "var(--control-lg)" }} />}
                                    >
                                      <Show
                                        when={log()!.log}
                                        fallback={
                                          <span class="nc-muted">
                                            {log()!.unavailable ?? "The log is empty."}
                                          </span>
                                        }
                                      >
                                        <CodeBlock code={log()!.log} title="log" lineNumbers={false} />
                                      </Show>
                                    </Show>
                                  </div>
                                </Show>
                              </li>
                            )}
                          </For>
                        </ul>
                      </Show>
                    </Show>
                  </div>
                </TabPanel>
              </div>

              <aside class="gh-side" aria-label="Details" data-part="side">
                <Panel
                  title="Reviewers"
                  actions={
                    r().state === "open" ? (
                      <IconButton
                        label="Request reviewers"
                        icon="plus"
                        onClick={() => setPick("reviewers")}
                        data-testid="edit-reviewers"
                      />
                    ) : undefined
                  }
                >
                  <div class="nc-stack">
                    <Show
                      when={people("reviewers").length || reviews().length}
                      fallback={<span class="nc-muted">No reviewers.</span>}
                    >
                      <For each={reviews()}>
                        {(v) => (
                          <div class="gh-side__row">
                            <Person login={v.login} />
                            <Badge
                              tone={
                                v.state === "approved"
                                  ? "success"
                                  : v.state === "changes_requested"
                                    ? "danger"
                                    : "neutral"
                              }
                            >
                              {v.state.replace("_", " ")}
                            </Badge>
                          </div>
                        )}
                      </For>
                      <For each={people("reviewers").filter((p) => !reviews().some((v) => v.login === p))}>
                        {(p) => (
                          <div class="gh-side__row">
                            <Person login={p} />
                            <Badge tone="warning">requested</Badge>
                          </div>
                        )}
                      </For>
                    </Show>
                    <div>
                      <ReviewBadge state={r().reviewState} />
                    </div>
                  </div>
                </Panel>
                <Panel
                  title="Assignees"
                  actions={
                    <IconButton
                      label="Edit assignees"
                      icon="plus"
                      onClick={() => setPick("assignees")}
                      data-testid="edit-assignees"
                    />
                  }
                >
                  <Show when={people("assignees").length} fallback={<span class="nc-muted">Nobody.</span>}>
                    <div class="nc-stack">
                      <For each={people("assignees")}>{(p) => <Person login={p} />}</For>
                    </div>
                  </Show>
                </Panel>
                <Panel
                  title="Labels"
                  actions={
                    <IconButton
                      label="Edit labels"
                      icon="plus"
                      onClick={() => setPick("labels")}
                      data-testid="edit-labels"
                    />
                  }
                >
                  <Show when={r().labels?.length} fallback={<span class="nc-muted">None.</span>}>
                    <Labels labels={r().labels} />
                  </Show>
                </Panel>
                <Panel title="Status">
                  <div class="nc-stack">
                    <ChecksState state={r().checksState} checks={r().checks} />
                    <span class="nc-meta">
                      <Icon name="branch" size="sm" />{" "}
                      {r().mergeable === "conflicting"
                        ? "Has conflicts with the base branch"
                        : r().mergeable === "mergeable"
                          ? "No conflicts with the base branch"
                          : "Mergeability is being worked out"}
                    </span>
                    <span class="nc-meta">
                      {plural(r().changedFiles ?? 0, "file")} ·{" "}
                      <span class="gh-add">+{r().additions ?? 0}</span>{" "}
                      <span class="gh-del">−{r().deletions ?? 0}</span>
                    </span>
                  </div>
                </Panel>
                <Show when={(r().links?.length ?? 0) + (r().sessions?.length ?? 0) > 0}>
                  <Panel title="Linked">
                    <div class="nc-stack" data-testid="linked">
                      <For each={[...(r().links ?? []), ...(r().sessions ?? [])] as string[]}>
                        {(u) => <EntityChip uri={u} />}
                      </For>
                    </div>
                  </Panel>
                </Show>
              </aside>
            </div>

            <ReviewDialog
              open={review()}
              onClose={() => setReview(false)}
              uri={uri}
              own={own()}
              onDone={() => void 0}
            />
            <MergeDialog open={merge()} onClose={() => setMerge(false)} uri={uri} onDone={() => void 0} />
            <PickDialog
              open={pick() !== ""}
              onClose={() => setPick("")}
              title={
                pick() === "labels" ? "Labels" : pick() === "assignees" ? "Assignees" : "Request reviews"
              }
              uri={uri}
              kind={pick() || "labels"}
              current={
                pick() === "labels"
                  ? ((r().labels ?? []) as Array<{ name: string }>).map((l) => l.name)
                  : pick() === "assignees"
                    ? people("assignees")
                    : people("reviewers")
              }
              onDone={() => void 0}
            />
            <Show when={busy()}>
              <span class="nc-meta">Working…</span>
            </Show>
          </>
        )}
      </Show>
    </div>
  )
}
