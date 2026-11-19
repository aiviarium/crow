// The conversation's pieces on Parrot's protocol: a turn (user bubble + assistant response),
// grouped tool/command/web/script steps, approval/question/plan/input/auth Request cards, plans,
// file changes with diffs, subagents, errors, and notices.
import {
  ApprovalCard,
  Avatar,
  Badge,
  Button,
  Callout,
  Card,
  ChatMessage,
  DiffView,
  Icon,
  State,
  TextField,
  ToolSteps,
} from "@aiviarium/nocturne"
import type { ClientRookery } from "@rookery/sdk/client"
import { createSignal, For, type JSX, Match, Show, Switch } from "solid-js"
import { errorMessage } from "./api"
import { Markdown } from "./markdown"
import {
  busy,
  countDiffLines,
  relativeTo,
  stepArg,
  stepIcon,
  stepOutput,
  stepStatus,
  stepVerb,
  type TurnView,
} from "./model"
import {
  extractQuestions,
  type FileChange,
  type FileChangeItem,
  formatAnswer,
  type ParrotItem,
  type PlanItem,
  pickApprovalChoices,
  type Request,
  type Session,
  type StructuredQuestion,
  subjectLines,
} from "./parrot"
import { type AgentsStore, formatChatPath } from "./store"
import { SurfaceCard } from "./tui"

export interface TurnCtx {
  rookery: ClientRookery
  store: AgentsStore
  host: string
  session: () => Session | null
  canUse: () => boolean
  openTerminal?: () => void
}

function hasRunning(t: TurnView): boolean {
  return t.parts.some(
    (p) =>
      (p.kind === "tools" && p.items.some((i) => i.status === "running")) ||
      (p.kind === "item" && p.item.kind === "assistant" && p.item.streaming),
  )
}

export function Turn(props: { turn: TurnView; ctx: TurnCtx; last: boolean }): JSX.Element {
  const over = () => !props.last || !busy(props.ctx.session()?.state ?? "idle")

  // Any tool/command item currently awaiting an open approval request is shown by the approval
  // card below rather than duplicated as a tool step row.
  const waitingItemIds = () =>
    new Set(
      props.turn.parts.flatMap((p) =>
        p.kind === "request" && p.request.kind === "approval" && p.request.status === "open" && p.request.item
          ? [p.request.item]
          : [],
      ),
    )

  return (
    <div class="ag-turn" data-part="turn" data-turn={props.turn.turn}>
      <For each={props.turn.user}>
        {(u) => (
          // biome-ignore lint/a11y/useValidAriaRole: ChatMessage's role is who speaks, not an ARIA role
          <ChatMessage role="user" data-item={u.id}>
            <span class="ag-user-text">{u.text}</span>
          </ChatMessage>
        )}
      </For>
      <Show when={props.turn.parts.length || (props.last && busy(props.ctx.session()?.state ?? "idle"))}>
        {/* biome-ignore lint/a11y/useValidAriaRole: ChatMessage's role is who speaks, not an ARIA role */}
        <ChatMessage role="assistant" avatar={<Avatar kind="ai" />}>
          <For each={props.turn.parts}>
            {(p) => (
              <Switch>
                <Match when={p.kind === "tools" && p}>
                  {(group) => (
                    <Show when={group().items.filter((t) => !waitingItemIds().has(t.id))}>
                      {(shown) => (
                        <Show when={shown().length}>
                          <ToolSteps
                            label="Steps"
                            steps={shown().map((t) => {
                              const status = stepStatus(t, over())
                              return {
                                icon: stepIcon(t),
                                verb: stepVerb(t, status === "running"),
                                arg: stepArg(t, props.ctx.session()?.cwd),
                                status,
                                output: stepOutput(t),
                              }
                            })}
                          />
                        </Show>
                      )}
                    </Show>
                  )}
                </Match>
                <Match when={p.kind === "item" && p}>
                  {(entry) => <ItemPart item={entry().item} ctx={props.ctx} />}
                </Match>
                <Match when={p.kind === "request" && p}>
                  {(entry) => <RequestPart request={entry().request} ctx={props.ctx} />}
                </Match>
              </Switch>
            )}
          </For>
          <Show
            when={
              props.last &&
              (props.ctx.session()?.state === "running" || props.ctx.session()?.state === "starting") &&
              !hasRunning(props.turn)
            }
          >
            <div class="ag-working" data-part="working">
              <span class="ag-working__dot" />
              <span class="nc-meta">
                {props.ctx.session()?.state === "starting" ? "Starting…" : "Working…"}
              </span>
            </div>
          </Show>
        </ChatMessage>
      </Show>
    </div>
  )
}

