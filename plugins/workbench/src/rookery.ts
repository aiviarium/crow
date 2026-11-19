// The plugin's `rookery` handle, for modules loaded later that are not handed it.
import type { ClientRookery } from "@rookery/sdk/client"

let handle: ClientRookery | null = null

export function setRookery(r: ClientRookery) {
  handle = r
}

export function rookery(): ClientRookery {
  if (!handle) throw new Error("the workbench's client half has not started")
  return handle
}
