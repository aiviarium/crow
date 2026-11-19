// One commit: its message, author, parents and refs, a link other parts of Crow can use, and its changes.
import { Badge, Button, EmptyState, IconButton } from "@aiviarium/nocturne"
import { createResource, createSignal, For, Show } from "solid-js"
import { age } from "../git/log"
import type { Workspace } from "../workspace"
import { EMPTY_TREE } from "./DiffTab"
import { ReviewBody } from "./Review"

export function CommitTab(props: { w: Workspace; sha: string }) {
  const w = props.w
  const [info] = createResource(
    () => props.sha,
    (sha) => w.api.git.commitInfo(w.env, w.root, sha),
  )
  const [mode, setMode] = createSignal<"split" | "unified">(
    matchMedia("(max-width: 720px)").matches ? "unified" : "split",
  )
  const copy = async () => {
    const c = info()?.commit
    if (!c) return
    const { uri, href } = w.api.commitLink(w.env, w.root, c.sha)
    await navigator.clipboard?.writeText(`${location.origin}${href}`).catch(() => {})
    w.rookery.workbench.toast({ title: "Link copied", body: uri, kind: "success" })
  }
  return (
    <div class="wb-commitview" data-part="commit-view" data-sha={props.sha}>
      <Show
        when={info()}
        fallback={
          <EmptyState
            icon="branch"
            title={info.error ? "No such commit" : "Reading the commit"}
            description={info.error ? String((info.error as Error).message) : undefined}
          />
        }
      >
        {(i) => (
          <>
            <header class="wb-commitview__head">
              <div class="wb-commitview__message">
                <span class="heading">{i().commit.subject}</span>
                <Show when={i().commit.message.split("\n").slice(1).join("\n").trim()}>
                  <pre class="body wb-commitview__body">
                    {i().commit.message.split("\n").slice(1).join("\n").trim()}
                  </pre>
                </Show>
              </div>
              <div class="wb-commitview__meta caption nc-muted">
                <span>
                  {i().commit.author} &lt;{i().commit.email}&gt; · {age(i().commit.time)} ·{" "}
                  {new Date(i().commit.time * 1000).toLocaleString()}
                </span>
                <span class="mono">{i().commit.sha}</span>
                <span>
                  Parents:{" "}
                  <For each={i().commit.parents} fallback={<span>none (the first commit)</span>}>
                    {(p) => (
                      <button
                        type="button"
                        class="wb-link mono"
                        onClick={() =>
                          w.openTab({ id: `commit:${p}`, kind: "commit", title: p.slice(0, 7), sha: p })
                        }
                      >
                        {p.slice(0, 7)}{" "}
                      </button>
                    )}
                  </For>
                </span>
                <span class="nc-row">
                  <For each={i().commit.refs}>
                    {(r) => (
                      <Badge tone={r.startsWith("tag:") ? "warning" : "accent"}>
                        {r.replace(/^HEAD -> /, "")}
                      </Badge>
                    )}
                  </For>
                </span>
              </div>
              <div class="nc-row">
                <Button size="sm" variant="ghost" icon="link" onClick={copy}>
                  Copy link
                </Button>
                <IconButton
                  label={mode() === "split" ? "Unified" : "Side by side"}
                  icon="sidebar"
                  pressed={mode() === "split"}
                  onClick={() => setMode(mode() === "split" ? "unified" : "split")}
                />
              </div>
            </header>
            <ReviewBody
              api={w.api}
              rookery={w.rookery}
              env={w.env}
              root={w.root}
              spec={{ kind: "range", base: i().commit.parents[0] ?? EMPTY_TREE, head: i().commit.sha }}
              onOpen={(path, line) => w.openFile(path, { line })}
              mode={mode()}
            />
          </>
        )}
      </Show>
    </div>
  )
}
