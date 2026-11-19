// /workbench/review/<env>/<path>?base=&head=&turns=&kind=: reviewing changes without leaving Crow. The range
// can be the working tree, the index, a branch against its base, two refs, or an agent session's turns one
// by one (turns: the checkpoint refs from base to head). Files are marked viewed, hunks and lines staged,
// files opened in the workbench to edit, then committed, pushed, and a pull request opened, all from here.

import { Button, Callout, Checkbox, EmptyState, IconButton, Tabs, TextField } from "@aiviarium/nocturne"
import type { ClientRookery, ViewHandle } from "@rookery/sdk/client"
import { createMemo, createResource, createSignal, Match, onCleanup, onMount, Show, Switch } from "solid-js"
import type { DiffSpec, WsInfo } from "../api"
import { Workspace } from "../workspace"
import { EMPTY_TREE } from "./DiffTab"
import { parseWorkspacePath, workspacePath } from "./Home"
import { ReviewBody } from "./Review"
import { PullRequestDialog } from "./ScmPanel"
import { syncAction } from "./sync"

export default function ReviewView(props: { rookery: ClientRookery; view: ViewHandle }) {
  const where = createMemo(() => parseWorkspacePath(props.view.path))
  const [info] = createResource(where, (w) =>
    props.rookery.host.call<WsInfo>("ws.info", { env: w.env, path: w.path }),
  )
  return (
    <Switch>
      <Match when={info.error}>
        <EmptyState
          icon="layers"
          title="Nothing to review here"
          description={`${where().env}:${where().path} · ${(info.error as Error)?.message}`}
        />
      </Match>
      <Match when={info()} keyed>
        {(i) => <Review rookery={props.rookery} view={props.view} info={i} />}
      </Match>
      <Match when={true}>
        <EmptyState icon="layers" title="Opening the review" />
      </Match>
    </Switch>
  )
}

type Range = { id: string; label: string; spec: DiffSpec }

/** A long path as its last two folders. */
const shortPath = (p: string) => {
  const parts = p.split("/").filter(Boolean)
  return parts.length > 3 ? `…/${parts.slice(-2).join("/")}` : p
}

