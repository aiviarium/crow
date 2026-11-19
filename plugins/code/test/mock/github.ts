// A mock GitHub: the REST endpoints the plugin uses, with the behaviour that matters to it: token and app
// authentication (a real RS256 check of the app's JWT, installation tokens that expire), repository
// visibility, pagination with Link headers, ETags and 304s, rate-limit headers and exhaustion, secondary
// limits, renamed repositories (301), webhooks with correct signatures, and the error bodies GitHub sends.
// Every method of MockGitHub is also reachable as `POST /__mock/<method>` with a JSON body, so a Playwright
// test (which runs in Node, not in this process) can drive it. It is a test fixture: the plugin's host half
// talks to it exactly as it talks to GitHub, through a connection whose API URL points here.
import {
  createHash,
  createHmac,
  createPublicKey,
  createVerify,
  generateKeyPairSync,
  randomUUID,
} from "node:crypto"

type J = Record<string, any>

export interface MockOptions {
  port?: number
  /** Requests a credential may make per hour. Default 5000. */
  rateLimit?: number
}

interface Repo {
  id: number
  full_name: string
  owner: string
  name: string
  private: boolean
  description: string
  default_branch: string
  allow: { merge: boolean; squash: boolean; rebase: boolean }
  /** Logins that may read (private) and write; "*" for everyone with a credential. */
  readers: Set<string>
  writers: Set<string>
  labels: Array<{ name: string; color: string }>
  assignable: string[]
  branches: Map<string, string>
  next: number
  items: Map<number, J>
  /** Comments of issues and pull requests by id, and inline review comments. */
  comments: Map<number, J>
  reviewComments: Map<number, J>
  reviews: Map<number, J[]>
  timeline: Map<number, J[]>
  files: Map<number, J[]>
  commits: Map<number, J[]>
  runs: Map<string, J[]>
  statuses: Map<string, J[]>
  logs: Map<number, string>
}

interface Installation {
  id: number
  appId: number
  /** Repositories (full names) it may reach; empty means all of its account's. */
  repos: Set<string>
  account: string
}

export class MockGitHub {
  readonly users = new Map<string, J>()
  readonly repos = new Map<string, Repo>()
  /** Personal access tokens: token -> { login, revoked, readOnly }. */
  readonly tokens = new Map<string, J>()
  readonly apps = new Map<
    number,
    { id: number; publicKey: string; privateKey: string; webhookSecret: string; installation: Installation }
  >()
  readonly installTokens = new Map<string, { installation: number; expires: number }>()
  readonly renames = new Map<string, number>()
  readonly hooks: Array<{ url: string; secret: string }> = []
  readonly deliveries: Array<{ id: string; event: string; body: string; status?: number }> = []
  readonly log: Array<{
    method: string
    path: string
    status: number
    credential: string
    counted: boolean
    at: number
  }> = []
  /** Number of the next 403 secondary-limit answers and the Retry-After they carry. */
  private secondary = { left: 0, retryAfter: 1 }
  private limit: number
  private buckets = new Map<string, { remaining: number; reset: number }>()
  private clock: number
  private ids = 1000
  private server?: ReturnType<typeof Bun.serve>
  private downFor = 0
  baseUrl = ""

  constructor(private readonly o: MockOptions = {}) {
    this.limit = o.rateLimit ?? 5000
    this.clock = Math.floor(Date.now() / 1000) * 1000
  }

  // ── Server ───────────────────────────────────────────────────────────────────────────────────────

  start(port = this.o.port ?? 0) {
    this.server = Bun.serve({ hostname: "127.0.0.1", port, fetch: (req) => this.handle(req) })
    this.baseUrl = `http://127.0.0.1:${this.server.port}`
    return this
  }

  stop() {
    this.server?.stop(true)
  }

  /** The API URL a connection uses: like a GitHub Enterprise Server's `/api/v3`. */
  get apiUrl() {
    return `${this.baseUrl}/api/v3`
  }

  // ── Control (also `POST /__mock/<method>`) ───────────────────────────────────────────────────────

  reset() {
    this.users.clear()
    this.repos.clear()
    this.tokens.clear()
    this.apps.clear()
    this.installTokens.clear()
    this.renames.clear()
    this.hooks.length = 0
    this.deliveries.length = 0
    this.log.length = 0
    this.buckets.clear()
    this.secondary = { left: 0, retryAfter: 1 }
    this.downFor = 0
    this.exhausted = null
    this.refusals = []
    this.manifests.clear()
    this.limit = this.o.rateLimit ?? 5000
    return { ok: true }
  }

  now() {
    return new Date(this.clock).toISOString().replace(/\.\d+Z$/, "Z")
  }

  /** Time passes: every change gets a later `updated_at`. */
  tick(seconds = 1) {
    this.clock += seconds * 1000
    return this.now()
  }

  user(login: string, o: { name?: string; email?: string } = {}) {
    const u = this.users.get(login) ?? {
      login,
      id: ++this.ids,
      avatar_url: `${this.baseUrl}/avatars/${login}.png`,
      html_url: `${this.baseUrl}/${login}`,
      type: "User",
      name: o.name ?? login,
      email: o.email ?? null,
    }
    Object.assign(u, o.name ? { name: o.name } : {}, o.email !== undefined ? { email: o.email } : {})
    this.users.set(login, u)
    return u
  }

  /** A personal access token for a user. */
  createToken(o: { login: string; token?: string; readOnly?: boolean }) {
    this.user(o.login)
    const token = o.token ?? `ghp_${randomUUID().replace(/-/g, "")}`
    this.tokens.set(token, { login: o.login, revoked: false, readOnly: !!o.readOnly })
    return { token }
  }

  revokeToken(o: { token: string }) {
    const t = this.tokens.get(o.token)
    if (t) t.revoked = true
    return { ok: !!t }
  }

  /** An app with one installation; the key is a PKCS#1 PEM, as GitHub hands it out. */
  createApp(o: {
    appId?: number
    installationId?: number
    account: string
    repos?: string[]
    webhookSecret?: string
  }) {
    const { publicKey, privateKey } = generateKeyPairSync("rsa", {
      modulusLength: 2048,
      publicKeyEncoding: { type: "spki", format: "pem" },
      privateKeyEncoding: { type: "pkcs1", format: "pem" },
    })
    const id = o.appId ?? ++this.ids
    const installation: Installation = {
      id: o.installationId ?? ++this.ids,
      appId: id,
      repos: new Set(o.repos ?? []),
      account: o.account,
    }
    const webhookSecret = o.webhookSecret ?? randomUUID()
    this.apps.set(id, { id, publicKey, privateKey, webhookSecret, installation })
    return { appId: id, installationId: installation.id, privateKey, webhookSecret }
  }

  /** Lets an installation reach more repositories. */
  installOn(o: { installationId: number; repo: string }) {
    for (const a of this.apps.values())
      if (a.installation.id === o.installationId) a.installation.repos.add(o.repo)
    return { ok: true }
  }

  createRepo(o: {
    full_name: string
    private?: boolean
    description?: string
    readers?: string[]
    writers?: string[]
    default_branch?: string
  }) {
    const [owner, name] = o.full_name.split("/") as [string, string]
    this.user(owner)
    const repo: Repo = {
      id: ++this.ids,
      full_name: o.full_name,
      owner,
      name,
      private: o.private ?? true,
      description: o.description ?? "",
      default_branch: o.default_branch ?? "main",
      allow: { merge: true, squash: true, rebase: true },
      readers: new Set(o.readers ?? ["*"]),
      writers: new Set(o.writers ?? ["*"]),
      labels: [
        { name: "bug", color: "d73a4a" },
        { name: "enhancement", color: "a2eeef" },
        { name: "docs", color: "0075ca" },
      ],
      assignable: [owner],
      branches: new Map([[o.default_branch ?? "main", this.sha()]]),
      next: 1,
      items: new Map(),
      comments: new Map(),
      reviewComments: new Map(),
      reviews: new Map(),
      timeline: new Map(),
      files: new Map(),
      commits: new Map(),
      runs: new Map(),
      statuses: new Map(),
      logs: new Map(),
    }
    this.repos.set(o.full_name, repo)
    return { id: repo.id }
  }

