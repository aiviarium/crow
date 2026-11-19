// What the views do to issues, through the host half (which writes them with the derived fields and sends
// the notifications). Each shows the change at once (an optimistic overlay on the project's store) and
// takes it back with a toast when the kernel refuses.
import type { ClientRookery } from "@rookery/sdk/client"
import type { IssueRow } from "../lib/model"
import { between } from "../lib/rank"
import type { ProjectStore } from "./store"

export type Patch = Partial<
  Pick<
    IssueRow,
    "title" | "state" | "priority" | "assignee" | "labels" | "estimate" | "due" | "parent" | "cycle"
  >
>

const say = (crow: ClientRookery, title: string, e: unknown) =>
  crow.workbench.toast({ title, body: String((e as Error)?.message ?? e), kind: "danger" })

/** The overlay for a patch: its state's name and category too, so the row moves to the right column. */
function shown(store: ProjectStore | null, patch: Patch): Partial<IssueRow> {
  const out: Partial<IssueRow> = { ...patch }
  if (patch.state && store) {
    const st = store.states().find((s) => s.id === patch.state)
    if (st) Object.assign(out, { stateName: st.name, stateCategory: st.category })
  }
  return out
}

export async function updateIssues(
  crow: ClientRookery,
  stores: (space: string) => ProjectStore | null,
  items: Array<Pick<IssueRow, "id" | "spaceId">>,
  patch: Patch,
): Promise<boolean> {
  if (!items.length) return true
  const undo = items.map(
    (i) => stores(i.spaceId)?.optimistic(i.id, shown(stores(i.spaceId), patch)) ?? (() => {}),
  )
  try {
    await crow.host.call("update", { items: items.map((i) => ({ id: i.id, space: i.spaceId })), patch })
    return true
  } catch (e) {
    for (const u of undo) u()
    say(crow, items.length > 1 ? "The issues were not changed" : "The issue was not changed", e)
    return false
  }
}

export async function moveIssue(
  crow: ClientRookery,
  store: ProjectStore,
  p: { id: string; above: IssueRow | null; below: IssueRow | null; patch?: Patch | null },
) {
  // The rank shown meanwhile: between the neighbours as this window sees them. The host computes the real
  // one from the neighbours as they are when it writes.
  const lo = p.above?.rank ?? ""
  const hi = p.below?.rank ?? null
  const undo = store.optimistic(p.id, { ...shown(store, p.patch ?? {}), rank: guessBetween(lo, hi) ?? lo })
  try {
    await crow.host.call("move", {
      space: store.space,
      id: p.id,
      above: p.above?.id ?? null,
      below: p.below?.id ?? null,
      ...(p.patch ? { patch: p.patch } : {}),
    })
  } catch (e) {
    undo()
    say(crow, "The issue was not moved", e)
  }
}

/** A key that sorts between two, for the overlay only (or the lower key when they are out of order). */
function guessBetween(lo: string, hi: string | null): string | null {
  try {
    return between(lo || null, hi)
  } catch {
    return null
  }
}

export async function createIssue(crow: ClientRookery, space: string, values: Record<string, unknown>) {
  return crow.host.call<IssueRow>("createIssue", { space, ...values })
}

export async function removeIssues(crow: ClientRookery, items: Array<Pick<IssueRow, "id" | "spaceId">>) {
  try {
    await crow.host.call("remove", { items: items.map((i) => ({ id: i.id, space: i.spaceId })) })
    crow.workbench.toast({
      title: items.length > 1 ? `${items.length} issues moved to the trash` : "Moved to the trash",
      kind: "info",
    })
    return true
  } catch (e) {
    say(crow, "Not deleted", e)
    return false
  }
}

/** Creates a label in the project, for the label picker's "Create label …". */
export async function createLabel(crow: ClientRookery, space: string, name: string): Promise<string | null> {
  try {
    const row = (await crow.data.labels.insert({
      name,
      color: "accent",
      scope: `space://${space}`,
    } as never)) as unknown as {
      id: string
    }
    return `label://${row.id}`
  } catch (e) {
    say(crow, "No label created", e)
    return null
  }
}
