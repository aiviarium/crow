import { expect, test } from "bun:test"
import { burnup, currentCycle, eventsFromHistory, nextDates, planRollover } from "../src/lib/cycles"
import {
  DEFAULT_DISPLAY,
  groupIssues,
  type Lookup,
  listRows,
  neighbours,
  patchForGroup,
  showsClosed,
} from "../src/lib/display"
import {
  type Filter,
  filterIssues,
  matches,
  parseQuery,
  printQuery,
  type Resolver,
  toggleValue,
} from "../src/lib/filter"
import { guessMapping, mapCsv, mapGithub, parseCsv, parseDate, parsePriority } from "../src/lib/importer"
import {
  branchName,
  findIssueKeys,
  isProjectKey,
  keyWords,
  parseIssueKey,
  slugify,
  suggestKey,
} from "../src/lib/keys"
import { type CycleRow, defaultState, type IssueRow, type StateRow } from "../src/lib/model"
import { actorUri, historyItems, linkGroup } from "../src/lib/timeline"

// ── keys ────────────────────────────────────────────────────────────────────────────────────────────

test("issue keys parse in any case and print in upper case", () => {
  expect(parseIssueKey("CROW-123")).toEqual({ project: "CROW", number: 123 })
  expect(parseIssueKey(" crow-7 ")).toEqual({ project: "CROW", number: 7 })
  expect(parseIssueKey("CROW-0")).toBeNull()
  expect(parseIssueKey("C-1")).toBeNull()
  expect(parseIssueKey("CROW123")).toBeNull()
  expect(parseIssueKey("1ABC-2")).toBeNull()
})

test("keys are found in branch names and pull request text", () => {
  expect(findIssueKeys("crow-123-fix-login")).toEqual(["CROW-123"])
  expect(findIssueKeys("Fixes CROW-12 and WEB-3, see CROW-12 again")).toEqual(["CROW-12", "WEB-3"])
  expect(findIssueKeys("feature/eng-42_thing")).toEqual(["ENG-42"])
  expect(findIssueKeys("utf-8 and x-1 are not keys? x-1 is too short")).toEqual(["UTF-8"])
  expect(findIssueKeys("no keys here")).toEqual([])
})

test("an issue key is indexed in words search finds however it is typed", () => {
  expect(keyWords("CROW-12")).toBe("CROW 12 CROW12")
  expect(keyWords("nope")).toBe("nope")
})

test("project keys", () => {
  expect(isProjectKey("CROW")).toBe(true)
  expect(isProjectKey("C")).toBe(false)
  expect(isProjectKey("crow")).toBe(false)
  expect(isProjectKey("A1B2")).toBe(true)
  expect(suggestKey("Crow")).toBe("CROW")
  expect(suggestKey("Website redesign")).toBe("WR")
  expect(suggestKey("  ")).toBe("PRJ")
  expect(suggestKey("2026 plans")).toMatch(/^P/)
})

test("branch names are the key and a short slug of the title", () => {
  expect(branchName("CROW-123", "Fix the login page's redirect loop!")).toBe(
    "crow-123-fix-the-login-page-s-redirect-loop",
  )
  expect(branchName("CROW-1", "Ünïcødé façade")).toBe("crow-1-unicode-facade")
  expect(branchName("CROW-9", "!!!")).toBe("crow-9")
  const long = branchName("CROW-55", `${"a ".repeat(80)}end`)
  expect(long.length).toBeLessThanOrEqual(60)
  expect(long.startsWith("crow-55-")).toBe(true)
  expect(long.endsWith("-")).toBe(false)
  expect(slugify("Hello,   World")).toBe("hello-world")
})

// ── filters ─────────────────────────────────────────────────────────────────────────────────────────

const issue = (over: Partial<IssueRow>): IssueRow => ({
  id: over.id ?? "i1",
  spaceId: "s1",
  number: 1,
  key: "CROW-1",
  title: "Fix login",
  label: "CROW-1 Fix login",
  document: null,
  state: "st-todo",
  stateName: "Todo",
  stateCategory: "unstarted",
  icon: null,
  priority: 0,
  assignee: null,
  labels: [],
  estimate: null,
  due: null,
  parent: null,
  cycle: null,
  rank: "5",
  followers: [],
  startedAt: null,
  completedAt: null,
  createdAt: "2026-11-01T10:00:00Z",
  updatedAt: "2026-11-01T10:00:00Z",
  createdBy: "user://ann",
  updatedBy: null,
  rev: 1,
  ...over,
})

