// The HTTP layer against the mock GitHub: conditional requests, pagination, rate limits, errors as people
// read them, and GitHub App credentials.
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test"
import { GitHubApi, summariseChecks } from "../src/lib/api"
import { appJwt, httpFor, normalizePem } from "../src/lib/auth"
import { explain } from "../src/lib/errors"
import { GitHubError, GitHubHttp, repoKey, webBase } from "../src/lib/http"
import { MockGitHub } from "./mock/github"

const mock = new MockGitHub()
beforeAll(() => {
  mock.start()
})
afterAll(() => mock.stop())
beforeEach(() => {
  mock.reset()
  mock.createRepo({ full_name: "acme/widgets", private: true })
})

const client = (token: string, o: { sleep?: (ms: number) => Promise<void>; maxWaitMs?: number } = {}) =>
  new GitHubHttp({
    baseUrl: mock.apiUrl,
    authorization: async () => `Bearer ${token}`,
    sleep: o.sleep ?? (async () => {}),
    maxWaitMs: o.maxWaitMs,
  })

describe("conditional requests and pagination", () => {
  test("an unchanged list answers 304 from the cache and costs no rate limit", async () => {
    const { token } = mock.createToken({ login: "ada" })
    for (let i = 0; i < 3; i++) mock.createIssue({ repo: "acme/widgets", title: `Issue ${i}`, quiet: true })
    const http = client(token)
    const first = await http.get<unknown[]>("/repos/acme/widgets/issues", { query: { state: "all" } })
    const before = http.rate!.remaining
    const second = await http.get<unknown[]>("/repos/acme/widgets/issues", { query: { state: "all" } })
    expect(first.notModified).toBe(false)
    expect(second.notModified).toBe(true)
    expect(second.data).toEqual(first.data)
    expect(http.rate!.remaining).toBe(before)
    expect(http.stats.notModified).toBe(1)
  })

  test("pages follow the Link header", async () => {
    const { token } = mock.createToken({ login: "ada" })
    for (let i = 0; i < 7; i++) mock.createIssue({ repo: "acme/widgets", title: `Issue ${i}`, quiet: true })
    const http = client(token)
    const seen: number[] = []
    for await (const p of http.pages<{ number: number }>("/repos/acme/widgets/issues", {
      query: { state: "all", per_page: 3 },
    })) {
      seen.push(p.items.length)
    }
    expect(seen).toEqual([3, 3, 1])
  })
})

describe("rate limits", () => {
  test("the headers of every answer are kept", async () => {
    const { token } = mock.createToken({ login: "ada" })
    const http = client(token)
    await http.get("/repos/acme/widgets")
    expect(http.rate).toMatchObject({ limit: 5000, remaining: 4999, resource: "core" })
  })

  test("a secondary limit is waited out and the request repeated", async () => {
    const { token } = mock.createToken({ login: "ada" })
    const slept: number[] = []
    const http = client(token, { sleep: async (ms) => void slept.push(ms) })
    mock.secondaryLimit({ count: 1, retryAfter: 2 })
    const r = await http.get("/repos/acme/widgets")
    expect(r.status).toBe(200)
    expect(slept).toEqual([expect.any(Number)])
    expect(slept[0]!).toBeGreaterThan(1000)
    expect(http.stats.retries).toBe(1)
  })

  test("a secondary limit longer than the patience of the call is an error with the time to retry", async () => {
    const { token } = mock.createToken({ login: "ada" })
    const http = client(token, { maxWaitMs: 1000 })
    mock.secondaryLimit({ count: 5, retryAfter: 120 })
    const e = await http.get("/repos/acme/widgets").catch((x) => x)
    expect(e).toBeInstanceOf(GitHubError)
    expect(e.kind).toBe("secondary_limit")
    expect(e.extra.retryAt).toBeGreaterThan(Date.now() + 100_000)
  })

  test("an exhausted primary limit says when it resets", async () => {
    const { token } = mock.createToken({ login: "ada" })
    const http = client(token)
    await http.get("/repos/acme/widgets")
    mock.setRate({ remaining: 0, resetInSeconds: 600 })
    const e = await http.get("/repos/acme/widgets/issues").catch((x) => x)
    expect(e.kind).toBe("rate_limited")
    expect(e.extra.retryAt).toBeGreaterThan(Date.now() + 500_000)
    expect(explain(e, { name: "Ada", kind: "token" })).toMatchObject({
      code: "UNAVAILABLE",
      reason: "github_rate_limited",
    })
  })

  test("server errors on reads are retried, writes are not", async () => {
    const { token } = mock.createToken({ login: "ada" })
    const http = client(token)
    mock.down({ count: 1 })
    expect((await http.get("/repos/acme/widgets")).status).toBe(200)
    mock.down({ count: 1 })
    mock.createIssue({ repo: "acme/widgets", title: "x", quiet: true })
    const e = await http.post("/repos/acme/widgets/issues/1/comments", { body: "hi" }).catch((x) => x)
    expect(e.kind).toBe("unavailable")
  })
})

