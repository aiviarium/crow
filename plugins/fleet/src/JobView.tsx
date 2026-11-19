// Fleet job detail view (`fleet.job`): shows job metadata, progress, live NDJSON log stream from
// `jobs.follow` with cursor tracking (`after`), cancel, and retry.
import {
  Button,
  Callout,
  Card,
  IdBadge,
  type LogEntry,
  LogViewer,
  MetaLine,
  State,
  type StreamStatus,
  ViewHeader,
  ViewLayout,
  WidgetProgress,
} from "@aiviarium/nocturne"
import type { JobEnd, JobInfo, LogItem } from "@rookery/client"
import type { ClientRookery, ViewHandle } from "@rookery/sdk/client"
import { createEffect, createSignal, type JSX, on, onCleanup, Show } from "solid-js"
import type { FleetApi } from "./fleetApi"
import {
  errorMessage,
  formatRelativeTime,
  isJobActive,
  jobItemToLogEntry,
  jobProgress,
  jobStatus,
} from "./format"

export function JobView(props: { view: ViewHandle; rookery: ClientRookery; api: FleetApi }): JSX.Element {
  const jobId = () => props.view.params.id ?? props.view.path ?? ""
  const hostFromParams = () => props.view.params.host ?? ""

  const [detail, setDetail] = createSignal<JobInfo | null>(null)
  const [entries, setEntries] = createSignal<LogEntry[]>([])
  const [streamState, setStreamState] = createSignal<StreamStatus>("connecting")
  const [streamOffset, setStreamOffset] = createSignal<number>(0)
  const [streamCode, setStreamCode] = createSignal<string | undefined>(undefined)
  const [error, setError] = createSignal<string | null>(null)
  const [acting, setActing] = createSignal<"cancel" | "retry" | null>(null)

  const hostName = () => {
    const fromParam = hostFromParams()
    if (fromParam) return fromParam
    const p = detail()?.params
    if (p && typeof p === "object") {
      const rec = p as Record<string, unknown>
      if (typeof rec.host === "string") return rec.host
    }
    return ""
  }

  const progress = () => jobProgress(detail()?.progress)

  createEffect(
    on(jobId, (id) => {
      if (!id) return
      let disposed = false
      let lastSeq = 0
      let handle: { close(): void } | null = null

      setDetail(null)
      setEntries([])
      setError(null)
      setStreamOffset(0)
      setStreamCode(undefined)
      setStreamState("connecting")
      props.view.setTitle(`Job ${id}`)

      const refreshDetail = async () => {
        try {
          const d = await props.api.getJob(id)
          if (disposed) return
          setDetail(d)
          props.view.setTitle(d.kind)
        } catch (err) {
          if (!disposed) setError(errorMessage(err))
        }
      }

      const appendItem = (item: LogItem) => {
        if (item.seq <= lastSeq) return
        lastSeq = item.seq
        setStreamOffset(lastSeq)
        setEntries((prev) => [...prev, jobItemToLogEntry(item)])
      }

      const openStream = async (after: number) => {
        if (disposed) return
        setStreamState(after > 0 ? "resuming" : "connecting")
        try {
          handle = await props.api.followJob(id, {
            after,
            onItem: (item) => {
              if (disposed) return
              setStreamState("live")
              appendItem(item)
            },
            onDone: (end: JobEnd) => {
              if (disposed) return
              setStreamState(end.state === "failed" ? "error" : "ended")
              if (end.error) setStreamCode(end.error.message)
              setDetail((prev) =>
                prev
                  ? {
                      ...prev,
                      state: end.state,
                      result: end.result ?? prev.result,
                      error: end.error ?? prev.error,
                    }
                  : prev,
              )
              void refreshDetail()
            },
            onError: (err) => {
              if (disposed) return
              setStreamState("error")
              setStreamCode(err.message)
            },
          })
          if (disposed) {
            handle.close()
            handle = null
          } else {
            setStreamState((s) => (s === "connecting" || s === "resuming" ? "live" : s))
          }
        } catch (err) {
          if (!disposed) {
            setStreamState("error")
            setStreamCode(errorMessage(err))
          }
        }
      }

      void refreshDetail()
      void openStream(0)

      onCleanup(() => {
        disposed = true
        handle?.close()
        handle = null
      })
    }),
  )

  const cancel = async () => {
    const id = jobId()
    if (!id || acting()) return
    setActing("cancel")
    try {
      await props.api.cancelJob(id)
      const d = await props.api.getJob(id)
      setDetail(d)
    } catch (err) {
      props.rookery.workbench.toast({
        kind: "danger",
        title: "Could not cancel job",
        body: errorMessage(err),
      })
    } finally {
      setActing(null)
    }
  }

  const retry = async () => {
    const id = jobId()
    if (!id || acting()) return
    setActing("retry")
    try {
      const retried = await props.api.retryJob(id)
      props.rookery.workbench.openView("fleet.job", {
        params: hostName() ? { id: retried.id, host: hostName() } : { id: retried.id },
      })
    } catch (err) {
      props.rookery.workbench.toast({
        kind: "danger",
        title: "Could not retry job",
        body: errorMessage(err),
      })
    } finally {
      setActing(null)
    }
  }

  const crumbs = () => {
    const list: Array<{ label: string; href?: string; icon?: "server" }> = [
      { label: "Fleet", icon: "server", href: props.rookery.views.href("fleet.hosts") ?? "/fleet/hosts" },
    ]
    const h = hostName()
    if (h) {
      list.push({
        label: h,
        href: props.rookery.views.href("fleet.host", { params: { name: h } }) ?? `/fleet/hosts/${h}`,
      })
    }
    list.push({ label: detail()?.kind ?? jobId() })
    return list
  }

  const active = () => {
    const state = detail()?.state
    return state ? isJobActive(state) : streamState() === "live"
  }

  const canRetry = () => {
    const state = detail()?.state
    return state === "failed" || state === "cancelled"
  }

  return (
    <ViewLayout
      id="fleet.job"
      scroll={false}
      header={
        <ViewHeader
          up
          noPin
          crumbs={crumbs()}
          context={
            <Show when={detail()}>
              {(d) => <State status={jobStatus(d().state).dot}>{jobStatus(d().state).label}</State>}
            </Show>
          }
          actions={[
            ...(active()
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
      <div class="fleet-page fleet-page--fill" data-part="fleet-job" data-job-id={jobId()}>
        <Show when={error()}>
          {(err) => (
            <Callout tone="danger" data-part="job-load-error">
              {err()}
            </Callout>
          )}
        </Show>

        <Show when={detail()}>
          {(d) => (
            <>
              <Card>
                <MetaLine
                  items={[
                    { label: <IdBadge>{d().id}</IdBadge> },
                    { label: d().kind },
                    d().subject ? { label: d().subject! } : null,
                    { label: `Attempt ${d().attempts} of ${d().maxAttempts}` },
                    { label: `Created ${formatRelativeTime(d().createdAt)}` },
                    d().finishedAt ? { label: `Finished ${formatRelativeTime(d().finishedAt)}` } : null,
                  ]}
                />
              </Card>

              <Show when={d().error}>
                {(err) => (
                  <Callout
                    tone="danger"
                    data-part="job-error"
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

        <Show when={progress()}>
          {(p) => (
            <Card>
              <div class="fleet-progress" data-part="job-progress">
                <div class="fleet-progress__head label">
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

        <LogViewer
          class="fleet-job-log"
          title="Job output"
          streamState={streamState()}
          streamOffset={streamOffset() > 0 ? streamOffset() : undefined}
          streamCode={streamCode()}
          entries={entries()}
          showTimestamps
          fill
          empty={active() ? "Waiting for output…" : "No output recorded."}
        />
      </div>
    </ViewLayout>
  )
}
