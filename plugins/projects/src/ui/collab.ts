// A document opened for live editing: the y-protocols sync and awareness messages that `documents.open`
// carries, applied to a Yjs document and awareness the editor binds to. The SDK opens the stream; what
// turns it into a session is the same for every shell, so Docs keeps it beside its views.

import type { ClientRookery } from "@rookery/sdk/client"
import * as decoding from "lib0/decoding"
import * as encoding from "lib0/encoding"
import { createSignal } from "solid-js"
import * as awarenessProtocol from "y-protocols/awareness"
import * as syncProtocol from "y-protocols/sync"
import * as Y from "yjs"
export interface DocumentSession {
  readonly doc: Y.Doc
  readonly awareness: awarenessProtocol.Awareness
  status(): string
  unsynced(): boolean
  error(): Error | null
  readOnly(): boolean
  close(): void
}

const MSG_SYNC = 0
const MSG_AWARENESS = 1
const MSG_AUTH = 2
const MSG_QUERY_AWARENESS = 3

const COLOURS = ["sky", "teal", "amber", "rose", "mint", "orchid", "ember"]

/** Prefixes a message with its varuint length, as `documents.open` frames them. */
export function frame(message: Uint8Array): Uint8Array {
  const head: number[] = []
  let n = message.byteLength
  do {
    let b = n & 0x7f
    n = Math.floor(n / 128)
    if (n > 0) b |= 0x80
    head.push(b)
  } while (n > 0)
  const out = new Uint8Array(head.length + message.byteLength)
  out.set(head, 0)
  out.set(message, head.length)
  return out
}

/** Reads whole framed messages off `buffer`, and what is left of it. */
export function unframe(buffer: Uint8Array): { messages: Uint8Array[]; rest: Uint8Array } {
  const messages: Uint8Array[] = []
  let at = 0
  for (;;) {
    let len = 0
    let mult = 1
    let i = at
    let complete = false
    while (i < buffer.byteLength) {
      const b = buffer[i++]!
      len += (b & 0x7f) * mult
      mult *= 128
      if (!(b & 0x80)) {
        complete = true
        break
      }
    }
    if (!complete || i + len > buffer.byteLength) break
    messages.push(buffer.slice(i, i + len))
    at = i + len
  }
  return { messages, rest: buffer.slice(at) }
}

function concat(a: Uint8Array, b: Uint8Array): Uint8Array {
  if (a.byteLength === 0) return b
  const out = new Uint8Array(a.byteLength + b.byteLength)
  out.set(a, 0)
  out.set(b, a.byteLength)
  return out
}

const encode = (write: (e: encoding.Encoder) => void): Uint8Array => {
  const e = encoding.createEncoder()
  write(e)
  return encoding.toUint8Array(e)
}

/** A presence of the signed-in person, picked from their id when the shell knows them. */
async function localPresence(rookery: ClientRookery): Promise<{ name: string; color: string } | null> {
  try {
    const me = await rookery.rpc.call<{ id?: string; name?: string }>("auth.me", {})
    if (!me?.name) return null
    let h = 0
    for (const c of String(me.id ?? me.name)) h = (h * 31 + c.charCodeAt(0)) >>> 0
    return { name: me.name, color: `var(--label-${COLOURS[h % COLOURS.length]})` }
  } catch {
    return null
  }
}

