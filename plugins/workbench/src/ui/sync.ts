// Push, pull and fetch: git run on the host with env.exec, from the client half, because they can take
// longer than a host handler may. Credentials are the host's business; a refused push shows git's own words.
import { runCommand } from "../api"
import type { Workspace } from "../workspace"

export type SyncOp = "push" | "pull" | "fetch"

export function syncArgs(
  op: SyncOp,
  o: {
    branch?: string | null
    upstream?: string
    remote?: string
    force?: boolean
    rebase?: boolean
    tags?: boolean
  } = {},
): string[] {
  const remote = o.remote ?? "origin"
  switch (op) {
    case "push": {
      const a = ["push", "--progress"]
      if (o.force) a.push("--force-with-lease")
      if (o.tags) a.push("--follow-tags")
      // A branch without an upstream gets one on the first push.
      if (!o.upstream && o.branch) a.push("-u", remote, `HEAD:refs/heads/${o.branch}`)
      return a
    }
    case "pull":
      return ["pull", "--progress", "--no-edit", o.rebase ? "--rebase" : "--ff"]
    case "fetch":
      return ["fetch", "--progress", "--prune", "--all"]
  }
}

/** Runs push, pull or fetch and reports how it went. Resolves true on success. */
export async function syncAction(
  w: Workspace,
  op: SyncOp,
  o: { force?: boolean; rebase?: boolean; tags?: boolean } = {},
): Promise<boolean> {
  const b = w.status()?.branch
  const rookery = w.rookery
  if (op === "push" && !b?.head) {
    rookery.workbench.toast({
      title: "Nothing to push from a detached HEAD",
      body: "Create a branch first.",
      kind: "warning",
    })
    return false
  }
  const remotes = (await w.api.git.refs(w.env, w.root).catch(() => null))?.remotes ?? []
  if (!remotes.length) {
    rookery.workbench.toast({
      title: `No remote to ${op}`,
      body: "This repository has no remote. Add one in a terminal: git remote add origin <url>.",
      kind: "warning",
    })
    return false
  }
  const remote = b?.upstream?.split("/")[0] ?? (remotes.includes("origin") ? "origin" : remotes[0])
  const args = syncArgs(op, { branch: b?.head, upstream: b?.upstream, remote, ...o })
  w.setSyncing(op)
  try {
    const r = await runCommand(rookery, {
      env: w.env,
      cwd: w.root,
      command: ["git", "-c", "color.ui=false", ...args],
      vars: { GIT_TERMINAL_PROMPT: "0", GIT_SSH_COMMAND: "ssh -o BatchMode=yes", LC_ALL: "C" },
      timeoutMs: 120_000,
    })
    if (r.exitCode === 0) {
      const what = op === "push" ? `Pushed ${b?.head}` : op === "pull" ? "Pulled" : "Fetched"
      rookery.workbench.toast({ title: what, kind: "success" })
      return true
    }
    const lines = r.stderr
      .split(/\r|\n/)
      .map((l) => l.trim())
      .filter(
        (l) =>
          l &&
          !/^(remote: )?(Counting|Compressing|Writing|Receiving|Resolving|Enumerating|Total|Delta)/.test(l),
      )
    rookery.workbench.toast({
      title: op === "push" ? "The push was refused" : `git ${op} failed`,
      body: lines.slice(-6).join("\n") || `exited ${r.exitCode ?? "without a status"}`,
      kind: "danger",
    })
    w.setLastError(`git ${op}: ${lines.slice(-6).join(" · ")}`)
    return false
  } finally {
    w.setSyncing(null)
    await w.refresh()
  }
}
