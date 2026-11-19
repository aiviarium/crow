// Typechecks the shell and every plugin that has a tsconfig.json, in parallel, so adding a plugin
// needs no edit to package.json.
import { existsSync, readdirSync } from "node:fs"
import { join } from "node:path"

const root = join(import.meta.dir, "..")
const projects = [
  "shell/tsconfig.json",
  ...readdirSync(join(root, "plugins"), { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => `plugins/${d.name}/tsconfig.json`)
    .filter((p) => existsSync(join(root, p)))
    .sort(),
]

const tsc = join(root, "node_modules", ".bin", "tsc")
const runs = projects.map(async (project) => {
  const proc = Bun.spawn([tsc, "-p", project, "--noEmit"], { cwd: root, stdout: "pipe", stderr: "pipe" })
  const [out, err, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ])
  return { project, code, output: out + err }
})

let failed = false
for (const run of await Promise.all(runs)) {
  if (run.code !== 0) {
    failed = true
    console.error(`[typecheck] ${run.project} failed:\n${run.output}`)
  }
}
console.log(`[typecheck] ${projects.length} projects, ${failed ? "failed" : "ok"}`)
process.exit(failed ? 1 : 0)
