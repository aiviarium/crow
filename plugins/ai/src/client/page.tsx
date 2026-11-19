// The Models page of Admin: which connection and model serve each task, where requests go, a box to try each
// task, usage per user, plugin, task, model and day, and the limits per user and day. Overrides by spaces and
// people show in "Where requests go"; their owners set them.
import {
  Badge,
  Button,
  type DataColumn,
  DataTable,
  EmptyState,
  SectionHeading,
  Select,
  StatCard,
  State,
  Switch,
  Tabs,
  TextArea,
  TextField,
} from "@aiviarium/nocturne"
import type { ConnectionInfo } from "@rookery/sdk/client"
import { createMemo, createResource, createSignal, For, type JSX, Show } from "solid-js"
import type { Calls, Limits, MappingInfo, Task, UsageBy, UsageRow } from "./calls"
import { ANTHROPIC_TYPE, type ManagedModels } from "./managed"
import type { ClientRookeryWithAi } from "./types"

const TASKS: Array<{ task: Task; title: string }> = [
  { task: "text", title: "Text" },
  { task: "fast", title: "Fast" },
  { task: "transcription", title: "Transcription" },
]

const num = (n: number) => n.toLocaleString()
const minutes = (s: number) => (s < 60 ? `${s.toFixed(1)} s` : `${(s / 60).toFixed(1)} min`)
const message = (e: unknown) => (e instanceof Error ? e.message : String(e))

export function ModelsPage(props: {
  rookery: ClientRookeryWithAi
  calls: Calls
  refreshTasks: () => void
  managed: ManagedModels
}): JSX.Element {
  const { rookery, calls } = props
  const [mappings, { refetch }] = createResource(() => calls.mappings())
  const [providers] = createResource(() => calls.providers())
  const [connections, { refetch: refetchConnections }] = createResource(() =>
    rookery.connections.list().then((list) => list.filter((c) => c.scope === "global")),
  )
  const [managed] = createResource(props.managed.available)
  const [admin] = createResource(() => props.managed.asAdmin().catch(() => false))
  const supportedTasks = () => TASKS.filter((t) => !managed() || t.task !== "transcription")
  // Bumped after each try, so the usage includes it.
  const [usageVersion, setUsageVersion] = createSignal(0)
  const changed = () => {
    void refetch()
    props.refreshTasks()
  }
  const global = (task: Task) => mappings()?.find((m) => m.task === task && m.scope === "global")
  const usable = (task: Task) => {
    const types = new Set(
      (providers() ?? []).filter((p) => p.tasks.includes(task)).map((p) => p.connectionType),
    )
    return (connections() ?? []).filter((c) => types.has(c.type))
  }
  return (
    <div class="ai__page" data-part="admin-models">
      <Show when={managed() && admin()}>
        <AddAnthropic rookery={rookery} onAdded={() => void refetchConnections()} />
      </Show>
      <Show
        when={(connections()?.length ?? 1) > 0 || (mappings()?.length ?? 0) > 0}
        fallback={<EmptyState icon="cpu" title="No model API connected" />}
      >
        <section class="ai__section">
          <SectionHeading title="Tasks" />
          <For each={supportedTasks()}>
            {(t) => (
              <TaskRow
                calls={calls}
                task={t.task}
                title={t.title}
                mapping={global(t.task)}
                connections={usable(t.task)}
                onChange={changed}
              />
            )}
          </For>
        </section>
        <Privacy mappings={mappings() ?? []} />
        <TryIt
          calls={calls}
          available={(task) => Boolean(global(task))}
          onRan={() => setUsageVersion((v) => v + 1)}
          streaming={!managed()}
        />
        <Show when={!managed()}>
          <Usage rookery={rookery} calls={calls} version={usageVersion()} />
          <LimitsPanel rookery={rookery} calls={calls} />
        </Show>
      </Show>
    </div>
  )
}

