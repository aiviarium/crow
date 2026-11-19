// Source control: the branch and its sync state, merge or rebase in progress, the commit box (amend,
// sign-off), conflicts, staged and unstaged changes with stage, unstage and discard per file, stashes, and
// opening a pull request. Everything is git run on the environment.
import {
  Badge,
  Button,
  Callout,
  Checkbox,
  ContextMenu,
  Dialog,
  Icon,
  IconButton,
  List,
  TextField,
  Switch as Toggle,
} from "@aiviarium/nocturne"
import { createEffect, createMemo, createResource, createSignal, For, on, Show } from "solid-js"
import type { Ref, Stash } from "../git/log"
import { isConflict, isStaged, isUnstaged, type StatusEntry } from "../git/status"
import type { Workspace } from "../workspace"
import { confirmAction, promptText } from "./prompt"
import { syncAction } from "./sync"

const name = (p: string) => p.replace(/\/$/, "").split("/").pop() ?? p
const dir = (p: string) => {
  const t = p.replace(/\/$/, "")
  return t.includes("/") ? t.slice(0, t.lastIndexOf("/")) : ""
}

export function ScmPanel(props: { w: Workspace; command: { id: string; at: number } | null }) {
  const w = props.w
  const [message, setMessage] = createSignal("")
  const [amend, setAmend] = createSignal(false)
  const [signoff, setSignoff] = createSignal(w.settings().signOff)
  const [busy, setBusy] = createSignal<string | null>(null)
  const [branches, setBranches] = createSignal(false)
  const [pr, setPr] = createSignal(false)
  const [showStashes, setShowStashes] = createSignal(false)
  const [stashes, { refetch: refetchStashes }] = createResource(
    () => (showStashes() ? w.status()?.stash : undefined),
    async () => (await w.api.git.stash(w.env, w.root, { op: "list" })).stashes ?? [],
  )
  let box!: HTMLTextAreaElement

  const entries = () => w.status()?.entries ?? []
  const conflicts = createMemo(() => entries().filter(isConflict))
  const staged = createMemo(() => entries().filter(isStaged))
  const unstaged = createMemo(() => entries().filter((e) => isUnstaged(e) || e.kind === "untracked"))

  createEffect(
    on(
      () => props.command,
      async (c) => {
        if (!c) return
        if (c.id === "workbench.commit") box?.focus()
        if (c.id === "workbench.stageAll") stage(unstaged())
        if (c.id === "workbench.stash") stash()
        if (c.id === "workbench.switchBranch") setBranches(true)
        if (c.id === "workbench.newBranch") newBranch()
        if (c.id === "workbench.openPullRequest") setPr(true)
      },
    ),
  )

  createEffect(
    on(amend, async (on) => {
      if (on && !message().trim()) setMessage(await w.api.git.lastMessage(w.env, w.root))
    }),
  )

  async function act<T>(label: string, f: () => Promise<T>): Promise<T | undefined> {
    setBusy(label)
    try {
      return await f()
    } catch (e) {
      w.rookery.workbench.toast({ title: `${label} failed`, body: (e as Error).message, kind: "danger" })
      return undefined
    } finally {
      setBusy(null)
      await w.refreshStatus()
    }
  }

  const stage = (list: StatusEntry[]) =>
    act("Staging", () =>
      w.api.git.stage(
        w.env,
        w.root,
        list.map((e) => e.path),
      ),
    )
  const unstage = (list: StatusEntry[]) =>
    act("Unstaging", () =>
      w.api.git.unstage(
        w.env,
        w.root,
        list.map((e) => e.path),
      ),
    )
  async function discard(list: StatusEntry[]) {
    const ok = await confirmAction({
      title:
        list.length === 1
          ? `Discard changes to ${name(list[0]!.path)}?`
          : `Discard changes to ${list.length} files?`,
      body: "The working tree goes back to what is staged or committed. Untracked files are deleted. This cannot be undone.",
      confirm: "Discard",
      danger: true,
    })
    if (!ok) return
    const untracked = list.filter((e) => e.kind === "untracked").map((e) => e.path)
    const tracked = list.filter((e) => e.kind !== "untracked").map((e) => e.path)
    await act("Discarding", () => w.api.git.discard(w.env, w.root, tracked, untracked))
    await w.refresh()
  }

  async function commit(all = false) {
    // Unsaved buffers are not in the commit; say so instead of committing something else than what shows.
    const dirty = w.dirtyPaths()
    if (
      dirty.length &&
      !(await confirmAction({
        title: "Save before committing?",
        body: `${dirty.join(", ")} ${dirty.length === 1 ? "has" : "have"} unsaved changes.`,
        confirm: "Save and commit",
      }))
    )
      return
    for (const p of dirty) await w.save(p)
    const r = await act("Committing", async () => {
      // "Commit all" takes new files too, as a review of an agent's work expects.
      if (!all && !staged().length && !amend()) await w.api.git.stage(w.env, w.root, [])
      return w.api.git.commit(w.env, w.root, {
        message: message(),
        amend: amend(),
        signoff: signoff(),
        all,
      })
    })
    if (r) {
      setMessage("")
      setAmend(false)
      w.rookery.workbench.toast({ title: `Committed ${r.sha.slice(0, 7)}`, kind: "success" })
    }
  }

  async function stash() {
    const m = await promptText({
      title: "Stash changes",
      label: "Message (optional)",
      confirm: "Stash",
      value: "",
    }).catch(() => null)
    if (m === null) return
    await act("Stashing", () => w.api.git.stash(w.env, w.root, { op: "push", message: m || undefined }))
    await w.refresh()
    refetchStashes()
  }

  async function newBranch(start?: string) {
    const n = await promptText({
      title: "Create a branch",
      label: start ? `From ${start}` : "From the current commit",
      confirm: "Create and switch",
      mono: true,
    })
    if (!n) return
    await act("Creating the branch", () => w.api.git.branch(w.env, w.root, { op: "create", name: n, start }))
    setBranches(false)
  }

  const integrate = (action: "continue" | "abort" | "skip") =>
    act(`${action} the ${w.status()?.state}`, async () => {
      const r = await w.api.git.integrate(w.env, w.root, {
        op: (w.status()!.state ?? "merge") as "merge",
        action,
      })
      if (r.conflicts)
        w.rookery.workbench.toast({
          title: "Conflicts remain",
          body: r.output.split("\n").slice(-3).join("\n"),
          kind: "warning",
        })
    }).then(() => w.refresh())

  const b = () => w.status()?.branch
  const openChange = (e: StatusEntry, section: "staged" | "unstaged" | "conflict") => {
    if (section === "conflict")
      w.openTab({
        id: `conflict:${e.path}`,
        kind: "conflict",
        title: `${name(e.path)} (merge)`,
        path: e.path,
      })
    else if (
      e.kind === "untracked" ||
      (section === "unstaged" && e.y === "D") ||
      (section === "staged" && e.x === "D")
    ) {
      if (e.kind === "untracked") w.openFile(e.path.replace(/\/$/, ""))
      else w.openDiff(e.path, section)
    } else w.openDiff(e.path, section)
  }
  const row = (e: StatusEntry, section: "staged" | "unstaged" | "conflict") => (
    // biome-ignore lint/a11y/useSemanticElements: a row with buttons inside cannot be a button itself
    <div
      class="wb-change"
      role="button"
      tabIndex={0}
      data-change={e.path}
      data-section={section}
      onClick={() => openChange(e, section)}
      onKeyDown={(ev) => {
        if (ev.key === "Enter" && ev.target === ev.currentTarget) openChange(e, section)
      }}
    >
      <span
        class="wb-change__letter mono"
        data-letter={
          section === "staged" ? e.x : section === "conflict" ? "!" : e.kind === "untracked" ? "U" : e.y
        }
      >
        {section === "staged" ? e.x : section === "conflict" ? "!" : e.kind === "untracked" ? "U" : e.y}
      </span>
      <span class="wb-change__name">{name(e.path)}</span>
      <span class="wb-change__dir caption nc-muted">{e.orig ? `${e.orig} →` : dir(e.path)}</span>
      <span class="wb-change__actions" onClick={(ev) => ev.stopPropagation()}>
        <Show
          when={
            section !== "conflict" &&
            e.kind !== "untracked" &&
            !(section === "staged" ? e.x === "D" : e.y === "D")
          }
        >
          <IconButton label={`Open ${name(e.path)}`} icon="file" onClick={() => w.openFile(e.path)} />
        </Show>
        <Show when={section === "unstaged"}>
          <IconButton label={`Discard ${name(e.path)}`} icon="trash" onClick={() => discard([e])} />
        </Show>
        <Show
          when={section === "staged"}
          fallback={<IconButton label={`Stage ${name(e.path)}`} icon="plus" onClick={() => stage([e])} />}
        >
          <IconButton label={`Unstage ${name(e.path)}`} icon="close" onClick={() => unstage([e])} />
        </Show>
      </span>
    </div>
  )

  return (
    <div class="wb-panel" data-part="scm-panel">
      <div class="wb-panel__head">
        <span class="label wb-panel__title">Source control</span>
        <IconButton
          label="History"
          icon="clock"
          onClick={() => w.openTab({ id: "history", kind: "history", title: "History" })}
        />
        <IconButton
          label="Review all changes"
          icon="check"
          onClick={() =>
            w.rookery.commands.run("workbench.review", {
              env: w.env,
              path: w.root,
              kind: "worktree",
              base: "HEAD",
            })
          }
        />
        <IconButton label="Stash" icon="archive" onClick={stash} />
        <IconButton label="Refresh" icon="activity" onClick={() => w.refresh()} />
      </div>

      <Show when={!w.info.isRepo}>
        <p class="body nc-muted wb-panel__note">This folder is not a git repository.</p>
      </Show>

      <Show when={b()}>
        <div class="wb-scm__branch">
          <button
            type="button"
            class="wb-scm__branch-name mono"
            data-part="branch-button"
            onClick={() => setBranches(true)}
          >
            <Icon name="branch" size="sm" />
            {b()!.head ?? `detached at ${b()!.oid?.slice(0, 7)}`}
            <Icon name="chevron-down" size="sm" />
          </button>
          <span class="wb-head__spacer" />
          <Button
            size="sm"
            variant="ghost"
            loading={w.syncing() === "pull"}
            onClick={() => syncAction(w, "pull")}
            title={b()!.upstream ? `Pull from ${b()!.upstream}` : "Pull"}
            data-part="pull"
          >
            ↓{b()!.behind || ""}
          </Button>
          <Button
            size="sm"
            variant="ghost"
            loading={w.syncing() === "push"}
            onClick={() => syncAction(w, "push")}
            title={b()!.upstream ? `Push to ${b()!.upstream}` : "Push and set the upstream"}
            data-part="push"
          >
            ↑{b()!.ahead || ""}
          </Button>
          <IconButton label="Fetch" icon="activity" onClick={() => syncAction(w, "fetch")} />
        </div>
        <Show when={!b()!.upstream && b()!.head}>
          <p class="caption nc-muted wb-panel__note">No upstream: pushing sets one.</p>
        </Show>
      </Show>

      <Show when={w.status()?.state}>
        <Callout tone="warning" class="wb-scm__state">
          A {w.status()!.state} is in progress.{" "}
          {conflicts().length
            ? `Resolve ${conflicts().length} conflict${conflicts().length === 1 ? "" : "s"}, then continue.`
            : "No conflicts left: continue it."}
          <div class="wb-scm__state-actions">
            <Button
              size="sm"
              variant="primary"
              disabled={conflicts().length > 0}
              onClick={() => integrate("continue")}
              data-part="continue"
            >
              Continue
            </Button>
            <Show when={w.status()?.state === "rebase"}>
              <Button size="sm" onClick={() => integrate("skip")}>
                Skip
              </Button>
            </Show>
            <Button size="sm" variant="ghost" onClick={() => integrate("abort")}>
              Abort
            </Button>
          </div>
        </Callout>
      </Show>

      <div class="wb-commit" data-part="commit-box">
        <textarea
          ref={box}
          class="nc-textarea wb-commit__message"
          rows={3}
          placeholder={
            staged().length
              ? `Message (${staged().length} staged)`
              : "Message (commits all changes when nothing is staged)"
          }
          aria-label="Commit message"
          value={message()}
          onInput={(e) => setMessage(e.currentTarget.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) {
              e.preventDefault()
              commit()
            }
          }}
        />
        <div class="wb-commit__row">
          <Checkbox label="Amend" checked={amend()} onChange={setAmend} />
          <Checkbox label="Sign off" checked={signoff()} onChange={setSignoff} />
          <span class="wb-head__spacer" />
          <Button
            variant="primary"
            size="sm"
            loading={busy() === "Committing"}
            disabled={
              (!message().trim() && !amend()) ||
              (!staged().length && !unstaged().length && !amend()) ||
              conflicts().length > 0
            }
            onClick={() => commit()}
            data-part="commit"
          >
            {amend() ? "Amend" : staged().length ? "Commit" : "Commit all"}
          </Button>
        </div>
      </div>

      <div class="wb-changes">
        <Show when={conflicts().length}>
          <Section title="Merge conflicts" count={conflicts().length} tone="danger">
            <For each={conflicts()}>{(e) => row(e, "conflict")}</For>
          </Section>
        </Show>
        <Show when={staged().length}>
          <Section
            title="Staged changes"
            count={staged().length}
            actions={<IconButton label="Unstage all" icon="close" onClick={() => unstage(staged())} />}
          >
            <For each={staged()}>{(e) => row(e, "staged")}</For>
          </Section>
        </Show>
        <Section
          title="Changes"
          count={unstaged().length}
          actions={
            <>
              <IconButton
                label="Discard all"
                icon="trash"
                onClick={() => unstaged().length && discard(unstaged())}
              />
              <IconButton label="Stage all" icon="plus" onClick={() => stage(unstaged())} />
            </>
          }
        >
          <For each={unstaged()} fallback={<p class="caption nc-muted wb-panel__note">No changes.</p>}>
            {(e) => row(e, "unstaged")}
          </For>
        </Section>
        <Show when={(w.status()?.stash ?? 0) > 0}>
          <Section
            title="Stashes"
            count={w.status()!.stash}
            collapsed={!showStashes()}
            onToggle={() => setShowStashes(!showStashes())}
          >
            <For each={stashes() ?? []}>
              {(s: Stash) => {
                const drop = async () => {
                  if (
                    await confirmAction({
                      title: `Drop ${s.ref}?`,
                      body: s.message,
                      confirm: "Drop",
                      danger: true,
                    })
                  )
                    act("Dropping", () => w.api.git.stash(w.env, w.root, { op: "drop", ref: s.ref })).then(
                      () => refetchStashes(),
                    )
                }
                return (
                  <ContextMenu
                    label={s.ref}
                    items={() => [{ id: "drop", label: "Drop", icon: "trash", danger: true }]}
                    onSelect={() => void drop()}
                  >
                    <div
                      class="wb-change"
                      data-stash={s.ref}
                      onKeyDown={(e) => {
                        if (e.key === "Delete" || e.key === "Backspace") {
                          e.preventDefault()
                          void drop()
                        }
                      }}
                    >
                      <span class="wb-change__letter mono">S</span>
                      <span class="wb-change__name">{s.message}</span>
                      <span class="wb-change__actions">
                        <IconButton
                          label={`Apply ${s.ref}`}
                          icon="check"
                          onClick={() =>
                            act("Applying", () =>
                              w.api.git.stash(w.env, w.root, { op: "apply", ref: s.ref }),
                            ).then(() => w.refresh())
                          }
                        />
                        <IconButton
                          label={`Pop ${s.ref}`}
                          icon="arrow-up-right"
                          onClick={() =>
                            act("Popping", () =>
                              w.api.git.stash(w.env, w.root, { op: "pop", ref: s.ref }),
                            ).then(() => {
                              w.refresh()
                              refetchStashes()
                            })
                          }
                        />
                      </span>
                    </div>
                  </ContextMenu>
                )
              }}
            </For>
          </Section>
        </Show>
      </div>

      <div class="wb-scm__foot">
        <Button
          size="sm"
          variant="secondary"
          icon="arrow-up-right"
          onClick={() => setPr(true)}
          disabled={!b()?.head}
          data-part="open-pr"
        >
          Open a pull request
        </Button>
      </div>

      <BranchPicker w={w} open={branches()} onClose={() => setBranches(false)} onNew={newBranch} />
      <PullRequestDialog w={w} open={pr()} onClose={() => setPr(false)} />
    </div>
  )
}

