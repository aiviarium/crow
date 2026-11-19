// The workbench's git parsing and patch building, against what real git writes: each test makes a
// throwaway repository, runs git there and checks the parse, and patches built from a selection are
// applied with `git apply` to see that exactly the chosen lines move.
import { afterAll, beforeEach, describe, expect, test } from "bun:test"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { hasConflictMarkers, parseConflicts, resolve } from "../src/git/conflict"
import { buildPatch, countChanges, hunkAt, linesInRange, parseDiff, unquote } from "../src/git/diff"
import { computeGraph } from "../src/git/graph"
import {
  age,
  blameBlocks,
  COMMIT_FORMAT,
  LOG_FORMAT,
  parseBlame,
  parseCommit,
  parseLog,
  parseRefs,
  parseStashes,
  REF_FORMAT,
  STASH_FORMAT,
} from "../src/git/log"
import { decorations, isConflict, isIgnored, isStaged, isUnstaged, parseStatus } from "../src/git/status"

const dirs: string[] = []
let repo = ""

function git(args: string[], opts: { stdin?: string; cwd?: string; ok?: boolean } = {}): string {
  const r = Bun.spawnSync(["git", "-c", "core.quotePath=false", ...args], {
    cwd: opts.cwd ?? repo,
    stdin: opts.stdin === undefined ? undefined : new TextEncoder().encode(opts.stdin),
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: "Ann",
      GIT_AUTHOR_EMAIL: "ann@example.com",
      GIT_COMMITTER_NAME: "Ann",
      GIT_COMMITTER_EMAIL: "ann@example.com",
      GIT_CONFIG_GLOBAL: "/dev/null",
      GIT_CONFIG_NOSYSTEM: "1",
    },
  })
  const out = r.stdout.toString()
  if (r.exitCode !== 0 && opts.ok !== false) throw new Error(`git ${args.join(" ")}: ${r.stderr.toString()}`)
  return out
}

function write(path: string, text: string) {
  writeFileSync(join(repo, path), text)
}

function newRepo() {
  repo = mkdtempSync(join(tmpdir(), "wb-git-"))
  dirs.push(repo)
  git(["init", "-q", "-b", "main"])
}

afterAll(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true })
})

const lines = (n: number, f = (i: number) => `line ${i}`) =>
  `${Array.from({ length: n }, (_, i) => f(i + 1)).join("\n")}\n`

describe("status (porcelain v2, -z)", () => {
  beforeEach(newRepo)

  test("branch headers, ordinary, renamed, untracked and ignored entries", () => {
    write("a.txt", "a\n")
    write("b file.txt", "b\n")
    write("old.txt", lines(20))
    write(".gitignore", "dist/\n*.log\n")
    git(["add", "."])
    git(["commit", "-qm", "first"])
    write("a.txt", "a changed\n")
    git(["add", "a.txt"])
    write("a.txt", "a changed twice\n")
    write("b file.txt", "b changed\n")
    git(["mv", "old.txt", "new name.txt"])
    write("untracked.txt", "u\n")
    Bun.spawnSync(["mkdir", "-p", join(repo, "dist")])
    write("dist/out.js", "x\n")
    write("debug.log", "x\n")
    const s = parseStatus(
      git(["status", "--porcelain=v2", "-z", "--branch", "--show-stash", "--ignored=traditional"]),
    )
    expect(s.branch.head).toBe("main")
    expect(s.branch.oid).toMatch(/^[0-9a-f]{40}$/)
    expect(s.stash).toBe(0)
    const by = Object.fromEntries(s.entries.map((e) => [e.path, e]))
    expect(by["a.txt"]).toMatchObject({ x: "M", y: "M", kind: "changed" })
    expect(isStaged(by["a.txt"]!) && isUnstaged(by["a.txt"]!)).toBe(true)
    expect(by["b file.txt"]).toMatchObject({ x: ".", y: "M" })
    expect(by["new name.txt"]).toMatchObject({ x: "R", kind: "renamed", orig: "old.txt" })
    expect(by["untracked.txt"]?.kind).toBe("untracked")
    expect(by["dist/"]?.kind).toBe("ignored")
    expect(by["debug.log"]?.kind).toBe("ignored")
    const d = decorations(s.entries)
    expect(d.files.get("a.txt")).toBe("M")
    expect(d.files.get("new name.txt")).toBe("R")
    expect(d.files.get("untracked.txt")).toBe("U")
    expect(isIgnored("dist/out.js", d.ignored)).toBe(true)
    expect(isIgnored("dist", d.ignored)).toBe(true)
    expect(isIgnored("distant.txt", d.ignored)).toBe(false)
  })

  test("before the first commit, detached, ahead and behind, stashes, conflicts", () => {
    write("a.txt", "a\n")
    let s = parseStatus(git(["status", "--porcelain=v2", "-z", "--branch"]))
    expect(s.branch.oid).toBeNull()
    expect(s.branch.head).toBe("main")
    git(["add", "."])
    git(["commit", "-qm", "one"])
    const bare = mkdtempSync(join(tmpdir(), "wb-bare-"))
    dirs.push(bare)
    git(["init", "-q", "--bare", bare])
    git(["remote", "add", "origin", bare])
    git(["push", "-qu", "origin", "main"])
    write("a.txt", "two\n")
    git(["commit", "-qam", "two"])
    write("a.txt", "dirty\n")
    git(["stash", "push", "-qm", "wip"])
    s = parseStatus(git(["status", "--porcelain=v2", "-z", "--branch", "--show-stash"]))
    expect(s.branch.upstream).toBe("origin/main")
    expect(s.branch.ahead).toBe(1)
    expect(s.branch.behind).toBe(0)
    expect(s.stash).toBe(1)
    const stashes = parseStashes(git(["stash", "list", `--format=${STASH_FORMAT}`]))
    expect(stashes).toHaveLength(1)
    expect(stashes[0]!.ref).toBe("stash@{0}")
    expect(stashes[0]!.message).toContain("wip")
    // A conflict.
    git(["checkout", "-qb", "other", "HEAD~1"])
    write("a.txt", "other\n")
    git(["commit", "-qam", "other"])
    git(["merge", "main"], { ok: false })
    s = parseStatus(git(["status", "--porcelain=v2", "-z", "--branch"]))
    const c = s.entries.find((e) => e.path === "a.txt")!
    expect(isConflict(c)).toBe(true)
    expect(c.x + c.y).toBe("UU")
    git(["checkout", "-q", "--detach", "HEAD"], { ok: false })
  })
})