const names: Record<string, Record<string, string>> = {
  state: { "st-todo": "Todo", "st-prog": "In progress", "st-done": "Done" },
  label: { "label://bug": "Bug", "label://fe": "Front end" },
  assignee: { "user://ann": "Ann", "user://bo": "Bo" },
  creator: { "user://ann": "Ann", "user://bo": "Bo" },
  cycle: { "cycle://c1": "Cycle 1" },
}
const resolver: Resolver = {
  id(field, name) {
    const m = names[field]
    if (!m) return null
    return Object.entries(m).find(([, n]) => n.toLowerCase() === name.toLowerCase())?.[0] ?? null
  },
  name(field, id) {
    return names[field]?.[id] ?? id
  },
}

test("the query bar reads fields, lists, negation, all-of and free text", () => {
  const { filter, unknown } = parseQuery(
    'state:"In progress",todo -assignee:bo label:bug+"front end" priority:urgent,high due:<2026-12-01 fix login nope:x',
    resolver,
  )
  expect(unknown).toEqual([])
  expect(filter.conditions).toEqual([
    { field: "state", op: "is", values: ["st-prog", "st-todo"] },
    { field: "assignee", op: "not", values: ["user://bo"] },
    { field: "label", op: "all", values: ["label://bug", "label://fe"] },
    { field: "priority", op: "is", values: ["1", "2"] },
    { field: "due", op: "before", values: ["2026-12-01"] },
  ])
  expect(filter.text).toBe("fix login nope:x")
  // Printing and reading again gives the same filter.
  expect(parseQuery(printQuery(filter, resolver), resolver).filter).toEqual(filter)
})

test("unknown values are reported, special values are kept", () => {
  const r = parseQuery("assignee:me,none label:nosuch cycle:current is:started", resolver)
  expect(r.unknown).toEqual(["label:nosuch"])
  expect(r.filter.conditions).toEqual([
    { field: "assignee", op: "is", values: ["me", "none"] },
    { field: "cycle", op: "is", values: ["current"] },
    { field: "category", op: "is", values: ["started"] },
  ])
})

test("matching", () => {
  const ctx = { me: "user://ann", currentCycles: { s1: "cycle://c1" }, today: "2026-11-15" }
  const a = issue({
    assignee: "user://ann",
    labels: ["label://bug"],
    priority: 1,
    cycle: "cycle://c1",
    due: "2026-11-10",
  })
  const b = issue({
    id: "i2",
    key: "CROW-2",
    title: "Write docs",
    state: "st-done",
    stateCategory: "completed",
  })
  const f = (q: string): Filter => parseQuery(q, resolver).filter
  expect(matches(a, f("assignee:me"), ctx)).toBe(true)
  expect(matches(b, f("assignee:me"), ctx)).toBe(false)
  expect(matches(b, f("assignee:none"), ctx)).toBe(true)
  expect(matches(a, f("-label:bug"), ctx)).toBe(false)
  expect(matches(b, f("label:none"), ctx)).toBe(true)
  expect(matches(a, f('label:bug+"front end"'), ctx)).toBe(false)
  expect(matches(a, f("cycle:current"), ctx)).toBe(true)
  expect(matches(a, f("due:overdue"), ctx)).toBe(true)
  expect(matches(a, f("due:>2026-11-11"), ctx)).toBe(false)
  expect(matches(a, f("priority:urgent"), ctx)).toBe(true)
  expect(matches(b, f("is:completed docs"), ctx)).toBe(true)
  expect(matches(b, f("crow-2"), ctx)).toBe(true)
  // A key-shaped word is that key, not every key it begins.
  expect(matches(issue({ key: "CROW-20" }), f("crow-2"), ctx)).toBe(false)
  expect(filterIssues([a, b], f("fix"), ctx).map((i) => i.id)).toEqual(["i1"])
})

test("toggling a value in the builder adds and removes it", () => {
  let f: Filter = { conditions: [] }
  f = toggleValue(f, "label", "label://bug")
  f = toggleValue(f, "label", "label://fe")
  expect(f.conditions).toEqual([{ field: "label", op: "is", values: ["label://bug", "label://fe"] }])
  f = toggleValue(toggleValue(f, "label", "label://bug"), "label", "label://fe")
  expect(f.conditions).toEqual([])
})

// ── grouping and order ─────────────────────────────────────────────────────────────────────────────