function ItemPart(props: { item: ParrotItem; ctx: TurnCtx }): JSX.Element {
  const it = () => props.item
  return (
    <Switch>
      <Match when={it().kind === "assistant" && (it() as Extract<ParrotItem, { kind: "assistant" }>)}>
        {(a) => (
          <div data-item={a().id} data-part="assistant-text" class="ag-text">
            <Markdown text={a().text ?? ""} />
          </div>
        )}
      </Match>
      <Match when={it().kind === "reasoning" && (it() as Extract<ParrotItem, { kind: "reasoning" }>)}>
        {(r) => <Reasoning item={r()} />}
      </Match>
      <Match when={it().kind === "plan" && (it() as Extract<ParrotItem, { kind: "plan" }>)}>
        {(p) => <PlanCard item={p()} />}
      </Match>
      <Match when={it().kind === "file_change" && (it() as Extract<ParrotItem, { kind: "file_change" }>)}>
        {(fc) => <FileChangeCard item={fc()} cwd={props.ctx.session()?.cwd} />}
      </Match>
      <Match when={it().kind === "subagent" && (it() as Extract<ParrotItem, { kind: "subagent" }>)}>
        {(sub) => (
          <Card
            class="ag-subagent"
            nested
            data-part="subagent"
            data-item={sub().id}
            title={sub().title || "Subagent"}
            action={
              <Show when={sub().session}>
                {(sid) => (
                  <Button
                    size="sm"
                    variant="ghost"
                    icon="arrow-up-right"
                    onClick={() =>
                      props.ctx.rookery.workbench.openView("agents.chat", {
                        path: formatChatPath(props.ctx.host, sid()),
                      })
                    }
                  >
                    Open
                  </Button>
                )}
              </Show>
            }
          >
            <Show when={sub().status}>
              <span class="nc-meta">Status: {sub().status}</span>
            </Show>
          </Card>
        )}
      </Match>
      <Match when={it().kind === "compaction" && (it() as Extract<ParrotItem, { kind: "compaction" }>)}>
        {(c) => (
          <span class="nc-meta ag-notice" data-part="compaction">
            Conversation compacted{c().summary ? `: ${c().summary}` : "."}
          </span>
        )}
      </Match>
      <Match when={it().kind === "handoff" && (it() as Extract<ParrotItem, { kind: "handoff" }>)}>
        {(h) => (
          <span class="nc-meta ag-notice" data-part="handoff">
            Handed off from {h().from} to {h().to} ({h().via}).
          </span>
        )}
      </Match>
      <Match when={it().kind === "hook" && (it() as Extract<ParrotItem, { kind: "hook" }>)}>
        {(hk) => (
          <span class="nc-meta ag-notice" data-part="hook">
            Hook {hk().name} ({hk().event}): {hk().outcome}
            {hk().output ? ` — ${hk().output}` : ""}
          </span>
        )}
      </Match>
      <Match when={it().kind === "review" && (it() as Extract<ParrotItem, { kind: "review" }>)}>
        {(rv) => {
          const text = () => {
            const f = rv().findings
            return typeof f === "string" ? f : JSON.stringify(f ?? rv().target, null, 2)
          }
          return (
            <Card class="ag-plan" nested data-part="review" title="Review">
              <pre class="ag-surface__text nc-mono">{text()}</pre>
            </Card>
          )
        }}
      </Match>
      <Match when={it().kind === "error" && (it() as Extract<ParrotItem, { kind: "error" }>)}>
        {(e) => (
          <Callout tone="danger" data-part="error-item">
            {e().message || "Something went wrong"}
          </Callout>
        )}
      </Match>
      <Match when={it().kind === "notice" && (it() as Extract<ParrotItem, { kind: "notice" }>)}>
        {(n) =>
          n().level === "error" ? (
            <Callout tone="danger" data-part="notice">
              {n().text}
            </Callout>
          ) : n().level === "warning" ? (
            <Callout tone="warning" data-part="notice">
              {n().text}
            </Callout>
          ) : (
            <span class="nc-meta ag-notice" data-part="notice">
              {n().text}
            </span>
          )
        }
      </Match>
    </Switch>
  )
}