describe("history, refs and blame", () => {
  beforeEach(newRepo)

  test("log with parents, refs and subjects that contain separators", () => {
    write("a.txt", "1\n")
    git(["add", "."])
    git(["commit", "-qm", "first: with, a comma"])
    git(["tag", "v1"])
    git(["checkout", "-qb", "feature"])
    write("b.txt", "b\n")
    git(["add", "."])
    git(["commit", "-qm", "feature work"])
    git(["checkout", "-q", "main"])
    write("a.txt", "2\n")
    git(["commit", "-qam", "main work"])
    git(["merge", "-q", "--no-ff", "-m", "Merge feature", "feature"])
    const log = parseLog(git(["log", "--topo-order", `--format=${LOG_FORMAT}`]))
    expect(log.map((c) => c.subject).sort()).toEqual([
      "Merge feature",
      "feature work",
      "first: with, a comma",
      "main work",
    ])
    expect(log[0]!.subject).toBe("Merge feature")
    expect(log[0]!.parents).toHaveLength(2)
    expect(log[0]!.refs).toContain("HEAD -> main")
    expect(log.at(-1)!.refs).toContain("tag: v1")
    expect(log.at(-1)!.parents).toEqual([])
    expect(log[0]!.author).toBe("Ann")
    const detail = parseCommit(git(["show", "-s", `--format=${COMMIT_FORMAT}`, "HEAD"]))!
    expect(detail.message).toBe("Merge feature")
    expect(detail.parents).toEqual(log[0]!.parents)

    const graph = computeGraph(log)
    expect(graph[0]!.lane).toBe(0)
    // The merge opens a second lane for its second parent, which closes again at the root.
    expect(Math.max(...graph.map((r) => r.width))).toBe(2)
    expect(graph[0]!.edges.filter((e) => e.from === 0)).toHaveLength(2)
    // main keeps to the left lane: the side branch joins it, and the root sits in lane 0 with one line in.
    const joining = graph.find((r) => r.edges.some((e) => e.from !== r.lane && e.to !== e.from))
    expect(joining).toBeDefined()
    const root = graph.at(-1)!
    expect(root.lane).toBe(0)
    expect(root.into).toEqual([0])
    expect(
      graph
        .filter((r) => graph.indexOf(r) > 0 && log[graph.indexOf(r)]!.subject !== "feature work")
        .every((r) => r.lane === 0),
    ).toBe(true)
    expect(root.edges).toHaveLength(0)

    const refs = parseRefs(git(["for-each-ref", `--format=${REF_FORMAT}`, "refs/heads", "refs/tags"]))
    expect(refs.find((r) => r.name === "main")).toMatchObject({ kind: "branch", current: true })
    expect(refs.find((r) => r.name === "feature")).toMatchObject({ kind: "branch", current: false })
    expect(refs.find((r) => r.name === "v1")?.kind).toBe("tag")
  })

  test("blame per line, with uncommitted lines", () => {
    write("a.txt", "one\ntwo\nthree\n")
    git(["add", "."])
    git(["commit", "-qm", "first"])
    write("a.txt", "one\nTWO\nthree\nfour\n")
    git(["commit", "-qam", "second"])
    write("a.txt", "one\nTWO\nthree\nfour\nfive\n")
    const b = parseBlame(git(["blame", "--porcelain", "--", "a.txt"]))
    expect(b.lines).toHaveLength(5)
    const subjects = b.lines.map((sha) => (b.commits[sha]!.uncommitted ? "-" : b.commits[sha]!.summary))
    expect(subjects).toEqual(["first", "second", "first", "second", "-"])
    expect(b.commits[b.lines[0]!]!.author).toBe("Ann")
    expect(b.commits[b.lines[0]!]!.email).toBe("ann@example.com")
    expect(blameBlocks(b).map((x) => [x.start, x.end])).toEqual([
      [1, 1],
      [2, 2],
      [3, 3],
      [4, 4],
      [5, 5],
    ])
    expect(age(1000, 1000 + 3 * 86400)).toBe("3 days ago")
  })
})

