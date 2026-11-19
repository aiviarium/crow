// The service the Models plugin calls for this provider (the `service` of the contribution to `ai.providers`): it
// gets the request and the id of the connection, and resolves the connection itself (`rookery.connections.resolve`)
// so the API key stays sealed in Rookery's credential store and is never sent to or stored in other plugins.
import { defineInterface, z } from "@rookery/sdk"

export const Task = z.enum(["text", "fast", "transcription"])
export type Task = z.infer<typeof Task>

export const ProviderCall = z.object({
  request: z.string(),
  provider: z.string(),
  task: Task,
  connection: z.string().describe("The id of the connection to use"),
  model: z.string().optional(),
  system: z.string().optional(),
  messages: z.array(z.object({ role: z.enum(["user", "assistant"]), content: z.string() })),
  schema: z.record(z.string(), z.unknown()).optional(),
  schemaName: z.string().optional(),
  maxTokens: z.number().int().min(1).optional(),
  temperature: z.number().optional(),
})
export type ProviderCallParams = z.infer<typeof ProviderCall>

export const GenerateChunk = z.discriminatedUnion("type", [
  z.object({ type: z.literal("delta"), text: z.string() }),
  z.object({
    type: z.literal("result"),
    text: z.string(),
    object: z.unknown().optional(),
    model: z.string().optional(),
    usage: z
      .object({
        inputTokens: z.number().optional(),
        outputTokens: z.number().optional(),
      })
      .optional(),
  }),
])
export type GenerateChunk = z.infer<typeof GenerateChunk>

export const ModelsResult = z.object({
  models: z.array(
    z.object({
      id: z.string(),
      title: z.string().optional(),
      tasks: z.array(Task).optional(),
    }),
  ),
})
export type ModelsResult = z.infer<typeof ModelsResult>

export default defineInterface({
  services: {
    anthropic: {
      generate: {
        description: "Text from the Messages API: `delta` chunks as it is written, then one `result`.",
        stream: true,
        params: ProviderCall,
        result: GenerateChunk,
      },
      models: {
        description: "The models the connection's key may use.",
        params: ProviderCall,
        result: ModelsResult,
      },
    },
  },
})
