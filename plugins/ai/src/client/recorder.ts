// Recording from the microphone, for dictation. What is sent, and why:
// - Opus in WebM (`audio/webm;codecs=opus`) where the browser records it: Chrome, Edge, Firefox, Chrome on
//   Android, and Safari 18.4 and later. About 3 to 4 KB a second at 32 kbit/s, so a minute of speech is
//   ~200 KB even on a phone's network, and every Whisper server (they decode with ffmpeg) and OpenAI take it.
// - Opus in Ogg next (older Firefox), then AAC in MP4 (`audio/mp4`): Safari before 18.4, which is every
//   iPhone not yet updated, records nothing else.
// - 16 kHz 16-bit mono WAV, built here, when the browser has no MediaRecorder or none of those types: about
//   32 KB a second, sent when recording stops (so without live text).
// Recording uses a 250 ms timeslice, so audio reaches the router while the person speaks and a live mapping
// can transcribe the audio so far.

/** Recorder formats in the order they are preferred. */
export const PREFERRED_TYPES = [
  "audio/webm;codecs=opus",
  "audio/ogg;codecs=opus",
  "audio/mp4;codecs=mp4a.40.2",
  "audio/mp4",
  "audio/webm",
]

/** The first type the browser's MediaRecorder records, or null for the WAV fallback. */
export function pickType(isSupported: (t: string) => boolean): string | null {
  return PREFERRED_TYPES.find((t) => isSupported(t)) ?? null
}

export const hasMicrophone = () =>
  typeof navigator !== "undefined" && typeof navigator.mediaDevices?.getUserMedia === "function"

/** Mono 16-bit PCM WAV from float samples, resampled to 16 kHz. */
export function encodeWav(chunks: Float32Array[], rate: number, target = 16_000): Uint8Array {
  const total = chunks.reduce((n, c) => n + c.length, 0)
  const ratio = rate / target
  const frames = Math.floor(total / ratio)
  const out = new DataView(new ArrayBuffer(44 + frames * 2))
  const str = (at: number, s: string) => {
    for (let i = 0; i < s.length; i++) out.setUint8(at + i, s.charCodeAt(i))
  }
  str(0, "RIFF")
  out.setUint32(4, 36 + frames * 2, true)
  str(8, "WAVE")
  str(12, "fmt ")
  out.setUint32(16, 16, true)
  out.setUint16(20, 1, true)
  out.setUint16(22, 1, true)
  out.setUint32(24, target, true)
  out.setUint32(28, target * 2, true)
  out.setUint16(32, 2, true)
  out.setUint16(34, 16, true)
  str(36, "data")
  out.setUint32(40, frames * 2, true)
  const all = new Float32Array(total)
  let at = 0
  for (const c of chunks) {
    all.set(c, at)
    at += c.length
  }
  for (let i = 0; i < frames; i++) {
    const s = Math.max(-1, Math.min(1, all[Math.floor(i * ratio)] ?? 0))
    out.setInt16(44 + i * 2, s < 0 ? s * 0x8000 : s * 0x7fff, true)
  }
  return new Uint8Array(out.buffer)
}

/** The microphone's level, 0 to 1, about twenty times a second. Returns a stop function. */
export function meter(
  ctx: AudioContext,
  source: MediaStreamAudioSourceNode,
  onLevel: (l: number) => void,
): () => void {
  const analyser = ctx.createAnalyser()
  analyser.fftSize = 1024
  source.connect(analyser)
  const buf = new Float32Array(analyser.fftSize)
  const timer = setInterval(() => {
    analyser.getFloatTimeDomainData(buf)
    let sum = 0
    for (const v of buf) sum += v * v
    onLevel(Math.min(1, Math.sqrt(sum / buf.length) * 5))
  }, 50)
  return () => {
    clearInterval(timer)
    analyser.disconnect()
  }
}

/** A permission or device failure of `getUserMedia`, in words (a blocked microphone has `blocked: true`). */
export function micError(e: any): Error {
  const name = e?.name ?? ""
  if (name === "NotAllowedError" || name === "SecurityError" || name === "PermissionDeniedError") {
    return Object.assign(new Error("Microphone access is blocked."), {
      blocked: true,
      name: "DictationBlockedError",
    })
  }
  if (name === "NotFoundError" || name === "OverconstrainedError") return new Error("no microphone was found")
  if (name === "NotReadableError") return new Error("the microphone is in use by another app")
  return e instanceof Error ? e : new Error(String(e))
}

/** What the microphone gives while recording: the bytes as they come, and a way to stop. */
export interface Recording {
  mime: string
  /** Stops recording; every byte has been passed to `onBytes` when it resolves. */
  stop(): Promise<void>
  /** Stops and releases the microphone without waiting. */
  cancel(): void
}

/** Starts recording; `onBytes` gets the audio in order. */
export async function record(opts: {
  onBytes: (bytes: Uint8Array) => void
  onLevel?: (level: number) => void
}): Promise<Recording> {
  // Browsers allow the microphone only on HTTPS and on localhost.
  if (!window.isSecureContext || !hasMicrophone()) {
    throw Object.assign(new Error("The microphone needs HTTPS."), {
      blocked: true,
      name: "DictationBlockedError",
    })
  }
  let media: MediaStream
  try {
    media = await navigator.mediaDevices.getUserMedia({
      audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: true },
    })
  } catch (e) {
    throw micError(e)
  }
  const ctx = new AudioContext()
  // iOS starts audio contexts suspended until a gesture; this runs inside the click or key press.
  void ctx.resume().catch(() => {})
  const source = ctx.createMediaStreamSource(media)
  const stopMeter = meter(ctx, source, (l) => opts.onLevel?.(l))
  const release = () => {
    stopMeter()
    for (const t of media.getTracks()) t.stop()
    void ctx.close()
  }
  const type = typeof MediaRecorder === "undefined" ? null : pickType((t) => MediaRecorder.isTypeSupported(t))
  if (type) {
    const recorder = new MediaRecorder(media, { mimeType: type, audioBitsPerSecond: 32_000 })
    // Reads of blobs finish in order: each waits for the one before.
    let chain: Promise<void> = Promise.resolve()
    recorder.ondataavailable = (e) => {
      if (e.data.size)
        chain = chain.then(async () => opts.onBytes(new Uint8Array(await e.data.arrayBuffer())))
    }
    recorder.start(250)
    return {
      mime: type,
      stop: () =>
        new Promise<void>((resolve) => {
          recorder.onstop = () => {
            release()
            void chain.then(resolve)
          }
          recorder.stop()
        }),
      cancel: () => {
        recorder.ondataavailable = null
        try {
          recorder.stop()
        } catch {}
        release()
      },
    }
  }
  // No MediaRecorder: raw samples, made into a WAV at the end.
  const chunks: Float32Array[] = []
  const node = ctx.createScriptProcessor(4096, 1, 1)
  node.onaudioprocess = (e) => chunks.push(new Float32Array(e.inputBuffer.getChannelData(0)))
  source.connect(node)
  node.connect(ctx.destination)
  return {
    mime: "audio/wav",
    stop: async () => {
      node.disconnect()
      const rate = ctx.sampleRate
      release()
      opts.onBytes(encodeWav(chunks, rate))
    },
    cancel: () => {
      node.disconnect()
      release()
    },
  }
}