describe("diffs and patches by hunk and line", () => {
  beforeEach(newRepo)

  function setup() {
    write("f.txt", lines(40))
    git(["add", "."])
    git(["commit", "-qm", "base"])
    // Two hunks: line 3 changed, line 30 removed and two lines added after 35.
    write(
      "f.txt",
      lines(40, (i) => (i === 3 ? "line 3 changed" : `line ${i}`))
        .replace("line 30\n", "")
        .replace("line 35\n", "line 35\nadded a\nadded b\n"),
    )
  }

  test("parse", () => {
    setup()
    const [f] = parseDiff(git(["diff", "--no-color", "--no-ext-diff"]))
    expect(f!.oldPath).toBe("f.txt")
    expect(f!.status).toBe("modified")
    expect(f!.hunks).toHaveLength(2)
    expect(countChanges(f!)).toEqual({ added: 3, removed: 2 })
    expect(hunkAt(f!, 3)).toBe(0)
    expect(hunkAt(f!, 36)).toBe(1)
  })

  test("staging one hunk", () => {
    setup()
    const [f] = parseDiff(git(["diff", "--no-color"]))
    const patch = buildPatch(
      f!,
      f!.hunks[1]!.lines.flatMap((l, i) => (l.type === " " ? [] : [{ hunk: 1, line: i }])),
    )!
    git(["apply", "--cached", "--check", "-"], { stdin: patch })
    git(["apply", "--cached", "-"], { stdin: patch })
    const staged = parseDiff(git(["diff", "--cached", "--no-color"]))[0]!
    expect(countChanges(staged)).toEqual({ added: 2, removed: 1 })
    const left = parseDiff(git(["diff", "--no-color"]))[0]!
    expect(countChanges(left)).toEqual({ added: 1, removed: 1 })
  })

  test("staging single lines: one addition of two, and a removal", () => {
    setup()
    const [f] = parseDiff(git(["diff", "--no-color"]))
    // In the new file "added a" is line 35 (one line was removed above it).
    const refs = linesInRange(f!, 35, 35)
    expect(refs).toHaveLength(1)
    git(["apply", "--cached", "-"], { stdin: buildPatch(f!, refs)! })
    const show = git(["show", ":f.txt"])
    expect(show).toContain("line 35\nadded a\nline 36")
    expect(show).not.toContain("added b")
    expect(show).toContain("line 30\n")
    expect(show).toContain("line 3\n")
  })

  test("unstaging some lines with a reverse patch from the staged diff", () => {
    setup()
    git(["add", "f.txt"])
    const [f] = parseDiff(git(["diff", "--cached", "--no-color"]))
    // Unstage the change on line 3 only.
    const refs = f!.hunks[0]!.lines.flatMap((l, i) => (l.type === " " ? [] : [{ hunk: 0, line: i }]))
    git(["apply", "--cached", "-R", "-"], { stdin: buildPatch(f!, refs, { reverse: true })! })
    const staged = git(["show", ":f.txt"])
    expect(staged).toContain("line 3\n")
    expect(staged).toContain("added b")
    // Unstage just "added b" of the rest.
    const [g] = parseDiff(git(["diff", "--cached", "--no-color"]))
    const b = g!.hunks.flatMap((h, hi) =>
      h.lines.flatMap((l, li) => (l.text === "added b" ? [{ hunk: hi, line: li }] : [])),
    )
    git(["apply", "--cached", "-R", "-"], { stdin: buildPatch(g!, b, { reverse: true })! })
    const after = git(["show", ":f.txt"])
    expect(after).toContain("added a\nline 36")
    expect(after).not.toContain("added b")
  })

  test("reverting a hunk in the working tree", () => {
    setup()
    const [f] = parseDiff(git(["diff", "--no-color"]))
    const refs = f!.hunks[0]!.lines.flatMap((l, i) => (l.type === " " ? [] : [{ hunk: 0, line: i }]))
    git(["apply", "-R", "-"], { stdin: buildPatch(f!, refs, { reverse: true })! })
    const text = Bun.file(join(repo, "f.txt")).text()
    return text.then((t) => {
      expect(t).toContain("line 3\n")
      expect(t).toContain("added a")
    })
  })

  test("new and deleted files, renames, no newline at end, quoted paths", () => {
    write("keep.txt", "k\n")
    write("gone.txt", "g\n")
    write("move me.txt", lines(10))
    git(["add", "."])
    git(["commit", "-qm", "base"])
    write("new.txt", "no newline")
    git(["rm", "-q", "gone.txt"])
    git(["mv", "move me.txt", "moved.txt"])
    git(["add", "new.txt"])
    const files = parseDiff(git(["diff", "--cached", "--no-color", "-M"]))
    const by = Object.fromEntries(files.map((f) => [f.newPath ?? f.oldPath, f]))
    expect(by["new.txt"]!.status).toBe("added")
    expect(by["new.txt"]!.oldPath).toBeNull()
    expect(by["new.txt"]!.hunks[0]!.lines[0]!.noNewline).toBe(true)
    expect(by["gone.txt"]!.status).toBe("deleted")
    expect(by["moved.txt"]!).toMatchObject({ status: "renamed", oldPath: "move me.txt" })
    // A new file staged by its lines only applies as an added file.
    git(["reset", "-q"])
    const [n] = parseDiff(git(["diff", "--no-color", "--no-index", "/dev/null", "new.txt"], { ok: false }))
    expect(n!.status).toBe("added")
    git(["apply", "--cached", "-"], { stdin: buildPatch(n!)! })
    expect(git(["show", ":new.txt"])).toBe("no newline")
    expect(unquote('"a\\tb\\303\\244"')).toBe("a\tbä")
  })
})

