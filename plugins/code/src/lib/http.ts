// The HTTP layer: one GitHubHttp per connection. It adds the credentials, follows `Link` pagination, keeps
// ETags so an unchanged resource answers 304 (which GitHub does not count against the rate limit), tracks
// the rate limit from the response headers, and backs off on secondary limits and server errors. It knows
// nothing of Crow; errors are GitHubError, mapped to Crow's codes in errors.ts.

export interface RateLimit {
  limit: number
  remaining: number
  /** Unix seconds. */
  reset: number
  resource?: string
  /** Unix ms when this was read. */
  at: number
}

export type GitHubErrorKind =
  | "bad_credentials"
  | "not_installed"
  | "ambiguous_installation"
  | "forbidden"
  | "sso_required"
  | "rate_limited"
  | "secondary_limit"
  | "not_found"
  | "gone"
  | "moved"
  | "conflict"
  | "not_allowed"
  | "validation"
  | "unavailable"
  | "network"

export class GitHubError extends Error {
  constructor(
    message: string,
    readonly kind: GitHubErrorKind,
    readonly status: number,
    readonly extra: {
      /** Unix ms: when retrying can work. */
      retryAt?: number
      /** Permissions GitHub says the call needs (`x-accepted-github-permissions`). */
      permissions?: string
      location?: string
      sso?: string
      errors?: unknown
      documentation?: string
      requestId?: string
    } = {},
  ) {
    super(message)
    this.name = "GitHubError"
  }
}

export interface HttpOptions {
  /** `https://api.github.com`, or `https://HOST/api/v3`. */
  baseUrl: string
  /** The Authorization header value, or null for anonymous requests. */
  authorization: () => Promise<string | null>
  /** Called after a 401 so the credentials can be refreshed (an installation token) before one retry. */
  onUnauthorized?: () => void
  fetch?: typeof fetch
  userAgent?: string
  /** Waits (ms); tests replace it. */
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>
  now?: () => number
  /** The longest a call waits out a secondary limit before giving up with `retryAt`. Default 20 s. */
  maxWaitMs?: number
  /** Retries of server errors and network failures for reads. Default 2. */
  retries?: number
  /** Entries of the ETag cache. Default 400. */
  cacheSize?: number
}

export interface Response<T> {
  data: T
  status: number
  headers: Headers
  /** The answer was 304 and `data` comes from the cache. */
  notModified: boolean
  next: string | null
  last: string | null
}

export interface RequestOptions {
  query?: Record<string, string | number | boolean | undefined>
  body?: unknown
  headers?: Record<string, string>
  /** Use and keep ETags (default for GET). */
  etag?: boolean
  /** Do not follow redirects: the caller wants the Location (a 301 for a renamed repository). */
  manual?: boolean
  /** The body is text, not JSON. */
  text?: boolean
  signal?: AbortSignal
  /** Do not wait for a secondary limit: throw at once. */
  noWait?: boolean
}

export const defaultSleep = (ms: number, signal?: AbortSignal) =>
  new Promise<void>((resolve, reject) => {
    if (signal?.aborted) return reject(signal.reason)
    const t = setTimeout(resolve, ms)
    signal?.addEventListener(
      "abort",
      () => {
        clearTimeout(t)
        reject(signal.reason)
      },
      { once: true },
    )
  })

function parseLink(header: string | null): Record<string, string> {
  const out: Record<string, string> = {}
  for (const part of (header ?? "").split(",")) {
    const m = /<([^>]+)>\s*;\s*rel="([^"]+)"/.exec(part)
    if (m) out[m[2]!] = m[1]!
  }
  return out
}

export class GitHubHttp {
  /** The last rate limit GitHub reported on this connection. */
  rate: RateLimit | null = null
  /** Requests made, and how many were answered 304 (for tests and the budget display). */
  readonly stats = { requests: 0, notModified: 0, retries: 0, waitedMs: 0 }
  private cache = new Map<string, { etag: string; data: unknown; link: Record<string, string> }>()
  private readonly f: typeof fetch
  private readonly sleep: (ms: number, signal?: AbortSignal) => Promise<void>
  private readonly now: () => number

  constructor(private readonly o: HttpOptions) {
    this.f = o.fetch ?? fetch
    this.sleep = o.sleep ?? defaultSleep
    this.now = o.now ?? Date.now
  }

  get baseUrl(): string {
    return this.o.baseUrl.replace(/\/+$/, "")
  }

  url(path: string, query?: RequestOptions["query"]): string {
    const u = new URL(
      /^https?:\/\//.test(path) ? path : `${this.baseUrl}${path.startsWith("/") ? "" : "/"}${path}`,
    )
    for (const [k, v] of Object.entries(query ?? {})) if (v !== undefined) u.searchParams.set(k, String(v))
    return u.toString()
  }