function AddAnthropic(props: { rookery: ClientRookeryWithAi; onAdded: () => void }): JSX.Element {
  const [name, setName] = createSignal("Anthropic")
  const [saving, setSaving] = createSignal(false)
  const [status, setStatus] = createSignal("")
  const add = async (e: SubmitEvent) => {
    e.preventDefault()
    const form = e.currentTarget as HTMLFormElement
    const input = new FormData(form).get("apiKey")
    if (typeof input !== "string" || !input.trim()) return
    setSaving(true)
    setStatus("")
    try {
      await props.rookery.connections.create({
        type: ANTHROPIC_TYPE,
        name: name().trim(),
        scope: "global",
        config: {},
        credential: input.trim(),
      })
      form.reset()
      setStatus("Connection added")
      props.onAdded()
    } catch (err) {
      setStatus(message(err))
    } finally {
      setSaving(false)
    }
  }
  return (
    <section class="ai__section">
      <SectionHeading title="Add an Anthropic connection" />
      <form class="ai__control" onSubmit={add}>
        <TextField label="Name" value={name()} onInput={(e) => setName(e.currentTarget.value)} required />
        <TextField label="API key" name="apiKey" type="password" autocomplete="off" required />
        <Button size="sm" variant="primary" type="submit" loading={saving()}>
          Connect
        </Button>
      </form>
      <Show when={status()}>
        <p role="status">{status()}</p>
      </Show>
    </section>
  )
}

function TaskRow(props: {
  calls: Calls
  task: Task
  title: string
  mapping: MappingInfo | undefined
  connections: ConnectionInfo[]
  onChange: () => void
}): JSX.Element {
  const [connection, setConnection] = createSignal<string | undefined>()
  const [model, setModel] = createSignal<string | undefined>()
  const [live, setLive] = createSignal<boolean | undefined>()
  const [saving, setSaving] = createSignal(false)
  const [error, setError] = createSignal<string>()
  const chosen = () => connection() ?? props.mapping?.connection
  const [models] = createResource(chosen, (id) => props.calls.models(id).catch(() => []))
  // Models that suit the task first; the rest are still offered.
  const offered = createMemo(() =>
    [...(models() ?? [])].sort(
      (a, b) =>
        Number(!(a.tasks ?? [props.task]).includes(props.task)) -
        Number(!(b.tasks ?? [props.task]).includes(props.task)),
    ),
  )
  const modelValue = () => model() ?? props.mapping?.model ?? ""
  const liveValue = () => live() ?? props.mapping?.live ?? false
  const dirty = () =>
    (connection() !== undefined && connection() !== props.mapping?.connection) ||
    (model() !== undefined && model() !== props.mapping?.model) ||
    (live() !== undefined && live() !== props.mapping?.live)
  const listId = `ai-models-${props.task}`
  const save = async () => {
    setSaving(true)
    setError(undefined)
    try {
      await props.calls.setMapping({
        task: props.task,
        scope: "global",
        connection: chosen(),
        model: modelValue().trim(),
        ...(props.task === "transcription" ? { live: liveValue() } : {}),
      })
      setConnection(undefined)
      setModel(undefined)
      setLive(undefined)
      props.onChange()
    } catch (e) {
      setError(message(e))
    } finally {
      setSaving(false)
    }
  }
  const remove = async () => {
    setError(undefined)
    try {
      await props.calls.removeMapping({ task: props.task, scope: "global" })
      props.onChange()
    } catch (e) {
      setError(message(e))
    }
  }
  return (
    <div class="ai__task" data-task={props.task}>
      <span class="ai__task-name">
        <span class="label">{props.title}</span>
        <Show when={props.mapping} fallback={<State status="off">Not set up</State>}>
          <State status="ok">Set up</State>
        </Show>
      </span>
      <div class="ai__control">
        <Select
          aria-label={`Connection for ${props.title}`}
          placeholder="Connection"
          value={chosen()}
          options={props.connections.map((c) => ({ value: c.id, label: c.name, description: c.type }))}
          onChange={(v) => setConnection(v)}
        />
        <TextField
          aria-label={`Model for ${props.title}`}
          class="ai__model"
          mono
          placeholder={models.loading ? "Loading models…" : "Model"}
          list={listId}
          value={modelValue()}
          onInput={(e) => setModel(e.currentTarget.value)}
        />
        <datalist id={listId}>
          <For each={offered()}>{(m) => <option value={m.id}>{m.title ?? ""}</option>}</For>
        </datalist>
        <Show when={props.task === "transcription"}>
          <Switch label="Live text" checked={liveValue()} onChange={setLive} />
        </Show>
        <Button
          size="sm"
          variant="primary"
          disabled={!chosen() || !modelValue().trim() || saving() || (!dirty() && Boolean(props.mapping))}
          onClick={save}
        >
          Save
        </Button>
        <Show when={props.mapping}>
          <Button size="sm" variant="ghost" onClick={remove}>
            Remove
          </Button>
        </Show>
      </div>
      <Show when={error()}>
        <span class="nc-meta ai__error" role="alert">
          {error()}
        </span>
      </Show>
    </div>
  )
}

