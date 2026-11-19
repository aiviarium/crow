// Live job log panel built on Nocturne's LogViewer and WidgetProgress, backed by `jobs.follow`
// with cursor tracking and automatic resumption across reconnects.
import { Card, type LogEntry, LogViewer, type StreamStatus, WidgetProgress } from "@aiviarium/nocturne"
import type { Connection, JobLogItem } from "@rookery/client"
import { createEffect, createSignal, type JSX, on, onCleanup, Show } from "solid-js"
import { type JobFollowDone, jobLogItemToEntry, openJobFollow } from "./state"

export interface JobLogProps {
  conn: Connection
  jobId: string
  active?: boolean
  onDone?: (done: JobFollowDone) => void
}

export function JobLog(props: JobLogProps): JSX.Element {
  const [entries, setEntries] = createSignal<LogEntry[]>([])
  const [streamState, setStreamState] = createSignal<StreamStatus>("connecting")
  const [cursor, setCursor] = createSignal(0)
  const [streamCode, setStreamCode] = createSignal<string | undefined>(undefined)
  const [progress, setProgress] = createSignal<{ done: number; total: number; message?: string } | null>(null)

  createEffect(
    on(
      () => props.jobId,
      (id) => {
        if (!id) return
        let disposed = false
        let lastSeq = 0
        let done = false
        let handle: { close(): void } | null = null

        setEntries([])
        setProgress(null)
        setCursor(0)
        setStreamCode(undefined)
        setStreamState("connecting")

        const append = (item: JobLogItem) => {
          if (item.seq <= lastSeq) return
          lastSeq = item.seq
          setCursor(lastSeq)

          if (item.payload.type === "progress") {
            const d = item.payload.done ?? 0
            const t = item.payload.total ?? 0
            if (t > 0) setProgress({ done: d, total: t, message: item.payload.message ?? undefined })
          }

          const entry = jobLogItemToEntry(item)
          if (entry) setEntries((prev) => [...prev, entry])
        }

        const connect = async (after: number) => {
          if (disposed || done) return
          setStreamState(after > 0 ? "resuming" : "connecting")
          try {
            handle?.close()
            handle = await openJobFollow(props.conn, id, after, {
              onItem: (item) => {
                if (disposed) return
                setStreamState("live")
                append(item)
              },
              onDone: (result) => {
                if (disposed) return
                done = true
                setStreamState(result.state === "failed" ? "error" : "ended")
                if (result.error) setStreamCode(result.error)
                props.onDone?.(result)
              },
              onEnd: () => {
                if (disposed || done) return
                // Stream closed before terminal frame (e.g. socket dropped); wait for reconnect.
                setStreamState("resuming")
              },
              onError: (err) => {
                if (disposed || done) return
                setStreamState("error")
                setStreamCode(err.message)
              },
            })
            if (disposed) {
              handle.close()
              handle = null
            } else if (!done) {
              setStreamState((s) => (s === "connecting" || s === "resuming" ? "live" : s))
            }
          } catch (err) {
            if (!disposed && !done) {
              setStreamState("error")
              setStreamCode(err instanceof Error ? err.message : String(err))
            }
          }
        }

        const offOpen = props.conn.onOpen(() => {
          if (!disposed && !done && lastSeq > 0) {
            void connect(lastSeq)
          }
        })

        void connect(0)

        onCleanup(() => {
          disposed = true
          offOpen()
          handle?.close()
          handle = null
        })
      },
    ),
  )

  return (
    <div class="crow-job-log" data-part="shell-job-log">
      <Show when={progress()}>
        {(p) => (
          <Card>
            <div class="crow-progress" data-part="shell-job-progress">
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

      <LogViewer
        title="Output"
        streamState={streamState()}
        streamOffset={cursor() > 0 ? cursor() : undefined}
        streamCode={streamCode()}
        entries={entries()}
        showTimestamps
        fill
        empty={props.active ? "Waiting for output…" : "No output recorded."}
      />
    </div>
  )
}
