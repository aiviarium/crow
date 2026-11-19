// The HTTP layer against what GitHub really answered (test/recordings, made by `bun plugins/code/test/record.ts
// --out plugins/code/test/recordings`): the Link header, the rate limit headers and the refusals are read as
// GitHub writes them, not as the mock in test/mock does. No network.
import { describe, expect, test } from "bun:test"
import { readdirSync, readFileSync } from "node:fs"
import { join } from "node:path"
import { explain } from "../src/lib/errors"
import { GitHubError, GitHubHttp } from "../src/lib/http"

const dir = join(import.meta.dir, "recordings")
interface Recorded {
  request: { url: string }
  response: { status: number; headers: Record<string, string>; body?: unknown; bodyText?: string }
}
const recordings = new Map<string, Recorded>(
  readdirSync(dir).map((f) => {
    const e = JSON.parse(readFileSync(join(dir, f), "utf8")) as Recorded
    return [e.request.url, e] as const
  }),
)

/** A fetch that answers with what was recorded for the address, as GitHub sent it. */
const replay = (async (input: RequestInfo | URL) => {
  const e = recordings.get(String(input))
  if (!e) throw new Error(`nothing was recorded for ${String(input)}`)
  const { status, headers, body, bodyText } = e.response
  return new Response(body === undefined ? (bodyText ?? "") : JSON.stringify(body), { status, headers })
}) as typeof fetch

const http = () =>
  new GitHubHttp({
    baseUrl: "https://api.github.com",
    authorization: async () => null,
    fetch: replay,
    sleep: async () => {},
    retries: 0,
  })

describe("recorded GitHub answers", () => {
  test("a repository, its rate limit and the cache validator are read", async () => {
    const h = http()
    const r = await h.get<{ full_name: string; default_branch: string }>("/repos/octocat/Hello-World")
    expect(r.status).toBe(200)
    expect(r.data.full_name).toBe("octocat/Hello-World")
    expect(typeof r.data.default_branch).toBe("string")
    expect(h.rate).toMatchObject({ limit: 60, resource: "core" })
    expect(h.rate!.remaining).toBeLessThanOrEqual(60)
    expect(h.rate!.reset).toBeGreaterThan(1_700_000_000)
    expect(r.headers.get("etag")).toMatch(/^(W\/)?"[0-9a-f]+"$/)
  })

  test("a page of pull requests says where the next and the last are, in GitHub's Link header", async () => {
    const r = await http().get<unknown[]>("/repos/octocat/Hello-World/pulls", {
      query: { state: "all", per_page: 1 },
    })
    expect(Array.isArray(r.data)).toBe(true)
    expect(r.next).toContain("page=2")
    expect(r.last).toMatch(/page=\d+$/)
  })

  test("the refusals are the kinds the plugin explains to a person", async () => {
    const missing = await http()
      .get("/repos/octocat/this-repository-does-not-exist-crow")
      .catch((e) => e)
    expect(missing).toBeInstanceOf(GitHubError)
    expect((missing as GitHubError).kind).toBe("not_found")
    expect(explain(missing, { name: "work", kind: "token" }, "that repository").code).toBe("NOT_FOUND")

    const anonymous = await http()
      .get("/user")
      .catch((e) => e)
    expect(anonymous).toBeInstanceOf(GitHubError)
    expect((anonymous as GitHubError).kind).toBe("bad_credentials")
    const said = explain(anonymous, { name: "work", kind: "token" })
    expect(said.code).toBe("FORBIDDEN")
    expect(said.reason).toBe("github_token_rejected")
  })

  test("the rate limit endpoint's answer has what the budget display reads", async () => {
    const r = await http().get<{ resources: { core: { limit: number; remaining: number; reset: number } } }>(
      "/rate_limit",
    )
    expect(r.data.resources.core).toMatchObject({ limit: 60 })
    expect(r.data.resources.core.remaining).toBeLessThanOrEqual(60)
  })
})
