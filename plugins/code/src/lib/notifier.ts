// What the plugin tells people, in their Crow inbox: a review is asked of them, someone mentions them, the
// checks of a pull request they opened fail, a repository stops syncing. `plan*` decide, from a row before
// and after a change, whom to tell what (pure, tested); `Notifier` maps GitHub logins to Crow users, leaves
// out people who cannot see the item or turned the kind off in their settings, and sends. Whether a
// notification also goes out as a push or a desktop notification is the user's per-kind setting in
// Settings › Notifications, which the kernel applies.
import type { Ctx, Rookery } from "@rookery/sdk"
import type { Accounts } from "./accounts"
import { mentionsLogin } from "./links"
import type { Rows } from "./rows"
import { getSetting, levelOf, sendNotice } from "./sdk"

export type Kind = "review_requested" | "mention" | "checks_failed" | "sync_failed"

export interface Planned {
  kind: Exclude<Kind, "sync_failed">
  /** The GitHub login to tell. */
  login: string
  text: string
  /** Who did it, for not telling people about their own actions. */
  by?: string
}

const SETTING: Record<
  Exclude<Kind, "sync_failed">,
  "code.notifyReviewRequests" | "code.notifyMentions" | "code.notifyChecks"
> = {
  review_requested: "code.notifyReviewRequests",
  mention: "code.notifyMentions",
  checks_failed: "code.notifyChecks",
}

const MENTION = /(?<![\w@/.-])@([A-Za-z0-9](?:[A-Za-z0-9-]{0,38}))(?![\w-])/g

export function mentionedLogins(text: string | null | undefined): string[] {
  const out: string[] = []
  for (const m of (text ?? "").matchAll(MENTION)) {
    const l = m[1]!
    if (!out.some((x) => x.toLowerCase() === l.toLowerCase())) out.push(l)
  }
  return out
}

const label = (repo: string, row: Rows) => `${repo}#${row.number}`

/** Changes to a pull request or issue that someone should hear about. `before` is null for a new item. */
export function planItem(kind: "pr" | "issue", repo: string, before: Rows | null, after: Rows): Planned[] {
  const out: Planned[] = []
  const name = `${label(repo, after)}: ${after.title}`
  if (kind === "pr") {
    const was = new Set<string>((before?.reviewers ?? []) as string[])
    for (const l of (after.reviewers ?? []) as string[]) {
      if (l.startsWith("team:") || was.has(l)) continue
      out.push({ kind: "review_requested", login: l, text: `Review requested on ${name}`, by: after.author })
    }
    if (
      after.state === "open" &&
      after.checksState === "failure" &&
      (before?.checksState !== "failure" || before.headSha !== after.headSha)
    ) {
      const failing = ((after.checks?.items ?? []) as Array<{ name: string; conclusion: string | null }>)
        .filter((i) => i.conclusion)
        .map((i) => i.name)
      out.push({
        kind: "checks_failed",
        login: after.author,
        text: `Checks failed on ${name}${failing.length ? ` (${failing.slice(0, 3).join(", ")}${failing.length > 3 ? ", …" : ""})` : ""}`,
      })
    }
  }
  // Mentions in the description: new ones only.
  const was = new Set(mentionedLogins(before?.body).map((l) => l.toLowerCase()))
  for (const l of mentionedLogins(after.body)) {
    if (!was.has(l.toLowerCase()))
      out.push({
        kind: "mention",
        login: l,
        text: `${after.author} mentioned you in ${name}`,
        by: after.author,
      })
  }
  return out
}

/** A new comment or review: whom it mentions. */
export function planComment(repo: string, item: Rows | null, comment: Rows): Planned[] {
  const n = comment.number as number
  const title = item?.title ? `: ${item.title}` : ""
  return mentionedLogins(comment.body).map((l) => ({
    kind: "mention" as const,
    login: l,
    text: `${comment.author} mentioned you in ${repo}#${n}${title}`,
    by: comment.author,
  }))
}

export class Notifier {
  constructor(
    private readonly rookery: Rookery,
    private readonly accounts: Accounts,
  ) {}

  /** Sends planned notifications about `entity` to the mapped Crow users who may see it. */
  async deliver(
    ctx: Ctx,
    host: string,
    entity: string,
    planned: Planned[],
    api?: Parameters<Accounts["userFor"]>[2],
  ) {
    const sent = new Set<string>()
    for (const p of planned) {
      if (p.by && p.by.toLowerCase() === p.login.toLowerCase()) continue
      const user = await this.accounts.userFor(host, p.login, api, ctx)
      if (!user || sent.has(`${p.kind}:${user}`)) continue
      if (!(await this.wants(ctx, user, p.kind, entity))) continue
      sent.add(`${p.kind}:${user}`)
      await this.send(user, p.kind, p.text, entity)
    }
  }

  async wants(ctx: Ctx, user: string, kind: Exclude<Kind, "sync_failed">, entity: string): Promise<boolean> {
    try {
      if (!(await getSetting<boolean>(this.rookery, SETTING[kind], { user }))) return false
      const level = await levelOf(ctx, entity, user)
      return level !== null
    } catch (e) {
      this.rookery.log.warn(`not telling ${user} about ${entity}: ${(e as Error).message}`)
      return false
    }
  }

  async send(user: string, kind: Kind, text: string, entity?: string) {
    await sendNotice(this.rookery, {
      user,
      kind: kind === "sync_failed" || kind === "checks_failed" ? "action" : "info",
      title: text.slice(0, 200),
      resource: entity,
    })
  }
}

export { mentionsLogin }
