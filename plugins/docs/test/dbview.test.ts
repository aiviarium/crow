import { describe, expect, test } from "bun:test"
import type { CollectionContribution } from "@rookery/sdk/client"
import {
  applyView,
  attrsOf,
  collectionColumns,
  databaseIsWide,
  groupRows,
  pageColumns,
  passes,
  toWhere,
  valueForGroup,
  visibleColumns,
} from "../src/lib/dbview"
import type { PropDef } from "../src/lib/props"

const defs: PropDef[] = [
  {
    id: "status",
    name: "Status",
    type: "select",
    options: [
      { id: "ready", name: "Ready", hue: "mint" },
      { id: "applying", name: "Applying", hue: "sky" },
      { id: "draft", name: "Draft" },
    ],
  },
  { id: "target", name: "Target", type: "text" },
  { id: "cpus", name: "CPUs", type: "number" },
  {
    id: "tags",
    name: "Tags",
    type: "multi",
    options: [
      { id: "gpu", name: "gpu" },
      { id: "arm", name: "arm" },
    ],
  },
  { id: "done", name: "Done", type: "checkbox" },
]

const rows = [
  { id: "1", title: "build-01", props: { status: "ready", target: "SSH", cpus: 16, tags: ["gpu"] } },
  { id: "2", title: "agent-lab", props: { status: "applying", target: "Cloud", cpus: 8 } },
  { id: "3", title: "field-laptop", props: { target: "USB", cpus: 4, tags: ["arm", "gpu"], done: true } },
  { id: "4", title: "ci-runner", props: { status: "ready", target: "Docker", cpus: 32 } },
]

describe("views of pages", () => {
  const cols = pageColumns(defs)

  test("filters, sorts and visible columns", () => {
    const view = {
      filters: [{ field: "status", op: "is" as const, value: "ready" }],
      sorts: [{ field: "cpus", dir: "desc" as const }],
    }
    expect(applyView(rows, cols, view).map((r) => r.title)).toEqual(["ci-runner", "build-01"])
    expect(
      applyView(rows, cols, { filters: [{ field: "target", op: "contains", value: "ss" }], sorts: [] }).map(
        (r) => r.id,
      ),
    ).toEqual(["1"])
    expect(
      applyView(rows, cols, { filters: [{ field: "status", op: "empty" }], sorts: [] }).map((r) => r.id),
    ).toEqual(["3"])
    expect(
      applyView(rows, cols, {
        filters: [{ field: "cpus", op: "gt", value: 8 }],
        sorts: [{ field: "title", dir: "asc" }],
      }).map((r) => r.id),
    ).toEqual(["1", "4"])
    expect(
      applyView(rows, cols, { filters: [{ field: "tags", op: "contains", value: "gpu" }], sorts: [] }).map(
        (r) => r.id,
      ),
    ).toEqual(["1", "3"])
    expect(
      applyView(rows, cols, { filters: [{ field: "done", op: "checked" }], sorts: [] }).map((r) => r.id),
    ).toEqual(["3"])
    // A sort puts empty values last whatever the direction of the rest.
    expect(
      applyView(rows, cols, { filters: [], sorts: [{ field: "status", dir: "asc" }] }).map((r) => r.id),
    ).toEqual(["1", "4", "2", "3"])
    expect(
      visibleColumns(cols, {
        layout: "table",
        sorts: [],
        filters: [],
        fields: ["cpus", "title", "nope"],
      }).map((c) => c.id),
    ).toEqual(["title", "cpus"])
  })

  test("groups follow the options' order and keep empty columns to drop into", () => {
    const status = cols.find((c) => c.id === "status")!
    const groups = groupRows(rows, status)
    expect(groups.map((g) => [g.label, g.rows.map((r) => r.id)])).toEqual([
      ["Ready", ["1", "4"]],
      ["Applying", ["2"]],
      ["Draft", []],
      ["No status", ["3"]],
    ])
    expect(valueForGroup(status, "draft")).toBe("draft")
    expect(valueForGroup(status, null)).toBeNull()
    const tags = cols.find((c) => c.id === "tags")!
    expect(groupRows(rows, tags).map((g) => g.rows.length)).toEqual([2, 1, 2])
    expect(valueForGroup(cols.find((c) => c.id === "done")!, "true")).toBe(true)
  })

  test("block attributes are filled in", () => {
    expect(attrsOf(undefined)).toEqual({
      source: null,
      view: { layout: "table", groupBy: null, sorts: [], filters: [], fields: [] },
    })
    expect(
      attrsOf({ source: { kind: "pages", parent: "p1" }, view: { layout: "board", groupBy: "status" } }).view
        .layout,
    ).toBe("board")
    expect(attrsOf({ source: { kind: "collection" } }).source).toBeNull()
  })
})

