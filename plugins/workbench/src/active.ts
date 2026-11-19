// The workspace view that has the focus, for commands and keys: they act on it and do nothing without one.
import { createSignal } from "solid-js"

export interface WorkspaceCommands {
  run(command: string, params: Record<string, unknown>): unknown
}

const mounted = new Set<WorkspaceCommands>()
const [current, setCurrent] = createSignal<WorkspaceCommands | null>(null)

export const activeWorkspace = current

export function registerWorkspace(w: WorkspaceCommands): () => void {
  mounted.add(w)
  setCurrent(w)
  return () => {
    mounted.delete(w)
    if (current() === w) setCurrent([...mounted].pop() ?? null)
  }
}

export function focusWorkspace(w: WorkspaceCommands) {
  if (mounted.has(w)) setCurrent(w)
}
