// Module shapes the bundler provides and Monaco's internals without types. Referenced from `index.ts` so
// they are in every program that reaches the editor, including the shell's (which imports every plugin's
// client half through its builtins).
declare module "*?worker" {
  /** Starts the bundled file as a module worker. */
  const createWorker: (options?: WorkerOptions) => Worker
  export default createWorker
}

declare module "monaco-editor/base/common/marked/marked" {
  export const marked: {
    parse(text: string, options?: { async?: boolean; gfm?: boolean }): string | Promise<string>
  }
}

declare module "monaco-editor/base/browser/dompurify/dompurify" {
  const purify: { sanitize(html: string, options?: Record<string, unknown>): string }
  export default purify
}
