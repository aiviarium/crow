// Pull requests and repositories as text for models: what `@` mentions in the agent composer and the
// `context` of model requests put in front of the model (crow.entities.text), and what the agent tools read.
import type { Rows } from "./rows"

const when = (v: unknown) => (v ? new Date(String(v)).toISOString().slice(0, 16).replace("T", " ") : "")
const names = (v: unknown) =>
  ((v ?? []) as Array<string | { name: string }>).map((x) => (typeof x === "string" ? x : x.name)).join(", ")

export function renderComments(comments: Rows[], limit = 40): string {
  const sorted = [...comments].sort(
    (a, b) => Date.parse(a.ghCreatedAt ?? "") - Date.parse(b.ghCreatedAt ?? ""),
  )
  const shown = sorted.slice(-limit)
  const out: string[] = []
  if (sorted.length > shown.length) out.push(`(${sorted.length - shown.length} earlier comments left out)`)
  for (const c of shown) {
    const head =
      c.kind === "review"
        ? `Review by ${c.author} (${String(c.reviewState).replace("_", " ")}), ${when(c.ghCreatedAt)}`
        : c.kind === "review_comment"
          ? `Comment by ${c.author} on ${c.path}${c.line ? `:${c.line}` : ""}, ${when(c.ghCreatedAt)}`
          : `Comment by ${c.author}, ${when(c.ghCreatedAt)}`
    out.push(`${head}\n${String(c.body ?? "").trim() || "(no text)"}`)
  }
  return out.join("\n\n")
}

export function renderPull(repo: Rows, pr: Rows, comments: Rows[]): string {
  const checks = pr.checks as {
    failed?: number
    pending?: number
    passed?: number
    items?: Array<{ name: string; conclusion: string | null }>
  } | null
  const failing = (checks?.items ?? []).filter((i) => i.conclusion).map((i) => `${i.name} (${i.conclusion})`)
  return [
    `Pull request ${repo.fullName}#${pr.number}: ${pr.title}`,
    `State: ${pr.state}${pr.draft ? " (draft)" : ""} · by ${pr.author} · ${pr.head} → ${pr.base}`,
    `Reviews: ${String(pr.reviewState).replace("_", " ")}${pr.reviewers?.length ? ` · requested from ${names(pr.reviewers)}` : ""}`,
    `Checks: ${pr.checksState}${checks ? ` (${checks.passed ?? 0} passed, ${checks.failed ?? 0} failed, ${checks.pending ?? 0} running)` : ""}${failing.length ? ` · failing: ${failing.join(", ")}` : ""}`,
    pr.labels?.length ? `Labels: ${names(pr.labels)}` : "",
    pr.assignees?.length ? `Assignees: ${names(pr.assignees)}` : "",
    `${pr.changedFiles ?? 0} files changed, +${pr.additions ?? 0} −${pr.deletions ?? 0} · mergeable: ${pr.mergeable ?? "unknown"}`,
    `${pr.htmlUrl}`,
    "",
    String(pr.body ?? "").trim() || "(no description)",
    comments.length ? `\n--- Conversation ---\n${renderComments(comments)}` : "",
  ]
    .filter((l, i, a) => l !== "" || a[i - 1] !== "")
    .join("\n")
}

export function renderRepo(repo: Rows, open: Rows[]): string {
  return [
    `Repository ${repo.fullName}${repo.private ? " (private)" : ""}`,
    repo.description ? String(repo.description) : "",
    `Default branch: ${repo.defaultBranch} · ${repo.openPulls ?? 0} open pull requests, ${repo.openIssues ?? 0} open issues`,
    `Sync: ${repo.status}${repo.lastSyncAt ? `, last ${when(repo.lastSyncAt)}` : ""}`,
    repo.htmlUrl,
    open.length
      ? `\nOpen pull requests:\n${open.map((p) => `#${p.number} ${p.title} (${p.author}, ${p.reviewState}, checks ${p.checksState})`).join("\n")}`
      : "",
  ]
    .filter(Boolean)
    .join("\n")
}