const states: StateRow[] = [
  { id: "st-back", spaceId: "s1", name: "Backlog", category: "backlog", color: "muted", rank: "1" },
  { id: "st-todo", spaceId: "s1", name: "Todo", category: "unstarted", color: "muted", rank: "2" },
  { id: "st-prog", spaceId: "s1", name: "In progress", category: "started", color: "warning", rank: "3" },
  { id: "st-done", spaceId: "s1", name: "Done", category: "completed", color: "accent", rank: "4" },
]
const look: Lookup = {
  states,
  labels: [
    { id: "label://bug", name: "Bug", color: "danger", scope: null },
    { id: "label://fe", name: "Front end", color: "info", scope: null },
  ],
  cycles: [],
  userName: (id) => names.assignee![id] ?? id,
  issue: () => undefined,
}

test("groups follow the workflow order, issues the manual order", () => {
  const list = [
    issue({ id: "a", rank: "3", state: "st-prog" }),
    issue({ id: "b", rank: "1", state: "st-todo" }),
    issue({ id: "c", rank: "2", state: "st-todo" }),
  ]
  const groups = groupIssues(list, DEFAULT_DISPLAY, look)
  expect(groups.map((g) => g.name)).toEqual(["Todo", "In progress"])
  expect(groups[0]!.issues.map((i) => i.id)).toEqual(["b", "c"])
  // A board shows every state as a column, empty ones included.
  const board = groupIssues(list, { ...DEFAULT_DISPLAY, layout: "board" }, look)
  expect(board.map((g) => g.name)).toEqual(["Backlog", "Todo", "In progress", "Done"])
  const rows = listRows(groups, new Set(["st-todo"]), "state")
  expect(rows.map((r) => (r.kind === "group" ? `#${r.group.name}` : r.issue.id))).toEqual([
    "#Todo",
    "#In progress",
    "a",
  ])
})

test("by label an issue sits in each of its labels' groups; by priority urgent comes first", () => {
  const list = [
    issue({ id: "a", labels: ["label://bug", "label://fe"], priority: 3 }),
    issue({ id: "b", labels: [], priority: 1 }),
  ]
  const byLabel = groupIssues(list, { ...DEFAULT_DISPLAY, groupBy: "label" }, look)
  expect(byLabel.map((g) => [g.name, g.issues.map((i) => i.id)])).toEqual([
    ["Bug", ["a"]],
    ["Front end", ["a"]],
    ["No label", ["b"]],
  ])
  const byPri = groupIssues(list, { ...DEFAULT_DISPLAY, groupBy: "priority" }, look)
  expect(byPri.map((g) => g.name)).toEqual(["Urgent", "Medium"])
  const ordered = groupIssues(list, { ...DEFAULT_DISPLAY, groupBy: "none", orderBy: "priority" }, look)
  expect(ordered[0]!.issues.map((i) => i.id)).toEqual(["b", "a"])
})

test("dropping into a group gives the patch that puts the issue there", () => {
  const a = issue({ labels: ["label://bug"] })
  expect(patchForGroup(a, "state", "st-prog")).toEqual({ state: "st-prog" })
  expect(patchForGroup(a, "state", "st-todo")).toBeNull()
  expect(patchForGroup(a, "assignee", "")).toBeNull()
  expect(patchForGroup(a, "assignee", "user://bo")).toEqual({ assignee: "user://bo" })
  expect(patchForGroup(a, "label", "label://fe", "label://bug")).toEqual({ labels: ["label://fe"] })
  expect(patchForGroup(a, "priority", "2")).toEqual({ priority: 2 })
  expect(neighbours([issue({ id: "x" }), issue({ id: "y" }), issue({ id: "z" })], "x", 1)).toMatchObject({
    above: { id: "y" },
    below: { id: "z" },
  })
})

test("closed issues show by the completed option", () => {
  const now = Date.parse("2026-11-15T00:00:00Z")
  const done = issue({ stateCategory: "completed", completedAt: "2026-11-01T00:00:00Z" })
  const recent = issue({ stateCategory: "completed", completedAt: "2026-11-13T00:00:00Z" })
  expect(showsClosed(done, "all", now)).toBe(true)
  expect(showsClosed(done, "week", now)).toBe(false)
  expect(showsClosed(recent, "week", now)).toBe(true)
  expect(showsClosed(recent, "none", now)).toBe(false)
  expect(showsClosed(issue({}), "none", now)).toBe(true)
})

test("a new issue starts in the first unstarted state", () => {
  expect(defaultState(states)?.name).toBe("Todo")
  expect(defaultState(states.filter((s) => s.category !== "unstarted"))?.name).toBe("Backlog")
})

// ── cycles ──────────────────────────────────────────────────────────────────────────────────────────

