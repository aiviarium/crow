// A workspace: /workbench/open/<env>/<absolute path>. The activity bar (Files, Search, Source control,
// History), the side panel, editor groups with tabs, the terminal panel at the workspace's path, and a
// right pane for a preview of a port or the assistant other plugins contribute. On a phone one pane shows
// at a time, with the activity bar at the bottom.

import {
  Badge,
  Button,
  Callout,
  EmptyState,
  Icon,
  IconButton,
  Split,
  TextField,
  ViewHeader,
  ViewLayout,
} from "@aiviarium/nocturne"
import type { ClientRookery, ViewHandle } from "@rookery/sdk/client"
import {
  createEffect,
  createMemo,
  createResource,
  createSignal,
  For,
  type JSX,
  Match,
  on,
  onCleanup,
  onMount,
  Show,
  Switch,
} from "solid-js"
import { focusWorkspace, registerWorkspace } from "../active"
import { Workspace } from "../workspace"
import { EditorArea } from "./EditorArea"
import { FileTree } from "./FileTree"
import { parseWorkspacePath, rememberWorkspace, workspacePath } from "./Home"
import { QuickOpen } from "./QuickOpen"
import { ScmPanel } from "./ScmPanel"
import { SearchPanel } from "./SearchPanel"
import { syncAction } from "./sync"

type Side = "files" | "search" | "scm"
type Right = "preview" | "assistant" | null

function usePhone() {
  const q = matchMedia("(max-width: 720px)")
  const [phone, setPhone] = createSignal(q.matches)
  const f = () => setPhone(q.matches)
  q.addEventListener("change", f)
  onCleanup(() => q.removeEventListener("change", f))
  return phone
}

export default function WorkspaceView(props: { rookery: ClientRookery; view: ViewHandle }): JSX.Element {
  const rookery = props.rookery
  const where = createMemo(() => parseWorkspacePath(props.view.path))
  const [ws] = createResource(where, async (w) => {
    const info = await rookery.host.call<import("../api").WsInfo>("ws.info", { env: w.env, path: w.path })
    return info
  })
  return (
    <Switch>
      <Match when={ws.error}>
        <EmptyState
          icon="folder"
          title="This workspace cannot be opened"
          description={`${where().env}:${where().path} · ${(ws.error as Error)?.message ?? ws.error}`}
        >
          <Button onClick={() => rookery.workbench.openView("workbench.home")}>Pick another</Button>
        </EmptyState>
      </Match>
      <Match when={ws()} keyed>
        {(info) => <Opened rookery={rookery} view={props.view} info={info} />}
      </Match>
      <Match when={true}>
        <EmptyState
          icon="edit"
          title={`Opening ${where().path.split("/").pop()}`}
          description={`on ${where().env}`}
        />
      </Match>
    </Switch>
  )
}

