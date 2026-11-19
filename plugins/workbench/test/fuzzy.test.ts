import { expect, test } from "bun:test"
import { fuzzyFilter, score } from "../src/fuzzy"

const paths = [
  "src/ui/Workspace.tsx",
  "src/ui/Files.tsx",
  "src/git/status.ts",
  "test/git.test.ts",
  "plugins/workbench/host.ts",
  "README.md",
  "docs/implementation.md",
]

test("in order, file names first, starts of words and runs", () => {
  expect(score("src/git/status.ts", "xyz")).toBeNull()
  expect(fuzzyFilter(paths, "status")[0]!.path).toBe("src/git/status.ts")
  expect(fuzzyFilter(paths, "wsp")[0]!.path).toBe("src/ui/Workspace.tsx")
  expect(fuzzyFilter(paths, "host")[0]!.path).toBe("plugins/workbench/host.ts")
  expect(fuzzyFilter(paths, "readme")[0]!.path).toBe("README.md")
  expect(fuzzyFilter(paths, "gittest")[0]!.path).toBe("test/git.test.ts")
  const hit = score("src/ui/Files.tsx", "files")!
  expect(hit.positions).toEqual([7, 8, 9, 10, 11])
  expect(fuzzyFilter(paths, "").length).toBe(paths.length)
})

test("20,000 paths per keystroke stay fast", () => {
  const many: string[] = []
  for (let i = 0; i < 20_000; i++) many.push(`packages/pkg-${i % 97}/src/module-${i}/component${i}.tsx`)
  many.push("packages/special/src/needle/Haystack.tsx")
  const t0 = performance.now()
  for (const q of ["h", "ha", "hay", "hays", "haystack"]) fuzzyFilter(many, q)
  const per = (performance.now() - t0) / 5
  expect(fuzzyFilter(many, "haystack")[0]!.path).toBe("packages/special/src/needle/Haystack.tsx")
  // A generous bound for a loaded shared machine; typically a few milliseconds.
  expect(per).toBeLessThan(150)
  console.log(`fuzzy: ${per.toFixed(1)} ms per keystroke over ${many.length} paths`)
})
