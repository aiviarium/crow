// Connecting GitHub: what a connection's "Test" says (who it is, what it can reach, how much of the rate
// limit is left, whether webhooks can verify), and creating a GitHub App from Crow with GitHub's manifest
// flow. The manifest flow needs no route of the kernel's: the shell page posts the manifest to GitHub, GitHub
// sends the browser back to a Crow view with a code, and the view hands the code to `app.complete`.
//
// A host half cannot create a connection at the pinned SDK: `rookery.connections` lists, gets and resolves.
// `app.complete` therefore answers with what the connection is made of, and the admin's browser creates it
// with `rookery.connections.create` (API.md, "needed (M2)").
import type { ConnectionCreate } from "@rookery/client"
import { type Ctx, RookeryError } from "@rookery/sdk"
import { explain } from "./errors"
import { GitHubHttp, webBase } from "./http"
import { normalizeBase, type Pool } from "./pool"
import { remember } from "./repos"
import type { ConnectionView } from "./sdk"
import type { Services } from "./sync"

const clock = (s: number) => new Date(s * 1000).toISOString().slice(11, 16)
const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`

export async function testConnection(
  sv: Services,
  ctx: Ctx,
  c: ConnectionView,
): Promise<{ ok: boolean; message: string; details?: unknown }> {
  const gh = sv.pool.fromConnection(c)
  try {
    const host = new URL(gh.web).host
    let who: string
    let reach: { total: number; repos: Array<{ full_name: string }> }
    const extra: string[] = []
    if (c.type.endsWith("token")) {
      const me = (await gh.api.user()).data
      who = `Signed in to ${host} as ${me.login}${me.name ? ` (${me.name})` : ""}`
      reach = await gh.api.userRepos()
      await remember(sv, ctx, gh)
    } else {
      reach = await gh.api.installationRepos()
      who = `App ${c.values.appId}${c.values.installationId ? `, installation ${c.values.installationId}` : ""} on ${host}`
      extra.push(
        c.values.webhookSecret
          ? "Webhooks are verified with the stored secret at /hooks/code/events."
          : "No webhook secret: repositories are polled, not pushed.",
      )
    }
    const rate = (await gh.api.rateLimit()).resources.core
    const names = reach.repos.slice(0, 3).map((r) => r.full_name)
    const message = [
      `${who}.`,
      `Reaches ${plural(reach.total, "repository", "repositories")}${names.length ? ` (${names.join(", ")}${reach.total > names.length ? ", …" : ""})` : ""}.`,
      `${rate.remaining.toLocaleString("en")} of ${rate.limit.toLocaleString("en")} requests left until ${clock(rate.reset)} UTC.`,
      ...extra,
    ].join(" ")
    return {
      ok: true,
      message,
      details: {
        host,
        repositories: reach.total,
        rate: {
          limit: rate.limit,
          remaining: rate.remaining,
          resetAt: new Date(rate.reset * 1000).toISOString(),
        },
      },
    }
  } catch (e) {
    const x = explain(e, gh.who)
    return { ok: false, message: `${x.message}${x.fix ? ` ${x.fix}` : ""}`, details: { reason: x.reason } }
  }
}

// ── Creating an app from Crow ───────────────────────────────────────────────────────────────────────

const PERMISSIONS = {
  metadata: "read",
  contents: "read",
  issues: "write",
  pull_requests: "write",
  checks: "read",
  statuses: "read",
  actions: "read",
}
const EVENTS = [
  "pull_request",
  "pull_request_review",
  "pull_request_review_comment",
  "issues",
  "issue_comment",
  "check_run",
  "check_suite",
  "status",
  "repository",
]

interface Pending {
  user: string
  apiBase: string
  origin: string
  at: number
}

export async function appManifest(
  sv: Services,
  ctx: Ctx,
  p: { origin: string; apiBase?: string; org?: string; name?: string },
) {
  if (!ctx.user?.admin)
    throw new RookeryError("FORBIDDEN", "Only an admin creates the deployment's GitHub App.")
  const apiBase = normalizeBase(p.apiBase)
  const web = webBase(apiBase)
  const state = crypto.randomUUID()
  const origin = p.origin.replace(/\/+$/, "")
  await sv.rookery.secrets.set(
    `manifest:${state}`,
    JSON.stringify({ user: ctx.user.id, apiBase, origin, at: Date.now() } satisfies Pending),
  )
  const back = `${origin}/github/connect`
  const manifest = {
    name: (p.name || `Crow (${new URL(origin).hostname})`).slice(0, 34),
    url: origin,
    hook_attributes: { url: `${origin}/hooks/code/events`, active: true },
    redirect_url: back,
    setup_url: back,
    public: false,
    default_permissions: PERMISSIONS,
    default_events: EVENTS,
  }
  const post = `${web}${p.org ? `/organizations/${encodeURIComponent(p.org)}` : ""}/settings/apps/new?state=${state}`
  return { post, manifest, state }
}

/**
 * GitHub sent the browser back with a code: convert it into the app's credentials, and answer with what the
 * connection is made of. The admin's browser creates it (`rookery.connections.create`), because a host half
 * cannot at the pinned SDK.
 */
export async function appComplete(sv: Services, ctx: Ctx, p: { code: string; state: string }) {
  if (!ctx.user?.admin)
    throw new RookeryError("FORBIDDEN", "Only an admin creates the deployment's GitHub App.")
  const raw = await sv.rookery.secrets.get(`manifest:${p.state}`)
  const pending = raw ? (JSON.parse(raw) as Pending) : null
  if (!pending || pending.user !== ctx.user.id || Date.now() - pending.at > 3600_000) {
    throw new RookeryError("INVALID", "This sign-in link has expired or was started by someone else.", {
      fix: "Start again from GitHub › Connect.",
    })
  }
  await sv.rookery.secrets.delete(`manifest:${p.state}`)
  const http = new GitHubHttp({ baseUrl: pending.apiBase, authorization: async () => null })
  let app: { id: number; slug: string; name: string; pem: string; webhook_secret: string; html_url: string }
  try {
    app = (await http.post<typeof app>(`/app-manifests/${encodeURIComponent(p.code)}/conversions`)).data
  } catch (e) {
    const x = explain(e, { name: "the app", kind: "app" })
    throw new RookeryError("INVALID", `GitHub did not accept the code: ${x.message}`, {
      fix: "Start again from GitHub › Connect; a code works once and for an hour.",
    })
  }
  /** What `rookery.connections.create` takes. */
  const connection: ConnectionCreate = {
    type: "code.github-app",
    name: `${app.name || app.slug} (GitHub App)`,
    scope: "global",
    config: { baseUrl: pending.apiBase, appId: String(app.id) },
    credential: JSON.stringify({ privateKey: app.pem, webhookSecret: app.webhook_secret }),
  }
  return {
    name: app.name || app.slug,
    slug: app.slug,
    install: `${app.html_url}/installations/new`,
    connection,
  }
}