function Section(props: {
  title: string
  count: number
  tone?: "danger"
  actions?: import("solid-js").JSX.Element
  children: import("solid-js").JSX.Element
  collapsed?: boolean
  onToggle?: () => void
}) {
  const [local, setLocal] = createSignal(false)
  const closed = () => props.collapsed ?? local()
  return (
    <section class="wb-section" data-section-title={props.title}>
      <div class="wb-section__head">
        <button
          type="button"
          class="wb-section__toggle label"
          onClick={() => (props.onToggle ? props.onToggle() : setLocal(!local()))}
        >
          <Icon name={closed() ? "chevron-right" : "chevron-down"} size="sm" />
          {props.title}
          <Badge tone={props.tone ?? "neutral"}>{props.count}</Badge>
        </button>
        <span class="wb-section__actions">{props.actions}</span>
      </div>
      <Show when={!closed()}>{props.children}</Show>
    </section>
  )
}

/** Branches and tags: switch, create, rename, delete, set the upstream, merge or rebase onto one, tag. */
export function BranchPicker(props: {
  w: Workspace
  open: boolean
  onClose: () => void
  onNew: (start?: string) => void
}) {
  const w = props.w
  const [filter, setFilter] = createSignal("")
  const [refs, { refetch }] = createResource(
    () => props.open || undefined,
    () => w.api.git.refs(w.env, w.root),
  )
  const [active, setActive] = createSignal(0)
  const list = createMemo(() => {
    const f = filter().toLowerCase()
    return (refs()?.refs ?? []).filter((r) => !f || r.name.toLowerCase().includes(f))
  })
  const run = async (label: string, f: () => Promise<unknown>) => {
    try {
      await f()
      refetch()
      await w.refresh()
    } catch (e) {
      w.rookery.workbench.toast({ title: `${label} failed`, body: (e as Error).message, kind: "danger" })
    }
  }
  const deletable = (r: Ref) => r.kind === "tag" || (r.kind === "branch" && !r.current)
  const del = async (r: Ref) => {
    if (r.kind === "tag") {
      if (await confirmAction({ title: `Delete tag ${r.name}?`, confirm: "Delete", danger: true }))
        run("Deleting the tag", () => w.api.git.tag(w.env, w.root, { op: "delete", name: r.name }))
      return
    }
    if (
      !(await confirmAction({
        title: `Delete ${r.name}?`,
        body: "Only if it is merged; otherwise git refuses and says so.",
        confirm: "Delete",
        danger: true,
      }))
    )
      return
    run("Deleting", () => w.api.git.branch(w.env, w.root, { op: "delete", name: r.name }))
  }
  const switchTo = (r: Ref) =>
    run("Switching", async () => {
      await w.api.git.branch(w.env, w.root, { op: "switch", name: r.kind === "tag" ? r.name : r.name })
      props.onClose()
    })
  return (
    <Dialog open={props.open} onClose={props.onClose} title="Branches and tags" size="md" placement="top">
      <div class="wb-branches" data-part="branch-picker">
        <div class="nc-row">
          <TextField
            aria-label="Filter branches"
            placeholder="Filter, or a name for a new branch"
            mono
            value={filter()}
            onInput={(e) => setFilter(e.currentTarget.value)}
          />
          <IconButton label="New branch" icon="plus" onClick={() => props.onNew()} data-part="new-branch" />
          <Button
            size="sm"
            icon="tag"
            onClick={async () => {
              const n = await promptText({
                title: "Create a tag",
                label: "At the current commit",
                confirm: "Create",
                mono: true,
              })
              if (n) run("Tagging", () => w.api.git.tag(w.env, w.root, { op: "create", name: n }))
            }}
          >
            Tag
          </Button>
        </div>
        <div
          class="wb-branches__list"
          onKeyDown={(e) => {
            const r = list()[active()]
            if (e.key !== "Delete" || !r || !deletable(r)) return
            e.preventDefault()
            void del(r)
          }}
        >
          <List
            items={list()}
            itemHeight={34}
            label="Branches"
            activeIndex={active()}
            onActiveChange={setActive}
            onSelect={(r) => switchTo(r)}
            getKey={(r) => r.ref}
          >
            {(r) => (
              <ContextMenu
                label={r.name}
                items={() => [
                  {
                    id: "delete",
                    label: r.kind === "tag" ? "Delete tag" : "Delete",
                    icon: "trash",
                    danger: true,
                    disabled: !deletable(r),
                  },
                ]}
                onSelect={() => void del(r)}
              >
                <div class="wb-branch" data-ref={r.ref} data-current={r.current ? "" : undefined}>
                  <Icon name={r.kind === "tag" ? "tag" : "branch"} size="sm" />
                  <span class="mono wb-branch__name">{r.name}</span>
                  <Show when={r.current}>
                    <Badge tone="accent">current</Badge>
                  </Show>
                  <Show when={r.kind === "remote"}>
                    <Badge tone="outline">remote</Badge>
                  </Show>
                  <Show when={r.upstream}>
                    <span class="caption nc-muted">
                      → {r.upstream}
                      {r.ahead ? ` ↑${r.ahead}` : ""}
                      {r.behind ? ` ↓${r.behind}` : ""}
                      {r.gone ? " (gone)" : ""}
                    </span>
                  </Show>
                  <span class="caption nc-muted wb-branch__subject">{r.subject}</span>
                  <span class="wb-branch__actions" onClick={(e) => e.stopPropagation()}>
                    <Show when={!r.current && r.kind !== "tag"}>
                      <IconButton
                        label={`Merge ${r.name} into the current branch`}
                        icon="layers"
                        onClick={() =>
                          run("Merging", async () => {
                            const m = await w.api.git.integrate(w.env, w.root, {
                              op: "merge",
                              action: "start",
                              ref: r.name,
                            })
                            props.onClose()
                            if (m.conflicts)
                              w.rookery.workbench.toast({
                                title: "The merge has conflicts",
                                body: "Resolve them in Source control.",
                                kind: "warning",
                              })
                          })
                        }
                      />
                      <IconButton
                        label={`Rebase the current branch onto ${r.name}`}
                        icon="sort"
                        onClick={() =>
                          run("Rebasing", async () => {
                            const m = await w.api.git.integrate(w.env, w.root, {
                              op: "rebase",
                              action: "start",
                              ref: r.name,
                            })
                            props.onClose()
                            if (m.conflicts)
                              w.rookery.workbench.toast({
                                title: "The rebase stopped at a conflict",
                                body: "Resolve it in Source control.",
                                kind: "warning",
                              })
                          })
                        }
                      />
                    </Show>
                    <Show when={r.kind === "branch"}>
                      <IconButton
                        label={`New branch from ${r.name}`}
                        icon="plus"
                        onClick={() => props.onNew(r.name)}
                      />
                      <IconButton
                        label={`Rename ${r.name}`}
                        icon="edit"
                        onClick={async () => {
                          const n = await promptText({
                            title: `Rename ${r.name}`,
                            label: "New name",
                            value: r.name,
                            confirm: "Rename",
                            mono: true,
                          })
                          if (n)
                            run("Renaming", () =>
                              w.api.git.branch(w.env, w.root, { op: "rename", name: r.name, newName: n }),
                            )
                        }}
                      />
                      <IconButton
                        label={`Set the upstream of ${r.name}`}
                        icon="link"
                        onClick={async () => {
                          const up = await promptText({
                            title: `Upstream of ${r.name}`,
                            label: "A remote branch, e.g. origin/main",
                            value: r.upstream ?? `origin/${r.name}`,
                            confirm: "Set",
                            mono: true,
                          })
                          if (up)
                            run("Setting the upstream", () =>
                              w.api.git.branch(w.env, w.root, {
                                op: "setUpstream",
                                name: r.name,
                                upstream: up,
                              }),
                            )
                        }}
                      />
                    </Show>
                  </span>
                </div>
              </ContextMenu>
            )}
          </List>
        </div>
      </div>
    </Dialog>
  )
}