const cycle = (id: string, startsOn: string, endsOn: string, closed = false): CycleRow => ({
  id,
  spaceId: "s1",
  number: Number(id.slice(1)),
  name: `Cycle ${id.slice(1)}`,
  startsOn,
  endsOn,
  closed,
  summary: null,
  rolledTo: null,
  createdAt: "",
})

test("an ended cycle closes and its unfinished issues roll over to the next one", () => {
  const cycles = [cycle("c1", "2026-11-01", "2026-11-14"), cycle("c2", "2026-11-15", "2026-11-28")]
  expect(currentCycle(cycles, "2026-11-15")?.id).toBe("c2")
  const issues = [
    { id: "a", cycle: "cycle://c1", stateCategory: "started" as const },
    { id: "b", cycle: "cycle://c1", stateCategory: "completed" as const },
    { id: "c", cycle: "cycle://c1", stateCategory: "cancelled" as const },
    { id: "d", cycle: "cycle://c2", stateCategory: "unstarted" as const },
  ]
  const plan = planRollover(cycles, issues, "2026-11-15", {
    auto: false,
    weeks: 2,
    uri: (id) => `cycle://${id}`,
  })
  expect(plan).toEqual({
    close: ["c1"],
    moves: [{ issue: "a", from: "cycle://c1", to: "cycle://c2" }],
    create: null,
  })
  // Nothing ended yet: nothing to do.
  expect(
    planRollover(cycles, issues, "2026-11-14", { auto: false, weeks: 2, uri: (id) => `cycle://${id}` }).close,
  ).toEqual([])
})

test("with automatic cycles a missing next cycle is created and the issues go there", () => {
  const cycles = [cycle("c1", "2026-11-01", "2026-11-14")]
  const plan = planRollover(
    cycles,
    [{ id: "a", cycle: "cycle://c1", stateCategory: "unstarted" }],
    "2026-11-16",
    {
      auto: true,
      weeks: 1,
      uri: (id) => `cycle://${id}`,
    },
  )
  expect(plan.close).toEqual(["c1"])
  expect(plan.create).toEqual({ startsOn: "2026-11-16", endsOn: "2026-11-22" })
  expect(plan.moves).toEqual([{ issue: "a", from: "cycle://c1", to: "new" }])
  // Without automatic cycles the issues leave the cycle.
  const manual = planRollover(
    cycles,
    [{ id: "a", cycle: "cycle://c1", stateCategory: "unstarted" }],
    "2026-11-16",
    {
      auto: false,
      weeks: 1,
      uri: (id) => `cycle://${id}`,
    },
  )
  expect(manual.moves[0]!.to).toBe("")
  expect(nextDates([cycle("c1", "2026-11-01", "2026-11-14")], 2, "2026-11-10")).toEqual({
    startsOn: "2026-11-15",
    endsOn: "2026-11-28",
  })
})

test("the burn-up counts scope and completed issues per day from history", () => {
  const c = cycle("c1", "2026-11-01", "2026-11-05")
  const uri = "cycle://c1"
  const histA = eventsFromHistory("a", { cycle: uri, category: "completed" }, [
    { at: "2026-10-30T09:00:00Z", op: "insert", changes: {} },
    { at: "2026-11-01T09:00:00Z", op: "update", changes: { cycle: [null, uri] } },
    { at: "2026-11-03T09:00:00Z", op: "update", changes: { stateCategory: ["unstarted", "completed"] } },
  ])
  const histB = eventsFromHistory("b", { cycle: uri, category: "started" }, [
    {
      at: "2026-11-02T12:00:00Z",
      op: "update",
      changes: { cycle: [null, uri], stateCategory: ["unstarted", "started"] },
    },
  ])
  expect(histB.start).toEqual({ cycle: null, category: "unstarted" })
  const points = burnup(
    c,
    uri,
    [...histA.events, ...histB.events],
    { a: histA.start, b: histB.start },
    "2026-11-04",
  )
  expect(points).toEqual([
    { date: "2026-11-01", scope: 1, completed: 0 },
    { date: "2026-11-02", scope: 2, completed: 0 },
    { date: "2026-11-03", scope: 2, completed: 1 },
    { date: "2026-11-04", scope: 2, completed: 1 },
  ])
})

// ── import ──────────────────────────────────────────────────────────────────────────────────────────

test("CSV with quotes, commas, newlines and CRLF", () => {
  const rows = parseCsv(
    'Title,Description,Labels\r\n"Fix ""login""","line 1\nline 2","bug, auth"\r\nSecond,,\r\n',
  )
  expect(rows).toEqual([
    ["Title", "Description", "Labels"],
    ['Fix "login"', "line 1\nline 2", "bug, auth"],
    ["Second", "", ""],
  ])
})

