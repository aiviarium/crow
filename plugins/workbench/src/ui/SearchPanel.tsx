// Search across the workspace with ripgrep, or git grep where ripgrep is missing, run on the host with
// env.exec and parsed here. Include and exclude globs, regex, case and whole word; replace in one file or
// all, after a preview of every change.
import { Button, Dialog, DiffView, Icon, IconButton, TextField } from "@aiviarium/nocturne"
import { createSignal, For, Show } from "solid-js"
import { type RunningProcess, runProcess } from "../api"
import type { FileMatches, SearchQuery } from "../git/search"
import { GitGrepParser, gitGrepCommand, matcher, RgParser, rgCommand } from "../git/search"
import type { Workspace } from "../workspace"

const MAX = 5000

export function SearchPanel(props: { w: Workspace }) {
  const w = props.w
  const [query, setQuery] = createSignal("")
  const [replacement, setReplacement] = createSignal("")
  const [showReplace, setShowReplace] = createSignal(false)
  const [regex, setRegex] = createSignal(false)
  const [caseSensitive, setCase] = createSignal(false)
  const [word, setWord] = createSignal(false)
  const [include, setInclude] = createSignal("")
  const [exclude, setExclude] = createSignal("")
  const [showGlobs, setShowGlobs] = createSignal(false)
  const [results, setResults] = createSignal<FileMatches[]>([])
  const [running, setRunning] = createSignal(false)
  const [summary, setSummary] = createSignal<string | null>(null)
  const [collapsed, setCollapsed] = createSignal<Record<string, boolean>>({})
  const [preview, setPreview] = createSignal<Array<{
    path: string
    count: number
    before?: string
    after?: string
    error?: string
  }> | null>(null)
  let proc: RunningProcess | null = null
  let timer: ReturnType<typeof setTimeout> | undefined

  const q = (): SearchQuery => ({
    query: query(),
    regex: regex(),
    caseSensitive: caseSensitive(),
    wholeWord: word(),
    include: include()
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean),
    exclude: exclude()
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean),
  })

  async function search() {
    proc?.kill()
    proc = null
    const sq = q()
    if (!sq.query) {
      setResults([])
      setSummary(null)
      return
    }
    if (sq.regex) {
      try {
        matcher(sq)
      } catch (e) {
        setSummary(`Not a valid regular expression: ${(e as Error).message}`)
        return
      }
    }
    setResults([])
    setRunning(true)
    setSummary(null)
    const t0 = performance.now()
    const rg = !!w.info.tools.rg
    const collected: FileMatches[] = []
    let count = 0
    let truncated = false
    const flush = (files: FileMatches[]) => {
      if (!files.length) return
      for (const f of files) {
        count += f.matches.length
        collected.push(f)
      }
      setResults([...collected])
      if (count >= MAX && proc) {
        truncated = true
        proc.kill()
      }
    }
    try {
      const rgp = new RgParser()
      const ggp = new GitGrepParser(matcher(sq))
      const mine = await runProcess(w.rookery, {
        env: w.env,
        cwd: w.root,
        command: rg ? rgCommand(sq) : gitGrepCommand(sq),
        onStdout: (t) => flush(rg ? rgp.push(t) : ggp.push(t)),
      })
      proc = mine
      const r = await mine.done
      if (proc !== mine) return
      if (!rg) flush(ggp.end())
      setRunning(false)
      proc = null
      const ms = Math.round(performance.now() - t0)
      if (r.exitCode !== null && r.exitCode > 1 && !collected.length)
        setSummary((r.stderr || `exited ${r.exitCode}`).trim().split("\n")[0]!)
      else
        setSummary(
          `${count} result${count === 1 ? "" : "s"} in ${collected.length} file${collected.length === 1 ? "" : "s"}${truncated ? ` (stopped at ${MAX})` : ""} · ${rg ? "ripgrep" : "git grep"} · ${ms} ms`,
        )
    } catch (e) {
      setRunning(false)
      proc = null
      setSummary((e as Error).message)
    }
  }

  const schedule = () => {
    clearTimeout(timer)
    timer = setTimeout(search, 250)
  }

  async function replace(paths: Array<{ path: string; matches?: FileMatches["matches"] }>, dryRun: boolean) {
    const r = await w.api.replace(w.env, w.root, q(), replacement(), paths, dryRun)
    if (dryRun) {
      setPreview(r.results.filter((x) => x.count || x.error))
      return
    }
    const failed = r.results.filter((x) => x.error)
    const done = r.results.reduce((n, x) => n + x.count, 0)
    w.rookery.workbench.toast({
      title: `Replaced ${done} occurrence${done === 1 ? "" : "s"}`,
      body: failed.length
        ? `Not changed: ${failed.map((f) => `${f.path} (${f.conflict ? "changed meanwhile" : f.error})`).join(", ")}`
        : undefined,
      kind: failed.length ? "warning" : "success",
    })
    setPreview(null)
    await w.refresh()
    search()
  }

  const toggle = (on: () => boolean, set: (v: boolean) => void, label: string, text: string) => (
    <button
      type="button"
      class="wb-toggle mono"
      aria-pressed={on()}
      title={label}
      aria-label={label}
      onClick={() => {
        set(!on())
        schedule()
      }}
    >
      {text}
    </button>
  )

  return (
    <div class="wb-panel" data-part="search-panel">
      <div class="wb-panel__head">
        <span class="label wb-panel__title">Search</span>
        <IconButton
          label={showReplace() ? "Hide replace" : "Replace"}
          icon="edit"
          pressed={showReplace()}
          onClick={() => setShowReplace(!showReplace())}
        />
        <IconButton
          label="Files to include and exclude"
          icon="filter"
          pressed={showGlobs()}
          onClick={() => setShowGlobs(!showGlobs())}
        />
        <IconButton label="Search again" icon="activity" onClick={search} />
      </div>
      <form
        class="wb-search"
        onSubmit={(e) => {
          e.preventDefault()
          search()
        }}
      >
        <div class="wb-search__row">
          <TextField
            aria-label="Search"
            placeholder="Search"
            mono
            value={query()}
            onInput={(e) => {
              setQuery(e.currentTarget.value)
              schedule()
            }}
            data-part="search-input"
          />
          <span class="wb-search__toggles">
            {toggle(caseSensitive, setCase, "Match case", "Aa")}
            {toggle(word, setWord, "Whole word", "ab")}
            {toggle(regex, setRegex, "Regular expression", ".*")}
          </span>
        </div>
        <Show when={showReplace()}>
          <div class="wb-search__row">
            <TextField
              aria-label="Replace"
              placeholder="Replace"
              mono
              value={replacement()}
              onInput={(e) => setReplacement(e.currentTarget.value)}
              data-part="replace-input"
            />
            <Button
              size="sm"
              disabled={!results().length}
              onClick={() =>
                replace(
                  results().map((f) => ({ path: f.path })),
                  true,
                )
              }
            >
              Replace all…
            </Button>
          </div>
        </Show>
        <Show when={showGlobs()}>
          <TextField
            aria-label="Files to include"
            placeholder="Include: src/**, *.ts"
            mono
            value={include()}
            onInput={(e) => {
              setInclude(e.currentTarget.value)
              schedule()
            }}
          />
          <TextField
            aria-label="Files to exclude"
            placeholder="Exclude: *.test.ts, dist/**"
            mono
            value={exclude()}
            onInput={(e) => {
              setExclude(e.currentTarget.value)
              schedule()
            }}
          />
        </Show>
      </form>
      <Show when={summary() || running()}>
        <p class="caption nc-muted wb-panel__note" data-part="search-summary">
          {running() ? `Searching… ${results().length} files so far` : summary()}
        </p>
      </Show>
      <div class="wb-results" role="tree" aria-label="Search results">
        <For each={results()}>
          {(f) => (
            <div class="wb-results__file" data-result-file={f.path}>
              <div class="wb-results__head">
                <button
                  type="button"
                  class="wb-results__toggle"
                  onClick={() => setCollapsed({ ...collapsed(), [f.path]: !collapsed()[f.path] })}
                >
                  <Icon name={collapsed()[f.path] ? "chevron-right" : "chevron-down"} size="sm" />
                  <span class="wb-results__name">{f.path.split("/").pop()}</span>
                  <span class="caption nc-muted wb-results__dir">
                    {f.path.includes("/") ? f.path.slice(0, f.path.lastIndexOf("/")) : ""}
                  </span>
                  <span class="nc-count">{f.matches.length}</span>
                </button>
                <Show when={showReplace()}>
                  <IconButton
                    label={`Replace in ${f.path}`}
                    icon="edit"
                    onClick={() => replace([{ path: f.path }], true)}
                  />
                </Show>
              </div>
              <Show when={!collapsed()[f.path]}>
                <For each={f.matches.slice(0, 200)}>
                  {(m) => {
                    const text = f.lines[m.line] ?? ""
                    const start = Math.max(0, m.col - 30)
                    return (
                      <button
                        type="button"
                        class="wb-results__match mono"
                        data-match={`${f.path}:${m.line}:${m.col}`}
                        onClick={() => w.openFile(f.path, { line: m.line, col: m.col + 1 })}
                      >
                        <span class="nc-muted wb-results__line">{m.line}</span>
                        <span class="wb-results__text">
                          {start > 0 ? "…" : ""}
                          {text.slice(start, m.col)}
                          <mark class="wb-results__hit">{text.slice(m.col, m.col + m.length)}</mark>
                          {text.slice(m.col + m.length, m.col + m.length + 80)}
                        </span>
                      </button>
                    )
                  }}
                </For>
              </Show>
            </div>
          )}
        </For>
      </div>
      <Dialog
        open={!!preview()}
        onClose={() => setPreview(null)}
        title="Replace"
        description={`${preview()?.reduce((n, x) => n + x.count, 0) ?? 0} occurrences of “${query()}” with “${replacement()}” in ${preview()?.length ?? 0} files`}
        size="lg"
        footer={
          <>
            <Button variant="ghost" onClick={() => setPreview(null)}>
              Cancel
            </Button>
            <Button
              variant="primary"
              data-part="confirm-replace"
              onClick={() =>
                replace(
                  (preview() ?? []).map((p) => ({ path: p.path })),
                  false,
                )
              }
            >
              Replace
            </Button>
          </>
        }
      >
        <div class="wb-replace-preview" data-part="replace-preview">
          <For each={preview() ?? []}>
            {(p) => (
              <Show
                when={p.before !== undefined}
                fallback={
                  <p class="body nc-muted">
                    {p.path}: {p.error}
                  </p>
                }
              >
                <DiffView before={p.before} after={p.after} path={p.path} context={1} />
              </Show>
            )}
          </For>
        </div>
      </Dialog>
    </div>
  )
}
