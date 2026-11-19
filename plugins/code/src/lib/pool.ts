// Turns Rookery connections into GitHub API clients. One client per connection and version of it (an edited
// connection gets a fresh one), so the installation token and the ETag cache survive between calls.
// Which connection a call uses:
//   - a sync uses the one the repository was attached with, as long as the caller may still use it;
//   - an action by a person (comment, review, merge) prefers that person's own token, so it is made as
//     them on GitHub, and falls back to the repository's connection, whose app then acts as "the bot".
import { type Ctx, type Rookery, RookeryError } from "@rookery/sdk"
import { GitHubApi } from "./api"
import { type Auth, httpFor } from "./auth"
import { rookeryError, type Whose } from "./errors"
import type { GitHubHttp, RateLimit } from "./http"
import { webBase } from "./http"
import type { RepoRow } from "./rows"
import { type ConnectionView, connectionView } from "./sdk"

export const APP = "code.github-app"
export const TOKEN = "code.github-token"
export const DEFAULT_API = "https://api.github.com"

export interface Gh {
  api: GitHubApi
  http: GitHubHttp
  auth: Auth
  connection: ConnectionView
  apiBase: string
  web: string
  who: Whose
  /** Runs a GitHub call and turns what goes wrong into a RookeryError that says what to do. */
  guard<T>(what: string, fn: () => Promise<T>): Promise<T>
}

export const normalizeBase = (v: unknown): string =>
  String(v || DEFAULT_API)
    .trim()
    .replace(/\/+$/, "")

export class Pool {
  private clients = new Map<string, { stamp: string; gh: Gh }>()

  constructor(
    private readonly rookery: Rookery,
    private readonly o: { fetch?: typeof fetch; sleep?: (ms: number) => Promise<void> } = {},
  ) {}

  fromConnection(c: ConnectionView): Gh {
    // A new client whenever the connection changes: its version, and its values (a new token, a new key).
    const stamp = `${c.updatedAt}:${Bun.hash(JSON.stringify(c.values))}`
    const hit = this.clients.get(c.id)
    if (hit && hit.stamp === stamp) return hit.gh
    const apiBase = normalizeBase(c.values.baseUrl)
    const creds =
      c.type === APP
        ? ({
            kind: "app",
            appId: String(c.values.appId ?? "").trim(),
            installationId: String(c.values.installationId ?? "").trim(),
            privateKey: String(c.values.privateKey ?? ""),
          } as const)
        : ({ kind: "token", token: String(c.values.token ?? "").trim() } as const)
    const { http, auth } = httpFor(creds, { baseUrl: apiBase, fetch: this.o.fetch, sleep: this.o.sleep })
    const who: Whose = { name: c.name, kind: c.type === APP ? "app" : "token" }
    const gh: Gh = {
      api: new GitHubApi(http),
      http,
      auth,
      connection: c,
      apiBase,
      web: webBase(apiBase),
      who,
      guard: async (what, fn) => {
        try {
          return await fn()
        } catch (e) {
          throw rookeryError(e, who, what)
        }
      },
    }
    this.clients.set(c.id, { stamp, gh })
    return gh
  }

  /**
   * A client for a connection that came from a list: lists leave the secrets out, so the connection is read
   * again, which reveals the credential to this plugin.
   */
  async open(ctx: Ctx | null, c: { id: string }): Promise<Gh> {
    void ctx
    return this.fromConnection(await connectionView(this.rookery, c.id))
  }

  /** The last rate limit each connection's client has seen. */
  rates(): Array<{ connection: string; rate: RateLimit }> {
    return [...this.clients.entries()].flatMap(([connection, c]) =>
      c.gh.http.rate ? [{ connection, rate: c.gh.http.rate }] : [],
    )
  }

  /** The connection a repository was attached with, or the nearest one that reaches the same GitHub. */
  async forRepo(ctx: Ctx | null, repo: Partial<RepoRow>): Promise<Gh> {
    const base = repo.apiBase ? normalizeBase(repo.apiBase) : null
    if (repo.connection) {
      try {
        return await this.open(ctx, { id: repo.connection })
      } catch (e) {
        if (!(e instanceof RookeryError) || (e.code !== "NOT_FOUND" && e.code !== "FORBIDDEN")) throw e
        // Deleted, or not one this caller may use: fall through to the nearest usable one.
      }
    }
    for (const type of [APP, TOKEN]) {
      const found = (await this.rookery.connections.list({ type })).find(
        (c) => !base || normalizeBase(c.config.baseUrl) === base,
      )
      if (found) return this.open(ctx, found)
    }
    throw new RookeryError(
      "FORBIDDEN",
      "There is no GitHub connection this repository can be reached with. The connection it was attached with is deleted or not shared with you.",
      {
        reason: "github_no_connection",
        fix: "Create a GitHub connection in Settings › Connections, then use “Sync now” on the repository.",
      },
    )
  }

  /** The caller's own token for a GitHub, if they have one (theirs, then a shared one). */
  async tokenFor(ctx: Ctx | null, apiBase: string): Promise<Gh | null> {
    const base = normalizeBase(apiBase)
    const all = (await this.rookery.connections.list({ type: TOKEN })).filter(
      (c) => normalizeBase(c.config.baseUrl) === base,
    )
    const own = all.find((c) => c.scope === "user") ?? all[0]
    return own ? this.open(ctx, own) : null
  }

  /** For a person's action: their own token if they have one, else the repository's connection. */
  async forAction(ctx: Ctx | null, repo: Partial<RepoRow>): Promise<Gh> {
    const base = repo.apiBase ?? DEFAULT_API
    return (await this.tokenFor(ctx, base)) ?? (await this.forRepo(ctx, repo))
  }

  /** Every GitHub connection the caller may use, for the connect view and for choosing one when attaching. */
  async available(ctx: Ctx | null): Promise<ConnectionView[]> {
    void ctx
    const out: ConnectionView[] = []
    for (const type of [APP, TOKEN])
      for (const c of await this.rookery.connections.list({ type }))
        out.push(await connectionView(this.rookery, c.id))
    return out
  }
}