function RequestPart(props: { request: Request; ctx: TurnCtx }): JSX.Element {
  const req = () => props.request
  return (
    <Switch>
      <Match when={req().kind === "approval"}>
        <ApprovalRequestCard request={req()} ctx={props.ctx} />
      </Match>
      <Match when={req().kind === "question"}>
        <QuestionRequestCard request={req()} ctx={props.ctx} />
      </Match>
      <Match when={req().kind === "plan"}>
        <PlanRequestCard request={req()} ctx={props.ctx} />
      </Match>
      <Match when={req().kind === "input" || req().kind === "auth"}>
        <SurfaceCard
          request={req()}
          host={props.ctx.host}
          store={props.ctx.store}
          canUse={props.ctx.canUse}
          onOpenTerminal={props.ctx.openTerminal}
        />
      </Match>
    </Switch>
  )
}

function Reasoning(props: { item: Extract<ParrotItem, { kind: "reasoning" }> }) {
  const [open, setOpen] = createSignal(false)
  return (
    <div class="ag-reasoning" data-part="reasoning">
      <button
        type="button"
        class="ag-reasoning__toggle nc-meta"
        aria-expanded={open()}
        onClick={() => setOpen(!open())}
      >
        <Icon name="chevron-right" size="sm" class={open() ? "ag-rot" : undefined} />
        {props.item.streaming ? "Thinking…" : "Thought"}
      </button>
      <Show when={open()}>
        <p class="ag-reasoning__text">{props.item.text ?? ""}</p>
      </Show>
    </div>
  )
}

function ApprovalRequestCard(props: { request: Request; ctx: TurnCtx }) {
  const [err, setErr] = createSignal<string | null>(null)
  const [sending, setSending] = createSignal(false)
  const req = () => props.request
  const choices = () => pickApprovalChoices(req().choices)
  const items = () => {
    const lines = subjectLines(req().subject, props.ctx.session()?.cwd)
    if (lines.length) return lines
    return req().description ? [req().description!] : undefined
  }

  const answer = async (choiceId: string) => {
    setErr(null)
    setSending(true)
    try {
      await props.ctx.store.answerRequest(props.ctx.host, req().id, { choice: choiceId })
    } catch (e) {
      setErr(errorMessage(e))
    } finally {
      setSending(false)
    }
  }

  const decidedState = (): { status: "ok" | "off"; word: string } => {
    const r = req()
    if (r.status === "cancelled" || r.status === "expired") {
      return { status: "off", word: r.status === "expired" ? "Expired" : "Withdrawn" }
    }
    const chosen = r.choices?.find((c) => c.id === r.answer?.choice)
    if (chosen?.intent === "deny") return { status: "off", word: "Denied" }
    if (chosen?.intent === "allow") return { status: "ok", word: "Allowed" }
    return { status: "ok", word: formatAnswer(r) }
  }

  return (
    <div data-part="approval" data-request={req().id} data-status={req().status} class="ag-approval">
      <Show
        when={req().status === "open"}
        fallback={
          <div class="ag-decided nc-meta" data-part="approval-decided">
            <State status={decidedState().status}>{decidedState().word}</State>
            <span class="ag-decided__summary">
              {req().title}
              <Show when={req().answeredBy}>{` · by ${req().answeredBy}`}</Show>
            </span>
          </div>
        }
      >
        <ApprovalCard
          summary={req().title || "The agent wants to go ahead"}
          items={items()}
          decision="pending"
          allowLabel={choices().allow?.label ?? "Allow"}
          denyLabel={choices().deny?.label ?? "Deny"}
          onAllow={() => {
            if (!sending() && props.ctx.canUse()) void answer(choices().allow?.id ?? "allow")
          }}
          onDeny={() => {
            if (!sending() && props.ctx.canUse()) void answer(choices().deny?.id ?? "deny")
          }}
          extra={
            choices().allowSession
              ? {
                  label: choices().allowSession!.label,
                  onClick: () => {
                    if (!sending() && props.ctx.canUse()) void answer(choices().allowSession!.id)
                  },
                }
              : undefined
          }
        />
      </Show>
      <Show when={err()}>
        <span class="nc-meta ag-error-text">{err()}</span>
      </Show>
    </div>
  )
}