/** Where requests go, per task and per override: the deployment's privacy view. */
function Privacy(props: { mappings: MappingInfo[] }): JSX.Element {
  const columns: DataColumn<MappingInfo>[] = [
    { id: "task", header: "Task", accessor: (m) => m.task, cell: (m) => <span class="label">{m.task}</span> },
    {
      id: "scope",
      header: "Set for",
      accessor: (m) => m.scope,
      cell: (m) => (
        <span class="nc-meta">
          {m.scope === "global"
            ? "Everyone"
            : m.scope === "space"
              ? `Space ${m.spaceId?.slice(-6)}`
              : `User ${m.userId?.slice(-6)}`}
        </span>
      ),
    },
    { id: "provider", header: "Provider", accessor: (m) => m.provider, type: "mono" },
    { id: "model", header: "Model", accessor: (m) => m.model, type: "mono" },
    { id: "destination", header: "Requests go to", accessor: (m) => m.destination, type: "mono" },
    {
      id: "local",
      header: "Network",
      accessor: (m) => (m.local ? "local" : "external"),
      cell: (m) => (
        <Badge tone={m.local ? "success" : "warning"}>{m.local ? "Stays here" : "Leaves the network"}</Badge>
      ),
    },
  ]
  return (
    <Show when={props.mappings.length}>
      <section class="ai__section" data-part="models-privacy">
        <SectionHeading title="Where requests go" />
        <DataTable
          label="Where requests go"
          rows={props.mappings}
          columns={columns}
          getRowId={(m) => `${m.task}:${m.scope}:${m.spaceId ?? m.userId ?? ""}`}
        />
      </section>
    </Show>
  )
}

/** A box per task to see that it works. */
function TryIt(props: {
  calls: Calls
  available: (task: Task) => boolean
  onRan: () => void
  streaming: boolean
}): JSX.Element {
  const [task, setTask] = createSignal<Task>("text")
  const [prompt, setPrompt] = createSignal("Write one sentence about the sea.")
  const [out, setOut] = createSignal("")
  const [meta, setMeta] = createSignal("")
  const [running, setRunning] = createSignal(false)
  let abort: AbortController | undefined
  const run = async () => {
    setOut("")
    setMeta("")
    setRunning(true)
    abort = new AbortController()
    const started = performance.now()
    let first = 0
    try {
      for await (const ev of props.calls.generate(
        { task: task(), prompt: prompt(), plugin: "crow" },
        abort.signal,
      )) {
        if (ev.type === "delta") {
          if (!first) first = performance.now()
          setOut((o) => o + ev.text)
        } else {
          const g = ev.generated
          const u = g.usage
          setMeta(
            `${g.provider} · ${g.model} · first text after ${Math.round((first || performance.now()) - started)} ms, done after ${Math.round(performance.now() - started)} ms` +
              (u.inputTokens !== undefined ? ` · ${u.inputTokens} in, ${u.outputTokens ?? 0} out` : ""),
          )
        }
      }
    } catch (e) {
      if (!abort.signal.aborted) setMeta(`Failed: ${message(e)}`)
    } finally {
      abort = undefined
      setRunning(false)
      props.onRan()
    }
  }
  return (
    <Show when={TASKS.some((t) => t.task !== "transcription" && props.available(t.task))}>
      <section class="ai__section" data-part="models-try">
        <SectionHeading title="Try it" />
        <Tabs
          label="Task to try"
          value={task()}
          onChange={(v) => {
            setTask(v as Task)
            setMeta("")
            setOut("")
          }}
          items={TASKS.filter((t) => t.task !== "transcription").map((t) => ({ id: t.task, label: t.title }))}
        />
        <Show when={props.available(task())}>
          <div class="ai__try" data-try={task()}>
            <TextArea
              aria-label="Prompt"
              value={prompt()}
              onInput={(e) => setPrompt(e.currentTarget.value)}
              rows={3}
            />
            <div class="nc-row">
              <Button
                variant="primary"
                size="sm"
                icon="sparkle"
                disabled={running() || !prompt().trim()}
                onClick={run}
              >
                Run
              </Button>
              <Show when={running() && props.streaming}>
                <Button variant="ghost" size="sm" onClick={() => abort?.abort()}>
                  Stop
                </Button>
              </Show>
            </div>
            <Show when={out()}>
              <pre class="ai__out body" data-part="models-try-output">
                {out()}
              </pre>
            </Show>
            <Show when={meta()}>
              <span class="nc-meta" data-part="models-try-meta">
                {meta()}
              </span>
            </Show>
          </div>
        </Show>
      </section>
    </Show>
  )
}

