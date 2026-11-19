// Resolves what a pull request or issue links to, for the `links` and `sessions` fields of its row:
// entity URLs and URIs written in the text, issue keys that plugins teach us through the extension point
// `github.linkPatterns`, and agent sessions registered for the branch with `github.linkSession`.
import type { Ctx, Rookery } from "@rookery/sdk"
import { candidates, entityUris, type LinkPattern } from "./links"
import type { GhCollections, Rows } from "./rows"
import { callService } from "./sdk"

const TTL = 30_000

interface Contribution extends LinkPattern {
  plugin?: string
}

export class Linker {
  private cache: { at: number; patterns: Contribution[] } | null = null
  private keys = new Map<string, { at: number; uri: string | null }>()

  constructor(private readonly rookery: Rookery) {}

  /** The patterns every plugin contributed, checked once every 30 seconds. */
  async patterns(): Promise<Contribution[]> {
    if (this.cache && Date.now() - this.cache.at < TTL) return this.cache.patterns
    let patterns: Contribution[] = []
    try {
      patterns = (await this.rookery.extensions.list("github.linkPatterns")).map((c) => ({
        ...(c.value as LinkPattern),
        plugin: c.plugin,
      }))
    } catch {
      // The point exists from the first start; a failure here only means no keys are recognised now.
    }
    this.cache = { at: Date.now(), patterns }
    return patterns
  }

  /** The entity URIs an item's title and body name, directly or by key, and its branch by key. */
  async linksFor(
    ctx: Ctx | null,
    space: string,
    item: { title?: string; body?: string; head?: string },
  ): Promise<string[]> {
    const out = [...entityUris(item.title), ...entityUris(item.body)].filter((u, i, a) => a.indexOf(u) === i)
    const patterns = await this.patterns()
    if (patterns.length === 0) return out
    const wanted = candidates(item, patterns)
    // One call per contributing method, for the keys it has not answered lately.
    const byMethod = new Map<string, { p: Contribution; keys: string[] }>()
    for (const c of wanted) {
      const hit = this.keys.get(`${c.pattern.id}:${c.key.toUpperCase()}`)
      if (hit && Date.now() - hit.at < TTL) continue
      const m: { p: Contribution; keys: string[] } = byMethod.get(
        `${c.pattern.service}.${c.pattern.method}`,
      ) ?? { p: c.pattern, keys: [] }
      if (!m.keys.includes(c.key)) m.keys.push(c.key)
      byMethod.set(`${c.pattern.service}.${c.pattern.method}`, m)
    }
    for (const { p, keys } of byMethod.values()) {
      try {
        // The contract is this plugin's extension point github.linkPatterns: keys in, URIs by key out.
        const answer =
          (await callService<Record<string, string | null>>(
            this.rookery,
            ctx,
            p.plugin ?? p.service,
            p.service,
            p.method,
            { keys, space },
          )) ?? {}
        for (const key of keys) {
          const uri = answer[key] ?? answer[key.toUpperCase()] ?? null
          this.keys.set(`${p.id}:${key.toUpperCase()}`, {
            at: Date.now(),
            uri: typeof uri === "string" && /^[a-z][a-z0-9-]*:\/\//.test(uri) ? uri : null,
          })
        }
      } catch (e) {
        this.rookery.log.warn(
          `link pattern ${p.id}: ${p.service}.${p.method} failed: ${(e as Error).message}`,
        )
      }
    }
    for (const c of wanted) {
      const uri = this.keys.get(`${c.pattern.id}:${c.key.toUpperCase()}`)?.uri
      if (uri && !out.includes(uri)) out.push(uri)
    }
    return out
  }

  /** The agent sessions registered for a pull request's branch. */
  async sessionsFor(
    data: GhCollections,
    repoFull: string,
    head: string,
    headSha: string,
    commits?: () => Promise<string[]>,
  ): Promise<string[]> {
    if (!head) return []
    const page = await data.branchLinks.find({ where: { branch: head } as never, limit: 100 })
    const out: string[] = []
    for (const l of page.rows as Rows[]) {
      if (l.repo && String(l.repo).toLowerCase() !== repoFull.toLowerCase()) continue
      // By branch name; when the session said which commit it left on the branch, that commit must be the
      // pull request's head or one of its commits (the session's work is in it).
      if (l.headSha && l.headSha !== headSha) {
        const shas = (await commits?.()) ?? []
        if (!shas.some((s) => s === l.headSha || s.startsWith(String(l.headSha)))) continue
      }
      if (!out.includes(l.session)) out.push(l.session)
    }
    return out
  }
}
