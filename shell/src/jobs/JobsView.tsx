// Shell Jobs view (`/jobs` and `/jobs/:id`): filterable list of jobs with state filter, live job
// log via `jobs.follow`, cancel, and retry.
import {
  Button,
  Callout,
  Card,
  EmptyState,
  IdBadge,
  ListRow,
  MetaLine,
  RowList,
  State,
  Tabs,
  TextField,
  toast,
  ViewHeader,
  ViewLayout,
  WidgetProgress,
} from "@aiviarium/nocturne"
import type { JobInfo, JobState } from "@rookery/client"
import { createEffect, createMemo, createSignal, For, type JSX, on, onCleanup, onMount, Show } from "solid-js"
import type { ShellApp } from "../app/state"
import { JobLog } from "./JobLog"
import { formatTimeAgo, isJobActive, jobProgress, jobStatusInfo, jobSubtitle, jobTitle } from "./state"

type JobFilter = "all" | "active" | "succeeded" | "failed" | "cancelled"

const FILTER_ITEMS: Array<{ id: JobFilter; label: string }> = [
  { id: "all", label: "All" },
  { id: "active", label: "Active" },
  { id: "succeeded", label: "Succeeded" },
  { id: "failed", label: "Failed" },
  { id: "cancelled", label: "Cancelled" },
]

function matchesFilter(state: JobState, filter: JobFilter): boolean {
  if (filter === "all") return true
  if (filter === "active") return isJobActive(state)
  return state === filter
}