  setRepo(o: {
    full_name: string
    allow?: Partial<Repo["allow"]>
    private?: boolean
    description?: string
    assignable?: string[]
  }) {
    const r = this.repo(o.full_name)
    if (o.allow) Object.assign(r.allow, o.allow)
    if (o.private !== undefined) r.private = o.private
    if (o.description !== undefined) r.description = o.description
    if (o.assignable) r.assignable = o.assignable
    return { ok: true }
  }

  /** Renames or transfers a repository: the old name answers 301 to the new one. */
  renameRepo(o: { full_name: string; to: string }) {
    const r = this.repo(o.full_name)
    this.repos.delete(o.full_name)
    this.renames.set(o.full_name.toLowerCase(), r.id)
    r.full_name = o.to
    ;[r.owner, r.name] = o.to.split("/") as [string, string]
    this.repos.set(o.to, r)
    return { ok: true }
  }

  deleteRepo(o: { full_name: string }) {
    this.repos.delete(o.full_name)
    return { ok: true }
  }

  /** Pushes a branch (the head of a pull request to come). */
  pushBranch(o: { repo: string; branch: string; sha?: string; user?: string }) {
    const r = this.repo(o.repo)
    const sha = o.sha ?? this.sha()
    r.branches.set(o.branch, sha)
    return { sha }
  }

  createPull(o: {
    repo: string
    title: string
    author?: string
    head?: string
    base?: string
    body?: string
    draft?: boolean
    labels?: string[]
    reviewers?: string[]
    files?: J[]
    commits?: J[]
    sha?: string
    quiet?: boolean
    conflicting?: boolean
  }) {
    const r = this.repo(o.repo)
    const head = o.head ?? `feature-${r.next}`
    const sha = o.sha ?? r.branches.get(head) ?? this.sha()
    r.branches.set(head, sha)
    const n = r.next++
    const author = this.user(o.author ?? "octo")
    const at = this.tick()
    const pr: J = {
      id: ++this.ids,
      number: n,
      state: "open",
      draft: !!o.draft,
      title: o.title,
      body: o.body ?? "",
      user: author,
      labels: (o.labels ?? []).map((l) => r.labels.find((x) => x.name === l) ?? { name: l, color: "ededed" }),
      assignees: [],
      requested_reviewers: (o.reviewers ?? []).map((l) => this.user(l)),
      requested_teams: [],
      milestone: null,
      head: { ref: head, sha, repo: { full_name: r.full_name, id: r.id } },
      base: {
        ref: o.base ?? r.default_branch,
        sha: r.branches.get(o.base ?? r.default_branch) ?? this.sha(),
        repo: { full_name: r.full_name, id: r.id },
      },
      html_url: `${this.baseUrl}/${r.full_name}/pull/${n}`,
      created_at: at,
      updated_at: at,
      closed_at: null,
      merged_at: null,
      merged: false,
      merged_by: null,
      conflicting: !!o.conflicting,
      is_pr: true,
    }
    r.items.set(n, pr)
    r.files.set(
      n,
      o.files ?? [
        this.file("src/main.ts", "export const a = 1\n", "export const a = 2\nexport const b = 3\n"),
      ],
    )
    r.commits.set(
      n,
      o.commits ?? [
        {
          sha,
          commit: {
            message: o.title,
            author: { name: author.login, email: `${author.login}@example.com`, date: at },
          },
          author,
        },
      ],
    )
    this.event(r, n, "committed", author, { sha, message: o.title })
    if (!o.quiet)
      this.emit(r, "pull_request", { action: "opened", pull_request: this.pullJson(r, pr), sender: author })
    return { number: n, sha, head }
  }

  createIssue(o: {
    repo: string
    title: string
    author?: string
    body?: string
    labels?: string[]
    assignees?: string[]
    quiet?: boolean
  }) {
    const r = this.repo(o.repo)
    const n = r.next++
    const author = this.user(o.author ?? "octo")
    const at = this.tick()
    const issue: J = {
      id: ++this.ids,
      number: n,
      state: "open",
      state_reason: null,
      title: o.title,
      body: o.body ?? "",
      user: author,
      labels: (o.labels ?? []).map((l) => r.labels.find((x) => x.name === l) ?? { name: l, color: "ededed" }),
      assignees: (o.assignees ?? []).map((l) => this.user(l)),
      milestone: null,
      comments: 0,
      html_url: `${this.baseUrl}/${r.full_name}/issues/${n}`,
      created_at: at,
      updated_at: at,
      closed_at: null,
      is_pr: false,
    }
    r.items.set(n, issue)
    if (!o.quiet)
      this.emit(r, "issues", { action: "opened", issue: this.issueJson(r, issue), sender: author })
    return { number: n }
  }

  /** Edits a pull request or issue as someone else would on github.com. */
  edit(o: {
    repo: string
    number: number
    title?: string
    body?: string
    state?: "open" | "closed"
    /** Why it was closed (or `reopened`), as GitHub's `state_reason`. */
    stateReason?: "completed" | "not_planned" | "reopened" | null
    labels?: string[]
    assignees?: string[]
    reviewers?: string[]
    draft?: boolean
    sender?: string
    quiet?: boolean
  }) {
    const r = this.repo(o.repo)
    const item = this.item(r, o.number)
    const sender = this.user(o.sender ?? "octo")
    if (o.title !== undefined) item.title = o.title
    if (o.body !== undefined) item.body = o.body
    if (o.draft !== undefined) item.draft = o.draft
    if (o.labels)
      item.labels = o.labels.map((l) => r.labels.find((x) => x.name === l) ?? { name: l, color: "ededed" })
    if (o.assignees) item.assignees = o.assignees.map((l) => this.user(l))
    if (o.reviewers) {
      const before = new Set((item.requested_reviewers as J[]).map((u) => u.login))
      item.requested_reviewers = o.reviewers.map((l) => this.user(l))
      for (const l of o.reviewers)
        if (!before.has(l))
          this.event(r, o.number, "review_requested", sender, { requested_reviewer: this.user(l) })
    }
    if (o.state && o.state !== item.state) {
      item.state = o.state
      item.closed_at = o.state === "closed" ? this.tick() : null
      if (!item.is_pr)
        item.state_reason =
          o.state === "closed" ? (o.stateReason ?? "completed") : (o.stateReason ?? "reopened")
      this.event(r, o.number, o.state === "closed" ? "closed" : "reopened", sender)
    } else if (o.stateReason !== undefined && !item.is_pr && item.state === "closed") {
      item.state_reason = o.stateReason ?? "completed"
    }
    item.updated_at = this.tick()
    if (!o.quiet) {
      const action =
        o.state === "closed"
          ? "closed"
          : o.state === "open"
            ? "reopened"
            : o.reviewers
              ? "review_requested"
              : "edited"
      this.emit(r, item.is_pr ? "pull_request" : "issues", {
        action,
        ...(item.is_pr ? { pull_request: this.pullJson(r, item) } : { issue: this.issueJson(r, item) }),
        ...(o.reviewers ? { requested_reviewer: item.requested_reviewers.at(-1) } : {}),
        sender,
      })
    }
    return { ok: true }
  }

  /** An administrator deletes an issue: it is gone, and so is its number. */
  deleteIssue(o: { repo: string; number: number }) {
    const r = this.repo(o.repo)
    r.items.delete(o.number)
    return { ok: true }
  }

  /** Someone comments, on github.com. */
  comment(o: { repo: string; number: number; body: string; author?: string; quiet?: boolean }) {
    return this.addComment(this.repo(o.repo), o.number, o.body, this.user(o.author ?? "octo"), o.quiet)
  }