test("columns are guessed from the header and mapped to issues", () => {
  const rows = parseCsv(
    "ID,Summary,Status,Priority,Assigned to,Tags,Points,Due\nOLD-1,Fix login,In Progress,P1,ann@dev.local,bug;auth,3,2026-12-01\n,,,,,,,\nOLD-2,,Todo,,,,,\n",
  )
  const mapping = guessMapping(rows[0]!)
  expect(mapping).toEqual(["source", "title", "state", "priority", "assignee", "labels", "estimate", "due"])
  const { issues, skipped } = mapCsv(rows, mapping)
  expect(issues).toEqual([
    {
      source: "OLD-1",
      title: "Fix login",
      state: "In Progress",
      priority: 1,
      assignee: "ann@dev.local",
      labels: ["bug", "auth"],
      estimate: 3,
      due: "2026-12-01",
    },
  ])
  expect(skipped).toEqual([3])
  expect(parsePriority("High")).toBe(2)
  expect(parsePriority("whatever")).toBeUndefined()
  expect(parseDate("Dec 1, 2026")).toBe("2026-12-01")
})

test("GitHub issues map states, labels, assignees and skip pull requests", () => {
  const { issues, skipped } = mapGithub([
    {
      number: 4,
      title: "Crash on start",
      body: "Steps…",
      state: "open",
      labels: [{ name: "bug" }, { name: "P1" }],
      assignee: { login: "ann" },
    },
    { number: 5, title: "Old idea", state: "closed", state_reason: "not_planned", labels: ["idea"] },
    { number: 6, title: "A PR", state: "open", pull_request: {} },
    {
      number: 7,
      title: "Done thing",
      state: "CLOSED",
      stateReason: "COMPLETED",
      labels: [],
      assignees: [{ login: "bo" }],
      createdAt: "2026-01-01T00:00:00Z",
    },
  ])
  expect(skipped).toBe(1)
  expect(issues.map((i) => [i.title, i.category, i.assignee, i.labels, i.priority, i.source])).toEqual([
    ["Crash on start", "unstarted", "ann", ["bug", "P1"], 1, "#4"],
    ["Old idea", "cancelled", undefined, ["idea"], undefined, "#5"],
    ["Done thing", "completed", "bo", [], undefined, "#7"],
  ])
  expect(() => mapGithub({ nope: 1 })).toThrow()
})

// ── timeline ────────────────────────────────────────────────────────────────────────────────────────

test("history becomes timeline entries, with quick edits by one person merged", () => {
  const items = historyItems([
    {
      op: "insert",
      rev: 1,
      principal: "user:ann",
      onBehalfOf: null,
      at: "2026-11-01T10:00:00Z",
      changes: {},
    },
    {
      op: "update",
      rev: 2,
      principal: "user:ann",
      onBehalfOf: null,
      at: "2026-11-01T10:05:00Z",
      changes: { state: ["a", "b"], rank: ["1", "2"] },
    },
    {
      op: "update",
      rev: 3,
      principal: "user:ann",
      onBehalfOf: null,
      at: "2026-11-01T10:05:20Z",
      changes: { state: ["b", "c"], priority: [0, 2] },
    },
    {
      op: "update",
      rev: 4,
      principal: "user:ann",
      onBehalfOf: null,
      at: "2026-11-01T10:05:30Z",
      changes: { priority: [2, 0] },
    },
    {
      op: "update",
      rev: 5,
      principal: "agent:s1",
      onBehalfOf: "ann",
      at: "2026-11-01T11:00:00Z",
      changes: { assignee: [null, "user://bo"] },
    },
    {
      op: "update",
      rev: 6,
      principal: "user:bo",
      onBehalfOf: null,
      at: "2026-11-01T12:00:00Z",
      changes: { rank: ["2", "3"] },
    },
  ])
  expect(items).toEqual([
    { kind: "created", at: "2026-11-01T10:00:00Z", actor: "user://ann" },
    {
      kind: "change",
      at: "2026-11-01T10:05:30Z",
      actor: "user://ann",
      onBehalfOf: null,
      changes: [{ field: "state", from: "a", to: "c" }],
    },
    {
      kind: "change",
      at: "2026-11-01T11:00:00Z",
      actor: "session://s1",
      onBehalfOf: "ann",
      changes: [{ field: "assignee", from: null, to: "user://bo" }],
    },
  ])
  expect(actorUri("user:x", null)).toBe("user://x")
  expect(linkGroup("issue://a", "parent")).toBe("sub-issue")
  expect(linkGroup("note://a", "document:x")).toBe("note")
})