  async request<T = unknown>(method: string, path: string, opts: RequestOptions = {}): Promise<Response<T>> {
    const url = this.url(path, opts.query)
    const wantEtag = (opts.etag ?? method === "GET") && !opts.text
    const retries = this.o.retries ?? 2
    let attempt = 0
    let refreshed = false
    for (;;) {
      const headers: Record<string, string> = {
        accept: "application/vnd.github+json",
        "x-github-api-version": "2022-11-28",
        "user-agent": this.o.userAgent ?? "crow-github-plugin",
        ...opts.headers,
      }
      const auth = await this.o.authorization()
      if (auth) headers.authorization = auth
      const cached = wantEtag ? this.cache.get(url) : undefined
      if (cached) headers["if-none-match"] = cached.etag
      if (opts.body !== undefined) headers["content-type"] = "application/json"
      let res: globalThis.Response
      this.stats.requests++
      try {
        res = await this.f(url, {
          method,
          headers,
          body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
          redirect: opts.manual ? "manual" : "follow",
          signal: opts.signal,
        })
      } catch (e) {
        if (opts.signal?.aborted) throw e
        if (method === "GET" && attempt < retries) {
          attempt++
          this.stats.retries++
          await this.pause(500 * 2 ** (attempt - 1), opts.signal)
          continue
        }
        throw new GitHubError(`cannot reach ${this.baseUrl}: ${(e as Error).message}`, "network", 0)
      }
      this.readRate(res.headers)

      if (res.status === 304 && cached) {
        this.stats.notModified++
        return {
          data: cached.data as T,
          status: 200,
          headers: res.headers,
          notModified: true,
          next: cached.link.next ?? null,
          last: cached.link.last ?? null,
        }
      }
      if (res.ok || (opts.manual && res.status >= 300 && res.status < 400)) {
        const link = parseLink(res.headers.get("link"))
        const data = (
          res.status === 204 || res.status >= 300
            ? null
            : opts.text
              ? await res.text()
              : await res.json().catch(() => null)
        ) as T
        const etag = res.headers.get("etag")
        if (wantEtag && etag && res.status === 200) this.remember(url, { etag, data, link })
        return {
          data,
          status: res.status,
          headers: res.headers,
          notModified: false,
          next: link.next ?? null,
          last: link.last ?? null,
        }
      }

      const err = await this.fail(res)
      if (err.kind === "bad_credentials" && this.o.onUnauthorized && !refreshed) {
        refreshed = true
        this.o.onUnauthorized()
        continue
      }
      if (err.kind === "secondary_limit" && !opts.noWait) {
        const wait = Math.max(0, (err.extra.retryAt ?? this.now() + 60_000) - this.now())
        if (wait <= (this.o.maxWaitMs ?? 20_000) && attempt < 3) {
          attempt++
          this.stats.retries++
          this.stats.waitedMs += wait
          await this.sleep(wait, opts.signal)
          continue
        }
      }
      if (err.kind === "unavailable" && method === "GET" && attempt < retries) {
        attempt++
        this.stats.retries++
        await this.pause(500 * 2 ** (attempt - 1), opts.signal)
        continue
      }
      throw err
    }
  }

  get<T = unknown>(path: string, opts?: RequestOptions) {
    return this.request<T>("GET", path, opts)
  }
  post<T = unknown>(path: string, body?: unknown, opts?: RequestOptions) {
    return this.request<T>("POST", path, { ...opts, body: body ?? {} })
  }
  put<T = unknown>(path: string, body?: unknown, opts?: RequestOptions) {
    return this.request<T>("PUT", path, { ...opts, body: body ?? {} })
  }
  patch<T = unknown>(path: string, body?: unknown, opts?: RequestOptions) {
    return this.request<T>("PATCH", path, { ...opts, body: body ?? {} })
  }
  delete<T = unknown>(path: string, body?: unknown, opts?: RequestOptions) {
    return this.request<T>("DELETE", path, { ...opts, body })
  }

  /**
   * Every page of a list, following `Link: rel="next"`. `stop` sees each page and ends the walk early
   * (a list sorted by update time stops at the first page older than the cursor). The first page is
   * conditional, so an unchanged list costs a 304 and `onFirst` can tell.
   */
  async *pages<T>(
    path: string,
    opts: RequestOptions & { maxPages?: number } = {},
  ): AsyncGenerator<{ items: T[]; notModified: boolean; page: number }> {
    let url: string | null = this.url(path, { per_page: 100, ...opts.query })
    let page = 0
    const max = opts.maxPages ?? 50
    while (url && page < max) {
      const r: Response<T[] | { items?: T[] }> = await this.get(url, { ...opts, query: undefined })
      page++
      const items = Array.isArray(r.data) ? r.data : ((r.data as { items?: T[] })?.items ?? [])
      yield { items, notModified: r.notModified, page }
      url = r.next
    }
  }