  /** Someone edits a comment on github.com. */
  editComment(o: { repo: string; id: number; body: string; quiet?: boolean }) {
    const r = this.repo(o.repo)
    const c = r.comments.get(o.id)
    if (!c) return { ok: false }
    c.body = o.body
    c.updated_at = this.tick()
    const n = Number(/\/(\d+)$/.exec(c.issue_url)?.[1])
    const item = r.items.get(n)
    if (item) item.updated_at = c.updated_at
    if (!o.quiet && item)
      this.emit(r, "issue_comment", {
        action: "edited",
        comment: c,
        issue: item.is_pr
          ? { ...this.issueJson(r, item), pull_request: { url: "" } }
          : this.issueJson(r, item),
        sender: c.user,
      })
    return { ok: true }
  }

  /** The issues (not pull requests) of a repository as GitHub has them, for assertions. */
  issues(o: { repo: string }) {
    const r = this.repo(o.repo)
    return [...r.items.values()]
      .filter((i) => !i.is_pr)
      .map((i) => ({
        number: i.number,
        id: i.id,
        title: i.title,
        body: i.body,
        state: i.state,
        state_reason: i.state_reason ?? null,
        labels: (i.labels as J[]).map((l) => l.name),
        assignees: (i.assignees as J[]).map((u) => u.login),
        author: i.user.login,
        updated_at: i.updated_at,
      }))
  }

  /** The comments of an issue as GitHub has them, for assertions. */
  commentsOf(o: { repo: string; number: number }) {
    const r = this.repo(o.repo)
    return [...r.comments.values()]
      .filter((c) => c.issue_url.endsWith(`/${o.number}`))
      .map((c) => ({ id: c.id, body: c.body, user: c.user.login, updated_at: c.updated_at }))
  }

  /**
   * Makes writes to a repository (or one of its issues) answer `status` for the next `count` requests:
   * 403 as a refused permission, 404 or 410 as a deleted issue. `count` 0 lifts it.
   */
  refuse(o: { repo: string; number?: number; status?: number; message?: string; count?: number }) {
    this.refusals = this.refusals.filter((x) => !(x.repo === o.repo && x.number === o.number))
    if (o.count !== 0)
      this.refusals.push({
        repo: o.repo,
        number: o.number,
        status: o.status ?? 403,
        message: o.message ?? "Resource not accessible by integration",
        left: o.count ?? 1_000_000,
      })
    return { ok: true }
  }
  private refusals: Array<{ repo: string; number?: number; status: number; message: string; left: number }> =
    []

  /** Sets the mock's clock (what `updated_at` says from now on). */
  setClock(o: { at: string }) {
    this.clock = Date.parse(o.at)
    return { now: this.now() }
  }

  deleteComment(o: { repo: string; id: number; quiet?: boolean }) {
    const r = this.repo(o.repo)
    const c = r.comments.get(o.id)
    if (!c) return { ok: false }
    r.comments.delete(o.id)
    const n = Number(/\/(\d+)$/.exec(c.issue_url)?.[1])
    const item = r.items.get(n)
    if (item) {
      item.comments = [...r.comments.values()].filter((x) => x.issue_url === c.issue_url).length
      item.updated_at = this.tick()
    }
    if (!o.quiet && item)
      this.emit(r, "issue_comment", {
        action: "deleted",
        comment: c,
        issue: item.is_pr
          ? { ...this.issueJson(r, item), pull_request: { url: "" } }
          : this.issueJson(r, item),
        sender: c.user,
      })
    return { ok: true }
  }

  review(o: {
    repo: string
    number: number
    state: "APPROVED" | "CHANGES_REQUESTED" | "COMMENTED"
    body?: string
    author?: string
    quiet?: boolean
  }) {
    return this.addReview(
      this.repo(o.repo),
      o.number,
      o.state,
      o.body ?? "",
      this.user(o.author ?? "reviewer"),
      o.quiet,
    )
  }

  reviewComment(o: {
    repo: string
    number: number
    body: string
    path?: string
    line?: number
    author?: string
  }) {
    const r = this.repo(o.repo)
    const pr = this.item(r, o.number)
    const author = this.user(o.author ?? "reviewer")
    const at = this.tick()
    const c: J = {
      id: ++this.ids,
      user: author,
      body: o.body,
      path: o.path ?? "src/main.ts",
      line: o.line ?? 1,
      side: "RIGHT",
      commit_id: pr.head.sha,
      pull_request_url: `${this.apiUrl}/repos/${r.full_name}/pulls/${o.number}`,
      html_url: `${pr.html_url}#discussion_r${this.ids}`,
      created_at: at,
      updated_at: at,
    }
    r.reviewComments.set(c.id, c)
    pr.updated_at = at
    return { id: c.id }
  }

  /** A check run on a commit. */
  check(o: {
    repo: string
    sha?: string
    number?: number
    name: string
    status?: "queued" | "in_progress" | "completed"
    conclusion?: string | null
    log?: string
    quiet?: boolean
  }) {
    const r = this.repo(o.repo)
    const sha = o.sha ?? this.item(r, o.number!).head.sha
    const list = r.runs.get(sha) ?? []
    const status = o.status ?? "completed"
    const existing = list.find((x) => x.name === o.name)
    const at = this.tick()
    const run: J = existing ?? {
      id: ++this.ids,
      name: o.name,
      started_at: at,
      html_url: `${this.baseUrl}/${r.full_name}/actions/runs/${this.ids}`,
      app: { slug: "github-actions", name: "GitHub Actions" },
    }
    Object.assign(run, {
      status,
      conclusion: status === "completed" ? (o.conclusion ?? "success") : null,
      completed_at: status === "completed" ? at : null,
    })
    if (!existing) list.push(run)
    r.runs.set(sha, list)
    if (o.log !== undefined) r.logs.set(run.id, o.log)
    for (const item of r.items.values()) if (item.is_pr && item.head.sha === sha) item.updated_at = at
    if (!o.quiet)
      this.emit(r, "check_run", {
        action: "completed",
        check_run: {
          ...run,
          head_sha: sha,
          pull_requests: [...r.items.values()]
            .filter((i) => i.is_pr && i.head.sha === sha)
            .map((i) => ({ number: i.number })),
        },
        sender: this.user("github-actions[bot]"),
      })
    return { id: run.id, sha }
  }

  status(o: {
    repo: string
    sha: string
    context: string
    state: "pending" | "success" | "failure" | "error"
  }) {
    const r = this.repo(o.repo)
    const list = (r.statuses.get(o.sha) ?? []).filter((s) => s.context !== o.context)
    list.push({ context: o.context, state: o.state, target_url: `${this.baseUrl}/status/${o.context}` })
    r.statuses.set(o.sha, list)
    return { ok: true }
  }

  /** The head of a pull request moves: new commit, new checks. */
  push(o: { repo: string; number: number; message?: string; author?: string }) {
    const r = this.repo(o.repo)
    const pr = this.item(r, o.number)
    const sha = this.sha()
    pr.head.sha = sha
    r.branches.set(pr.head.ref, sha)
    const author = this.user(o.author ?? pr.user.login)
    r.commits.get(o.number)?.push({
      sha,
      commit: {
        message: o.message ?? "More changes",
        author: { name: author.login, email: `${author.login}@example.com`, date: this.tick() },
      },
      author,
    })
    pr.updated_at = this.tick()
    this.event(r, o.number, "committed", author, { sha, message: o.message ?? "More changes" })
    this.emit(r, "pull_request", {
      action: "synchronize",
      pull_request: this.pullJson(r, pr),
      sender: author,
    })
    return { sha }
  }

  /** Makes the next `count` requests answer a secondary rate limit. */
  secondaryLimit(o: { count?: number; retryAfter?: number } = {}) {
    this.secondary = { left: o.count ?? 1, retryAfter: o.retryAfter ?? 1 }
    return { ok: true }
  }

  /** Sets what a credential has left of its rate limit (for every credential from now on). */
  setRate(o: { limit?: number; remaining?: number; resetInSeconds?: number }) {
    if (o.limit) this.limit = o.limit
    if (o.remaining !== undefined) {
      const reset = Math.floor(Date.now() / 1000) + (o.resetInSeconds ?? 3600)
      for (const k of this.buckets.keys()) this.buckets.set(k, { remaining: o.remaining, reset })
      this.exhausted = { remaining: o.remaining, reset }
    }
    return { ok: true }
  }