function Opened(props: { rookery: ClientRookery; view: ViewHandle; info: import("../api").WsInfo }) {
  const rookery = props.rookery
  const w = new Workspace(rookery, props.info)
  onCleanup(() => w.dispose())
  const name = props.info.root.split("/").filter(Boolean).pop() ?? props.info.root
  props.view.setTitle(name)
  // Unsaved buffers mark the tab. They are kept in drafts when the view is hidden or closed, so the mark stays
  // with the tab until they are saved or reverted (plugins.md, view.setDirty).
  createEffect(() => props.view.setDirty(w.dirtyPaths().length > 0))
  // The URL may point inside the repository: open at its root, with the file if it was one.
  if (props.info.root !== props.info.path) {
    const rel = w.rel(props.info.path)
    queueMicrotask(() =>
      rookery.workbench.openView("workbench.open", {
        path: workspacePath(props.info.env, props.info.root),
        params: { ...props.view.params, ...(rel && rel !== props.info.path ? { file: rel } : {}) },
      }),
    )
  }

  const phone = usePhone()
  const [side, setSide] = createSignal<Side | null>((props.view.params.panel as Side) || "files")
  const [phonePane, setPhonePane] = createSignal<"side" | "editor">("side")
  const [terminal, setTerminal] = createSignal(props.view.params.terminal === "1")
  const [right, setRight] = createSignal<Right>(null)
  const [quick, setQuick] = createSignal(false)

  const showSide = (s: Side) => {
    setSide(s)
    if (phone()) setPhonePane("side")
  }
  const toggleSide = (s: Side) => {
    if (phone()) {
      setSide(s)
      setPhonePane("side")
      return
    }
    setSide(side() === s ? null : s)
  }

  onMount(async () => {
    await w.init()
    await w.restoreLayout()
    const file = props.view.params.file
    if (file) w.openFile(file, { line: Number(props.view.params.line) || undefined })
    rememberWorkspace(rookery, {
      env: props.info.env,
      path: props.info.root,
      name,
      branch: w.status()?.branch.head ?? props.info.branch,
    })
  })

  // A file opened on a phone shows the editor.
  createEffect(
    on(
      () => w.activeTab()?.id,
      (id) => {
        if (id && phone()) setPhonePane("editor")
      },
      { defer: true },
    ),
  )

  // No file watch on a berth host: refresh when the window gets the focus back, and on demand.
  const onFocus = () => {
    if (document.visibilityState === "visible") w.refresh()
  }
  window.addEventListener("focus", onFocus)
  document.addEventListener("visibilitychange", onFocus)
  onCleanup(() => {
    window.removeEventListener("focus", onFocus)
    document.removeEventListener("visibilitychange", onFocus)
  })

  const commands = {
    run: (id: string, params: Record<string, unknown>) => run(id, params),
  }
  onCleanup(registerWorkspace(commands))

  const editor = () => w.editors.get(w.focused())?.editor()
  const activePath = () => w.activeTab()?.path
  const editorAction = (action: string) => {
    const e = editor()
    if (!e) return
    e.focus()
    e.getAction?.(action)?.run()
  }

  const [blame, setBlame] = createSignal(false)
  const [minimap, setMinimap] = createSignal<boolean | null>(null)
  const [wrap, setWrap] = createSignal<string | null>(null)

  async function run(id: string, params: Record<string, unknown>) {
    switch (id) {
      case "workbench.quickOpen":
        return setQuick(true)
      case "workbench.save": {
        const p = activePath()
        if (p) await w.save(p)
        return
      }
      case "workbench.saveAll":
        for (const p of w.dirtyPaths()) await w.save(p)
        return
      case "workbench.format": {
        const p = activePath()
        if (p && w.formatter) await w.formatter(p)
        return
      }
      case "workbench.gotoLine":
        return editorAction("editor.action.gotoLine")
      case "workbench.find":
        return editorAction("editor.action.startFindReplaceAction")
      case "workbench.splitEditor":
        return w.split()
      case "workbench.closeEditor": {
        const t = w.activeTab()
        if (t) w.closeTab(t.id)
        return
      }
      case "workbench.toggleSidebar":
        return setSide(side() ? null : "files")
      case "workbench.toggleTerminal":
        return setTerminal(!terminal())
      case "workbench.togglePreview":
        return setRight(right() === "preview" ? null : "preview")
      case "workbench.toggleAssistant":
        return setRight(right() === "assistant" ? null : "assistant")
      case "workbench.toggleMinimap":
        return setMinimap(!(minimap() ?? w.settings().minimap))
      case "workbench.toggleWordWrap":
        return setWrap((wrap() ?? w.settings().wordWrap) === "off" ? "on" : "off")
      case "workbench.toggleBlame":
        return setBlame(!blame())
      case "workbench.files":
        return showSide("files")
      case "workbench.search":
        return showSide("search")
      case "workbench.sourceControl":
        return showSide("scm")
      case "workbench.revealFile":
        showSide("files")
        return setReveal(activePath() ?? null)
      case "workbench.refresh":
        return w.refresh()
      case "workbench.copyLink":
        return copyLink(activePath())
      case "workbench.history":
        return w.openTab({ id: "history", kind: "history", title: "History" })
      case "workbench.fileHistory": {
        const p = activePath()
        if (p)
          w.openTab({
            id: `history:${p}`,
            kind: "history",
            title: `History of ${p.split("/").pop()}`,
            path: p,
          })
        return
      }
      case "workbench.review":
        return rookery.commands.run("workbench.review", { env: w.env, path: w.root, ...params })
      case "workbench.commit":
      case "workbench.stageAll":
      case "workbench.stash":
        showSide("scm")
        return setScmCommand({ id, at: Date.now() })
      case "workbench.push":
      case "workbench.pull":
      case "workbench.fetch":
        return syncAction(w, id.slice(10) as "push" | "pull" | "fetch")
      case "workbench.switchBranch":
      case "workbench.newBranch":
      case "workbench.openPullRequest":
        showSide("scm")
        return setScmCommand({ id, at: Date.now() })
    }
  }

  const [reveal, setReveal] = createSignal<string | null>(null)
  const [scmCommand, setScmCommand] = createSignal<{ id: string; at: number } | null>(null)

  async function copyLink(path?: string) {
    if (!path) return
    const { uri, href } = await w.api.link(w.env, w.abs(path))
    await navigator.clipboard?.writeText(`${location.origin}${href}`).catch(() => {})
    rookery.workbench.toast({ title: "Link copied", body: uri, kind: "success" })
  }

  const changes = createMemo(() => w.status()?.entries.filter((e) => e.kind !== "ignored").length ?? 0)
  const branch = () => w.status()?.branch

  const rail = (): Array<{ id: Side; label: string; icon: "file" | "search" | "branch"; key: string }> => [
    { id: "files", label: "Files", icon: "file", key: "mod+shift+e" },
    { id: "search", label: "Search", icon: "search", key: "mod+shift+f" },
    { id: "scm", label: "Source control", icon: "branch", key: "mod+shift+g" },
  ]

  const sidePanel = () => (
    <div class="wb-side" data-part="workbench-side">
      <Switch>
        <Match when={side() === "files"}>
          <FileTree w={w} reveal={reveal()} onRevealed={() => setReveal(null)} />
        </Match>
        <Match when={side() === "search"}>
          <SearchPanel w={w} />
        </Match>
        <Match when={side() === "scm"}>
          <ScmPanel w={w} command={scmCommand()} />
        </Match>
      </Switch>
    </div>
  )

  const editors = () => (
    <EditorArea
      w={w}
      blame={blame()}
      minimap={minimap() ?? w.settings().minimap}
      wordWrap={wrap() ?? w.settings().wordWrap}
      phone={phone()}
      onQuickOpen={() => setQuick(true)}
    />
  )

  const center = () => (
    <Show when={terminal() && !phone()} fallback={editors()}>
      <Split
        orientation="vertical"
        fixed="second"
        defaultSize={260}
        min={120}
        max={800}
        label="Resize the terminal panel"
        first={editors()}
        second={<TerminalPanel w={w} onClose={() => setTerminal(false)} />}
      />
    </Show>
  )

  // Choosing the preview or the assistant opens the layout's right-hand panel, also after it was collapsed.
  const [asideRequest, setAsideRequest] = createSignal(0)
  createEffect(on(right, (r) => r && setAsideRequest((n) => n + 1), { defer: true }))

  // The activity bar: always there at the left; picking the open panel again closes it.
  const activity = () => (
    <nav class="wb-rail" aria-label="Workbench">
      <For each={rail()}>
        {(r) => (
          <button
            type="button"
            class="wb-rail__item"
            aria-label={r.label}
            title={r.label}
            aria-pressed={phone() ? phonePane() === "side" && side() === r.id : side() === r.id}
            data-rail={r.id}
            onClick={() => toggleSide(r.id)}
          >
            <Icon name={r.icon} />
            <Show when={r.id === "scm" && changes()}>
              <span class="wb-rail__badge" data-part="changes-count">
                {changes()}
              </span>
            </Show>
          </button>
        )}
      </For>
      <button
        type="button"
        class="wb-rail__item"
        aria-label="History"
        title="History"
        data-rail="history"
        onClick={() => run("workbench.history", {})}
      >
        <Icon name="clock" />
      </button>
      <Show when={phone()}>
        <button
          type="button"
          class="wb-rail__item"
          aria-label="Editor"
          aria-pressed={phonePane() === "editor"}
          data-rail="editor"
          onClick={() => setPhonePane("editor")}
        >
          <Icon name="edit" />
        </button>
      </Show>
    </nav>
  )

  // Where the workspace is (the tab has its name): the environment, the branch, an operation in progress.
  const header = () => (
    <ViewHeader
      context={
        <>
          <span class="wb-head__where mono nc-muted">{w.env}</span>
          <Show when={branch()}>
            {(b) => (
              <button
                type="button"
                class="wb-head__branch mono"
                data-part="branch"
                onClick={() => run("workbench.switchBranch", {})}
              >
                <Icon name="branch" size="sm" />
                {b().head ?? `detached ${b().oid?.slice(0, 7) ?? ""}`}
                <Show when={b().ahead || b().behind}>
                  <span class="nc-muted">
                    {b().ahead ? `↑${b().ahead}` : ""}
                    {b().behind ? ` ↓${b().behind}` : ""}
                  </span>
                </Show>
              </button>
            )}
          </Show>
          <Show when={w.status()?.state}>
            <Badge tone="warning">{w.status()!.state} in progress</Badge>
          </Show>
        </>
      }
      actions={[
        {
          id: "quick-open",
          label: "Open file",
          icon: "search",
          shortcut: "Ctrl P",
          onClick: () => setQuick(true),
        },
        {
          id: "terminal",
          label: "Terminal",
          icon: "terminal",
          pressed: terminal(),
          onClick: () => setTerminal(!terminal()),
        },
        {
          id: "preview",
          label: "Preview a port",
          icon: "eye",
          pressed: right() === "preview",
          onClick: () => run("workbench.togglePreview", {}),
        },
        {
          id: "assistant",
          label: "Assistant",
          icon: "sparkle",
          pressed: right() === "assistant",
          onClick: () => run("workbench.toggleAssistant", {}),
        },
        {
          id: "review",
          label: "Review changes",
          icon: "check",
          onClick: () =>
            rookery.commands.run("workbench.review", {
              env: w.env,
              path: w.root,
              kind: "worktree",
              base: "HEAD",
            }),
        },
        { id: "refresh", label: "Refresh files and status", overflow: true, onClick: () => w.refresh() },
      ]}
    />
  )

  return (
    <div
      class="wb"
      data-part="workbench"
      data-env={w.env}
      data-root={w.root}
      data-phone={phone() ? "" : undefined}
      onFocusIn={() => focusWorkspace(commands)}
      onPointerDown={() => focusWorkspace(commands)}
    >
      <ViewLayout
        id="workbench"
        rail={activity()}
        sidebar={phone() ? undefined : sidePanel()}
        sidebarLabel="Files, search and source control"
        sidebarWidth={280}
        sidebarOpen={side() !== null}
        onSidebarToggle={(open) => setSide(open ? "files" : null)}
        header={header()}
        aside={
          right() && !phone() ? (
            <RightPane w={w} which={right()!} onClose={() => setRight(null)} onSwitch={setRight} />
          ) : undefined
        }
        asideLabel={right() === "assistant" ? "Assistant" : "Preview"}
        asideRequest={asideRequest()}
        asideWidth={360}
        scroll={false}
        minMain={480}
      >
        <div class="wb-main">
          <Show when={w.lastError()}>
            <Callout
              tone="danger"
              class="wb-error"
              action={<IconButton label="Dismiss" icon="close" onClick={() => w.setLastError(null)} />}
            >
              {w.lastError()}
            </Callout>
          </Show>
          <Show
            when={!phone()}
            fallback={
              <div class="wb-phone">
                <Show when={phonePane() === "side"} fallback={editors()}>
                  {sidePanel()}
                </Show>
              </div>
            }
          >
            {center()}
          </Show>
        </div>
      </ViewLayout>
      <QuickOpen w={w} open={quick()} onClose={() => setQuick(false)} />
    </div>
  )
}