function QuestionRequestCard(props: { request: Request; ctx: TurnCtx }) {
  const req = () => props.request
  const questions = () => extractQuestions(req())
  const [picked, setPicked] = createSignal<Record<string, string[]>>({})
  const [other, setOther] = createSignal<Record<string, string>>({})
  const [err, setErr] = createSignal<string | null>(null)
  const [sending, setSending] = createSignal(false)
  const pending = () => req().status === "open"

  const toggle = (q: StructuredQuestion, optId: string) => {
    const cur = picked()[q.id] ?? []
    const next = q.multiSelect
      ? cur.includes(optId)
        ? cur.filter((id) => id !== optId)
        : [...cur, optId]
      : [optId]
    setPicked({ ...picked(), [q.id]: next })
  }

  const submit = async () => {
    setErr(null)
    setSending(true)
    try {
      const qs = questions()
      // Standard single Parrot choice question: send `{ choice }` when a choice was picked and no free text.
      if (qs.length === 1 && (req().choices?.length ?? 0) > 0) {
        const q = qs[0]!
        const free = other()[q.id]?.trim()
        const sel = picked()[q.id] ?? []
        if (sel.length === 1 && !free) {
          await props.ctx.store.answerRequest(props.ctx.host, req().id, { choice: sel[0]! })
          return
        }
        await props.ctx.store.answerRequest(props.ctx.host, req().id, {
          ...(sel[0] ? { choice: sel[0] } : {}),
          ...(free ? { message: free, value: free } : {}),
        })
        return
      }

      // Multi-question or free-form input: send `{ value: Record<string, string> }` or `{ value: string }`.
      const answers: Record<string, string> = {}
      for (const q of qs) {
        const free = other()[q.id]?.trim()
        const selectedLabels = (picked()[q.id] ?? []).map(
          (id) => q.options.find((o) => o.id === id)?.label ?? id,
        )
        const combined = [...selectedLabels, ...(free ? [free] : [])]
        if (combined.length) answers[q.question] = combined.join(", ")
      }
      const singleFree = qs.length === 1 ? answers[qs[0]!.question] : undefined
      await props.ctx.store.answerRequest(
        props.ctx.host,
        req().id,
        qs.length === 1 && singleFree !== undefined ? { value: singleFree } : { value: answers },
      )
    } catch (e) {
      setErr(errorMessage(e))
    } finally {
      setSending(false)
    }
  }

  return (
    <div
      class="ag-question nc-approval"
      data-part="question"
      data-request={req().id}
      data-status={req().status}
    >
      <Show when={pending()} fallback={<State status="ok">Answered</State>}>
        <State status="warn">Needs your answer</State>
      </Show>
      <For each={questions()}>
        {(q) => (
          <div class="ag-question__one">
            <Show when={q.header}>
              <span class="nc-meta">{q.header}</span>
            </Show>
            <span class="nc-approval__summary">{q.question}</span>
            <Show when={req().description && questions().length === 1 && req().description !== q.question}>
              <span class="nc-meta">{req().description}</span>
            </Show>
            <Show when={pending()} fallback={<span class="ag-question__answer">{formatAnswer(req())}</span>}>
              <Show when={q.options.length > 0}>
                {/* biome-ignore lint/a11y/useAriaPropsSupportedByRole: a group or radiogroup, both named by aria-label */}
                <div
                  class="ag-question__options"
                  role={q.multiSelect ? "group" : "radiogroup"}
                  aria-label={q.question}
                >
                  <For each={q.options}>
                    {(o) => (
                      // biome-ignore lint/a11y/useAriaPropsSupportedByRole: the role is radio or checkbox, both take aria-checked
                      <button
                        type="button"
                        class="ag-option"
                        role={q.multiSelect ? "checkbox" : "radio"}
                        aria-checked={(picked()[q.id] ?? []).includes(o.id)}
                        onClick={() => toggle(q, o.id)}
                      >
                        <span class="ag-option__label">
                          {o.label}
                          <Show when={(picked()[q.id] ?? []).includes(o.id)}>
                            <Icon name="check" size="sm" class="ag-option__check" />
                          </Show>
                        </span>
                        <Show when={o.description}>
                          <span class="nc-meta">{o.description}</span>
                        </Show>
                      </button>
                    )}
                  </For>
                </div>
              </Show>
              <TextField
                label={q.options.length ? "Or your own answer" : "Your answer"}
                value={other()[q.id] ?? ""}
                onInput={(e) => setOther({ ...other(), [q.id]: e.currentTarget.value })}
              />
            </Show>
          </div>
        )}
      </For>
      <Show when={pending()}>
        <span class="nc-row nc-row--end">
          <Button size="sm" variant="primary" onClick={submit} disabled={!props.ctx.canUse() || sending()}>
            Answer
          </Button>
        </span>
      </Show>
      <Show when={err()}>
        <span class="nc-meta ag-error-text">{err()}</span>
      </Show>
    </div>
  )
}

