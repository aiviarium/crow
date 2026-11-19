// What a level on a host allows, the grants a person changes, and how a Rookery error reads in the UI.
// Ported from the prototype's `plugins/fleet/lib/access.ts`, onto Rookery's `access.*` methods: grants are
// on `env://NAME` (plans/design.md, "Levels on a host").
import type { Grant, GrantInfo, LevelHeld } from "@rookery/client"
import type { ClientRookery } from "@rookery/sdk/client"
import { RookeryError } from "@rookery/sdk/client"
import { envName } from "./env"

export type Level = Grant
export type Need = Level | "admin"

const RANK: Record<string, number> = { view: 1, use: 2, manage: 3 }

/** What each level allows, as plans/design.md puts it. */
export const LEVELS: Array<{ value: Level; label: string; can: string }> = [
  { value: "view", label: "Can view", can: "See the host, its state, sessions and desktop picture." },
  { value: "use", label: "Can use", can: "Open terminals, run processes, edit files and use the desktop." },
  {
    value: "manage",
    label: "Can manage",
    can: "Power, apply, host actions, units and logs, sharing, rename and remove.",
  },
]

export const levelLabel = (l: Level | null | undefined) =>
  LEVELS.find((x) => x.value === l)?.label ?? l ?? "no access"

export interface Who {
  /** The person's level on the host, `undefined` when unknown. */
  level?: string | null
  /** A Rookery admin, who holds manage everywhere. */
  admin?: boolean
}

/** Whether `who` holds at least `need`. `admin` is the org role, checked separately. */
export function allows(who: Who, need: Need): boolean {
  if (who.admin) return true
  if (need === "admin") return false
  return (RANK[who.level ?? ""] ?? 0) >= RANK[need]
}

/** Why an action is unavailable, or null when it is allowed. For tooltips on disabled buttons. */
export function why(who: Who, need: Need, env?: string): string | null {
  if (allows(who, need)) return null
  if (need === "admin") return "Only a Rookery admin can do that."
  const have = who.level ? `you have ${who.level}` : "you have no access"
  const where = env ? `env://${envName(env)}` : "this host"
  return `Needs ${need} on ${where}; ${have}. Ask its owner to share it with you.`
}

/** Who holds what on a resource: `access.grants`. */
export interface Sharing {
  resource: string
  /** The owner's user id, who holds manage. */
  owner: string | null
  grants: GrantInfo[]
}

export interface UserInfo {
  id: string
  name: string
  email?: string
  admin: boolean
  disabled: boolean
}

export interface GrantsApi {
  /** Who holds what on the resource. Needs `manage`. */
  grants(resource: string): Promise<Sharing>
  /** The caller's own level. */
  level(resource: string): Promise<Level | null>
  grant(resource: string, principal: string, level: Level): Promise<GrantInfo>
  revoke(resource: string, principal: string): Promise<void>
  /** Everyone, for picking a person to share with. Needs `admin`; empty when the caller is not one. */
  users(): Promise<UserInfo[]>
}

export function createGrantsApi(rookery: ClientRookery): GrantsApi {
  return {
    grants: (resource) => rookery.rpc.call<Sharing>("access.grants", { resource }),
    async level(resource) {
      const held = await rookery.rpc.call<LevelHeld>("access.level", { resource })
      return held.level
    },
    grant: (resource, principal, level) =>
      rookery.rpc.call<GrantInfo>("access.grant", { resource, principal, level }),
    async revoke(resource, principal) {
      await rookery.rpc.call("access.revoke", { resource, principal })
    },
    async users() {
      try {
        const res = await rookery.rpc.call<{ users: UserInfo[] }>("admin.users", {})
        return res.users ?? []
      } catch {
        return []
      }
    },
  }
}

/** The HTTP-style number for a Rookery error code, for the badge that leads a message. */
const NUMBERS: Record<string, number> = {
  INVALID: 400,
  UNAUTHENTICATED: 401,
  FORBIDDEN: 403,
  NOT_FOUND: 404,
  CONFLICT: 409,
  UNAVAILABLE: 503,
  TIMEOUT: 504,
  INTERNAL: 500,
}

export interface Explained {
  /** `403`, or the code the server used. */
  code: string
  /** What happened, in a sentence. */
  what: string
  /** What to do about it. */
  fix: string
}

/** Turns anything thrown by a call into the three parts Nocturne's errors have: code, what, fix. */
export function explain(e: unknown, ctx: { env?: string; doing?: string } = {}): Explained {
  const doing = ctx.doing ?? "do that"
  const host = ctx.env ? ` on ${envName(ctx.env)}` : ""
  const error = RookeryError.from(e)
  const code = String(NUMBERS[error.code] ?? 500)
  switch (error.code) {
    case "FORBIDDEN":
      return {
        code,
        what: error.message || `You may not ${doing}${host}.`,
        fix: ctx.env
          ? `Ask the owner of env://${envName(ctx.env)} for a higher level, in Access.`
          : "Ask a Rookery admin.",
      }
    case "NOT_FOUND":
      return {
        code,
        what: error.message || "That does not exist, or it is not shared with you.",
        fix: "Refresh the list; it may have been removed.",
      }
    case "CONFLICT":
      return {
        code,
        what: error.message,
        fix: "It changed meanwhile. Reload it and try again.",
      }
    case "TIMEOUT":
      return {
        code,
        what: `${ctx.env ? envName(ctx.env) : "The host"} did not answer in time.`,
        fix: "Retry.",
      }
    case "UNAVAILABLE":
      return {
        code,
        what: error.message || `Can't reach ${ctx.env ? envName(ctx.env) : "the host"}.`,
        fix: "Check that the host is online, then retry.",
      }
    case "INVALID":
      return { code, what: error.message, fix: "Correct the value and try again." }
    default:
      return { code, what: error.message || `Could not ${doing}${host}.`, fix: "Try again." }
  }
}