/** Opens `id` for live editing, with the current document and everyone in it. */
export function openDocument(rookery: ClientRookery, id: string): DocumentSession {
  const doc = new Y.Doc()
  const awareness = new awarenessProtocol.Awareness(doc)
  const [status, setStatus] = createSignal<string>("connecting")
  const [readOnly, setReadOnly] = createSignal(false)
  const [error, setError] = createSignal<Error | null>(null)
  const [unsynced, setUnsynced] = createSignal(false)
  const remote = { remote: true }
  let stream: Awaited<ReturnType<ClientRookery["documents"]["open"]>> | null = null
  let buffer = new Uint8Array(0)
  let closed = false
  let pending = 0
  let unsyncedTimer: ReturnType<typeof setTimeout> | undefined

  const send = (message: Uint8Array) => {
    void stream?.write(frame(message)).catch(() => {})
  }

  const onUpdate = (update: Uint8Array, origin: unknown) => {
    if (origin === remote || readOnly() || !stream) return
    pending++
    if (!unsyncedTimer) {
      unsyncedTimer = setTimeout(() => {
        unsyncedTimer = undefined
        if (pending > 0 && !closed) setUnsynced(true)
      }, 1500)
    }
    send(
      encode((e) => {
        encoding.writeVarUint(e, MSG_SYNC)
        syncProtocol.writeUpdate(e, update)
      }),
    )
  }

  const onAwareness = (
    { added, updated, removed }: { added: number[]; updated: number[]; removed: number[] },
    origin: unknown,
  ) => {
    if (origin === remote) return
    const changed = added.concat(updated, removed)
    send(
      encode((e) => {
        encoding.writeVarUint(e, MSG_AWARENESS)
        encoding.writeVarUint8Array(e, awarenessProtocol.encodeAwarenessUpdate(awareness, changed))
      }),
    )
  }

  const handle = (message: Uint8Array) => {
    const decoder = decoding.createDecoder(message)
    const type = decoding.readVarUint(decoder)
    switch (type) {
      case MSG_SYNC: {
        const response = encoding.createEncoder()
        encoding.writeVarUint(response, MSG_SYNC)
        const kind = syncProtocol.readSyncMessage(decoder, response, doc, remote)
        if (encoding.length(response) > 1) send(encoding.toUint8Array(response))
        if (kind === syncProtocol.messageYjsSyncStep2) {
          pending = 0
          clearTimeout(unsyncedTimer)
          unsyncedTimer = undefined
          setUnsynced(false)
          setStatus("synced")
        }
        break
      }
      case MSG_AWARENESS:
        awarenessProtocol.applyAwarenessUpdate(awareness, decoding.readVarUint8Array(decoder), remote)
        break
      case MSG_AUTH:
        if (decoding.readVarUint(decoder) === 0) setReadOnly(true)
        break
      case MSG_QUERY_AWARENESS:
        send(
          encode((e) => {
            encoding.writeVarUint(e, MSG_AWARENESS)
            encoding.writeVarUint8Array(
              e,
              awarenessProtocol.encodeAwarenessUpdate(awareness, Array.from(awareness.getStates().keys())),
            )
          }),
        )
        break
    }
  }

  doc.on("update", onUpdate)
  awareness.on("update", onAwareness)

  void (async () => {
    try {
      const opened = await rookery.documents.open(id)
      if (closed) {
        opened.close()
        return
      }
      stream = opened
      setReadOnly(opened.readOnly)
      setStatus("syncing")
      opened.onData = (data) => {
        buffer = concat(buffer, data) as Uint8Array<ArrayBuffer>
        const { messages, rest } = unframe(buffer)
        buffer = rest as Uint8Array<ArrayBuffer>
        for (const message of messages) handle(message)
      }
      opened.onEnd = (failure) => {
        if (closed) return
        stream = null
        awarenessProtocol.removeAwarenessStates(
          awareness,
          Array.from(awareness.getStates().keys()).filter((c) => c !== doc.clientID),
          remote,
        )
        if (failure && (failure.code === "NOT_FOUND" || failure.code === "FORBIDDEN")) {
          setError(new Error(failure.message))
          setStatus("error")
          return
        }
        setStatus("offline")
      }
      send(
        encode((e) => {
          encoding.writeVarUint(e, MSG_SYNC)
          syncProtocol.writeSyncStep1(e, doc)
        }),
      )
      const presence = await localPresence(rookery)
      if (presence && !closed) awareness.setLocalStateField("user", presence)
    } catch (e) {
      setError(e instanceof Error ? e : new Error(String(e)))
      setStatus("error")
    }
  })()

  return {
    doc,
    awareness,
    status,
    unsynced,
    error,
    readOnly,
    close() {
      if (closed) return
      closed = true
      clearTimeout(unsyncedTimer)
      awarenessProtocol.removeAwarenessStates(awareness, [doc.clientID], "local")
      const opened = stream
      stream = null
      if (opened) setTimeout(() => opened.close(), 50)
      doc.off("update", onUpdate)
      awareness.off("update", onAwareness)
      awareness.destroy()
      doc.destroy()
    },
  }
}
