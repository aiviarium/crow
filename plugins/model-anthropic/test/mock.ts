// A mock of Anthropic's Messages API (POST /v1/messages with SSE streaming, GET /v1/models) for the tests.
export interface MockMessages {
  url: string
  requests: any[]
  aborted: () => boolean
  stop(): void
}

function sse(events: Array<[string, unknown]>): string {
  return events.map(([name, data]) => `event: ${name}\ndata: ${JSON.stringify(data)}\n\n`).join("")
}

export function startMockMessages(port = 0): MockMessages {
  const requests: any[] = []
  let aborted = false
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port,
    async fetch(req) {
      const url = new URL(req.url)
      const key = req.headers.get("x-api-key") ?? req.headers.get("authorization")?.replace(/^Bearer /, "")
      if (key !== "sk-ant-mock") {
        return Response.json(
          { type: "error", error: { type: "authentication_error", message: "invalid x-api-key" } },
          { status: 401 },
        )
      }
      if (url.pathname === "/v1/models") {
        return Response.json({
          data: [
            {
              type: "model",
              id: "claude-opus-5-5",
              display_name: "Claude Opus 5.5",
              created_at: "2026-10-01T00:00:00Z",
            },
            {
              type: "model",
              id: "claude-haiku-5-5",
              display_name: "Claude Haiku 5.5",
              created_at: "2026-10-01T00:00:00Z",
            },
          ],
          has_more: false,
          first_id: "claude-opus-5-5",
          last_id: "claude-haiku-5-5",
        })
      }
      if (url.pathname !== "/v1/messages") return new Response("not found", { status: 404 })
      const body = (await req.json()) as any
      requests.push({ body, headers: Object.fromEntries(req.headers) })
      const model = body.model
      if (model === "missing") {
        return Response.json(
          { type: "error", error: { type: "not_found_error", message: `model: ${model}` } },
          { status: 404 },
        )
      }
      const structured = body.output_config?.format?.type === "json_schema"
      const pieces = structured ? ['{"title":', '"A Claude title"}'] : ["Hello", " from", " Claude"]
      const message = {
        id: "msg_mock",
        type: "message",
        role: "assistant",
        model,
        content: [],
        stop_reason: null,
        stop_sequence: null,
        usage: { input_tokens: 21, output_tokens: 1 },
      }
      const head: Array<[string, unknown]> = [
        ["message_start", { type: "message_start", message }],
        [
          "content_block_start",
          { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
        ],
      ]
      const delta = (text: string): [string, unknown] => [
        "content_block_delta",
        { type: "content_block_delta", index: 0, delta: { type: "text_delta", text } },
      ]
      const tail: Array<[string, unknown]> = [
        ["content_block_stop", { type: "content_block_stop", index: 0 }],
        [
          "message_delta",
          {
            type: "message_delta",
            delta: { stop_reason: model === "refuses" ? "refusal" : "end_turn", stop_sequence: null },
            usage: { output_tokens: 7 },
          },
        ],
        ["message_stop", { type: "message_stop" }],
      ]
      const enc = new TextEncoder()
      const slow = model === "slow"
      const stream = new ReadableStream({
        async start(c) {
          c.enqueue(enc.encode(sse(head)))
          for (let i = 0; i < (slow ? 200 : pieces.length); i++) {
            if (slow) await Bun.sleep(100)
            try {
              c.enqueue(enc.encode(sse([delta(slow ? `${i} ` : pieces[i]!)])))
            } catch {
              return
            }
          }
          c.enqueue(enc.encode(sse(tail)))
          c.close()
        },
        cancel() {
          aborted = true
        },
      })
      return new Response(stream, { headers: { "content-type": "text/event-stream" } })
    },
  })
  return {
    url: `http://127.0.0.1:${server.port}`,
    requests,
    aborted: () => aborted,
    stop: () => server.stop(true),
  }
}
