// Dictation: records from the microphone and sends the audio to the router's `dictate` stream in chunks
// (`dictateAudio`; a client cannot stream bytes to a service), and hands back the transcript, with live text
// where the mapping has it. Audio is never stored: it goes from the recorder to the router, which drops it once
// it is transcribed.
import type { Calls } from "./calls"
import { hasMicrophone, record } from "./recorder"
import type { SpeechSession, SpeechSource, SpeechStartOptions } from "./types"

function toBase64(bytes: Uint8Array): string {
  let s = ""
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000))
  return btoa(s)
}

type DictateEvent = { type: "partial"; text: string } | { type: "transcribed"; transcribed: { text: string } }

export function speechSource(api: {
  calls: Calls
  available: () => boolean
  language: () => Promise<string | undefined>
}): SpeechSource {
  return {
    available: () => hasMicrophone() && api.available(),
    async start(o: SpeechStartOptions): Promise<SpeechSession> {
      const request = crypto.randomUUID()
      const lang = await api.language()
      // Audio goes out in order; the stream is opened once the recorder says what it records.
      let chain: Promise<unknown> = Promise.resolve()
      const send = (params: Record<string, unknown>) => {
        chain = chain.then(() => api.calls.dictateAudio({ request, ...params })).catch(() => {})
      }
      const rec = await record({
        onBytes: (bytes) => send({ data: toBase64(bytes) }),
        onLevel: o.onLevel,
      })
      const abort = new AbortController()
      const done = (async () => {
        let text: string | undefined
        for await (const ev of api.calls.dictate(
          { request, mime: rec.mime, ...(lang && lang !== "auto" ? { language: lang } : {}), plugin: "crow" },
          abort.signal,
        ) as AsyncIterable<DictateEvent>) {
          if (ev.type === "partial") o.onPartial?.(ev.text)
          else if (ev.type === "transcribed") text = ev.transcribed.text
        }
        if (text === undefined) throw new Error("the transcription ended without text")
        return text
      })()
      done.catch(() => {})
      let ended = false
      return {
        async finish() {
          if (ended) return done
          ended = true
          await rec.stop()
          send({ end: true })
          await chain
          return done
        },
        cancel() {
          if (ended) return
          ended = true
          rec.cancel()
          abort.abort()
        },
      }
    },
  }
}