/** Names for user ids, from the entity index when available. */
function useNames(rookery: ClientRookeryWithAi, ids: () => string[]) {
  const [names] = createResource(
    () => ids().filter(Boolean).sort().join(","),
    async (key) => {
      if (!key || !rookery.entities) return {} as Record<string, string>
      const found = await rookery.entities.resolveMany(key.split(",").map((id) => `user://${id}`))
      return Object.fromEntries(found.map((e) => [e.uri.replace("user://", ""), e.title]))
    },
  )
  return (id: string) => names()?.[id]
}

function Usage(props: { rookery: ClientRookeryWithAi; calls: Calls; version: number }): JSX.Element {
  const [by, setBy] = createSignal<UsageBy>("user")
  const [days, setDays] = createSignal("30")
  const [report] = createResource(
    () => ({ by: by(), days: Number(days()), v: props.version }),
    (q) => props.calls.usage(q.by, q.days),
  )
  const [totals] = createResource(
    () => ({ days: Number(days()), v: props.version }),
    (q) => props.calls.usage("task", q.days),
  )
  const nameOf = useNames(props.rookery, () =>
    by() === "user" ? (report()?.rows ?? []).map((r) => r.key) : [],
  )
  const sum = (f: (r: UsageRow) => number) => (totals()?.rows ?? []).reduce((n, r) => n + f(r), 0)
  const label = () => ({ user: "User", plugin: "Plugin", task: "Task", model: "Model", day: "Day" })[by()]
  const text = (r: UsageRow) => r.label ?? (by() === "user" ? nameOf(r.key) : undefined) ?? (r.key || "none")
  const columns = (): DataColumn<UsageRow>[] => [
    {
      id: "key",
      header: label(),
      sortable: true,
      accessor: (r) => text(r),
      cell: (r) => <span class={by() === "user" ? "label" : "nc-mono"}>{text(r)}</span>,
    },
    {
      id: "requests",
      header: "Requests",
      type: "num",
      sortable: true,
      accessor: (r) => num(r.requests),
      sortValue: (r) => r.requests,
    },
    {
      id: "errors",
      header: "Failed",
      type: "num",
      sortable: true,
      accessor: (r) => num(r.errors),
      sortValue: (r) => r.errors,
    },
    {
      id: "in",
      header: "Tokens in",
      type: "num",
      sortable: true,
      accessor: (r) => num(r.inputTokens),
      sortValue: (r) => r.inputTokens,
    },
    {
      id: "out",
      header: "Tokens out",
      type: "num",
      sortable: true,
      accessor: (r) => num(r.outputTokens),
      sortValue: (r) => r.outputTokens,
    },
    {
      id: "audio",
      header: "Audio",
      type: "num",
      sortable: true,
      accessor: (r) => minutes(r.audioSeconds),
      sortValue: (r) => r.audioSeconds,
    },
  ]
  return (
    <section class="ai__section" data-part="models-usage">
      <SectionHeading
        title="Usage"
        action={
          <Select
            aria-label="Period"
            value={days()}
            onChange={setDays}
            options={[
              { value: "1", label: "Today" },
              { value: "7", label: "Last 7 days" },
              { value: "30", label: "Last 30 days" },
            ]}
          />
        }
      />
      <div class="ai__stats">
        <StatCard label="Requests" value={num(sum((r) => r.requests))} />
        <StatCard label="Tokens" value={num(sum((r) => r.inputTokens + r.outputTokens))} />
        <StatCard label="Audio" value={minutes(sum((r) => r.audioSeconds))} />
        <StatCard label="Failed" value={num(sum((r) => r.errors))} />
      </div>
      <Tabs
        label="Group usage by"
        value={by()}
        onChange={(v) => setBy(v as UsageBy)}
        items={[
          { id: "user", label: "Users" },
          { id: "plugin", label: "Plugins" },
          { id: "task", label: "Tasks" },
          { id: "model", label: "Models" },
          { id: "day", label: "Days" },
        ]}
      />
      <Show when={(report()?.rows.length ?? 0) > 0}>
        <DataTable label="Usage" rows={report()?.rows ?? []} columns={columns()} getRowId={(r) => r.key} />
      </Show>
    </section>
  )
}