describe("errors say what to do", () => {
  test("a revoked token", async () => {
    const { token } = mock.createToken({ login: "ada" })
    mock.revokeToken({ token })
    const e = await client(token)
      .get("/user")
      .catch((x) => x)
    expect(e.kind).toBe("bad_credentials")
    const x = explain(e, { name: "Ada's token", kind: "token" })
    expect(x.code).toBe("FORBIDDEN")
    expect(x.reason).toBe("github_token_rejected")
    expect(x.message).toContain("Ada's token")
    expect(x.fix).toContain("revoked")
  })

  test("a private repository the token cannot see is a 404 that names the fix", async () => {
    mock.createRepo({ full_name: "acme/secret", private: true, readers: ["grace"] })
    const { token } = mock.createToken({ login: "ada" })
    const e = await client(token)
      .get("/repos/acme/secret")
      .catch((x) => x)
    expect(explain(e, { name: "Ada", kind: "token" }, "acme/secret")).toMatchObject({
      code: "NOT_FOUND",
      reason: "github_not_found",
    })
  })

  test("a read-only token cannot comment and the error names the permission", async () => {
    const { token } = mock.createToken({ login: "ada", readOnly: true })
    mock.createIssue({ repo: "acme/widgets", title: "x", quiet: true })
    const e = await client(token)
      .post("/repos/acme/widgets/issues/1/comments", { body: "hi" })
      .catch((x) => x)
    const x = explain(e, { name: "Ada", kind: "token" }, "comment on this issue")
    expect(x.code).toBe("FORBIDDEN")
    expect(x.fix).toContain("issues=write")
  })
})

describe("GitHub App credentials", () => {
  test("the JWT is signed with the app's key and accepted, and the installation token is minted once and cached", async () => {
    const app = mock.createApp({ account: "acme", repos: ["acme/widgets"] })
    const { http, auth } = httpFor(
      {
        kind: "app",
        appId: String(app.appId),
        installationId: String(app.installationId),
        privateKey: app.privateKey,
      },
      { baseUrl: mock.apiUrl },
    )
    const a = new GitHubApi(http)
    const repos = await a.installationRepos()
    expect(repos.repos.map((r) => r.full_name)).toEqual(["acme/widgets"])
    await a.repo("acme/widgets")
    const mints = mock.requests({ path: "access_tokens" })
    expect(mints).toHaveLength(1)
    expect(auth.describe).toContain(String(app.appId))
  })

  test("a token GitHub no longer accepts is replaced once and the request repeated", async () => {
    const app = mock.createApp({ account: "acme", repos: ["acme/widgets"] })
    const { http } = httpFor(
      {
        kind: "app",
        appId: String(app.appId),
        installationId: String(app.installationId),
        privateKey: app.privateKey,
      },
      { baseUrl: mock.apiUrl },
    )
    await http.get("/repos/acme/widgets")
    mock.installTokens.clear()
    expect((await http.get("/repos/acme/widgets/labels")).status).toBe(200)
    expect(mock.requests({ path: "access_tokens" })).toHaveLength(2)
  })

  test("a wrong key is a clear error", async () => {
    const app = mock.createApp({ account: "acme" })
    const other = mock.createApp({ account: "other" })
    const { http } = httpFor(
      {
        kind: "app",
        appId: String(app.appId),
        installationId: String(app.installationId),
        privateKey: other.privateKey,
      },
      { baseUrl: mock.apiUrl },
    )
    const e = await http.get("/installation/repositories").catch((x) => x)
    expect(e.kind).toBe("bad_credentials")
    expect(explain(e, { name: "App", kind: "app" }).fix).toContain("private key")
    expect(() => appJwt("1", "not a key")).toThrow(/private key/)
  })

  test("a key pasted with escaped newlines or on one line still reads", () => {
    const app = mock.createApp({ account: "acme" })
    const escaped = app.privateKey.trim().replace(/\n/g, "\\n")
    const oneLine = `"${app.privateKey.replace(/\n/g, " ")}"`
    expect(appJwt("1", escaped).split(".")).toHaveLength(3)
    expect(normalizePem(oneLine)).toContain("-----BEGIN RSA PRIVATE KEY-----\n")
  })
})