function PlanRequestCard(props: { request: Request; ctx: TurnCtx }) {
  const req = () => props.request
  const [err, setErr] = createSignal<string | null>(null)
  const [sending, setSending] = createSignal(false)
  const choices = () => pickApprovalChoices(req().choices)
  const planText = () => {
    const subj = req().subject
    if (subj && subj.type === "plan") return subj.text
    return req().description ?? ""
  }
  const answer = async (choiceId: string) => {
    setErr(null)
    setSending(true)
    try {
      await props.ctx.store.answerRequest(props.ctx.host, req().id, { choice: choiceId })
    } catch (e) {
      setErr(errorMessage(e))
    } finally {
      setSending(false)
    }
  }

  return (
    <Card
      class="ag-plan"
      data-part="plan-request"
      data-request={req().id}
      data-status={req().status}
      title={req().title || "Plan"}
      action={
        <Badge tone={req().status === "open" ? "warning" : "success"}>
          {req().status === "open" ? "Proposed" : formatAnswer(req())}
        </Badge>
      }
    >
      <Show when={planText()}>
        <Markdown text={planText()} />
      </Show>
      <Show when={req().status === "open"}>
        <div class="nc-row nc-row--end ag-plan__actions">
          <Button
            size="sm"
            variant="secondary"
            disabled={!props.ctx.canUse() || sending()}
            onClick={() => void answer(choices().deny?.id ?? "reject")}
          >
            {choices().deny?.label ?? "Keep planning"}
          </Button>
          <Button
            size="sm"
            variant="primary"
            disabled={!props.ctx.canUse() || sending()}
            onClick={() => void answer(choices().allow?.id ?? "approve")}
          >
            {choices().allow?.label ?? "Approve plan"}
          </Button>
        </div>
      </Show>
      <Show when={err()}>
        <span class="nc-meta ag-error-text">{err()}</span>
      </Show>
    </Card>
  )
}

