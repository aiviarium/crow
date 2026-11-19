import { describe, expect, test } from "bun:test"
import { candidates, entityUris, keysIn, mentionsLogin } from "../src/lib/links"
import { changedFields, latestReviews, mapPull, reviewState } from "../src/lib/mapping"
import { mentionedLogins, planComment, planItem } from "../src/lib/notifier"
import { apiBaseFor, parseRepo } from "../src/lib/repos"
import { intervalSecs } from "../src/lib/sync"
import type { GhPull, GhReview } from "../src/lib/types"

const U = "0192a3f0-6b0e-7000-8000-000000000042"

describe("links", () => {
  test("Crow entity URLs and URIs in text, once each", () => {
    const text = `Fixes https://crow.example.com/e/issue/${U} and issue://${U}, also https://example.com/e/note/${U.replace("42", "43")}.`
    expect(entityUris(text)).toEqual([`issue://${U}`, `note://${U.replace("42", "43")}`])
    expect(entityUris("see https://github.com/a/b/pull/3 and ssh://host/x")).toEqual([])
    expect(entityUris(null)).toEqual([])
  })

  test("issue keys by a contributed pattern, in title, body and branch", () => {
    const p = {
      id: "projects.keys",
      pattern: "\\b([A-Z][A-Z0-9]+-\\d+)\\b",
      service: "projects",
      method: "resolveKeys",
    }
    expect(keysIn("ENG-12 and eng-13, not E-1 or ENG-", p)).toEqual(["ENG-12", "eng-13"])
    const found = candidates({ title: "Fix ENG-12", body: "relates to ENG-9", head: "eng-12-fix" }, [p])
    expect(found.map((c) => c.key)).toEqual(["ENG-12", "ENG-9", "eng-12"])
    // A pattern that opts out of branches.
    expect(candidates({ title: "x", head: "eng-12-fix" }, [{ ...p, branches: false }])).toEqual([])
    // A broken pattern finds nothing instead of failing the sync.
    expect(keysIn("ENG-12", { ...p, pattern: "(" })).toEqual([])
  })

  test("a mention is not an e-mail address or part of a word", () => {
    expect(mentionsLogin("ping @ada please", "ada")).toBe(true)
    expect(mentionsLogin("mail ada@example.com", "ada")).toBe(false)
    expect(mentionsLogin("@adam is not ada", "ada")).toBe(false)
    expect(mentionedLogins("cc @ada, @Grace-H and (@linus). mail a@b.c")).toEqual(["ada", "Grace-H", "linus"])
  })
})

const user = (login: string) => ({ login, id: 1 })
const review = (login: string, state: GhReview["state"], at: string, body = ""): GhReview => ({
  id: Math.random(),
  user: user(login),
  state,
  body,
  submitted_at: at,
  html_url: "",
})

describe("reviews", () => {
  test("the latest review of each person counts, and a comment does not undo an approval", () => {
    const rs = latestReviews([
      review("ada", "APPROVED", "2026-01-01T10:00:00Z"),
      review("ada", "COMMENTED", "2026-01-01T11:00:00Z"),
      review("grace", "CHANGES_REQUESTED", "2026-01-01T10:30:00Z"),
      review("grace", "APPROVED", "2026-01-01T12:00:00Z"),
      review("linus", "DISMISSED", "2026-01-01T09:00:00Z"),
      review("bo", "PENDING", "2026-01-01T09:00:00Z"),
    ])
    expect(rs.map((r) => [r.login, r.state]).sort()).toEqual([
      ["ada", "approved"],
      ["grace", "approved"],
    ])
    expect(reviewState(rs, [])).toBe("approved")
  })

  test("the overall state", () => {
    const a = latestReviews([review("a", "APPROVED", "2026-01-01T10:00:00Z")])
    const c = latestReviews([
      review("a", "CHANGES_REQUESTED", "2026-01-01T10:00:00Z"),
      review("b", "APPROVED", "2026-01-01T10:00:00Z"),
    ])
    const k = latestReviews([review("a", "COMMENTED", "2026-01-01T10:00:00Z")])
    expect(reviewState(c, [])).toBe("changes_requested")
    expect(reviewState(a, ["x"])).toBe("approved")
    expect(reviewState([], ["x"])).toBe("pending")
    expect(reviewState(k, [])).toBe("commented")
    expect(reviewState([], [])).toBe("none")
  })
})