/** Number fields for limits; empty means no limit. */
function LimitFields(props: { value: Limits; onChange: (l: Limits) => void; prefix: string }): JSX.Element {
  const field = (key: keyof Limits, label: string, scale = 1) => (
    <TextField
      label={label}
      aria-label={`${props.prefix} ${label}`}
      class="ai__limit"
      inputMode="numeric"
      placeholder="No limit"
      value={props.value[key] === undefined ? "" : String(Math.round((props.value[key] as number) / scale))}
      onInput={(e) => {
        const v = e.currentTarget.value.trim()
        const n = Number(v)
        props.onChange({
          ...props.value,
          [key]: v === "" || !Number.isFinite(n) ? undefined : Math.max(0, Math.round(n * scale)),
        })
      }}
    />
  )
  return (
    <div class="ai__limits-fields">
      {field("requests", "Requests a day")}
      {field("tokens", "Tokens a day")}
      {field("audioSeconds", "Audio minutes a day", 60)}
    </div>
  )
}

function LimitsPanel(props: { rookery: ClientRookeryWithAi; calls: Calls }): JSX.Element {
  const [info, { mutate }] = createResource(() => props.calls.limits())
  const [draft, setDraft] = createSignal<Limits | undefined>()
  const [who, setWho] = createSignal<string | undefined>()
  const [query, setQuery] = createSignal("")
  const [userDraft, setUserDraft] = createSignal<Limits>({})
  const [error, setError] = createSignal<string>()
  const [found] = createResource(query, async (q) => {
    if (q.trim().length < 1 || !props.rookery.entities) return []
    return props.rookery.entities.search(q, { schemes: ["user"], limit: 8 })
  })
  const nameOf = useNames(props.rookery, () => (info()?.users ?? []).map((u) => u.userId))
  const set = async (user: string | undefined, limits: Limits) => {
    setError(undefined)
    try {
      mutate(await props.calls.setLimits({ ...(user ? { user } : {}), limits }))
    } catch (e) {
      setError(message(e))
    }
  }
  const describe = (l: Limits) =>
    [
      l.requests !== undefined && `${num(l.requests)} requests`,
      l.tokens !== undefined && `${num(l.tokens)} tokens`,
      l.audioSeconds !== undefined && `${minutes(l.audioSeconds)} of audio`,
    ]
      .filter(Boolean)
      .join(" · ") || "No limit"
  return (
    <section class="ai__section" data-part="models-limits">
      <SectionHeading title="Limits" />
      <div class="ai__task">
        <span class="ai__task-name">
          <span class="label">Everyone</span>
          <span class="nc-meta">{describe(info()?.default ?? {})}</span>
        </span>
        <div class="ai__control">
          <LimitFields prefix="Everyone" value={draft() ?? info()?.default ?? {}} onChange={setDraft} />
          <Button
            size="sm"
            variant="primary"
            disabled={!draft()}
            onClick={() => set(undefined, draft()!).then(() => setDraft(undefined))}
          >
            Save
          </Button>
        </div>
      </div>
      <For each={info()?.users ?? []}>
        {(u) => (
          <div class="ai__task" data-user={u.userId}>
            <span class="ai__task-name">
              <span class="label">{u.name ?? nameOf(u.userId) ?? u.userId}</span>
              <span class="nc-meta">{describe(u.limits)}</span>
            </span>
            <div class="ai__control">
              <Button
                size="sm"
                variant="ghost"
                icon="trash"
                aria-label="Remove the limit"
                onClick={() => set(u.userId, {})}
              />
            </div>
          </div>
        )}
      </For>
      <div class="ai__task">
        <span class="ai__task-name">
          <span class="label">One person</span>
        </span>
        <div class="ai__control">
          <TextField
            aria-label="Find a person"
            placeholder="Name"
            value={query()}
            onInput={(e) => {
              setQuery(e.currentTarget.value)
              setWho(undefined)
            }}
          />
          <Select
            aria-label="User"
            placeholder="Person"
            value={who()}
            onChange={setWho}
            options={(found() ?? []).map((e) => ({ value: e.uri.replace("user://", ""), label: e.title }))}
          />
          <LimitFields prefix="User" value={userDraft()} onChange={setUserDraft} />
          <Button
            size="sm"
            disabled={!who() || Object.values(userDraft()).every((v) => v === undefined)}
            onClick={() => set(who(), userDraft()).then(() => setUserDraft({}))}
          >
            Add
          </Button>
        </div>
      </div>
      <Show when={error()}>
        <span class="nc-meta ai__error" role="alert">
          {error()}
        </span>
      </Show>
    </section>
  )
}
