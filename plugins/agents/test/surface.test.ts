// Unit tests for surface text cleanup, Parrot ItemPatch application, ConfigOption schema
// extraction, and the Rookery ClientStream NDJSON transport.
import { describe, expect, test } from "bun:test"
import type { ClientStream } from "@rookery/sdk/client"
import { surfaceText } from "../src/model"
import { applyItemPatch, extractOptionChoices, type ParrotItem } from "../src/parrot"
import { rookeryStreamTransport } from "../src/transport"

describe("surfaceText", () => {
  test("drops the title line and the CLI's key hints, whole or wrapped", () => {
    const text = [
      "Pick a theme",
      "Which one do you want?",
      "Enter to select · ↑/↓ to navigate · Esc",
      "to cancel",
      "↓ More models",
      "Keep this line, it says what to do",
    ].join("\n")
    expect(
      surfaceText({ title: "Pick a theme", text, hints: ["Enter to select · ↑/↓ to navigate · Esc"] }),
    ).toBe("Which one do you want?\nKeep this line, it says what to do")
  })

  test("keeps text that only mentions keys in a sentence", () => {
    expect(surfaceText({ text: "The tool wants to write the file." })).toBe(
      "The tool wants to write the file.",
    )
  })
})

describe("applyItemPatch", () => {
  test("creates, streams via append, updates via set, and removes items", () => {
    let items: ParrotItem[] = []
    items = applyItemPatch(items, {
      id: "msg-1",
      kind: "assistant",
      turn: "t-1",
      set: { text: "Hello" },
      streaming: true,
    })
    expect(items).toHaveLength(1)
    expect(items[0]).toMatchObject({
      id: "msg-1",
      kind: "assistant",
      turn: "t-1",
      text: "Hello",
      streaming: true,
    })

    items = applyItemPatch(items, {
      id: "msg-1",
      append: { text: ", world!" },
      streaming: false,
    })
    expect(items[0]).toMatchObject({
      id: "msg-1",
      kind: "assistant",
      text: "Hello, world!",
      streaming: false,
    })

    items = applyItemPatch(items, {
      id: "msg-1",
      set: { _meta: { a: 1 } },
    })
    items = applyItemPatch(items, {
      id: "msg-1",
      set: { _meta: { b: 2 } },
    })
    expect(items[0]?.kind === "assistant" ? items[0]._meta : undefined).toEqual({ a: 1, b: 2 })

    items = applyItemPatch(items, { id: "msg-1", removed: true })
    expect(items).toHaveLength(0)
  })
})

describe("extractOptionChoices", () => {
  test("extracts choices from oneOf and enum JSON Schemas", () => {
    const choices = extractOptionChoices({
      id: "model",
      role: "model",
      label: "Model",
      applies: "now",
      value: "claude-sonnet-4-6",
      schema: {
        oneOf: [
          { const: "claude-sonnet-4-6", title: "Sonnet 4.6", description: "Balanced" },
          { const: "claude-opus-4-6", title: "Opus 4.6" },
        ],
      },
    })
    expect(choices).toEqual([
      { id: "claude-sonnet-4-6", label: "Sonnet 4.6", description: "Balanced" },
      { id: "claude-opus-4-6", label: "Opus 4.6", description: undefined },
    ])

    const enumChoices = extractOptionChoices({
      id: "effort",
      role: "effort",
      label: "Effort",
      applies: "now",
      value: "medium",
      schema: { enum: ["low", "medium", "high"] },
    })
    expect(enumChoices.map((c) => c.id)).toEqual(["low", "medium", "high"])
  })
})

describe("rookeryStreamTransport", () => {
  test("frames NDJSON writes in order and reassembles chunked UTF-8 reads", async () => {
    const written: string[] = []
    const dec = new TextDecoder()
    const enc = new TextEncoder()
    let closedCount = 0

    const stream: ClientStream = {
      id: 1,
      result: { stream: 1 },
      async write(data) {
        await Bun.sleep(1)
        written.push(dec.decode(data))
      },
      eof() {},
      close() {
        closedCount++
      },
      onData: () => {},
      onEnd: () => {},
    }

    const transport = rookeryStreamTransport(stream)
    const received: string[] = []
    let closeErr: Error | undefined
    let closed = false

    // Chunk arrives before setHandlers to verify pre-handler buffering.
    stream.onData(enc.encode('{"jsonrpc":"2.0","id":1'))

    transport.setHandlers({
      message: (line) => received.push(line),
      close: (err) => {
        closed = true
        closeErr = err
      },
    })

    // Split across a multi-byte UTF-8 character ("—") and multiple messages in one chunk.
    const secondPart = enc.encode(
      ',"result":{"ok":true}}\n{"jsonrpc":"2.0","method":"ping","params":{"t":"—"}}\n',
    )
    stream.onData(secondPart.subarray(0, 35))
    stream.onData(secondPart.subarray(35))

    expect(received).toEqual([
      '{"jsonrpc":"2.0","id":1,"result":{"ok":true}}',
      '{"jsonrpc":"2.0","method":"ping","params":{"t":"—"}}',
    ])

    transport.send('{"a":1}')
    transport.send('{"b":2}')
    await Bun.sleep(20)
    expect(written).toEqual(['{"a":1}\n', '{"b":2}\n'])

    stream.onEnd({ code: "UNAVAILABLE", message: "host dropped" })
    expect(closed).toBe(true)
    expect(closeErr?.message).toBe("UNAVAILABLE: host dropped")

    transport.close()
    expect(closedCount).toBe(0) // already closed by onEnd
  })
})