const pull = (o: Partial<GhPull> = {}): GhPull => ({
  id: 7,
  number: 3,
  state: "open",
  title: "Rework",
  body: "text",
  user: user("ada"),
  labels: [{ name: "bug", color: "d73a4a" }],
  assignees: [user("grace")],
  requested_reviewers: [user("linus")],
  requested_teams: [{ slug: "core" }],
  head: { ref: "feat", sha: "abc", repo: { full_name: "a/b" } },
  base: { ref: "main", sha: "def", repo: { full_name: "a/b" } },
  html_url: "https://github.com/a/b/pull/3",
  created_at: "2026-01-01T00:00:00Z",
  updated_at: "2026-01-02T00:00:00Z",
  closed_at: null,
  merged_at: null,
  additions: 4,
  deletions: 1,
  changed_files: 2,
  commits: 1,
  comments: 2,
  review_comments: 1,
  mergeable: null,
  ...o,
})

describe("mapping", () => {
  test("a pull request becomes a row", () => {
    const f = mapPull("gh-repo://r", "a/b", pull(), { reviews: [] })
    expect(f).toMatchObject({
      repo: "gh-repo://r",
      number: 3,
      state: "open",
      author: "ada",
      reviewers: ["linus", "team:core"],
      reviewState: "pending",
      head: "feat",
      base: "main",
      commentCount: 3,
      mergeable: "unknown",
      subtitle: "a/b#3 · open · ada",
    })
    expect(f.labels).toEqual([{ name: "bug", color: "d73a4a" }])
  })

  test("merged and draft", () => {
    expect(mapPull("r", "a/b", pull({ merged_at: "2026-01-03T00:00:00Z", state: "closed" })).state).toBe(
      "merged",
    )
    expect(mapPull("r", "a/b", pull({ draft: true })).subtitle).toContain("draft")
  })

  test("what the list endpoint lacks is left out, so it does not overwrite what detail knew", () => {
    const { additions, deletions, changed_files, commits, comments, review_comments, mergeable, ...list } =
      pull()
    const f = mapPull("r", "a/b", list as GhPull)
    expect("additions" in f).toBe(false)
    expect("mergeable" in f).toBe(false)
    expect("reviewState" in f).toBe(false)
  })

  test("only what differs is written", () => {
    const row = {
      title: "A",
      labels: [{ name: "x", color: "1" }],
      ghUpdatedAt: "2026-01-02T00:00:00+00:00",
      number: 1,
    }
    expect(
      changedFields(row, {
        title: "A",
        labels: [{ name: "x", color: "1" }],
        ghUpdatedAt: "2026-01-02T00:00:00Z",
      }),
    ).toEqual({})
    expect(changedFields(row, { title: "B", labels: [{ name: "y", color: "1" }] })).toEqual({
      title: "B",
      labels: [{ name: "y", color: "1" }],
    })
    expect(changedFields(null, { title: "A" })).toEqual({ title: "A" })
  })
})

