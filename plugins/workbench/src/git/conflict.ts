// Conflict markers in a file that a merge, rebase or stash pop left behind, and resolving one region at a
// time: take ours, theirs, both, or the base (diff3 style markers have one).

export interface ConflictRegion {
  /** 0-based line index of `<<<<<<<`. */
  start: number
  /** 0-based line index of `>>>>>>>`. */
  end: number
  ours: string[]
  base: string[] | null
  theirs: string[]
  oursLabel: string
  theirsLabel: string
}

export function parseConflicts(text: string): ConflictRegion[] {
  const lines = text.split("\n")
  const out: ConflictRegion[] = []
  let i = 0
  while (i < lines.length) {
    if (!lines[i]!.startsWith("<<<<<<<")) {
      i++
      continue
    }
    const start = i
    const oursLabel = lines[i]!.slice(7).trim()
    const ours: string[] = []
    let base: string[] | null = null
    const theirs: string[] = []
    let part: "ours" | "base" | "theirs" = "ours"
    let end = -1
    for (i++; i < lines.length; i++) {
      const l = lines[i]!
      if (part === "ours" && l.startsWith("|||||||")) {
        part = "base"
        base = []
      } else if ((part === "ours" || part === "base") && l.startsWith("=======")) part = "theirs"
      else if (part === "theirs" && l.startsWith(">>>>>>>")) {
        end = i
        out.push({ start, end, ours, base, theirs, oursLabel, theirsLabel: l.slice(7).trim() })
        i++
        break
      } else if (part === "ours") ours.push(l)
      else if (part === "base") base!.push(l)
      else theirs.push(l)
    }
    if (end < 0) break
  }
  return out
}

export type Resolution = "ours" | "theirs" | "both" | "base"

/** The text with one region replaced by the side chosen. */
export function resolve(text: string, region: ConflictRegion, how: Resolution): string {
  const lines = text.split("\n")
  const take =
    how === "ours"
      ? region.ours
      : how === "theirs"
        ? region.theirs
        : how === "base"
          ? (region.base ?? [])
          : [...region.ours, ...region.theirs]
  lines.splice(region.start, region.end - region.start + 1, ...take)
  return lines.join("\n")
}

export const hasConflictMarkers = (text: string) => /^<<<<<<< /m.test(text) && /^>>>>>>> /m.test(text)
