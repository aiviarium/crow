import { expect, test } from "bun:test"
import type { StateRow } from "../src/lib/model"
import {
  decide,
  hueOf,
  labelSet,
  remoteState,
  remoteStateOf,
  sameList,
  sameMarkdown,
  stateFor,
  unstarted,
  withConflict,
} from "../src/lib/source"

const states: StateRow[] = [
  { id: "b", spaceId: "s", name: "Backlog", category: "backlog", color: "muted", rank: "a" },
  { id: "t", spaceId: "s", name: "Todo", category: "unstarted", color: "muted", rank: "b" },
  { id: "p", spaceId: "s", name: "In progress", category: "started", color: "warning", rank: "c" },
  { id: "r", spaceId: "s", name: "In review", category: "started", color: "info", rank: "d" },
  { id: "d", spaceId: "s", name: "Done", category: "completed", color: "accent", rank: "e" },
  { id: "x", spaceId: "s", name: "Cancelled", category: "cancelled", color: "muted", rank: "f" },
]

test("GitHub's state and reason are one value; a closed issue without a reason was completed", () => {
  expect(remoteState("open")).toBe("open")
  expect(remoteState("open", "reopened")).toBe("open")
  expect(remoteState("closed")).toBe("closed:completed")
  expect(remoteState("closed", "completed")).toBe("closed:completed")
  expect(remoteState("closed", "not_planned")).toBe("closed:not_planned")
})

test("Crow's categories as GitHub sees them: everything not done is open", () => {
  expect(remoteStateOf("backlog")).toBe("open")
  expect(remoteStateOf("unstarted")).toBe("open")
  expect(remoteStateOf("started")).toBe("open")
  expect(remoteStateOf("completed")).toBe("closed:completed")
  expect(remoteStateOf("cancelled")).toBe("closed:not_planned")
  expect(remoteStateOf(null)).toBe("open")
})

test("states map by the table in docs/issues.md", () => {
  // open, first seen: the default unstarted state
  expect(stateFor("open", null, states)?.name).toBe("Todo")
  // open while started in Crow: unchanged
  expect(stateFor("open", "started", states)).toBeUndefined()
  expect(stateFor("open", "unstarted", states)).toBeUndefined()
  // closed completed / not planned: the first state of the category, unless it is already there
  expect(stateFor("closed:completed", "started", states)?.name).toBe("Done")
  expect(stateFor("closed:completed", "completed", states)).toBeUndefined()
  expect(stateFor("closed:not_planned", "unstarted", states)?.name).toBe("Cancelled")
  expect(stateFor("closed:not_planned", "cancelled", states)).toBeUndefined()
  // reopened: the default unstarted state
  expect(stateFor("open", "completed", states)?.name).toBe("Todo")
  expect(stateFor("open", "cancelled", states)?.name).toBe("Todo")
  // a project without unstarted states falls back to the backlog
  expect(unstarted(states.filter((s) => s.category !== "unstarted"))?.name).toBe("Backlog")
})

test("an inbound value is taken when only the source changed; when both did, the later write wins", () => {
  const at = (s: number) => new Date(Date.UTC(2026, 10, 16, 12, 0, s)).toISOString()
  expect(
    decide({ remoteChanged: false, crowChanged: true, same: false, remoteAt: at(9), crowAt: at(1) }),
  ).toEqual({ kind: "keep" })
  expect(
    decide({ remoteChanged: true, crowChanged: false, same: false, remoteAt: at(1), crowAt: at(9) }),
  ).toEqual({ kind: "apply" })
  expect(
    decide({ remoteChanged: true, crowChanged: true, same: true, remoteAt: at(1), crowAt: at(9) }),
  ).toEqual({
    kind: "keep",
  })
  expect(
    decide({ remoteChanged: true, crowChanged: true, same: false, remoteAt: at(9), crowAt: at(1) }),
  ).toEqual({
    kind: "conflict",
    won: "source",
  })
  expect(
    decide({ remoteChanged: true, crowChanged: true, same: false, remoteAt: at(1), crowAt: at(9) }),
  ).toEqual({
    kind: "conflict",
    won: "crow",
  })
  // Crow never wrote the field: the source wins.
  expect(
    decide({ remoteChanged: true, crowChanged: true, same: false, remoteAt: at(1), crowAt: null }),
  ).toEqual({
    kind: "conflict",
    won: "source",
  })
})

test("Markdown and label sets compare by meaning", () => {
  expect(sameMarkdown("a\r\nb  \n\n", "a\nb")).toBe(true)
  expect(sameMarkdown("a", "b")).toBe(false)
  expect(labelSet(["Bug", "bug", " docs "])).toEqual(["bug", "docs"])
  expect(sameList(["Bug", "Docs"], ["docs", "bug"])).toBe(true)
  expect(sameList(["Bug"], [])).toBe(false)
})

test("GitHub's label colours map to the nearest accent", () => {
  expect(hueOf("d73a4a")).toBe("rose")
  expect(hueOf("#0075ca")).toBe("sky")
  expect(hueOf("a2eeef")).toBe("teal")
  expect(hueOf("fbca04")).toBe("amber")
  expect(hueOf("ededed")).toBe("muted")
  expect(hueOf("")).toBe("muted")
  expect(hueOf("not a colour")).toBe("muted")
})

test("an issue keeps its last conflicts", () => {
  let list = undefined as ReturnType<typeof withConflict> | undefined
  for (let i = 0; i < 25; i++)
    list = withConflict(list, { field: "title", at: String(i), won: "crow", lost: i, kept: -i })
  expect(list!.length).toBe(20)
  expect(list![0]!.lost).toBe(5)
})