describe("who is told what", () => {
  const before = {
    number: 3,
    title: "T",
    author: "ada",
    reviewers: ["grace"],
    body: "hi @bo",
    checksState: "pending",
    headSha: "a",
    state: "open",
  }
  test("a new review request, a new mention and a first failure; each once", () => {
    const after = {
      ...before,
      reviewers: ["grace", "linus", "team:core"],
      body: "hi @bo and @eve",
      checksState: "failure",
      checks: { items: [{ name: "test", conclusion: "failure" }] },
    }
    const got = planItem("pr", "a/b", before, after)
    expect(got.map((g) => [g.kind, g.login])).toEqual([
      ["review_requested", "linus"],
      ["checks_failed", "ada"],
      ["mention", "eve"],
    ])
    expect(got[1]!.text).toContain("test")
    // Nothing new, nothing said.
    expect(planItem("pr", "a/b", after, after)).toEqual([])
  })

  test("checks that fail again on a new commit are news again", () => {
    const failed = { ...before, checksState: "failure", headSha: "a" }
    expect(planItem("pr", "a/b", failed, { ...failed, headSha: "b" }).map((g) => g.kind)).toEqual([
      "checks_failed",
    ])
  })

  test("a new item names its reviewers and mentions", () => {
    const got = planItem("pr", "a/b", null, { ...before, reviewers: ["ada"], checksState: "none" })
    expect(got.map((g) => [g.kind, g.login])).toEqual([
      ["review_requested", "ada"],
      ["mention", "bo"],
    ])
  })

  test("comments mention people; closed pull requests do not report failed checks", () => {
    expect(
      planComment("a/b", { title: "T" }, { number: 3, author: "grace", body: "@ada look @grace" }).map(
        (g) => g.login,
      ),
    ).toEqual(["ada", "grace"])
    expect(
      planItem("pr", "a/b", null, { ...before, state: "closed", checksState: "failure" }).map((g) => g.kind),
    ).not.toContain("checks_failed")
  })
})

describe("the rest", () => {
  test("repositories as people write them", () => {
    expect(parseRepo("acme/widgets")).toEqual({ fullName: "acme/widgets" })
    expect(parseRepo("https://github.com/acme/widgets.git")).toEqual({
      host: "github.com",
      fullName: "acme/widgets",
    })
    expect(parseRepo("git@ghe.example.com:acme/widgets.git")).toEqual({
      host: "ghe.example.com",
      fullName: "acme/widgets",
    })
    expect(parseRepo("https://ghe.example.com/acme/widgets/")).toEqual({
      host: "ghe.example.com",
      fullName: "acme/widgets",
    })
    // A server on another port, over plain HTTP (an Enterprise Server in a lab, the mock in tests).
    expect(parseRepo("http://127.0.0.1:4806/acme/widgets.git")).toEqual({
      host: "127.0.0.1:4806",
      fullName: "acme/widgets",
      scheme: "http",
    })
    expect(parseRepo("ssh://git@ghe.example.com:2222/acme/widgets.git")).toEqual({
      host: "ghe.example.com",
      fullName: "acme/widgets",
    })
    expect(parseRepo("nonsense")).toBeNull()
    expect(apiBaseFor("github.com")).toBe("https://api.github.com")
    expect(apiBaseFor("ghe.example.com")).toBe("https://ghe.example.com/api/v3")
    expect(apiBaseFor("127.0.0.1:4806", "http")).toBe("http://127.0.0.1:4806/api/v3")
  })

  test("webhooks that arrive make polling a slow reconciliation", () => {
    const now = Date.parse("2026-01-10T12:00:00Z")
    expect(intervalSecs({ pollSecs: 60 }, now)).toBe(60)
    expect(intervalSecs({ pollSecs: 60, lastWebhookAt: "2026-01-10T11:00:00Z" }, now)).toBe(900)
    expect(intervalSecs({ pollSecs: 60, lastWebhookAt: "2026-01-08T11:00:00Z" }, now)).toBe(60)
    expect(intervalSecs({ pollSecs: 3 }, now)).toBe(15)
  })
})

test("checks read again unchanged write nothing, whenever they were read", () => {
  const stored = {
    checksState: "failure",
    checks: { total: 2, failed: 1, items: [], at: "2026-01-01T00:00:00Z" },
  }
  const again = {
    checksState: "failure",
    checks: { total: 2, failed: 1, items: [], at: "2026-01-01T00:05:00Z" },
  }
  expect(changedFields(stored, again)).toEqual({})
  const changed = { ...again, checks: { ...again.checks, failed: 0 } }
  expect(Object.keys(changedFields(stored, changed))).toEqual(["checks"])
})
