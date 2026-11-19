#!/usr/bin/env bun
// Prepares `.deps/<name>` for cross-repo TypeScript packages (@rookery/client, @rookery/sdk,
// @aiviarium/nocturne). Inside aiviarium/mono (when sibling checkouts exist and CROW_USE_PINS is
// unset), symlinks directly to the sibling checkouts so local edits apply immediately. Standalone
// and in CI, shallow-fetches the exact commit pinned in deps.json.

import { existsSync, lstatSync, mkdirSync, readFileSync, readlinkSync, rmSync, symlinkSync } from "node:fs"
import { dirname, join, relative, resolve } from "node:path"

interface DepPin {
  repo: string
  commit: string
  ref?: string
  sibling: string
  probe: string
}

const ROOT = resolve(dirname(import.meta.path), "..")
const DEPS_DIR = join(ROOT, ".deps")
const usePins = process.env.CROW_USE_PINS === "1" || process.env.CI === "true"

const pins = JSON.parse(readFileSync(join(ROOT, "deps.json"), "utf8")) as Record<string, DepPin>
mkdirSync(DEPS_DIR, { recursive: true })

function run(cmd: string[], cwd: string): string {
  const proc = Bun.spawnSync(cmd, { cwd, stdout: "pipe", stderr: "pipe" })
  if (proc.exitCode !== 0) {
    const err = new TextDecoder().decode(proc.stderr).trim()
    throw new Error(`command failed (${proc.exitCode}): ${cmd.join(" ")}\n${err}`)
  }
  return new TextDecoder().decode(proc.stdout).trim()
}

function currentCommit(dir: string): string | null {
  try {
    return run(["git", "rev-parse", "HEAD"], dir)
  } catch {
    return null
  }
}

for (const [name, pin] of Object.entries(pins)) {
  const target = join(DEPS_DIR, name)
  const siblingAbs = resolve(ROOT, pin.sibling)
  const hasSibling = !usePins && existsSync(join(siblingAbs, pin.probe))

  if (hasSibling) {
    const rel = relative(DEPS_DIR, siblingAbs)
    let needsLink = true
    try {
      const st = lstatSync(target)
      if (st.isSymbolicLink() && resolve(DEPS_DIR, readlinkSync(target)) === siblingAbs) {
        needsLink = false
      } else {
        rmSync(target, { recursive: true, force: true })
      }
    } catch {
      // Target does not exist yet.
    }
    if (needsLink) {
      symlinkSync(rel, target, "dir")
      console.log(`[sync-deps] ${name}: linked -> ${rel}`)
    } else {
      console.log(`[sync-deps] ${name}: linked (up to date)`)
    }
    continue
  }

  // Standalone / CI mode: shallow-fetch the exact pinned commit into `.deps/<name>`.
  let isSymlink = false
  try {
    isSymlink = lstatSync(target).isSymbolicLink()
  } catch {
    // Missing.
  }
  if (isSymlink) rmSync(target, { force: true })

  if (existsSync(join(target, ".git")) && currentCommit(target) === pin.commit) {
    console.log(`[sync-deps] ${name}: pinned ${pin.commit.slice(0, 12)} (cached)`)
    continue
  }

  rmSync(target, { recursive: true, force: true })
  mkdirSync(target, { recursive: true })
  run(["git", "init", "-q"], target)
  run(["git", "fetch", "-q", "--depth", "1", pin.repo, pin.commit], target)
  run(["git", "checkout", "-q", "--detach", "FETCH_HEAD"], target)
  const got = currentCommit(target)
  if (got !== pin.commit) {
    throw new Error(`[sync-deps] ${name}: expected ${pin.commit}, got ${got}`)
  }
  console.log(`[sync-deps] ${name}: fetched ${pin.commit.slice(0, 12)}`)
}