function Review(props: { rookery: ClientRookery; view: ViewHandle; info: WsInfo }) {
  const rookery = props.rookery
  const w = new Workspace(rookery, props.info)
  onCleanup(() => w.dispose())
  const params = props.view.params
  const name = props.info.root.split("/").filter(Boolean).pop()
  props.view.setTitle(params.title ?? `Review ${name}`)
  // Side by side when there is room for it, unless the user chose.
  const [chosen, setMode] = createSignal<"split" | "unified" | null>(null)
  const [narrow, setNarrow] = createSignal(matchMedia("(max-width: 720px)").matches)
  const mode = () => chosen() ?? (narrow() ? "unified" : "split")
  let root!: HTMLDivElement
  onMount(() => {
    const ro = new ResizeObserver(() => setNarrow(root.clientWidth < 900))
    ro.observe(root)
    // On a phone frames stack taller than the screen: fit the view to what shows of the shell's main area,
    // so the diffs scroll inside it and the commit bar stays on screen.
    const phone = matchMedia("(max-width: 720px)")
    const fit = () => {
      const main = root.closest("main")
      if (!phone.matches || !main) {
        root.style.height = ""
        root.style.flex = ""
        return
      }
      root.style.flex = "none"
      const h =
        Math.min(main.getBoundingClientRect().bottom, window.innerHeight) - root.getBoundingClientRect().top
      root.style.height = `${Math.max(320, Math.floor(h))}px`
    }
    fit()
    window.addEventListener("resize", fit)
    phone.addEventListener("change", fit)
    onCleanup(() => {
      ro.disconnect()
      window.removeEventListener("resize", fit)
      phone.removeEventListener("change", fit)
    })
  })
  const turns = (params.turns ?? "").split(",").filter(Boolean)
  const [branchBase] = createResource(async () => {
    await w.refreshStatus()
    const up = w.status()?.branch.upstream
    for (const cand of [params.base, up, "origin/main", "origin/master", "main", "master"]) {
      if (!cand || cand === w.status()?.branch.head) continue
      const sha = await w.api.git.mergeBase(w.env, w.root, cand, "HEAD").catch(() => null)
      if (sha) return { ref: cand, sha }
    }
    return null
  })

  const ranges = createMemo<Range[]>(() => {
    const out: Range[] = []
    if (turns.length && params.base) {
      out.push({
        id: "all",
        label: `All ${turns.length} turns`,
        spec: { kind: "range", base: params.base, head: turns[turns.length - 1] },
      })
      let prev = params.base
      turns.forEach((t, i) => {
        out.push({
          id: `turn-${i + 1}`,
          label: `Turn ${i + 1}`,
          spec: { kind: "range", base: prev, head: t },
        })
        prev = t
      })
    } else if (params.base && params.head) {
      out.push({
        id: "range",
        label: `${shortRef(params.base)}…${shortRef(params.head)}`,
        spec: { kind: "range", base: params.base, head: params.head },
      })
    }
    out.push({ id: "unstaged", label: "Unstaged", spec: { kind: "unstaged" } })
    out.push({ id: "staged", label: "Staged", spec: { kind: "staged" } })
    out.push({ id: "worktree", label: "All uncommitted", spec: { kind: "worktree", base: "HEAD" } })
    const bb = branchBase()
    if (bb)
      out.push({
        id: "branch",
        label: `Branch vs ${shortRef(bb.ref)}`,
        spec: { kind: "worktree", base: bb.sha },
      })
    return out
  })
  const initial = () => {
    if (turns.length && params.base) return "all"
    if (params.base && params.head) return "range"
    if (params.kind === "staged" || params.kind === "unstaged" || params.kind === "branch") return params.kind
    return "worktree"
  }
  const [active, setActive] = createSignal(initial())
  const range = createMemo(() => ranges().find((r) => r.id === active()) ?? ranges()[0]!)
  const [nonce, setNonce] = createSignal(0)
  const [message, setMessage] = createSignal("")
  const [signoff, setSignoff] = createSignal(false)
  const [pr, setPr] = createSignal(false)
  const [busy, setBusy] = createSignal<string | null>(null)
  const [done, setDone] = createSignal<string | null>(null)

  onMount(async () => {
    await Promise.all([w.refreshStatus(), w.initSettings()])
    setSignoff(w.settings().signOff)
  })

  const open = (path: string, line?: number) =>
    rookery.workbench.openView("workbench.open", {
      path: workspacePath(w.env, w.root),
      params: { file: path, ...(line ? { line: String(line) } : {}) },
    })

  const commit = async () => {
    setBusy("commit")
    try {
      const staged = (w.status()?.entries ?? []).some(
        (e) => (e.kind === "changed" || e.kind === "renamed") && e.x !== ".",
      )
      if (!staged) await w.api.git.stage(w.env, w.root, [])
      const r = await w.api.git.commit(w.env, w.root, { message: message(), signoff: signoff() })
      setMessage("")
      setDone(`Committed ${r.sha.slice(0, 7)}`)
      await w.refreshStatus()
      setNonce(nonce() + 1)
    } catch (e) {
      rookery.workbench.toast({ title: "The commit failed", body: (e as Error).message, kind: "danger" })
    } finally {
      setBusy(null)
    }
  }

  const changes = () => (w.status()?.entries ?? []).filter((e) => e.kind !== "ignored").length
  const b = () => w.status()?.branch

  return (
    <div ref={root} class="wb-reviewview" data-part="review-view" data-env={w.env} data-root={w.root}>
      <header class="wb-reviewview__head">
        <div class="wb-reviewview__title">
          <span class="heading">{params.title ?? `Review ${name}`}</span>
          <span class="mono caption nc-muted" title={`${w.env}:${w.root}`}>
            {w.env}:{shortPath(w.root)}
            {b()?.head ? ` · ${b()!.head}` : ""}
          </span>
        </div>
        <span class="wb-head__spacer" />
        <IconButton
          label={mode() === "split" ? "Unified" : "Side by side"}
          icon="sidebar"
          pressed={mode() === "split"}
          onClick={() => setMode(mode() === "split" ? "unified" : "split")}
        />
        <IconButton
          label="Refresh"
          icon="activity"
          onClick={() => {
            w.refreshStatus()
            setNonce(nonce() + 1)
          }}
        />
        <Button
          size="sm"
          variant="ghost"
          icon="edit"
          onClick={() => rookery.workbench.openView("workbench.open", { path: workspacePath(w.env, w.root) })}
        >
          Open in workbench
        </Button>
      </header>
      <div class="wb-reviewview__ranges">
        <Tabs
          label="What to review"
          variant="underline"
          items={ranges().map((r) => ({ id: r.id, label: r.label }))}
          value={range().id}
          onChange={setActive}
        />
      </div>
      <div class="wb-reviewview__body">
        <Show when={`${range().id}:${nonce()}`} keyed>
          {(_key) => (
            <ReviewBody
              api={w.api}
              rookery={rookery}
              env={w.env}
              root={w.root}
              spec={
                range().spec.kind === "range" && range().spec.base === ""
                  ? { ...range().spec, base: EMPTY_TREE }
                  : range().spec
              }
              editable={range().spec.kind === "unstaged" || range().spec.kind === "staged"}
              onOpen={open}
              onChanged={() => w.refreshStatus()}
              mode={mode()}
              viewedKey={`viewed:${w.env}:${w.root}:${range().spec.kind}:${range().spec.base ?? ""}:${range().spec.head ?? ""}`}
            />
          )}
        </Show>
      </div>
      <footer class="wb-reviewview__foot" data-part="review-commit">
        <Show when={done()}>
          <Callout
            tone="info"
            action={<IconButton label="Dismiss" icon="close" onClick={() => setDone(null)} />}
          >
            {done()}
          </Callout>
        </Show>
        <div class="wb-reviewview__commit">
          <TextField
            aria-label="Commit message"
            placeholder={changes() ? `Commit message (${changes()} changed files)` : "No uncommitted changes"}
            value={message()}
            onInput={(e) => setMessage(e.currentTarget.value)}
            onKeyDown={(e) => e.key === "Enter" && (e.ctrlKey || e.metaKey) && message().trim() && commit()}
            data-part="review-message"
          />
          <Checkbox label="Sign off" checked={signoff()} onChange={setSignoff} />
          <Button
            variant="primary"
            disabled={!message().trim() || !changes()}
            loading={busy() === "commit"}
            onClick={commit}
            data-part="review-commit-button"
          >
            Commit
          </Button>
          <Button
            variant="secondary"
            loading={w.syncing() === "push"}
            disabled={!b()?.head}
            onClick={async () => {
              if (await syncAction(w, "push")) setDone(`Pushed ${b()?.head}`)
            }}
            data-part="review-push"
          >
            Push{b()?.ahead ? ` ↑${b()!.ahead}` : ""}
          </Button>
          <Button
            variant="ghost"
            icon="arrow-up-right"
            disabled={!b()?.head}
            onClick={() => setPr(true)}
            data-part="review-pr"
          >
            Pull request
          </Button>
        </div>
      </footer>
      <PullRequestDialog
        w={w}
        open={pr()}
        onClose={() => setPr(false)}
        base={branchBase()?.ref.replace(/^origin\//, "")}
      />
    </div>
  )
}

/** A commit as people read it: seven characters of a hash (keeping a `^` or `~2` after it), a branch by its name. */
function shortRef(ref: string): string {
  const m = /^([0-9a-f]{12,40})([~^].*)?$/i.exec(ref.trim())
  return m ? `${m[1]!.slice(0, 7)}${m[2] ?? ""}` : ref.trim()
}