export function JobsView(props: { app: ShellApp; jobId?: string }): JSX.Element {
  const [filter, setFilter] = createSignal<JobFilter>("all")
  const [search, setSearch] = createSignal("")
  const [detail, setDetail] = createSignal<JobInfo | null>(null)
  const [detailError, setDetailError] = createSignal<string | null>(null)
  const [acting, setActing] = createSignal<"cancel" | "retry" | null>(null)

  const selectedId = () => props.jobId ?? props.app.routeMatch()?.params.id ?? ""

  onMount(() => {
    props.app.setViewTitle("Jobs")
    void props.app.jobs.refresh()
  })

  const filtered = createMemo(() => {
    const f = filter()
    const q = search().trim().toLowerCase()
    return props.app.jobs.jobs().filter((job) => {
      if (!matchesFilter(job.state, f)) return false
      if (!q) return true
      return (
        job.kind.toLowerCase().includes(q) ||
        (job.subject ?? "").toLowerCase().includes(q) ||
        job.id.toLowerCase().includes(q)
      )
    })
  })

  const loadDetail = async (id: string) => {
    if (!id) {
      setDetail(null)
      setDetailError(null)
      return
    }
    setDetailError(null)
    try {
      const d = await props.app.jobs.get(id)
      setDetail(d)
      props.app.setViewTitle(jobTitle(d))
    } catch (err) {
      setDetailError(err instanceof Error ? err.message : String(err))
    }
  }

  createEffect(
    on(selectedId, (id) => {
      if (!id) {
        setDetail(null)
        props.app.setViewTitle("Jobs")
        return
      }
      void loadDetail(id)
    }),
  )

  // Keep open job detail fresh when `jobs.changed` arrives.
  const offChanged = props.app.jobs.onChanged((job: JobInfo) => {
    if (job.id === selectedId()) {
      setDetail((prev) => (prev ? { ...prev, job } : prev))
    }
  })
  onCleanup(offChanged)

  const selectJob = (id: string) => {
    props.app.navigate(`/jobs/${encodeURIComponent(id)}`)
  }

  const cancel = async () => {
    const id = selectedId()
    if (!id || acting()) return
    setActing("cancel")
    try {
      await props.app.jobs.cancel(id)
      await loadDetail(id)
    } catch (err) {
      toast({
        title: "Could not cancel job",
        description: err instanceof Error ? err.message : String(err),
        tone: "danger",
      })
    } finally {
      setActing(null)
    }
  }

  const retry = async () => {
    const id = selectedId()
    if (!id || acting()) return
    setActing("retry")
    try {
      const retried = await props.app.jobs.retry(id)
      selectJob(retried.id)
    } catch (err) {
      toast({
        title: "Could not retry job",
        description: err instanceof Error ? err.message : String(err),
        tone: "danger",
      })
    } finally {
      setActing(null)
    }
  }

  const activeJob = () => {
    const d = detail()
    if (d) return d
    const id = selectedId()
    return id ? (props.app.jobs.jobs().find((j) => j.id === id) ?? null) : null
  }

  const canCancel = () => {
    const j = activeJob()
    return j ? isJobActive(j.state) : false
  }

  const canRetry = () => {
    const j = activeJob()
    return j ? j.state === "failed" || j.state === "cancelled" : false
  }

  return (
    <ViewLayout
      id="crow.jobs"
      sidebarLabel="Jobs"
      sidebarWidth={320}
      scroll={false}
      sidebar={
        <div class="crow-split-list" data-part="jobs-list">
          <div class="crow-split-list__controls">
            <TextField
              variant="search"
              label="Search jobs"
              placeholder="Filter jobs…"
              value={search()}
              onInput={(e) => setSearch(e.currentTarget.value)}
            />
            <Tabs
              label="Job state filter"
              items={FILTER_ITEMS}
              value={filter()}
              onChange={(id) => setFilter(id as JobFilter)}
            />
          </div>

          <div class="crow-split-list__body">
            <Show when={props.app.jobs.error()}>
              {(err) => (
                <div class="crow-pad">
                  <Callout
                    tone="danger"
                    action={
                      <Button size="sm" onClick={() => void props.app.jobs.refresh()}>
                        Retry
                      </Button>
                    }
                  >
                    {err()}
                  </Callout>
                </div>
              )}
            </Show>

            <Show
              when={filtered().length > 0}
              fallback={
                <div class="crow-pad">
                  <EmptyState
                    icon="activity"
                    title={props.app.jobs.jobs().length === 0 ? "No jobs yet" : "No matching jobs"}
                    description={
                      props.app.jobs.jobs().length === 0
                        ? "Background work such as host applies and actions will appear here."
                        : "Try a different state filter or search query."
                    }
                  >
                    <Show when={filter() !== "all" || search().trim() !== ""}>
                      <Button
                        size="sm"
                        variant="secondary"
                        onClick={() => {
                          setFilter("all")
                          setSearch("")
                        }}
                      >
                        Clear filters
                      </Button>
                    </Show>
                  </EmptyState>
                </div>
              }
            >
              <RowList label="Jobs list">
                <For each={filtered()}>
                  {(job) => {
                    const s = jobStatusInfo(job.state)
                    return (
                      <ListRow
                        title={jobTitle(job)}
                        secondary={jobSubtitle(job)}
                        meta={formatTimeAgo(job.createdAt)}
                        leading={<State status={s.dot}>{s.label}</State>}
                        selected={job.id === selectedId()}
                        data-job-row={job.id}
                        onClick={() => selectJob(job.id)}
                      />
                    )
                  }}
                </For>
              </RowList>
            </Show>
          </div>
        </div>
      }
      header={
        <ViewHeader
          noPin
          crumbs={
            activeJob()
              ? [{ label: "Jobs", icon: "activity", href: "/jobs" }, { label: jobTitle(activeJob()!) }]
              : [{ label: "Jobs", icon: "activity" }]
          }
          context={
            <Show when={activeJob()}>
              {(j) => <State status={jobStatusInfo(j().state).dot}>{jobStatusInfo(j().state).label}</State>}
            </Show>
          }
          actions={[
            {
              id: "refresh",
              label: "Refresh jobs",
              icon: "refresh-cw",
              onClick: () => {
                void props.app.jobs.refresh()
                if (selectedId()) void loadDetail(selectedId())
              },
            },
            ...(canCancel()
              ? [
                  {
                    id: "cancel",
                    label: acting() === "cancel" ? "Cancelling…" : "Cancel",
                    icon: "close" as const,
                    danger: true,
                    disabled: acting() !== null,
                    onClick: () => void cancel(),
                  },
                ]
              : []),
            ...(canRetry()
              ? [
                  {
                    id: "retry",
                    label: acting() === "retry" ? "Retrying…" : "Retry",
                    icon: "rotate-ccw" as const,
                    primary: true,
                    disabled: acting() !== null,
                    onClick: () => void retry(),
                  },
                ]
              : []),
          ]}
        />
      }
    >
      <div class="crow-detail-pane" data-part="jobs-detail">
        <Show
          when={selectedId()}
          fallback={
            <div class="crow-home">
              <EmptyState
                icon="activity"
                title="Select a job"
                description="Choose a job from the list to follow its live output, cancel, or retry it."
              />
            </div>
          }
        >
          {(id) => (
            <div class="crow-detail-stack">
              <Show when={detailError()}>
                {(err) => (
                  <Callout tone="danger" data-part="jobs-detail-error">
                    {err()}
                  </Callout>
                )}
              </Show>

              <Show when={activeJob()}>
                {(job) => (
                  <>
                    <Card>
                      <MetaLine
                        items={[
                          { label: <IdBadge>{job().id}</IdBadge> },
                          { label: job().kind },
                          job().subject ? { label: job().subject! } : null,
                          { label: `Attempt ${job().attempts} of ${job().maxAttempts}` },
                          { label: `Created ${formatTimeAgo(job().createdAt)}` },
                          job().finishedAt ? { label: `Finished ${formatTimeAgo(job().finishedAt)}` } : null,
                        ]}
                      />
                    </Card>

                    <Show when={jobProgress(job().progress)}>
                      {(p) => (
                        <Card>
                          <div class="crow-progress" data-part="job-progress">
                            <div class="crow-progress__head label">
                              <span>{p().message ?? "Working…"}</span>
                              <span class="mono">
                                {p().done} / {p().total}
                              </span>
                            </div>
                            <WidgetProgress
                              value={p().total > 0 ? (p().done / p().total) * 100 : 0}
                              label={p().message ?? "Job progress"}
                            />
                          </div>
                        </Card>
                      )}
                    </Show>

                    <Show when={job().error}>
                      {(err) => (
                        <Callout
                          tone="danger"
                          data-part="jobs-job-error"
                          action={
                            <Show when={canRetry()}>
                              <Button size="sm" onClick={() => void retry()}>
                                Retry
                              </Button>
                            </Show>
                          }
                        >
                          {err().message}
                        </Callout>
                      )}
                    </Show>
                  </>
                )}
              </Show>

              <JobLog
                conn={props.app.conn}
                jobId={id()}
                active={activeJob() ? isJobActive(activeJob()!.state) : true}
                onDone={() => {
                  void loadDetail(id())
                  void props.app.jobs.refresh()
                }}
              />
            </div>
          )}
        </Show>
      </div>
    </ViewLayout>
  )
}