  async all<T>(path: string, opts: RequestOptions & { maxPages?: number } = {}): Promise<T[]> {
    const out: T[] = []
    for await (const p of this.pages<T>(path, opts)) out.push(...p.items)
    return out
  }

  /** Drops the ETags, so the next reads are full ones (a full resync). */
  forget() {
    this.cache.clear()
  }

  private remember(url: string, v: { etag: string; data: unknown; link: Record<string, string> }) {
    this.cache.delete(url)
    this.cache.set(url, v)
    const max = this.o.cacheSize ?? 400
    while (this.cache.size > max) this.cache.delete(this.cache.keys().next().value as string)
  }

  private async pause(ms: number, signal?: AbortSignal) {
    this.stats.waitedMs += ms
    await this.sleep(ms, signal)
  }

  private readRate(h: Headers) {
    const limit = Number(h.get("x-ratelimit-limit"))
    const remaining = h.get("x-ratelimit-remaining")
    const reset = Number(h.get("x-ratelimit-reset"))
    if (h.get("x-ratelimit-limit") && remaining !== null && Number.isFinite(reset)) {
      this.rate = {
        limit,
        remaining: Number(remaining),
        reset,
        resource: h.get("x-ratelimit-resource") ?? undefined,
        at: this.now(),
      }
    }
  }

  private async fail(res: globalThis.Response): Promise<GitHubError> {
    const text = await res.text().catch(() => "")
    let body: { message?: string; documentation_url?: string; errors?: unknown } = {}
    try {
      body = JSON.parse(text)
    } catch {
      body = { message: text.slice(0, 300) }
    }
    const message = body.message || res.statusText || `HTTP ${res.status}`
    const h = res.headers
    const extra = {
      permissions: h.get("x-accepted-github-permissions") ?? undefined,
      errors: body.errors,
      documentation: body.documentation_url,
      requestId: h.get("x-github-request-id") ?? undefined,
    }
    const retryAfter = Number(h.get("retry-after"))
    const remaining = h.get("x-ratelimit-remaining")
    const reset = Number(h.get("x-ratelimit-reset"))
    const s = res.status
    if (s === 401) return new GitHubError(message, "bad_credentials", s, extra)
    if (s === 403 || s === 429) {
      const sso = h.get("x-github-sso")
      if (sso) return new GitHubError(message, "sso_required", s, { ...extra, sso })
      if (
        /secondary rate limit|abuse detection/i.test(message) ||
        (Number.isFinite(retryAfter) && h.get("retry-after"))
      ) {
        const wait = Number.isFinite(retryAfter) && h.get("retry-after") ? retryAfter : 60
        return new GitHubError(message, "secondary_limit", s, { ...extra, retryAt: this.now() + wait * 1000 })
      }
      if (remaining === "0" || /rate limit/i.test(message)) {
        return new GitHubError(message, "rate_limited", s, {
          ...extra,
          retryAt: Number.isFinite(reset) && reset > 0 ? reset * 1000 : this.now() + 60_000,
        })
      }
      return new GitHubError(message, "forbidden", s, extra)
    }
    if (s === 404) return new GitHubError(message, "not_found", s, extra)
    if (s === 410) return new GitHubError(message, "gone", s, extra)
    if (s === 405) return new GitHubError(message, "not_allowed", s, extra)
    if (s === 409) return new GitHubError(message, "conflict", s, extra)
    if (s === 422) return new GitHubError(message, "validation", s, extra)
    if (s === 301 || s === 302 || s === 307 || s === 308)
      return new GitHubError(message, "moved", s, { ...extra, location: h.get("location") ?? undefined })
    return new GitHubError(message, s >= 500 ? "unavailable" : "validation", s, extra)
  }
}

/** The web address of an API base: `https://api.github.com` is `https://github.com`, `https://h/api/v3` is `https://h`. */
export function webBase(apiBase: string): string {
  const u = apiBase.replace(/\/+$/, "")
  if (/^https:\/\/api\.github\.com$/i.test(u)) return "https://github.com"
  return u.replace(/\/api\/v3$/i, "")
}

/** A key for a repository that is the same on every connection: `github.com/owner/name`, lower case. */
export function repoKey(apiBase: string, fullName: string): string {
  return `${new URL(webBase(apiBase)).host}/${fullName}`.toLowerCase()
}