  private exhausted: { remaining: number; reset: number } | null = null

  /** Answers 502 for the next `count` requests. */
  down(o: { count?: number } = {}) {
    this.downFor = o.count ?? 1
    return { ok: true }
  }

  // ── Webhooks ─────────────────────────────────────────────────────────────────────────────────────

  /** Where to send deliveries, signed with `secret` (an app's webhook secret). */
  addHook(o: { url: string; secret: string }) {
    this.hooks.push(o)
    return { ok: true }
  }

  clearHooks() {
    this.hooks.length = 0
    return { ok: true }
  }

  /** Sends the same delivery again, with the same delivery id (as GitHub's "Redeliver" does). */
  async redeliver(o: { id: string }) {
    const d = this.deliveries.find((x) => x.id === o.id)
    if (!d) return { ok: false }
    await this.send(d.event, d.body, d.id)
    return { ok: true, status: d.status }
  }

  /** Sends a delivery with a bad signature, for the test that the kernel refuses it. */
  async deliverUnsigned(o: { url: string; event?: string; body?: J }) {
    const r = await fetch(o.url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-github-event": o.event ?? "ping",
        "x-github-delivery": randomUUID(),
        "x-hub-signature-256": "sha256=00",
      },
      body: JSON.stringify(o.body ?? { zen: "no" }),
    })
    return { status: r.status }
  }

  private emit(repo: Repo, event: string, payload: J) {
    const app = [...this.apps.values()].find(
      (a) => a.installation.repos.has(repo.full_name) || a.installation.account === repo.owner,
    )
    const body = JSON.stringify({
      ...payload,
      repository: this.repoJson(repo),
      ...(app ? { installation: { id: app.installation.id } } : {}),
    })
    const id = randomUUID()
    this.deliveries.push({ id, event, body })
    void this.send(event, body, id)
  }

  private async send(event: string, body: string, id: string) {
    for (const h of this.hooks) {
      const sig = `sha256=${createHmac("sha256", h.secret).update(body).digest("hex")}`
      try {
        const r = await fetch(h.url, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "x-github-event": event,
            "x-github-delivery": id,
            "x-hub-signature-256": sig,
            "user-agent": "GitHub-Hookshot/mock",
          },
          body,
        })
        const d = this.deliveries.find((x) => x.id === id)
        if (d) d.status = r.status
      } catch {
        // The target is down: GitHub would show a failed delivery.
      }
    }
  }

  // ── State for assertions ─────────────────────────────────────────────────────────────────────────

  item(r: Repo, n: number): J {
    const i = r.items.get(n)
    if (!i) throw new Error(`no #${n} in ${r.full_name}`)
    return i
  }

  state(o: { repo: string; number: number }) {
    const r = this.repo(o.repo)
    const i = this.item(r, o.number)
    return {
      ...(i.is_pr ? this.pullJson(r, i) : this.issueJson(r, i)),
      comments_list: [...r.comments.values()]
        .filter((c) => c.issue_url.endsWith(`/${o.number}`))
        .map((c) => ({ id: c.id, body: c.body, user: c.user.login })),
      reviews: r.reviews.get(o.number) ?? [],
    }
  }

  requests(o: { since?: number; path?: string } = {}) {
    return this.log.filter(
      (l) => (o.since === undefined || l.at >= o.since) && (!o.path || l.path.includes(o.path)),
    )
  }

  /** The deliveries sent so far, with the status the target answered. */
  deliveriesSent() {
    return this.deliveries.map((d) => ({ id: d.id, event: d.event, status: d.status ?? null }))
  }

  clearRequests() {
    this.log.length = 0
    return { ok: true }
  }

  rateOf(o: { credential: string }) {
    return this.buckets.get(o.credential) ?? null
  }

  // ── Building blocks ──────────────────────────────────────────────────────────────────────────────

  private sha() {
    return createHash("sha1")
      .update(`${++this.ids}${Math.random()}`)
      .digest("hex")
  }

  repo(full: string): Repo {
    const r = this.repos.get(full)
    if (!r) throw new Error(`no repository ${full}`)
    return r
  }

  file(path: string, before: string, after: string): J {
    const a = before.split("\n").filter((_, i, l) => i < l.length - 1 || l[i] !== "")
    const b = after.split("\n").filter((_, i, l) => i < l.length - 1 || l[i] !== "")
    const patch = [
      `@@ -1,${a.length} +1,${b.length} @@`,
      ...a.map((l) => `-${l}`),
      ...b.map((l) => `+${l}`),
    ].join("\n")
    return {
      filename: path,
      status: "modified",
      additions: b.length,
      deletions: a.length,
      changes: a.length + b.length,
      patch,
    }
  }

  private event(r: Repo, n: number, event: string, actor: J, extra: J = {}) {
    const list = r.timeline.get(n) ?? []
    list.push({ id: ++this.ids, event, created_at: this.now(), actor, ...extra })
    r.timeline.set(n, list)
  }

  private addComment(r: Repo, n: number, body: string, author: J, quiet?: boolean) {
    const item = this.item(r, n)
    const at = this.tick()
    const c: J = {
      id: ++this.ids,
      user: author,
      body,
      issue_url: `${this.apiUrl}/repos/${r.full_name}/issues/${n}`,
      html_url: `${item.html_url}#issuecomment-${this.ids}`,
      created_at: at,
      updated_at: at,
    }
    r.comments.set(c.id, c)
    item.comments = [...r.comments.values()].filter((x) => x.issue_url === c.issue_url).length
    item.updated_at = at
    this.event(r, n, "commented", author, { body, id: c.id })
    if (!quiet)
      this.emit(r, "issue_comment", {
        action: "created",
        comment: c,
        issue: item.is_pr
          ? { ...this.issueJson(r, item), pull_request: { url: "" } }
          : this.issueJson(r, item),
        sender: author,
      })
    return { id: c.id }
  }

  private addReview(r: Repo, n: number, state: string, body: string, author: J, quiet?: boolean) {
    const pr = this.item(r, n)
    const at = this.tick()
    const rv: J = {
      id: ++this.ids,
      user: author,
      body,
      state,
      submitted_at: at,
      html_url: `${pr.html_url}#pullrequestreview-${this.ids}`,
      commit_id: pr.head.sha,
    }
    const list = r.reviews.get(n) ?? []
    list.push(rv)
    r.reviews.set(n, list)
    pr.requested_reviewers = (pr.requested_reviewers as J[]).filter((u) => u.login !== author.login)
    pr.updated_at = at
    this.event(r, n, "reviewed", author, { state: state.toLowerCase(), body, submitted_at: at })
    if (!quiet)
      this.emit(r, "pull_request_review", {
        action: "submitted",
        review: rv,
        pull_request: this.pullJson(r, pr),
        sender: author,
      })
    return { id: rv.id }
  }

  repoJson(r: Repo, cred?: { login?: string; write?: boolean }): J {
    return {
      id: r.id,
      name: r.name,
      full_name: r.full_name,
      owner: this.user(r.owner),
      private: r.private,
      archived: false,
      description: r.description,
      html_url: `${this.baseUrl}/${r.full_name}`,
      default_branch: r.default_branch,
      permissions: { admin: false, push: cred?.write ?? true, pull: true },
      allow_merge_commit: r.allow.merge,
      allow_squash_merge: r.allow.squash,
      allow_rebase_merge: r.allow.rebase,
    }
  }

  private base(item: J): J {
    const { is_pr, conflicting, ...rest } = item
    return rest
  }

  pullJson(r: Repo, pr: J): J {
    const files = r.files.get(pr.number) ?? []
    return {
      ...this.base(pr),
      mergeable: pr.state === "open" ? !pr.conflicting : null,
      mergeable_state: pr.conflicting ? "dirty" : "clean",
      comments: [...r.comments.values()].filter((c) => c.issue_url.endsWith(`/${pr.number}`)).length,
      review_comments: [...r.reviewComments.values()].filter((c) =>
        c.pull_request_url.endsWith(`/${pr.number}`),
      ).length,
      commits: r.commits.get(pr.number)?.length ?? 1,
      additions: files.reduce((a, f) => a + f.additions, 0),
      deletions: files.reduce((a, f) => a + f.deletions, 0),
      changed_files: files.length,
      url: `${this.apiUrl}/repos/${r.full_name}/pulls/${pr.number}`,
    }
  }

  issueJson(r: Repo, i: J): J {
    return {
      ...this.base(i),
      ...(i.is_pr ? { pull_request: { url: `${this.apiUrl}/repos/${r.full_name}/pulls/${i.number}` } } : {}),
      url: `${this.apiUrl}/repos/${r.full_name}/issues/${i.number}`,
    }
  }

  // ── HTTP ─────────────────────────────────────────────────────────────────────────────────────────

  private json(status: number, body: unknown, headers: Record<string, string> = {}) {
    return new Response(JSON.stringify(body), {
      status,
      headers: { "content-type": "application/json; charset=utf-8", ...headers },
    })
  }

  /** Who is calling, from the Authorization header. */
  private who(req: Request): {
    kind: "anon" | "token" | "app" | "install" | "bad"
    key: string
    login?: string
    installation?: Installation
    readOnly?: boolean
    app?: number
  } {
    const h = req.headers.get("authorization")
    if (!h) return { kind: "anon", key: "anon" }
    const [, token] = /^(?:Bearer|token) (.+)$/i.exec(h) ?? []
    if (!token) return { kind: "bad", key: "bad" }
    const pat = this.tokens.get(token)
    if (pat)
      return pat.revoked
        ? { kind: "bad", key: token }
        : { kind: "token", key: token, login: pat.login, readOnly: pat.readOnly }
    const inst = this.installTokens.get(token)
    if (inst) {
      const app = [...this.apps.values()].find((a) => a.installation.id === inst.installation)
      return !app || inst.expires < Date.now()
        ? { kind: "bad", key: token }
        : { kind: "install", key: token, installation: app.installation, login: `${app.id}[bot]` }
    }
    const jwt = token.split(".")
    if (jwt.length === 3) {
      try {
        const claims = JSON.parse(Buffer.from(jwt[1]!, "base64url").toString())
        const app = this.apps.get(Number(claims.iss))
        if (app && claims.exp * 1000 > Date.now() && claims.exp - claims.iat <= 660) {
          const ok = createVerify("RSA-SHA256")
            .update(`${jwt[0]}.${jwt[1]}`)
            .verify(createPublicKey(app.publicKey), Buffer.from(jwt[2]!, "base64url"))
          if (ok) return { kind: "app", key: `app-${app.id}`, app: app.id }
        }
      } catch {
        // Falls through: bad credentials.
      }
    }
    return { kind: "bad", key: token }
  }

  private canRead(who: ReturnType<MockGitHub["who"]>, r: Repo): boolean {
    if (!r.private) return true
    if (who.kind === "install")
      return (
        who.installation!.repos.has(r.full_name) ||
        (who.installation!.account === r.owner && who.installation!.repos.size === 0)
      )
    if (who.kind === "token")
      return (
        r.readers.has("*") || r.readers.has(who.login!) || r.writers.has(who.login!) || r.owner === who.login
      )
    return false
  }

  private canWrite(who: ReturnType<MockGitHub["who"]>, r: Repo): boolean {
    if (who.kind === "install") return this.canRead(who, r)
    if (who.kind === "token")
      return !who.readOnly && (r.writers.has("*") || r.writers.has(who.login!) || r.owner === who.login)
    return false
  }

  private paginate(url: URL, items: J[], total = items.length) {
    const per = Math.min(100, Number(url.searchParams.get("per_page") ?? 30))
    const page = Math.max(1, Number(url.searchParams.get("page") ?? 1))
    const last = Math.max(1, Math.ceil(total / per))
    const slice = items.slice((page - 1) * per, page * per)
    const link: string[] = []
    const at = (p: number) => {
      const u = new URL(url)
      u.searchParams.set("page", String(p))
      return u.toString()
    }
    if (page < last) link.push(`<${at(page + 1)}>; rel="next"`, `<${at(last)}>; rel="last"`)
    if (page > 1) link.push(`<${at(page - 1)}>; rel="prev"`, `<${at(1)}>; rel="first"`)
    return { slice, link: link.join(", ") }
  }

  private async handle(req: Request): Promise<Response> {
    const url = new URL(req.url)
    if (url.pathname.startsWith("/__mock/")) return this.control(req, url)
    if (url.pathname.startsWith("/__logs/")) {
      const [, , repo, id] = url.pathname.split("/")
      return new Response(this.repos.get(decodeURIComponent(repo!))?.logs.get(Number(id)) ?? "", {
        headers: { "content-type": "text/plain" },
      })
    }
    if (url.pathname === "/settings/apps/new" || url.pathname === "/organizations/acme/settings/apps/new")
      return this.manifestForm(req, url)
    if (!url.pathname.startsWith("/api/v3")) return new Response("not found", { status: 404 })
    const path = url.pathname.slice("/api/v3".length)
    const who = this.who(req)
    const started = Date.now()
    const res = await this.route(req, url, path, who)
    // Rate limit: every answer says what is left; 304s and /rate_limit are free.
    const counted = res.status !== 304 && path !== "/rate_limit"
    let bucket = this.buckets.get(who.key)
    if (!bucket) {
      bucket = this.exhausted
        ? { ...this.exhausted }
        : { remaining: this.limit, reset: Math.floor(Date.now() / 1000) + 3600 }
      this.buckets.set(who.key, bucket)
    }
    if (bucket.reset * 1000 < Date.now())
      Object.assign(bucket, { remaining: this.limit, reset: Math.floor(Date.now() / 1000) + 3600 })
    if (counted && !res.headers.has("x-ratelimit-limit")) bucket.remaining = Math.max(0, bucket.remaining - 1)
    if (!res.headers.has("x-ratelimit-limit")) {
      res.headers.set("x-ratelimit-limit", String(who.kind === "anon" ? 60 : this.limit))
      res.headers.set("x-ratelimit-remaining", String(bucket.remaining))
      res.headers.set("x-ratelimit-reset", String(bucket.reset))
      res.headers.set("x-ratelimit-resource", "core")
    }
    this.log.push({
      method: req.method,
      path: url.pathname.slice("/api/v3".length) + url.search,
      status: res.status,
      credential: who.key,
      counted,
      at: started,
    })
    return res
  }

  private async control(req: Request, url: URL): Promise<Response> {
    const name = url.pathname.slice("/__mock/".length)
    const fn = (this as any)[name]
    if (
      typeof fn !== "function" ||
      name.startsWith("_") ||
      ["handle", "route", "start", "stop"].includes(name)
    )
      return this.json(404, { message: `no control method ${name}` })
    const args =
      req.method === "POST" ? await req.json().catch(() => ({})) : Object.fromEntries(url.searchParams)
    try {
      const out = await fn.call(this, args)
      return this.json(200, out ?? { ok: true })
    } catch (e) {
      return this.json(400, { message: (e as Error).message })
    }
  }

  /** What github.com does for "Create GitHub App from a manifest": it shows a form and sends the browser back with a code. */
  private async manifestForm(req: Request, url: URL): Promise<Response> {
    const form = req.method === "POST" ? await req.formData() : null
    const manifest = JSON.parse(String(form?.get("manifest") ?? url.searchParams.get("manifest") ?? "{}"))
    const state = url.searchParams.get("state") ?? ""
    const code = `mf_${randomUUID().slice(0, 8)}`
    this.manifests.set(code, manifest)
    const back = new URL(manifest.redirect_url)
    back.searchParams.set("code", code)
    back.searchParams.set("state", state)
    return Response.redirect(back.toString(), 302)
  }

  readonly manifests = new Map<string, J>()

  private async route(
    req: Request,
    url: URL,
    path: string,
    who: ReturnType<MockGitHub["who"]>,
  ): Promise<Response> {
    const m = req.method
    const q = (k: string) => url.searchParams.get(k)
    if (this.downFor > 0) {
      this.downFor--
      return this.json(502, { message: "Server Error" })
    }
    if (who.kind === "bad")
      return this.json(401, { message: "Bad credentials", documentation_url: "https://docs.github.com/rest" })
    if (this.secondary.left > 0 && who.kind !== "anon" && path !== "/rate_limit") {
      this.secondary.left--
      return this.json(
        403,
        {
          message:
            "You have exceeded a secondary rate limit. Please wait a few minutes before you try again.",
          documentation_url: "https://docs.github.com/rest/overview/rate-limits-for-the-rest-api",
        },
        { "retry-after": String(this.secondary.retryAfter) },
      )
    }
    const bucket = this.buckets.get(who.key)
    if (bucket && bucket.remaining === 0 && bucket.reset * 1000 > Date.now() && path !== "/rate_limit") {
      return this.json(
        403,
        {
          message: `API rate limit exceeded for ${who.login ?? "this credential"}.`,
          documentation_url: "https://docs.github.com/rest/overview/rate-limits-for-the-rest-api",
        },
        {
          "x-ratelimit-limit": String(this.limit),
          "x-ratelimit-remaining": "0",
          "x-ratelimit-reset": String(bucket.reset),
          "x-ratelimit-resource": "core",
        },
      )
    }

    // The manifest flow's last step needs no credentials.
    let g = /^\/app-manifests\/([^/]+)\/conversions$/.exec(path)
    if (g && m === "POST") {
      const manifest = this.manifests.get(g[1]!)
      if (!manifest) return this.json(404, { message: "Not Found" })
      const app = this.createApp({ account: "acme", webhookSecret: randomUUID() })
      this.manifests.delete(g[1]!)
      return this.json(201, {
        id: app.appId,
        slug: String(manifest.name ?? "crow").toLowerCase(),
        name: manifest.name,
        pem: app.privateKey,
        webhook_secret: app.webhookSecret,
        client_id: "Iv1.mock",
        client_secret: "mock",
        html_url: `${this.baseUrl}/apps/crow`,
        installation_id: app.installationId,
      })
    }

    if (path === "/rate_limit") {
      const b = this.buckets.get(who.key) ?? {
        remaining: this.limit,
        reset: Math.floor(Date.now() / 1000) + 3600,
      }
      const core = {
        limit: this.limit,
        remaining: b.remaining,
        reset: b.reset,
        used: this.limit - b.remaining,
      }
      return this.json(200, {
        resources: { core, search: { ...core, limit: 30 }, graphql: core },
        rate: core,
      })
    }
    if (path === "/user") {
      if (who.kind !== "token")
        return this.json(who.kind === "anon" ? 401 : 403, {
          message: who.kind === "anon" ? "Requires authentication" : "Resource not accessible by integration",
        })
      return this.etagged(req, this.user(who.login!))
    }
    g = /^\/app\/installations\/(\d+)\/access_tokens$/.exec(path)
    if (g && m === "POST") {
      if (who.kind !== "app") return this.json(401, { message: "A JSON web token could not be decoded" })
      const app = this.apps.get(who.app!)!
      if (app.installation.id !== Number(g[1])) return this.json(404, { message: "Not Found" })
      const token = `ghs_${randomUUID().replace(/-/g, "")}`
      const expires = Date.now() + 3600_000
      this.installTokens.set(token, { installation: app.installation.id, expires })
      return this.json(201, { token, expires_at: new Date(expires).toISOString().replace(/\.\d+Z$/, "Z") })
    }
    if (path === "/app/installations") {
      if (who.kind !== "app") return this.json(401, { message: "A JSON web token could not be decoded" })
      const app = this.apps.get(who.app!)!
      return this.json(200, [{ id: app.installation.id, account: { login: app.installation.account } }])
    }
    g = /^\/users\/([^/]+)$/.exec(path)
    if (g) {
      const u = this.users.get(decodeURIComponent(g[1]!))
      return u ? this.etagged(req, u) : this.json(404, { message: "Not Found" })
    }
    if (path === "/installation/repositories") {
      if (who.kind !== "install")
        return this.json(403, { message: "Resource not accessible by personal access token" })
      const all = [...this.repos.values()].filter((r) => this.canRead(who, r))
      const { slice, link } = this.paginate(url, all)
      return this.json(
        200,
        { total_count: all.length, repositories: slice.map((r) => this.repoJson(r as any, { write: true })) },
        link ? { link } : {},
      )
    }
    if (path === "/user/repos") {
      const all = [...this.repos.values()].filter((r) => this.canRead(who, r))
      const { slice, link } = this.paginate(url, all)
      return this.json(
        200,
        slice.map((r) => this.repoJson(r as any, { write: this.canWrite(who, r as any) })),
        link ? { link } : {},
      )
    }
    g = /^\/repositories\/(\d+)$/.exec(path)
    if (g) {
      const r = [...this.repos.values()].find((x) => x.id === Number(g![1]))
      if (!r || !this.canRead(who, r)) return this.json(404, { message: "Not Found" })
      return this.etagged(req, this.repoJson(r, { write: this.canWrite(who, r) }))
    }

    g = /^\/repos\/([^/]+)\/([^/]+)(\/.*)?$/.exec(path)
    if (!g) return this.json(404, { message: "Not Found", documentation_url: "https://docs.github.com/rest" })
    const full = `${decodeURIComponent(g[1]!)}/${decodeURIComponent(g[2]!)}`
    const rest = g[3] ?? ""
    const renamedTo = this.renames.get(full.toLowerCase())
    if (
      renamedTo !== undefined &&
      ![...this.repos.keys()].some((k) => k.toLowerCase() === full.toLowerCase())
    ) {
      return new Response(null, {
        status: 301,
        headers: { location: `${this.apiUrl}/repositories/${renamedTo}` },
      })
    }
    const repo = [...this.repos.values()].find((r) => r.full_name.toLowerCase() === full.toLowerCase())
    if (!repo || !this.canRead(who, repo))
      return this.json(404, { message: "Not Found", documentation_url: "https://docs.github.com/rest" })
    const write = this.canWrite(who, repo)
    const needWrite = (perm: string) =>
      write
        ? null
        : this.json(
            403,
            {
              message:
                who.kind === "install"
                  ? "Resource not accessible by integration"
                  : "Resource not accessible by personal access token",
            },
            { "x-accepted-github-permissions": perm },
          )

    if (m !== "GET") {
      const n = Number(/^\/issues\/(\d+)/.exec(rest)?.[1] ?? Number.NaN)
      const no = this.refusals.find(
        (x) =>
          x.left > 0 &&
          x.repo.toLowerCase() === repo.full_name.toLowerCase() &&
          (x.number === undefined || x.number === n || /^\/issues\/comments/.test(rest)),
      )
      if (no) {
        no.left--
        return this.json(no.status, {
          message:
            no.status === 403 ? no.message : no.status === 410 ? "This issue was deleted" : "Not Found",
          documentation_url: "https://docs.github.com/rest",
        })
      }
    }
    if (rest === "") return this.etagged(req, this.repoJson(repo, { write }))
    if (rest === "/labels") return this.etagged(req, repo.labels)
    if (rest === "/assignees")
      return this.etagged(
        req,
        repo.assignable.map((l) => this.user(l)),
      )
    let h = /^\/branches\/(.+)$/.exec(rest)
    if (h) {
      const sha = repo.branches.get(decodeURIComponent(h[1]!))
      return sha
        ? this.json(200, { name: decodeURIComponent(h[1]!), commit: { sha } })
        : this.json(404, { message: "Branch not found" })
    }

    // Pull requests
    if (rest === "/pulls" && m === "GET") {
      let list = [...repo.items.values()].filter((i) => i.is_pr)
      const st = q("state") ?? "open"
      if (st !== "all") list = list.filter((i) => i.state === st)
      const head = q("head")
      if (head) list = list.filter((i) => `${repo.owner}:${i.head.ref}` === head)
      list.sort(
        (a, b) =>
          (Date.parse(b.updated_at) - Date.parse(a.updated_at)) * (q("direction") === "asc" ? -1 : 1) ||
          b.number - a.number,
      )
      const { slice, link } = this.paginate(url, list)
      return this.etagged(
        req,
        slice.map((i) => this.listPull(repo, i)),
        link,
      )
    }
    if (rest === "/pulls" && m === "POST") {
      const denied = needWrite("pull_requests=write")
      if (denied) return denied
      const b = (await req.json()) as J
      if (!repo.branches.has(b.head))
        return this.json(422, {
          message: "Validation Failed",
          errors: [{ resource: "PullRequest", field: "head", code: "invalid" }],
        })
      if (!repo.branches.has(b.base))
        return this.json(422, {
          message: "Validation Failed",
          errors: [{ resource: "PullRequest", field: "base", code: "invalid" }],
        })
      if (
        [...repo.items.values()].some(
          (i) => i.is_pr && i.state === "open" && i.head.ref === b.head && i.base.ref === b.base,
        )
      )
        return this.json(422, {
          message: "Validation Failed",
          errors: [
            {
              resource: "PullRequest",
              code: "custom",
              message: `A pull request already exists for ${repo.owner}:${b.head}.`,
            },
          ],
        })
      const r = this.createPull({
        repo: repo.full_name,
        title: b.title,
        head: b.head,
        base: b.base,
        body: b.body,
        draft: b.draft,
        author: who.login?.replace(/\[bot\]$/, "[bot]") ?? "octo",
      })
      return this.json(201, this.pullJson(repo, repo.items.get(r.number)!))
    }
    h = /^\/pulls\/(\d+)$/.exec(rest)
    if (h && repo.items.get(Number(h[1]))?.is_pr) {
      const pr = repo.items.get(Number(h[1]))!
      if (m === "GET") return this.etagged(req, this.pullJson(repo, pr))
      if (m === "PATCH") {
        const denied = needWrite("pull_requests=write")
        if (denied) return denied
        const b = (await req.json()) as J
        this.edit({
          repo: repo.full_name,
          number: pr.number,
          state: b.state,
          title: b.title,
          body: b.body,
          sender: who.login,
        })
        return this.json(200, this.pullJson(repo, pr))
      }
    }
    h = /^\/pulls\/(\d+)\/merge$/.exec(rest)
    if (h && m === "PUT") {
      const denied = needWrite("pull_requests=write")
      if (denied) return denied
      const pr = repo.items.get(Number(h[1]))
      if (!pr?.is_pr) return this.json(404, { message: "Not Found" })
      const b = (await req.json()) as J
      if (pr.state !== "open") return this.json(405, { message: "Pull Request is not mergeable" })
      if (pr.conflicting) return this.json(405, { message: "Pull Request is not mergeable" })
      const method = (b.merge_method ?? "merge") as "merge" | "squash" | "rebase"
      if (!repo.allow[method])
        return this.json(405, {
          message: `${{ merge: "Merge commits", squash: "Squash merges", rebase: "Rebase merges" }[method]} are not allowed on this repository.`,
        })
      if (b.sha && b.sha !== pr.head.sha)
        return this.json(409, { message: "Head branch was modified. Review and try the merge again." })
      pr.state = "closed"
      pr.merged = true
      pr.merged_at = this.tick()
      pr.closed_at = pr.merged_at
      pr.merged_by = this.user(who.login ?? "octo")
      pr.updated_at = pr.merged_at
      const sha = this.sha()
      this.event(repo, pr.number, "merged", pr.merged_by, { commit_id: sha })
      this.emit(repo, "pull_request", {
        action: "closed",
        pull_request: this.pullJson(repo, pr),
        sender: pr.merged_by,
      })
      return this.json(200, { sha, merged: true, message: "Pull Request successfully merged" })
    }
    h = /^\/pulls\/(\d+)\/(reviews|files|commits|comments|requested_reviewers)$/.exec(rest)
    if (h) {
      const n = Number(h[1])
      const pr = repo.items.get(n)
      if (!pr?.is_pr) return this.json(404, { message: "Not Found" })
      const what = h[2]
      if (what === "reviews" && m === "GET") {
        const { slice, link } = this.paginate(url, repo.reviews.get(n) ?? [])
        return this.etagged(req, slice, link)
      }
      if (what === "reviews" && m === "POST") {
        const denied = needWrite("pull_requests=write")
        if (denied) return denied
        const b = (await req.json()) as J
        const state = (
          { APPROVE: "APPROVED", REQUEST_CHANGES: "CHANGES_REQUESTED", COMMENT: "COMMENTED" } as J
        )[b.event]
        if (!state)
          return this.json(422, {
            message: "Validation Failed",
            errors: [{ resource: "PullRequestReview", code: "invalid", field: "event" }],
          })
        if (state === "APPROVED" && pr.user.login === who.login)
          return this.json(422, {
            message: "Unprocessable Entity",
            errors: ["Can not approve your own pull request"],
          })
        if (state !== "APPROVED" && !b.body)
          return this.json(422, {
            message: "Validation Failed",
            errors: [{ resource: "PullRequestReview", code: "missing_field", field: "body" }],
          })
        const id = this.addReview(repo, n, state, b.body ?? "", this.user(who.login ?? "reviewer")).id
        return this.json(
          200,
          repo.reviews.get(n)!.find((x) => x.id === id),
        )
      }
      if (what === "files") {
        const { slice, link } = this.paginate(url, repo.files.get(n) ?? [])
        return this.etagged(req, slice, link)
      }
      if (what === "commits") {
        const { slice, link } = this.paginate(url, repo.commits.get(n) ?? [])
        return this.etagged(req, slice, link)
      }
      if (what === "comments") {
        const list = [...repo.reviewComments.values()].filter((c) => c.pull_request_url.endsWith(`/${n}`))
        const { slice, link } = this.paginate(url, list)
        return this.etagged(req, slice, link)
      }
      if (what === "requested_reviewers") {
        const denied = needWrite("pull_requests=write")
        if (denied) return denied
        const b = (await req.json()) as J
        const names: string[] = b.reviewers ?? []
        if (m === "POST") {
          const unknown = names.find((l) => !repo.assignable.includes(l) && !this.users.has(l))
          if (unknown)
            return this.json(422, {
              message: "Validation Failed",
              errors: [`Could not resolve to a user with the login of '${unknown}'.`],
            })
          this.edit({
            repo: repo.full_name,
            number: n,
            reviewers: [...new Set([...(pr.requested_reviewers as J[]).map((u) => u.login), ...names])],
            sender: who.login,
          })
        } else {
          pr.requested_reviewers = (pr.requested_reviewers as J[]).filter((u) => !names.includes(u.login))
          pr.updated_at = this.tick()
        }
        return this.json(m === "POST" ? 201 : 200, this.pullJson(repo, pr))
      }
    }
    if (rest === "/pulls/comments") {
      const since = q("since")
      let list = [...repo.reviewComments.values()]
      if (since) list = list.filter((c) => Date.parse(c.updated_at) >= Date.parse(since))
      list.sort(
        (a, b) =>
          (Date.parse(a.updated_at) - Date.parse(b.updated_at)) * (q("direction") === "desc" ? -1 : 1),
      )
      const { slice, link } = this.paginate(url, list)
      return this.etagged(req, slice, link)
    }

    // Issues
    if (rest === "/issues" && m === "GET") {
      let list = [...repo.items.values()]
      const st = q("state") ?? "open"
      if (st !== "all") list = list.filter((i) => i.state === st)
      const since = q("since")
      if (since) list = list.filter((i) => Date.parse(i.updated_at) >= Date.parse(since))
      list.sort(
        (a, b) =>
          (Date.parse(a.updated_at) - Date.parse(b.updated_at) || a.number - b.number) *
          (q("direction") === "desc" ? -1 : 1),
      )
      const { slice, link } = this.paginate(url, list)
      return this.etagged(
        req,
        slice.map((i) => this.issueJson(repo, i)),
        link,
      )
    }
    if (rest === "/issues" && m === "POST") {
      const denied = needWrite("issues=write")
      if (denied) return denied
      const b = (await req.json()) as J
      const { number } = this.createIssue({
        repo: repo.full_name,
        title: b.title,
        body: b.body,
        labels: b.labels,
        assignees: b.assignees,
        author: who.login,
      })
      return this.json(201, this.issueJson(repo, repo.items.get(number)!))
    }
    h = /^\/issues\/(\d+)$/.exec(rest)
    if (h) {
      const i = repo.items.get(Number(h[1]))
      if (!i) return this.json(404, { message: "Not Found" })
      if (m === "GET") return this.etagged(req, this.issueJson(repo, i))
      if (m === "PATCH") {
        const denied = needWrite("issues=write")
        if (denied) return denied
        const b = (await req.json()) as J
        this.edit({
          repo: repo.full_name,
          number: i.number,
          state: b.state,
          stateReason: b.state_reason,
          title: b.title,
          body: b.body,
          labels: b.labels,
          assignees: b.assignees,
          sender: who.login,
        })
        return this.json(200, this.issueJson(repo, i))
      }
    }
    h = /^\/issues\/comments\/(\d+)$/.exec(rest)
    if (h) {
      const c = repo.comments.get(Number(h[1]))
      if (!c) return this.json(404, { message: "Not Found" })
      if (m === "GET") return this.etagged(req, c)
      const denied = needWrite("issues=write")
      if (denied) return denied
      if (m === "PATCH") {
        const b = (await req.json()) as J
        if (c.user.login !== who.login && who.kind === "token")
          return this.json(403, { message: "You can only edit your own comments" })
        this.editComment({ repo: repo.full_name, id: c.id, body: b.body })
        return this.json(200, c)
      }
      if (m === "DELETE") {
        this.deleteComment({ repo: repo.full_name, id: c.id })
        return new Response(null, { status: 204 })
      }
    }
    if (rest === "/issues/comments") {
      const since = q("since")
      let list = [...repo.comments.values()]
      if (since) list = list.filter((c) => Date.parse(c.updated_at) >= Date.parse(since))
      list.sort(
        (a, b) =>
          (Date.parse(a.updated_at) - Date.parse(b.updated_at) || a.id - b.id) *
          (q("direction") === "desc" ? -1 : 1),
      )
      const { slice, link } = this.paginate(url, list)
      return this.etagged(req, slice, link)
    }
    h = /^\/issues\/(\d+)\/(comments|labels|assignees|timeline)$/.exec(rest)
    if (h) {
      const n = Number(h[1])
      const item = repo.items.get(n)
      if (!item) return this.json(404, { message: "Not Found" })
      const what = h[2]
      if (what === "comments" && m === "GET") {
        const { slice, link } = this.paginate(
          url,
          [...repo.comments.values()].filter((c) => c.issue_url.endsWith(`/${n}`)),
        )
        return this.etagged(req, slice, link)
      }
      if (what === "comments" && m === "POST") {
        const denied = needWrite("issues=write")
        if (denied) return denied
        const b = (await req.json()) as J
        if (!b.body)
          return this.json(422, {
            message: "Validation Failed",
            errors: [{ resource: "IssueComment", code: "missing_field", field: "body" }],
          })
        const id = this.addComment(repo, n, b.body, this.user(who.login ?? "octo")).id
        return this.json(201, repo.comments.get(id))
      }
      if (what === "labels" && m === "PUT") {
        const denied = needWrite("issues=write")
        if (denied) return denied
        const b = (await req.json()) as J
        this.edit({ repo: repo.full_name, number: n, labels: b.labels, sender: who.login })
        this.event(repo, n, "labeled", this.user(who.login ?? "octo"), { label: item.labels.at(-1) })
        return this.json(200, item.labels)
      }
      if (what === "assignees") {
        const denied = needWrite("issues=write")
        if (denied) return denied
        const b = (await req.json()) as J
        const cur = (item.assignees as J[]).map((u) => u.login)
        const next =
          m === "POST"
            ? [...new Set([...cur, ...(b.assignees ?? [])])]
            : cur.filter((l) => !(b.assignees ?? []).includes(l))
        this.edit({ repo: repo.full_name, number: n, assignees: next, sender: who.login })
        this.event(repo, n, m === "POST" ? "assigned" : "unassigned", this.user(who.login ?? "octo"), {
          assignee: this.user((b.assignees ?? [])[0] ?? "octo"),
        })
        return this.json(m === "POST" ? 201 : 200, this.issueJson(repo, item))
      }
      if (what === "timeline") {
        const { slice, link } = this.paginate(url, repo.timeline.get(n) ?? [])
        return this.etagged(req, slice, link)
      }
    }

    // Checks
    h = /^\/commits\/([^/]+)\/(check-runs|status)$/.exec(rest)
    if (h) {
      const sha = decodeURIComponent(h[1]!)
      if (h[2] === "check-runs") {
        const runs = repo.runs.get(sha) ?? []
        return this.etagged(req, { total_count: runs.length, check_runs: runs })
      }
      const sts = repo.statuses.get(sha) ?? []
      const state = sts.some((s) => s.state === "failure" || s.state === "error")
        ? "failure"
        : sts.some((s) => s.state === "pending")
          ? "pending"
          : "success"
      return this.etagged(req, {
        state: sts.length ? state : "pending",
        statuses: sts,
        total_count: sts.length,
      })
    }
    h = /^\/actions\/jobs\/(\d+)\/logs$/.exec(rest)
    if (h) {
      if (!repo.logs.has(Number(h[1]))) return this.json(404, { message: "Not Found" })
      return new Response(null, {
        status: 302,
        headers: { location: `${this.baseUrl}/__logs/${encodeURIComponent(repo.full_name)}/${h[1]}` },
      })
    }
    return this.json(404, { message: "Not Found", documentation_url: "https://docs.github.com/rest" })
  }

  private listPull(repo: Repo, pr: J): J {
    // The list endpoint has no mergeable, additions or deletions.
    const {
      mergeable,
      mergeable_state,
      additions,
      deletions,
      changed_files,
      commits,
      comments,
      review_comments,
      merged_by,
      merged,
      ...rest
    } = this.pullJson(repo, pr)
    return rest
  }

  private etagged(req: Request, body: unknown, link = ""): Response {
    const text = JSON.stringify(body)
    const etag = `W/"${createHash("sha1").update(text).digest("hex")}"`
    const headers: Record<string, string> = {
      etag,
      "content-type": "application/json; charset=utf-8",
      ...(link ? { link } : {}),
    }
    if (req.headers.get("if-none-match") === etag) return new Response(null, { status: 304, headers })
    return new Response(text, { status: 200, headers })
  }

  /** A realistic small world: an app installation on `acme`, a repository with pull requests in every state. */
  seedDemo(o: { webhookUrl?: string } = {}) {
    this.user("ada", { name: "Ada Lovelace", email: "ada@dev.local" })
    this.user("grace", { name: "Grace Hopper", email: "grace@dev.local" })
    this.user("linus", { name: "Linus T", email: null as any })
    const app = this.createApp({ account: "acme", repos: ["acme/widgets"] })
    this.createRepo({ full_name: "acme/widgets", private: true, description: "The widget factory" })
    this.setRepo({ full_name: "acme/widgets", assignable: ["ada", "grace", "linus", "acme"] })
    if (o.webhookUrl) this.addHook({ url: o.webhookUrl, secret: app.webhookSecret })
    return { ...app, repo: "acme/widgets" }
  }
}

/** Starts a mock for a test or the e2e suite. */
export function startMock(o: MockOptions = {}) {
  return new MockGitHub(o).start()
}
