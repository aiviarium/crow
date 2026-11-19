// Client-side capability types expected from Rookery/Crow shell (assist, speech, entity lookup) that
// are not yet present on @rookery/sdk/client's ClientRookery interface.
import type { ClientRookery, Disposable } from "@rookery/sdk/client"

export interface AssistRequest {
  action: "improve" | "shorten" | "longer" | "continue" | "fix" | "summarize" | "translate" | "custom"
  instruction: string
  selection: string
  before: string
  after: string
  signal: AbortSignal
}

export type AssistHandler = (req: AssistRequest) => AsyncIterable<string>

export interface SpeechStartOptions {
  onLevel?: (level: number) => void
  onPartial?: (text: string) => void
}

export interface SpeechSession {
  finish(): Promise<string>
  cancel(): void
}

export interface SpeechSource {
  available(): boolean
  start(options: SpeechStartOptions): Promise<SpeechSession>
}

export interface EntityRefSummary {
  uri: string
  title: string
}

export interface EntityLookup {
  resolveMany(uris: string[]): Promise<EntityRefSummary[]>
  search(query: string, opts?: { schemes?: string[]; limit?: number }): Promise<EntityRefSummary[]>
}

export type ClientRookeryWithAi = ClientRookery & {
  assist?: { provide(handler: AssistHandler): Disposable }
  speech?: { provide(source: SpeechSource): Disposable }
  entities?: EntityLookup
}