describe("the API facade", () => {
  test("a renamed repository is found through the redirect", async () => {
    const { token } = mock.createToken({ login: "ada" })
    mock.renameRepo({ full_name: "acme/widgets", to: "acme/gadgets" })
    const r = await new GitHubApi(client(token)).repo("acme/widgets")
    expect(r.data.full_name).toBe("acme/gadgets")
  })

  test("a repository that is gone is NOT_FOUND", async () => {
    const { token } = mock.createToken({ login: "ada" })
    mock.deleteRepo({ full_name: "acme/widgets" })
    const e = await new GitHubApi(client(token)).repo("acme/widgets").catch((x) => x)
    expect(e.kind).toBe("not_found")
  })

  test("check runs and statuses make one summary", () => {
    const s = summariseChecks(
      [
        { id: 1, name: "build", status: "completed", conclusion: "success" },
        { id: 2, name: "test", status: "completed", conclusion: "failure" },
        { id: 3, name: "lint", status: "in_progress", conclusion: null },
        { id: 4, name: "docs", status: "completed", conclusion: "skipped" },
      ],
      { state: "pending", statuses: [{ context: "ci/legacy", state: "pending" }] },
    )
    expect(s).toMatchObject({ state: "failure", total: 5, passed: 2, failed: 1, pending: 2 })
    expect(s.items.map((i) => i.name)).toEqual(["test", "lint", "ci/legacy"])
    expect(summariseChecks([], null).state).toBe("none")
    expect(summariseChecks([{ id: 1, name: "a", status: "queued", conclusion: null }], null).state).toBe(
      "pending",
    )
  })

  test("a job log is cut to its end", async () => {
    const { token } = mock.createToken({ login: "ada" })
    const { number } = mock.createPull({ repo: "acme/widgets", title: "x", quiet: true })
    const { id } = mock.check({
      repo: "acme/widgets",
      number,
      name: "test",
      conclusion: "failure",
      log: `${"noise\n".repeat(5000)}FAILED: expected 1 got 2\n`,
      quiet: true,
    })
    const log = await new GitHubApi(client(token)).jobLog("acme/widgets", id, 200)
    expect(log).toContain("FAILED: expected 1 got 2")
    expect(log.length).toBeLessThan(400)
  })
})

describe("addresses", () => {
  test("web base and repository key", () => {
    expect(webBase("https://api.github.com")).toBe("https://github.com")
    expect(webBase("https://ghe.example.com/api/v3/")).toBe("https://ghe.example.com")
    expect(repoKey("https://api.github.com", "Acme/Widgets")).toBe("github.com/acme/widgets")
    expect(repoKey("https://ghe.example.com/api/v3", "a/b")).toBe("ghe.example.com/a/b")
  })
})
