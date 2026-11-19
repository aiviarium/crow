// What a failed GitHub call means for the person: Rookery's error code, a message that says what happened,
// and `details.fix` saying what to do. Never UNAUTHENTICATED: the shell reads that as "your Crow session
// ended" and shows the sign-in page.
import { RookeryError } from "@rookery/sdk"
import { GitHubError } from "./http"

export interface Whose {
  /** The connection's name. */
  name: string
  kind: "app" | "token"
}

export interface Explained {
  code: "INVALID" | "FORBIDDEN" | "NOT_FOUND" | "CONFLICT" | "UNAVAILABLE"
  /** A stable machine-readable reason the client switches on. */
  reason: string
  message: string
  fix?: string
  retryAt?: number
}

const clock = (ms: number) => new Date(ms).toISOString().slice(11, 16)

export function explain(e: unknown, who: Whose, what = "that"): Explained {
  if (!(e instanceof GitHubError)) {
    return { code: "UNAVAILABLE", reason: "github_unreachable", message: (e as Error).message }
  }
  const conn = `the connection "${who.name}"`
  switch (e.kind) {
    case "bad_credentials":
      return {
        code: "FORBIDDEN",
        reason: "github_token_rejected",
        message: `GitHub rejected the credentials of ${conn} (401 ${e.message}).`,
        fix:
          who.kind === "token"
            ? "The token was probably revoked or has expired. Create a new token on GitHub and paste it into the connection in Settings › Connections."
            : "Check that the app is still installed, and that the App ID, Installation ID and private key of the connection are right. Generate a new private key in the app's settings on GitHub if the old one was deleted.",
      }
    case "not_installed":
      return {
        code: "FORBIDDEN",
        reason: "github_app_not_installed",
        message: `The app of ${conn} is not installed anywhere yet.`,
        fix: "Install it on your organisation or account (the app's page on GitHub › Install App), then test the connection again.",
      }
    case "ambiguous_installation":
      return {
        code: "FORBIDDEN",
        reason: "github_app_installation",
        message: `The app of ${conn} is installed more than once, so Crow cannot tell which installation to use.`,
        fix: "Enter the Installation ID: the number at the end of the installation's URL on GitHub.",
      }
    case "sso_required":
      return {
        code: "FORBIDDEN",
        reason: "github_sso_required",
        message: `The organisation requires single sign-on for ${conn}.`,
        fix: `Authorize the token for the organisation (${e.extra.sso ?? "Settings › Developer settings › Personal access tokens › Configure SSO"}).`,
      }
    case "rate_limited":
      return {
        code: "UNAVAILABLE",
        reason: "github_rate_limited",
        message: `GitHub's rate limit for ${conn} is used up${e.extra.retryAt ? `; it resets at ${clock(e.extra.retryAt)} UTC` : ""}.`,
        fix: "Nothing to do: syncing continues by itself after the reset. A GitHub App has a higher limit than a personal token.",
        retryAt: e.extra.retryAt,
      }
    case "secondary_limit":
      return {
        code: "UNAVAILABLE",
        reason: "github_secondary_limit",
        message: `GitHub asked ${conn} to slow down (${e.message}).`,
        fix: "Nothing to do: Crow waits and tries again.",
        retryAt: e.extra.retryAt,
      }
    case "forbidden":
      return {
        code: "FORBIDDEN",
        reason: "github_forbidden",
        message: `GitHub does not let ${conn} do ${what}: ${e.message}`,
        fix: e.extra.permissions
          ? `Give the ${who.kind === "app" ? "app" : "token"} the permission "${e.extra.permissions}" and ${who.kind === "app" ? "accept the new permissions on the installation" : "try again"}.`
          : `Check the ${who.kind === "app" ? "app's permissions and that it is installed on this repository" : "token's scopes and that it can access this repository"}.`,
      }
    case "not_found":
      return {
        code: "NOT_FOUND",
        reason: "github_not_found",
        message: `GitHub cannot find ${what}, or ${conn} cannot see it.`,
        fix: `Check the name. For a private repository the ${who.kind === "app" ? "app must be installed on it" : "token must have access to it"}.`,
      }
    case "gone":
      return { code: "NOT_FOUND", reason: "github_gone", message: `${what} was deleted on GitHub.` }
    case "moved":
      return {
        code: "NOT_FOUND",
        reason: "github_moved",
        message: `${what} moved: ${e.extra.location ?? e.message}`,
      }
    case "conflict":
      return { code: "CONFLICT", reason: "github_conflict", message: e.message }
    case "not_allowed":
      return { code: "INVALID", reason: "github_not_allowed", message: e.message }
    case "validation": {
      const detail = Array.isArray(e.extra.errors)
        ? (e.extra.errors as Array<{ message?: string; code?: string; field?: string } | string>)
            .map((x) =>
              typeof x === "string" ? x : (x.message ?? `${x.field ?? ""} ${x.code ?? ""}`.trim()),
            )
            .filter(Boolean)
            .join("; ")
        : ""
      return {
        code: "INVALID",
        reason: "github_invalid",
        message: `${e.message}${detail ? `: ${detail}` : ""}`,
      }
    }
    case "network":
      return {
        code: "UNAVAILABLE",
        reason: "github_unreachable",
        message: e.message,
        fix: "Check that this server can reach GitHub (a proxy or firewall may be in the way), then try again.",
      }
    default:
      return {
        code: "UNAVAILABLE",
        reason: "github_unavailable",
        message: `GitHub answered ${e.status}: ${e.message}`,
      }
  }
}

export function rookeryError(e: unknown, who: Whose, what?: string): RookeryError {
  if (e instanceof RookeryError) return e
  const x = explain(e, who, what)
  return new RookeryError(x.code, x.message, {
    reason: x.reason,
    fix: x.fix,
    retryAt: x.retryAt ? new Date(x.retryAt).toISOString() : undefined,
    connection: who.name,
  })
}
