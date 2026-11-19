// The public API of the Models plugin: the `ai` service, implemented by its Rust service `router`, and the
// `ai.providers` extension contract that provider plugins implement.
//
// Other plugins ask for a task (`text`, `fast`, `transcription`), never a model; an admin maps each task to
// a connection and a model. A task nobody mapped is `UNAVAILABLE`, so a feature checks `tasks` and hides itself.
//
// `@rookery/sdk` does not yet export `defineInterface`, so this module exports the typed Zod schemas directly
// alongside the manifest declaration shape (`interface.json`).
import { z } from "@rookery/sdk"

export const Task = z.enum(["text", "fast", "transcription"])
export type Task = z.infer<typeof Task>

export const Usage = z.object({
  inputTokens: z.number().int().min(0).optional(),
  outputTokens: z.number().int().min(0).optional(),
  audioSeconds: z.number().min(0).optional(),
})
export type Usage = z.infer<typeof Usage>

export const GenerateParams = z.object({
  request: z.string().optional().describe("The caller's id for the request, a UUID"),
  task: Task,
  system: z.string().optional(),
  messages: z
    .array(z.object({ role: z.enum(["user", "assistant"]), content: z.string() }))
    .optional()
    .describe("The conversation so far"),
  prompt: z.string().optional().describe("A user message added after the messages"),
  context: z
    .array(z.string())
    .optional()
    .describe("Entity URIs, turned into text for the caller and given to the model before the messages"),
  schema: z.record(z.string(), z.unknown()).optional().describe("A JSON Schema the answer must match"),
  schemaName: z.string().optional(),
  maxTokens: z.number().int().min(1).optional(),
  temperature: z.number().optional(),
  plugin: z.string().optional().describe("The plugin the request is for, for the usage report"),
  space: z
    .string()
    .optional()
    .describe("The space whose mapping applies; the caller's current one by default"),
})
export type GenerateParams = z.infer<typeof GenerateParams>

export const Generated = z.object({
  request: z.string(),
  text: z.string(),
  object: z.unknown().optional().describe("With a schema: the parsed answer, checked against it"),
  model: z.string(),
  provider: z.string(),
  usage: Usage,
})
export type Generated = z.infer<typeof Generated>

export const Transcribed = z.object({
  request: z.string(),
  text: z.string(),
  language: z.string().optional(),
  seconds: z.number().optional(),
  model: z.string(),
  provider: z.string(),
})
export type Transcribed = z.infer<typeof Transcribed>

/** The contract a provider plugin's contribution to `ai.providers` and its backing service implement. */
export const ProviderContribution = z.object({
  id: z.string(),
  title: z.string(),
  description: z.string().optional(),
  connectionType: z.string(),
  tasks: z.array(Task),
  models: z
    .array(
      z.object({
        id: z.string(),
        title: z.string().optional(),
        tasks: z.array(Task).optional(),
      }),
    )
    .optional(),
  detectsLanguage: z.boolean().optional(),
  service: z.string(),
})
export type ProviderContribution = z.infer<typeof ProviderContribution>

export const ProviderCallParams = z.object({
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
  audio: z.string().optional(),
  mime: z.string().optional(),
  language: z.string().optional(),
})
export type ProviderCallParams = z.infer<typeof ProviderCallParams>

export const ProviderGenerateChunk = z.discriminatedUnion("type", [
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
export type ProviderGenerateChunk = z.infer<typeof ProviderGenerateChunk>

export const ProviderModelInfo = z.object({
  id: z.string(),
  title: z.string().optional(),
  tasks: z.array(Task).optional(),
})
export type ProviderModelInfo = z.infer<typeof ProviderModelInfo>

export const aiInterface = {
  services: {
    ai: {
      tasks: {
        description: "Which tasks the caller can use where they are, and where requests for each go.",
        params: z.object({ space: z.string().optional() }),
        result: z.object({
          tasks: z.array(
            z.object({
              task: Task,
              available: z.boolean(),
              scope: z.enum(["global", "space", "user"]).optional(),
              provider: z.string().optional(),
              model: z.string().optional(),
              destination: z.string().optional(),
              live: z.boolean(),
              detectsLanguage: z.boolean(),
            }),
          ),
        }),
      },
      generate: {
        description:
          "Text from the model mapped to a task, as it is written: `delta` events, then one `done` event with the whole answer. Leaving the stream cancels the request upstream.",
        stream: true,
        params: GenerateParams,
        result: z.discriminatedUnion("type", [
          z.object({ type: z.literal("delta"), text: z.string() }),
          z.object({ type: z.literal("done"), generated: Generated }),
        ]),
      },
      complete: {
        description: "The whole answer at once; with a schema the checked object as well.",
        params: GenerateParams,
        result: Generated,
      },
      transcribe: {
        description: "Speech to text of a whole clip.",
        params: z.object({
          audio: z.string().describe("The clip, base64"),
          mime: z.string().min(1).max(100),
          language: z.string().optional(),
          request: z.string().optional(),
          plugin: z.string().optional(),
          space: z.string().optional(),
        }),
        result: Transcribed,
      },
    },
  },
} as const

export default aiInterface