/**
 * The terminal panel: the terminal plugin's own panel, embedded beside the editors. A terminal opened there
 * is the terminal plugin's session; the workspace's path is not passed on, as `terminals.open` answers a
 * stream in this SDK and the panel opens its own sessions (see API.md).
 */
function TerminalPanel(props: { w: Workspace; onClose: () => void }) {
  const View = props.w.rookery.views.View
  return (
    <div class="wb-terminal" data-part="workbench-terminal">
      <div class="wb-terminal__tabs" role="tablist" aria-label="Terminals">
        <span class="label nc-muted wb-terminal__label">Terminal</span>
        <span class="wb-head__spacer" />
        <IconButton label="Hide the terminal panel" icon="close" onClick={props.onClose} />
      </div>
      <div class="wb-terminal__body">
        <Show
          when={View}
          keyed
          fallback={<Callout tone="warning">The terminal plugin is not installed on this server.</Callout>}
        >
          {(Terminal) => <Terminal id="terminal.panel" class="wb-terminal__view" />}
        </Show>
      </div>
    </div>
  )
}

/** A preview of a port on the environment through the kernel's proxy, or the assistant. */
function RightPane(props: {
  w: Workspace
  which: "preview" | "assistant"
  onClose: () => void
  onSwitch: (r: Right) => void
}) {
  const w = props.w
  const [port, setPort] = createSignal<number | null>(null)
  const [draft, setDraft] = createSignal("")
  const [nonce, setNonce] = createSignal(0)
  const [assistants] = createResource(() => w.api.assistants().catch(() => []))
  // The server proxies a port on the host's loopback at /env/<name>/port/<n>/ (M3).
  const url = () => (port() ? `/env/${encodeURIComponent(w.env)}/port/${port()}/` : null)
  const View = w.rookery.views.View
  return (
    <div class="wb-right" data-part="workbench-right">
      <div class="wb-right__head">
        <button
          type="button"
          class="wb-right__tab label"
          aria-pressed={props.which === "preview"}
          onClick={() => props.onSwitch("preview")}
        >
          Preview
        </button>
        <button
          type="button"
          class="wb-right__tab label"
          aria-pressed={props.which === "assistant"}
          onClick={() => props.onSwitch("assistant")}
        >
          Assistant
        </button>
        <span class="wb-head__spacer" />
        <IconButton label="Close the pane" icon="close" onClick={props.onClose} />
      </div>
      <Switch>
        <Match when={props.which === "preview"}>
          <form
            class="wb-right__bar"
            onSubmit={(e) => {
              e.preventDefault()
              const n = Number(draft())
              if (n > 0 && n < 65536) setPort(n)
            }}
          >
            <TextField
              aria-label="Port"
              placeholder="Port, e.g. 5173"
              mono
              value={draft()}
              onInput={(e) => setDraft(e.currentTarget.value)}
            />
            <Button type="submit" size="sm">
              Show
            </Button>
            <Show when={url()}>
              <IconButton label="Reload" icon="activity" onClick={() => setNonce(nonce() + 1)} />
              <IconButton
                label="Open in a new tab"
                icon="arrow-up-right"
                onClick={() => window.open(url()!, "_blank", "noopener")}
              />
            </Show>
          </form>
          <Show
            when={url()}
            fallback={
              <EmptyState
                icon="eye"
                title="Preview a port"
                description={`A dev server on ${w.env}, through Crow's proxy at /env/${w.env}/port/<n>/.`}
              />
            }
          >
            {(u) => (
              <Show when={nonce() + 1} keyed>
                {(_n) => (
                  <iframe
                    class="wb-right__frame"
                    title={`Port ${port()} on ${w.env}`}
                    src={u()}
                    data-part="preview-frame"
                  />
                )}
              </Show>
            )}
          </Show>
        </Match>
        <Match when={props.which === "assistant"}>
          <Show
            when={(assistants() ?? [])[0]}
            fallback={
              <EmptyState
                icon="sparkle"
                title="No assistant here yet"
                description="This is where the assistant beside the code goes. A plugin fills it through the workbench.assistant extension point, as the Agents plugin does."
              />
            }
          >
            {(a) => (
              <Show when={View} keyed>
                {(Assist) => (
                  <Assist
                    id={a().view}
                    params={{ env: w.env, path: w.root, file: w.activeTab()?.path ?? "" }}
                    class="wb-right__assistant"
                  />
                )}
              </Show>
            )}
          </Show>
        </Match>
      </Switch>
    </div>
  )
}
