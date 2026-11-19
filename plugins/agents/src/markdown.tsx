// Markdown for assistant messages (parsed in markdown-parse.ts), built as elements, never as HTML strings,
// so a message cannot inject markup. Fenced code is a CodeBlock (which scrolls long lines), a table scrolls
// sideways in its own box.
import { CodeBlock } from "@aiviarium/nocturne"
import { For, type JSX, Match, Show, Switch } from "solid-js"
import { type Block, type Inline, parseBlocks, parseInline } from "./markdown-parse"

export { type Block, parseBlocks, parseInline } from "./markdown-parse"

const safeHref = (h: string) => (/^(https?:|mailto:|\/)/i.test(h) ? h : undefined)

function Inlines(props: { nodes: Inline[]; onMention?: (uri: string) => void }): JSX.Element {
  return (
    <For each={props.nodes}>
      {(n) => (
        <Switch>
          <Match when={n.t === "text" && n}>{(x) => x().v}</Match>
          <Match when={n.t === "code" && n}>{(x) => <code class="ag-md__code">{x().v}</code>}</Match>
          <Match when={n.t === "b" && n}>
            {(x) => (
              <strong>
                <Inlines nodes={x().v} onMention={props.onMention} />
              </strong>
            )}
          </Match>
          <Match when={n.t === "i" && n}>
            {(x) => (
              <em>
                <Inlines nodes={x().v} onMention={props.onMention} />
              </em>
            )}
          </Match>
          <Match when={n.t === "a" && n}>
            {(x) => (
              <a href={safeHref(x().href)} target="_blank" rel="noreferrer noopener">
                <Inlines nodes={x().v} onMention={props.onMention} />
              </a>
            )}
          </Match>
          <Match when={n.t === "mention" && n}>
            {(x) => (
              <button
                type="button"
                class="nc-token nc-token--ref ag-md__mention"
                onClick={() => props.onMention?.(x().uri)}
              >
                {x().v}
              </button>
            )}
          </Match>
          <Match when={n.t === "br"}>
            <br />
          </Match>
        </Switch>
      )}
    </For>
  )
}

function Blocks(props: { blocks: Block[]; tight?: boolean; onMention?: (uri: string) => void }): JSX.Element {
  const inl = (s: string) => <Inlines nodes={parseInline(s)} onMention={props.onMention} />
  return (
    <For each={props.blocks}>
      {(b) => (
        <Switch>
          <Match when={b.t === "p" && b}>
            {(x) => (props.tight ? inl(x().text) : <p>{inl(x().text)}</p>)}
          </Match>
          <Match when={b.t === "h" && b}>
            {(x) => <p class={`ag-md__h ag-md__h${Math.min(x().level, 3)}`}>{inl(x().text)}</p>}
          </Match>
          <Match when={b.t === "code" && b}>
            {(x) => (
              <CodeBlock
                code={x().code}
                language={x().lang || undefined}
                title={x().lang || undefined}
                copyable
              />
            )}
          </Match>
          <Match when={b.t === "list" && b}>
            {(x) => {
              const items = (
                <For each={x().items}>
                  {(it) => (
                    <li>
                      <Blocks blocks={it} tight={x().tight} onMention={props.onMention} />
                    </li>
                  )}
                </For>
              )
              return x().ordered ? <ol start={x().start}>{items}</ol> : <ul>{items}</ul>
            }}
          </Match>
          <Match when={b.t === "quote" && b}>
            {(x) => (
              <blockquote>
                <Blocks blocks={x().blocks} onMention={props.onMention} />
              </blockquote>
            )}
          </Match>
          <Match when={b.t === "hr"}>
            <hr />
          </Match>
          <Match when={b.t === "table" && b}>
            {(x) => (
              <div class="ag-md__table" data-part="markdown-table">
                <table>
                  <thead>
                    <tr>
                      <For each={x().head}>
                        {(c, k) => <th style={{ "text-align": x().align[k()] ?? undefined }}>{inl(c)}</th>}
                      </For>
                    </tr>
                  </thead>
                  <Show when={x().rows.length}>
                    <tbody>
                      <For each={x().rows}>
                        {(r) => (
                          <tr>
                            <For each={r}>
                              {(c, k) => (
                                <td style={{ "text-align": x().align[k()] ?? undefined }}>{inl(c)}</td>
                              )}
                            </For>
                          </tr>
                        )}
                      </For>
                    </tbody>
                  </Show>
                </table>
              </div>
            )}
          </Match>
        </Switch>
      )}
    </For>
  )
}

export function Markdown(props: { text: string; onMention?: (uri: string) => void }): JSX.Element {
  return (
    <div class="ag-md" data-part="markdown">
      <Blocks blocks={parseBlocks(props.text)} onMention={props.onMention} />
    </div>
  )
}
