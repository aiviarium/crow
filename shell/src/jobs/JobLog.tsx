// Live job log panel built on Nocturne's LogViewer, backed by `jobs.follow` with cursor tracking
// and automatic resumption across reconnects.
import { type LogEntry, LogViewer, type StreamStatus } from "@aiviarium/nocturne"
import type { Connection, JobEnd, LogItem } from "@rookery/client"
import { createEffect, createSignal, type JSX, on, onCleanup } from "solid-js"
import { jobLogItemToEntry, openJobFollow } from "./state"

export interface JobLogProps {
  conn: Connection
  jobId: string
  active?: boolean
  onDone?: (end: JobEnd) => void
}

export function JobLog(props: JobLogProps): JSX.Element {
  const [entries, setEntries] = createSignal<LogEntry[]>([])
  const [streamState, setStreamState] = createSignal<StreamStatus>("connecting")
  const [cursor, setCursor] = createSignal(0)
  const [streamCode, setStreamCode] = createSignal<string | undefined>(undefined)

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
        setCursor(0)
        setStreamCode(undefined)
        setStreamState("connecting")

        const append = (item: LogItem) => {
          if (item.seq <= lastSeq) return
          lastSeq = item.seq
          setCursor(lastSeq)
          setEntries((prev) => [...prev, jobLogItemToEntry(item)])
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
              onDone: (end) => {
                if (disposed) return
                done = true
                setStreamState(end.state === "failed" ? "error" : "ended")
                if (end.error) setStreamCode(end.error.message)
                props.onDone?.(end)
              },
              onEnd: () => {
                if (disposed || done) return
                // Stream closed before the terminal line (e.g. socket dropped); wait for reconnect.
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