/**
 * Opening a pull request: the branch is pushed and a provider from `workbench.pullRequestProviders` opens
 * it (the GitHub CLI on the environment is the first; a GitHub plugin with its own API access can take
 * over). Title and body are the user's to edit.
 */
export function PullRequestDialog(props: {
  w: Workspace
  open: boolean
  onClose: () => void
  base?: string
  head?: string
}) {
  const w = props.w
  const [providers] = createResource(
    () => props.open || undefined,
    async () => {
      const list = await w.api.prProviders()
      const checked = await Promise.all(
        list.map(async (p) => {
          if (!p.available) return { ...p, ok: true, reason: "" }
          try {
            const r = await w.rookery.commands.run<{ available: boolean; reason?: string }>(p.available, {
              env: w.env,
              path: w.root,
            })
            return { ...p, ok: !!r?.available, reason: r?.reason ?? "" }
          } catch (e) {
            return { ...p, ok: false, reason: (e as Error).message }
          }
        }),
      )
      return checked
    },
  )
  const [title, setTitle] = createSignal("")
  const [body, setBody] = createSignal("")
  const [base, setBase] = createSignal("")
  const [draft, setDraft] = createSignal(false)
  const [busy, setBusy] = createSignal(false)
  const [result, setResult] = createSignal<{ url?: string | null; message?: string } | null>(null)
  const [error, setError] = createSignal<string | null>(null)
  createEffect(
    on(
      () => props.open,
      async (open) => {
        if (!open) return
        setResult(null)
        setError(null)
        const msg = await w.api.git.lastMessage(w.env, w.root).catch(() => "")
        const [first = "", ...rest] = msg.split("\n")
        setTitle(first)
        setBody(rest.join("\n").trim())
        setBase(props.base ?? "")
      },
    ),
  )
  const create = async (p: { command: string }) => {
    setBusy(true)
    setError(null)
    try {
      const head = props.head ?? w.status()?.branch.head ?? ""
      const r = await w.rookery.commands.run<{ url?: string | null; message?: string }>(p.command, {
        env: w.env,
        path: w.root,
        remote: w.status()?.branch.upstream?.split("/")[0] ?? "origin",
        branch: head,
        ...(base().trim() ? { base: base().trim() } : {}),
        title: title(),
        body: body(),
        draft: draft(),
      })
      setResult(r ?? {})
      await w.refresh()
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setBusy(false)
    }
  }
  return (
    <Dialog open={props.open} onClose={props.onClose} title="Open a pull request" size="md">
      <div class="wb-pr" data-part="pull-request">
        <p class="body nc-muted">
          From <span class="mono">{props.head ?? w.status()?.branch.head}</span> on {w.env}. The branch is
          pushed first.
        </p>
        <TextField
          label="Title"
          value={title()}
          onInput={(e) => setTitle(e.currentTarget.value)}
          data-part="pr-title"
        />
        <label class="nc-field">
          <span class="nc-field__label">Description</span>
          <textarea
            class="nc-textarea"
            rows={6}
            value={body()}
            onInput={(e) => setBody(e.currentTarget.value)}
            data-part="pr-body"
          />
        </label>
        <TextField
          label="Base branch (optional)"
          placeholder="The repository's default"
          mono
          value={base()}
          onInput={(e) => setBase(e.currentTarget.value)}
        />
        <Toggle label="Draft" checked={draft()} onChange={setDraft} />
        <Show when={error()}>
          <Callout tone="danger">{error()}</Callout>
        </Show>
        <Show when={result()}>
          <Callout tone="info">
            <Show when={result()!.url} fallback={result()!.message || "Done."}>
              Opened:{" "}
              <a href={result()!.url!} target="_blank" rel="noopener">
                {result()!.url}
              </a>
            </Show>
          </Callout>
        </Show>
        <div class="wb-pr__providers">
          <For
            each={providers() ?? []}
            fallback={
              <span class="caption nc-muted">
                {providers.loading ? "Looking for ways to open it…" : "No provider is installed."}
              </span>
            }
          >
            {(p) => (
              <div class="wb-pr__provider" data-provider={p.id}>
                <Button
                  variant="primary"
                  disabled={!p.ok || busy() || !title().trim()}
                  loading={busy()}
                  onClick={() => create(p)}
                >
                  Open with {p.title}
                </Button>
                <Show when={!p.ok}>
                  <span class="caption nc-muted">{p.reason}</span>
                </Show>
              </div>
            )}
          </For>
        </div>
      </div>
    </Dialog>
  )
}