describe("views of a collection", () => {
  const issues: CollectionContribution = {
    name: "issues",
    entity: { scheme: "issue", title: "title" },
    history: true,
    trash: true,
    indexes: [],
    unique: [],
    fields: [
      {
        name: "title",
        type: "text",
        search: true,
        index: false,
        unique: false,
        caseInsensitive: false,
        required: true,
      },
      {
        name: "state",
        type: "enum",
        values: ["todo", "doing", "done"],
        search: false,
        index: true,
        unique: false,
        caseInsensitive: false,
        required: false,
      },
      {
        name: "estimate",
        type: "integer",
        search: false,
        index: false,
        unique: false,
        caseInsensitive: false,
        required: false,
      },
      {
        name: "assignee",
        type: "ref",
        to: "user",
        search: false,
        index: false,
        unique: false,
        caseInsensitive: false,
        required: false,
      },
      {
        name: "labels",
        type: "refs",
        to: "label",
        search: false,
        index: false,
        unique: false,
        caseInsensitive: false,
        required: false,
      },
      {
        name: "body",
        type: "richtext",
        search: true,
        index: false,
        unique: false,
        caseInsensitive: false,
        required: false,
      },
    ],
  }
  const cols = collectionColumns(issues, { title: "Issues", status: "state", create: true })

  test("fields become typed columns, the primary first and rich text left out", () => {
    expect(cols.map((c) => [c.id, c.type])).toEqual([
      ["title", "title"],
      ["state", "select"],
      ["estimate", "number"],
      ["assignee", "person"],
      ["labels", "relation"],
      ["updatedAt", "date"],
      ["createdAt", "date"],
    ])
    expect(cols[1]!.options!.map((o) => o.name)).toEqual(["Todo", "Doing", "Done"])
  })

  test("what the store can filter goes into where; the rest stays for the client", () => {
    const { where, rest } = toWhere(
      [
        { field: "state", op: "is", value: "doing" },
        { field: "estimate", op: "gt", value: "3" },
        { field: "title", op: "contains", value: "flaky" },
        { field: "labels", op: "contains", value: "label://bug" },
        { field: "assignee", op: "empty" },
      ],
      cols,
    )
    expect(where).toEqual({
      and: [
        { state: "doing" },
        { estimate: { gt: 3 } },
        { labels: { contains: "label://bug" } },
        { assignee: null },
      ],
    })
    expect(rest).toEqual([{ field: "title", op: "contains", value: "flaky" }])
    expect(toWhere([], cols)).toEqual({ where: {}, rest: [] })
    expect(toWhere([{ field: "state", op: "isNot", value: "done" }], cols).where).toEqual({
      state: { ne: "done" },
    })
    const row = {
      id: "i1",
      title: "Flaky test",
      state: "doing",
      assignee: "user://ann",
      updatedAt: "2026-11-14T10:00:00+00:00",
    }
    expect(passes({ field: "title", op: "contains", value: "flaky" }, cols[0]!, row)).toBe(true)
    expect(cols.find((c) => c.id === "updatedAt")!.get(row)).toBe("2026-11-14")
  })
})

describe("databaseIsWide", () => {
  const src = { kind: "pages", parent: "p1" }
  test("a table or a board with a source is forced wide; a list or an empty block is not", () => {
    expect(databaseIsWide({ source: src, view: { layout: "table" } })).toBe(true)
    expect(databaseIsWide({ source: src, view: { layout: "board" } })).toBe(true)
    expect(databaseIsWide({ source: src })).toBe(true)
    expect(databaseIsWide({ source: src, view: { layout: "list" } })).toBe(false)
    expect(databaseIsWide({ source: null, view: { layout: "board" } })).toBe(false)
  })
})
