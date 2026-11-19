// Records what GitHub's REST API answers an anonymous caller into `test/recordings/` (docs/ci.md, "Recorded
// exchanges"): a public repository, a page of its pull requests with the Link header, the refusals, and the
// rate limit. No credentials and nothing of anyone's: the public `octocat/Hello-World` repository. The
// plugin's tests replay them (test/recorded.test.ts).
import { mkdirSync, writeFileSync } from "node:fs"
import { dirname, join } from "node:path"

const out = process.argv[process.argv.indexOf("--out") + 1]
if (!out || process.argv.indexOf("--out") < 0) throw new Error("usage: record.ts --out <folder>")
const api = "https://api.github.com"
const accept = { accept: "application/vnd.github+json", "x-github-api-version": "2022-11-28" }
// The headers a client reads, and nothing that identifies the caller (cookies, request ids).
const KEEP = [
  "cache-control",
  "content-type",
  "etag",
  "link",
  "retry-after",
  "www-authenticate",
  "x-github-media-type",
  "x-ratelimit-limit",
  "x-ratelimit-remaining",
  "x-ratelimit-reset",
  "x-ratelimit-resource",
  "x-ratelimit-used",
]
async function record(file: string, path: string) {
  const res = await fetch(`${api}${path}`, { headers: { ...accept, "user-agent": "crow-recorder" } })
  const text = await res.text()
  const headers: Record<string, string> = {}
  for (const [k, v] of res.headers) if (KEEP.includes(k)) headers[k] = v
  let body: unknown
  try {
    body = JSON.parse(text)
  } catch {}
  const exchange = {
    request: { method: "GET", url: `${api}${path}`, headers: { accept: accept.accept } },
    response: { status: res.status, headers, ...(body === undefined ? { bodyText: text } : { body }) },
  }
  mkdirSync(dirname(join(out as string, file)), { recursive: true })
  writeFileSync(join(out as string, file), `${JSON.stringify(exchange, null, 2)}\n`)
}

await record("repo.json", "/repos/octocat/Hello-World")
await record("pulls-page-1.json", "/repos/octocat/Hello-World/pulls?state=all&per_page=1")
await record("not-found.json", "/repos/octocat/this-repository-does-not-exist-crow")
await record("unauthorized.json", "/user")
await record("rate-limit.json", "/rate_limit")
