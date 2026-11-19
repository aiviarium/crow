// The editor's "Ask AI": the `text` task, wherever it is set up.
import type { Calls } from "./calls"
import type { AssistHandler } from "./types"

const SYSTEM =
  "You are the writing assistant of a document editor. Do what the instruction asks with the text you are " +
  "given and answer with the resulting text only: no preamble, no quotes around it. Keep the text's language. " +
  "Use Markdown only where the result needs structure (lists, headings)."

export function assistant(calls: Calls): AssistHandler {
  return (req) => {
    const parts = [`Instruction: ${req.instruction}`]
    if (req.selection) parts.push(`Text:\n${req.selection}`)
    else
      parts.push(
        `Text before the cursor:\n${req.before.slice(-3000)}`,
        `Text after the cursor:\n${req.after.slice(0, 1000)}`,
      )
    const events = calls.generate(
      { task: "text", system: SYSTEM, prompt: parts.join("\n\n"), plugin: "crow" },
      req.signal,
    )
    return (async function* () {
      for await (const ev of events) if (ev.type === "delta") yield ev.text
    })()
  }
}