function PlanCard(props: { item: PlanItem & { kind: "plan" } }) {
  const entries = () => props.item.entries ?? []
  return (
    <Card
      class="ag-plan"
      data-part="plan"
      data-item={props.item.id}
      title={entries().length ? "To do" : "Plan"}
    >
      <Show when={entries().length > 0}>
        <ul class="ag-plan__list">
          <For each={entries()}>
            {(e) => (
              <li class="ag-plan__entry" data-status={e.status}>
                <Icon
                  name={e.status === "done" ? "check" : e.status === "active" ? "sparkle" : "minus"}
                  size="sm"
                />
                <span>{e.text}</span>
              </li>
            )}
          </For>
        </ul>
      </Show>
      <Show when={props.item.text}>{(txt) => <Markdown text={txt()} />}</Show>
    </Card>
  )
}

const OP_LETTER: Record<string, string> = {
  add: "A",
  modify: "M",
  delete: "D",
  move: "R",
}

const OP_CLASS: Record<string, string> = {
  add: "added",
  modify: "modified",
  delete: "deleted",
  move: "renamed",
}

function FileChangeCard(props: { item: FileChangeItem & { kind: "file_change" }; cwd?: string }) {
  const [open, setOpen] = createSignal(false)
  const changes = () => props.item.changes ?? []
  const hasDiff = () => changes().some((c) => Boolean(c.diff))
  const totalStats = () => {
    let additions = 0
    let deletions = 0
    for (const c of changes()) {
      const s = countDiffLines(c.diff)
      additions += s.additions
      deletions += s.deletions
    }
    return { additions, deletions }
  }

  return (
    <Card class="ag-diff" data-part="file-change" data-item={props.item.id}>
      <div class="ag-diff__head">
        <Show
          when={changes().length === 1 && changes()[0]}
          fallback={
            <>
              <Icon name="branch" size="sm" />
              <span class="ag-diff__title">
                {changes().length} {changes().length === 1 ? "file" : "files"} changed
              </span>
              <Show when={totalStats().additions || totalStats().deletions}>
                <span class="nc-mono nc-meta">
                  +{totalStats().additions} −{totalStats().deletions}
                </span>
              </Show>
            </>
          }
        >
          {(f) => <FileRow change={f()} cwd={props.cwd} />}
        </Show>
        <Show when={hasDiff()}>
          <span class="ag-diff__actions">
            <Button size="sm" variant="ghost" onClick={() => setOpen(!open())} aria-expanded={open()}>
              {open() ? "Hide diff" : "View diff"}
            </Button>
          </span>
        </Show>
      </div>
      <Show when={changes().length > 1}>
        <ul class="ag-diff__files">
          <For each={changes()}>
            {(f) => (
              <li>
                <FileRow change={f} cwd={props.cwd} />
              </li>
            )}
          </For>
        </ul>
      </Show>
      <Show when={open()}>
        <div class="ag-diff__patches">
          <For each={changes().filter((c) => Boolean(c.diff))}>
            {(c) => (
              <DiffView
                patch={c.diff!}
                path={relativeTo(c.path, props.cwd)}
                mode="unified"
                data-part="diff-view"
              />
            )}
          </For>
        </div>
      </Show>
    </Card>
  )
}

function FileRow(props: { change: FileChange; cwd?: string }) {
  const stats = () => countDiffLines(props.change.diff)
  const displayPath = () => relativeTo(props.change.path, props.cwd)
  return (
    <span class="ag-diff__file nc-mono" title={props.change.path}>
      <span class={`ag-diff__status ag-diff__status--${OP_CLASS[props.change.op] ?? "modified"}`}>
        {OP_LETTER[props.change.op] ?? "M"}
      </span>
      <span class="ag-diff__path">{displayPath()}</span>
      <Show when={stats().additions || stats().deletions}>
        <span class="nc-meta">
          +{stats().additions} −{stats().deletions}
        </span>
      </Show>
    </span>
  )
}
