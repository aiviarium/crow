// Which Crow user a GitHub login is. Three sources, strongest first:
//   - the person's own token: GitHub says who it belongs to (`GET /user`), so this is certain;
//   - a manual mapping an admin set;
//   - the e-mail address on the GitHub profile, when the person made it public and a Crow user has it.
// A mapping is kept in the global `accounts` collection, so notifications, "mine" filters and the author
// shown on a pull request all use the same answer. Nothing is guessed from names.
import type { Ctx, Rookery } from "@rookery/sdk"
import type { GitHubApi } from "./api"
import { ghGlobal } from "./rows"
import { entitiesOf } from "./sdk"

export interface Account {
  id: string
  key: string
  login: string
  host: string
  user: string | null
  email: string | null
  source: "token" | "email" | "manual"
}

export const accountKey = (host: string, login: string) => `${host}/${login}`.toLowerCase()

const userId = (uri: string | null | undefined) => (uri ?? "").replace(/^user:\/\//, "") || null

export class Accounts {
  /** Logins whose profile has no matching Crow user, so a sync does not ask again every minute. */
  private misses = new Map<string, number>()

  constructor(private readonly rookery: Rookery) {}

  async find(host: string, login: string): Promise<Account | null> {
    const page = await ghGlobal(this.rookery).accounts.find({
      where: { key: accountKey(host, login) } as never,
      limit: 1,
    })
    return (page.rows[0] as unknown as Account | undefined) ?? null
  }

  /** The Crow user (an id) a login maps to, asking GitHub for a public e-mail address once if needed. */
  async userFor(host: string, login: string, api?: GitHubApi, ctx?: Ctx | null): Promise<string | null> {
    if (!login) return null
    const known = await this.find(host, login)
    if (known?.user) return userId(known.user)
    const missed = this.misses.get(accountKey(host, login))
    if (!api || (missed && Date.now() - missed < 6 * 3600_000)) return null
    let email: string | null = null
    try {
      email =
        ((await api.http.get<{ email?: string | null }>(`/users/${encodeURIComponent(login)}`)).data.email ??
          null) ||
        null
    } catch {
      // A profile we cannot read is not a reason to fail a sync.
    }
    const user = email ? await this.userByEmail(email, ctx) : null
    if (!user) {
      this.misses.set(accountKey(host, login), Date.now())
      return null
    }
    await this.remember(host, login, user, "email", email)
    return user
  }

  async userByEmail(email: string, ctx?: Ctx | null): Promise<string | null> {
    const want = email.trim().toLowerCase()
    if (!want) return null
    const entities = entitiesOf(this.rookery)
    const found = await entities.search(ctx as Ctx, want, { schemes: ["user"], limit: 10 }).catch(() => [])
    const hit = found.find((e) => (e.subtitle ?? "").toLowerCase() === want)
    return hit ? hit.id : null
  }

  /** Records that `login` on `host` is `user`. A person's own token outranks everything else. */
  async remember(
    host: string,
    login: string,
    user: string,
    source: Account["source"],
    email?: string | null,
    ctx?: Ctx | null,
  ) {
    void ctx
    const key = accountKey(host, login)
    const existing = await this.find(host, login)
    const values = {
      key,
      login,
      host,
      user: `user://${user}`,
      source,
      ...(email ? { email } : {}),
    }
    if (!existing) {
      await ghGlobal(this.rookery).accounts.insert(values)
      return
    }
    // A manual mapping or a token's proof is not replaced by a guess from an e-mail address.
    if (source === "email" && existing.user && existing.source !== "email") return
    if (existing.user === values.user && existing.source === source) return
    await ghGlobal(this.rookery).accounts.update(existing.id, values)
  }

  /** The logins known for a user on a host. */
  async loginsOf(host: string, user: string): Promise<string[]> {
    const page = await ghGlobal(this.rookery).accounts.find({
      where: { user: `user://${user}`, host } as never,
      limit: 20,
    })
    return page.rows.map((r) => String(r.login))
  }

  /** Removes the mapping a person's token made, when their connection is deleted. */
  async forget(host: string, login: string) {
    const a = await this.find(host, login)
    if (a?.source === "token") await ghGlobal(this.rookery).accounts.delete(a.id)
  }
}
