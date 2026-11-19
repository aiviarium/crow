// The files a diff touches, from `--numstat -z` and `--name-status -z` (both machine-readable), and branch
// names as git accepts them.

export type FileStatus =
  | "modified"
  | "added"
  | "deleted"
  | "renamed"
  | "copied"
  | "typechange"
  | "unmerged"
  | "untracked"

export interface ChangedFile {
  path: string
  oldPath?: string
  status: FileStatus
  added: number
  removed: number
  binary: boolean
}

const STATUS: Record<string, FileStatus> = {
  M: "modified",
  A: "added",
  D: "deleted",
  R: "renamed",
  C: "copied",
  T: "typechange",
  U: "unmerged",
}

/**
 * Joins `git diff --numstat -z` (`added TAB removed TAB path NUL`, or for a rename `added TAB removed TAB
 * NUL old NUL new NUL`; `-` counts for binary files) with `--name-status -z` (`X NUL path NUL`, or
 * `R<score> NUL old NUL new NUL`).
 */
export function parseFileList(numstat: string, nameStatus: string): ChangedFile[] {
  const files = new Map<string, ChangedFile>()
  const ns = nameStatus.split("\0")
  for (let i = 0; i < ns.length; ) {
    const code = ns[i++]
    if (!code) continue
    const letter = code[0]!
    if (letter === "R" || letter === "C") {
      const oldPath = ns[i++]!
      const path = ns[i++]!
      files.set(path, { path, oldPath, status: STATUS[letter]!, added: 0, removed: 0, binary: false })
    } else {
      const path = ns[i++]!
      files.set(path, { path, status: STATUS[letter] ?? "modified", added: 0, removed: 0, binary: false })
    }
  }
  const nums = numstat.split("\0")
  for (let i = 0; i < nums.length; ) {
    const rec = nums[i++]
    if (!rec) continue
    const [a, r, p] = rec.split("\t")
    let path = p ?? ""
    if (path === "") {
      i++ // the old path
      path = nums[i++] ?? ""
    }
    const f = files.get(path)
    if (!f) continue
    if (a === "-" && r === "-") f.binary = true
    else {
      f.added = Number(a) || 0
      f.removed = Number(r) || 0
    }
  }
  return [...files.values()]
}

/** A branch or tag name git accepts, made from what someone typed: spaces become dashes. */
export function sanitizeBranch(name: string): string {
  return name
    .trim()
    .replace(/\s+/g, "-")
    .replace(/[~^:?*[\\]+/g, "-")
    .replace(/./gu, (c) => (c.charCodeAt(0) < 0x20 || c.charCodeAt(0) === 0x7f ? "-" : c))
    .replace(/\.\.+/g, ".")
    .replace(/@\{/g, "-")
    .replace(/^[-./]+|[./]+$/g, "")
    .replace(/\.lock$/, "")
}
