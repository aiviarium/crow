// The client half's handle, kept where every view and component can reach it, and what the views share:
// who the signed-in person is on GitHub, the connections they can use, and how to open a GitHub item.
import type { ClientRookery } from "@rookery/sdk/client"
import { createResource, createRoot } from "solid-js"

let handle: ClientRookery | undefined

export function setRookery(c: ClientRookery) {
  handle = c
}

export function rookery(): ClientRookery {
  if (!handle) throw new Error("the GitHub plugin's client half has not started")
  return handle
}

export interface Me {
  logins: Array<{ host: string; login: string }>
  admin: boolean
}

let meResource: ReturnType<typeof makeMe> | undefined

function makeMe() {
  return createRoot(() => createResource<Me>(() => rookery().host.call<Me>("me")))
}

/** The caller's GitHub logins (from their own tokens) and whether they are an admin. Loaded once. */
export function useMe() {
  meResource ??= makeMe()
  const [me, { refetch }] = meResource
  return {
    me,
    logins: () => (me()?.logins ?? []).map((l) => l.login),
    admin: () => !!me()?.admin,
    refetch,
  }
}

export interface ConnectionRow {
  id: string
  name: string
  type: string
  scope: string
  baseUrl: string
  canManage: boolean
  webhooks: boolean
  rate: { limit: number; remaining: number; resetAt: string } | null
}

/** A message for an error from the host half: what happened, and the fix when the plugin knows one. */
export function describe(e: unknown): { message: string; fix?: string; reason?: string } {
  const err = e as { message?: string; details?: { fix?: string; reason?: string } }
  return { message: err.message ?? String(e), fix: err.details?.fix, reason: err.details?.reason }
}

/** Opens an item of this plugin, or a Crow entity it linked to. */
export function openEntity(uri: string): void {
  const c = rookery()
  if (uri.startsWith("gh-pr://")) {
    c.workbench.openView("code.pull", { path: uri.slice("gh-pr://".length) })
    return
  }
  if (uri.startsWith("gh-repo://")) {
    c.workbench.openView("code.repo", { path: uri.slice("gh-repo://".length) })
    return
  }
  if (/^https?:\/\//.test(uri)) {
    window.open(uri, "_blank", "noopener,noreferrer")
    return
  }
  c.entities.open(uri)
}

/** Opens the Crow issue a GitHub issue became: its project's issues, at that issue. */
export async function openIssue(issue: { key?: string | null; slug?: string | null; uri?: string }) {
  const c = rookery()
  if (issue.key && issue.slug) {
    c.workbench.openView("projects.issue", {
      path: issue.key,
      context: { "rookery.space": issue.slug },
    })
    return
  }
  c.workbench.toast({ title: "This issue is not synced here", kind: "warning" })
}
