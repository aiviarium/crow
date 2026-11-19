// Credentials for the two connection types. A personal access token is sent as it is. A GitHub App
// installation signs a short JWT with the app's private key (RS256), exchanges it for an installation token
// (valid for an hour) and caches that token, refreshing it two minutes before it expires or after a 401.
import { createSign } from "node:crypto"
import { GitHubError, GitHubHttp, type HttpOptions } from "./http"

export interface AppCredentials {
  kind: "app"
  appId: string
  installationId: string
  privateKey: string
}

export interface TokenCredentials {
  kind: "token"
  token: string
}

export type Credentials = AppCredentials | TokenCredentials

const b64url = (b: Buffer | string) =>
  Buffer.from(b).toString("base64").replace(/=+$/, "").replace(/\+/g, "-").replace(/\//g, "_")

/** A PEM as people paste it: `\n` written out, one line, Windows line ends, stray quotes. */
export function normalizePem(pem: string): string {
  let s = pem
    .trim()
    .replace(/^["']|["']$/g, "")
    .replace(/\\n/g, "\n")
    .replace(/\r\n?/g, "\n")
  const m = /-----BEGIN ([A-Z ]+)-----([\s\S]*?)-----END \1-----/.exec(s)
  if (m) {
    const body = m[2]!.replace(/\s+/g, "")
    s = `-----BEGIN ${m[1]}-----\n${body.match(/.{1,64}/g)?.join("\n") ?? ""}\n-----END ${m[1]}-----\n`
  }
  return s
}

/** The JWT an app presents to GitHub: valid for ten minutes at most, backdated a minute for clock skew. */
export function appJwt(appId: string, privateKey: string, nowMs = Date.now()): string {
  const iat = Math.floor(nowMs / 1000) - 60
  const head = b64url(JSON.stringify({ alg: "RS256", typ: "JWT" }))
  const claims = b64url(JSON.stringify({ iat, exp: iat + 9 * 60 + 60, iss: appId }))
  const signer = createSign("RSA-SHA256")
  signer.update(`${head}.${claims}`)
  let sig: Buffer
  try {
    sig = signer.sign(normalizePem(privateKey))
  } catch (e) {
    throw new GitHubError(
      `the app's private key cannot be read (${(e as Error).message}). Paste the whole .pem file GitHub gave you, including the BEGIN and END lines.`,
      "bad_credentials",
      401,
    )
  }
  return `${head}.${claims}.${b64url(sig)}`
}

export interface Auth {
  /** The Authorization header value. */
  authorization(): Promise<string>
  /** Forget a cached token after GitHub refused it. */
  invalidate(): void
  /** Who this is, for messages: "app 12345 (installation 67)" or "a personal access token". */
  describe: string
}

export function tokenAuth(c: TokenCredentials): Auth {
  return {
    authorization: async () => `Bearer ${c.token}`,
    invalidate() {},
    describe: "a personal access token",
  }
}

export function appAuth(
  c: AppCredentials,
  api: { baseUrl: string; fetch?: typeof fetch; now?: () => number },
): Auth {
  const now = api.now ?? Date.now
  let cached: { token: string; expiresAt: number } | null = null
  let minting: Promise<string> | null = null
  let installation = c.installationId
  const mint = async (): Promise<string> => {
    const jwt = appJwt(c.appId, c.privateKey, now())
    const http = new GitHubHttp({
      baseUrl: api.baseUrl,
      authorization: async () => `Bearer ${jwt}`,
      fetch: api.fetch,
      now: api.now,
      retries: 1,
    })
    // An app installed in one place needs no Installation ID: find it.
    if (!installation) {
      const found = (await http.get<Array<{ id: number }>>("/app/installations", { etag: false })).data
      if (found.length === 0) throw new GitHubError("The app is not installed", "not_installed", 403)
      if (found.length > 1)
        throw new GitHubError("The app has several installations", "ambiguous_installation", 403)
      installation = String(found[0]!.id)
    }
    const r = await http.post<{ token: string; expires_at: string }>(
      `/app/installations/${encodeURIComponent(installation)}/access_tokens`,
    )
    cached = { token: r.data.token, expiresAt: Date.parse(r.data.expires_at) }
    return cached.token
  }
  return {
    async authorization() {
      if (cached && cached.expiresAt - now() > 120_000) return `Bearer ${cached.token}`
      minting ??= mint().finally(() => {
        minting = null
      })
      return `Bearer ${await minting}`
    },
    invalidate() {
      cached = null
    },
    get describe() {
      return `app ${c.appId}${installation ? ` (installation ${installation})` : ""}`
    },
  }
}

export function makeAuth(
  c: Credentials,
  api: { baseUrl: string; fetch?: typeof fetch; now?: () => number },
): Auth {
  return c.kind === "app" ? appAuth(c, api) : tokenAuth(c)
}

export function httpFor(
  c: Credentials,
  o: Omit<HttpOptions, "authorization" | "onUnauthorized"> & { auth?: Auth },
): { http: GitHubHttp; auth: Auth } {
  const auth = o.auth ?? makeAuth(c, { baseUrl: o.baseUrl, fetch: o.fetch, now: o.now })
  return {
    auth,
    http: new GitHubHttp({
      ...o,
      authorization: () => auth.authorization(),
      onUnauthorized: () => auth.invalidate(),
    }),
  }
}