describe("conflict markers", () => {
  test("regions with and without a base, and resolving each way", () => {
    const text = [
      "top",
      "<<<<<<< HEAD",
      "ours 1",
      "||||||| base",
      "base 1",
      "=======",
      "theirs 1",
      ">>>>>>> feature",
      "middle",
      "<<<<<<< HEAD",
      "ours 2",
      "=======",
      "theirs 2a",
      "theirs 2b",
      ">>>>>>> feature",
      "end",
    ].join("\n")
    expect(hasConflictMarkers(text)).toBe(true)
    const regions = parseConflicts(text)
    expect(regions).toHaveLength(2)
    expect(regions[0]).toMatchObject({
      start: 1,
      end: 7,
      ours: ["ours 1"],
      base: ["base 1"],
      theirs: ["theirs 1"],
      theirsLabel: "feature",
    })
    expect(regions[1]!.base).toBeNull()
    const second = resolve(text, regions[1]!, "both")
    expect(second).toContain("middle\nours 2\ntheirs 2a\ntheirs 2b\nend")
    const first = resolve(second, parseConflicts(second)[0]!, "base")
    expect(first).toBe("top\nbase 1\nmiddle\nours 2\ntheirs 2a\ntheirs 2b\nend")
    expect(hasConflictMarkers(first)).toBe(false)
    expect(resolve(text, regions[0]!, "theirs").split("\n")[1]).toBe("theirs 1")
  })
})

describe("changed files and names", () => {
  beforeEach(newRepo)

  test("numstat and name-status with renames, binaries, additions and deletions", async () => {
    const { parseFileList, sanitizeBranch } = await import("../src/git/files")
    write("keep.txt", lines(5))
    write("gone.txt", "g\n")
    write("move.txt", lines(20))
    git(["add", "."])
    git(["commit", "-qm", "base"])
    write("keep.txt", lines(6))
    git(["rm", "-q", "gone.txt"])
    git(["mv", "move.txt", "moved file.txt"])
    writeFileSync(join(repo, "img.bin"), new Uint8Array([0, 1, 2, 0, 255]))
    git(["add", "."])
    const files = parseFileList(
      git(["diff", "--cached", "--numstat", "-z", "-M"]),
      git(["diff", "--cached", "--name-status", "-z", "-M"]),
    )
    const by = Object.fromEntries(files.map((f) => [f.path, f]))
    expect(by["keep.txt"]).toMatchObject({ status: "modified", added: 1, removed: 0 })
    expect(by["gone.txt"]).toMatchObject({ status: "deleted", removed: 1 })
    expect(by["moved file.txt"]).toMatchObject({ status: "renamed", oldPath: "move.txt" })
    expect(by["img.bin"]).toMatchObject({ status: "added", binary: true })
    expect(sanitizeBranch(" fix the  thing ")).toBe("fix-the-thing")
    expect(sanitizeBranch("feat/a..b~1")).toBe("feat/a.b-1")
  })
})
