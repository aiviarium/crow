// A `@aiviarium/parrot-client` Transport over a Rookery `ClientStream` (`agents.connect`).
// Frames JSON-RPC 2.0 messages as newline-delimited UTF-8 JSON (NDJSON), matching `parrot serve`'s
// wire framing and Rookery's stream conventions.
import {
  Client,
  type ClientOptions,
  type InitializeResult,
  type Transport,
  type TransportHandlers,
} from "@aiviarium/parrot-client"
import type { AgentConnect, ClientRookery, ClientStream } from "@rookery/sdk/client"
import { errorMessage, hostNameFromEnv, toEnvUri } from "./api"
import { AGENT_CONNECT } from "./rookery-wire"

const encoder = new TextEncoder()

/**
 * Wraps a Rookery binary `ClientStream` as a `@aiviarium/parrot-client` `Transport`.
 *
 * Incoming bytes are decoded incrementally as UTF-8 and split on `\n` (ignoring trailing `\r` and
 * blank lines). Outgoing messages are serialized onto a write chain so backpressure from Rookery's
 * credit window never reorders frames.
 */
export function rookeryStreamTransport(stream: ClientStream): Transport {
  const decoder = new TextDecoder()
  let handlers: TransportHandlers | undefined
  let buffer = ""
  let closed = false
  let pendingClose: { had: boolean; error?: Error } = { had: false }
  const queuedLines: string[] = []
  let writeChain: Promise<void> = Promise.resolve()

  const emitLine = (raw: string) => {
    const line = raw.endsWith("\r") ? raw.slice(0, -1) : raw
    if (!line) return
    if (handlers) handlers.message(line)
    else queuedLines.push(line)
  }

  const emitClose = (error?: Error) => {
    if (closed) return
    closed = true
    if (handlers) handlers.close(error)
    else pendingClose = { had: true, error }
  }

  stream.onData = (chunk) => {
    if (closed) return
    buffer += decoder.decode(chunk, { stream: true })
    let nl = buffer.indexOf("\n")
    while (nl !== -1) {
      const line = buffer.slice(0, nl)
      buffer = buffer.slice(nl + 1)
      emitLine(line)
      nl = buffer.indexOf("\n")
    }
  }

  stream.onEnd = (err) => {
    if (closed) return
    buffer += decoder.decode()
    if (buffer) {
      const rest = buffer
      buffer = ""
      for (const line of rest.split("\n")) emitLine(line)
    }
    const reason = err ? new Error(`${err.code}: ${err.message}`) : undefined
    emitClose(reason)
  }

  return {
    send(text) {
      if (closed) return
      const payload = encoder.encode(`${text}\n`)
      writeChain = writeChain
        .then(() => {
          if (closed) return
          return stream.write(payload)
        })
        .catch((err) => {
          if (closed) return
          const reason = err instanceof Error ? err : new Error(errorMessage(err))
          try {
            stream.close()
          } catch {
            // Stream may already be torn down.
          }
          emitClose(reason)
        })
    },
    close() {
      if (closed) return
      closed = true
      try {
        stream.close()
      } catch {
        // Ignore close errors on an already closed stream.
      }
    },
    setHandlers(next) {
      handlers = next
      if (queuedLines.length > 0) {
        const lines = queuedLines.splice(0, queuedLines.length)
        for (const line of lines) next.message(line)
      }
      if (pendingClose.had) {
        const reason = pendingClose.error
        pendingClose = { had: false }
        next.close(reason)
      }
    },
  }
}

export interface ConnectParrotOptions {
  /** Options passed to Parrot `initialize`. */
  client?: ClientOptions
}

export interface ParrotConnection {
  readonly host: string
  readonly env: string
  readonly stream: ClientStream
  readonly client: Client
  readonly initialized: InitializeResult
  close(): void
}

/**
 * Opens an authorised `agents.connect` binary stream to `parrot serve` on `host`, runs the Parrot
 * `initialize` handshake, and returns the ready `Client`.
 */
export async function connectParrot(
  rookery: ClientRookery,
  hostOrEnv: string,
  options: ConnectParrotOptions = {},
): Promise<ParrotConnection> {
  const host = hostNameFromEnv(hostOrEnv)
  const env = toEnvUri(host)
  const params: AgentConnect = { env }
  const stream = await rookery.streams.open(AGENT_CONNECT, params)
  const transport = rookeryStreamTransport(stream)
  const client = new Client(transport)
  try {
    const initialized = await client.initialize({
      peer: {
        kind: "client",
        name: "crow-agents",
        version: "0.1.0",
        ...options.client?.peer,
      },
      ...options.client,
    })
    return {
      host,
      env,
      stream,
      client,
      initialized,
      close() {
        client.close()
      },
    }
  } catch (err) {
    client.close()
    throw err
  }
}
