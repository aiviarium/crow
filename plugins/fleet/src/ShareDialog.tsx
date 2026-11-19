// Sharing a host: who holds what on `env://NAME`, adding a person or everyone at a level, changing a level
// and taking a grant away. Ported from the prototype's shell share dialog (`shell/src/data/share.tsx`) to
// a fleet component, on Rookery's `access.*` methods: `access.grants`, `access.grant`, `access.revoke` and
// `access.level`, all needing manage on the host.
import { Avatar, Badge, Button, Callout, Dialog, IconButton, Select, TextField } from "@aiviarium/nocturne"
import type { GrantInfo } from "@rookery/client"
import type { ClientRookery } from "@rookery/sdk/client"
import { createResource, createSignal, For, type JSX, Show } from "solid-js"
import {
  createGrantsApi,
  explain,
  type GroupInfo,
  LEVELS,
  type Level,
  levelLabel,
  type UserInfo,
} from "./access"
import { envUri } from "./env"
import { createMeApi, principalOf } from "./me"

/** `user:<id>` or `group:<id>` as a name, when `admin.users`/`admin.groups` told us who they are. */
function nameOf(principal: string, users: UserInfo[], groups: GroupInfo[]): string | undefined {
  if (principal === "everyone") return "Everyone signed in"
  if (principal.startsWith("group:")) {
    const id = principal.slice("group:".length)
    return groups.find((g) => g.id === id)?.name
  }
  const id = principal.replace(/^user:/, "")
  return users.find((u) => u.id === id)?.name
}

export function ShareDialog(props: {
  /** The host: `dev-01` or `env://dev-01`. */
  host: string
  rookery: ClientRookery
  onClose: () => void
}): JSX.Element {
  const grants = createGrantsApi(props.rookery)
  const meApi = createMeApi(props.rookery)
  const resource = () => envUri(props.host)
  const [me] = createResource(() => meApi.me())
  const [users] = createResource(() => grants.users())
  const [groups] = createResource(() => grants.groups())
  // A refusal is an answer here, not a thrown error: the dialog says why it cannot show the grants.
  const [loaded, { refetch }] = createResource(resource, (uri) =>
    grants
      .grants(uri)
      .then((value) => ({ ok: true as const, value }))
      .catch((e) => ({
        ok: false as const,
        error: explain(e, { env: props.host, doing: "see who this host is shared with" }),
      })),
  )
  const sharing = () => {
    const r = loaded()
    return r?.ok ? r.value : undefined
  }
  const refusal = () => {
    const r = loaded()
    return r && !r.ok ? r.error : undefined
  }
  const [level, setLevel] = createSignal<Level>("use")
  const [query, setQuery] = createSignal("")
  const [principal, setPrincipal] = createSignal("")
  const [busy, setBusy] = createSignal(false)
  const [error, setError] = createSignal<string>()

  const canManage = () => sharing() !== undefined
  const owner = () => sharing()?.owner ?? null
  const isAdmin = () => me()?.admin ?? false

  const people = () => {
    const text = query().trim().toLowerCase()
    const candidates = [
      ...(users() ?? []).map((u) => ({
        principal: principalOf(u.id),
        name: u.name,
        detail: u.email ?? u.id,
        label: "Add",
      })),
      ...(groups() ?? []).map((g) => ({
        principal: `group:${g.id}`,
        name: g.name,
        detail: `${g.members} ${g.members === 1 ? "member" : "members"}`,
        label: "Group",
      })),
    ]
    if (!text) return candidates.slice(0, 6)
    return candidates
      .filter((c) => c.name.toLowerCase().includes(text) || c.detail.toLowerCase().includes(text))
      .slice(0, 6)
  }

  const already = (principal: string) =>
    (principal.startsWith("user:") ? owner() === principal.slice("user:".length) : false) ||
    !!sharing()?.grants.some((g) => g.principal === principal)

  const run = async (fn: () => Promise<unknown>, what: string) => {
    if (busy()) return
    setBusy(true)
    setError(undefined)
    try {
      await fn()
      await refetch()
    } catch (e) {
      const x = explain(e, { env: props.host, doing: what })
      setError(`${x.code} · ${x.what} ${x.fix}`)
    } finally {
      setBusy(false)
    }
  }

  const addPerson = (principal: string) =>
    run(() => grants.grant(resource(), principal, level()), "share the host")

  const addPrincipal = () => {
    const value = principal().trim()
    if (!value) return
    const who = value === "everyone" || value.startsWith("user:") ? value : principalOf(value)
    setPrincipal("")
    void run(() => grants.grant(resource(), who, level()), "share the host")
  }

  return (
    <Dialog
      open
      onClose={props.onClose}
      title={`Share ${props.host}`}
      description="People you add get access to this host. Its owner and Rookery admins always hold manage."
      size="md"
      data-part="share-dialog"
      footer={
        <Button variant="secondary" onClick={props.onClose}>
          Done
        </Button>
      }
    >
      <div class="fleet-share" data-host={props.host}>
        <Show when={error()}>
          {(err) => (
            <Callout tone="danger" data-part="share-error">
              {err()}
            </Callout>
          )}
        </Show>
        <Show
          when={sharing()}
          fallback={
            <>
              <Show when={refusal()}>
                {(x) => (
                  <Callout tone="danger" data-part="share-forbidden">
                    {x().code} · {x().what} {x().fix}
                  </Callout>
                )}
              </Show>
              <Show when={!loaded()}>
                <span class="nc-meta">Loading who has access…</span>
              </Show>
            </>
          }
        >
          {(s) => (
            <>
              <div class="fleet-share__add">
                <Show
                  when={isAdmin() && people().length}
                  fallback={
                    <TextField
                      label="Add a person"
                      placeholder="user id, or everyone"
                      value={principal()}
                      onInput={(e) => setPrincipal(e.currentTarget.value)}
                      onKeyDown={(e) => {
                        if (e.key === "Enter") addPrincipal()
                      }}
                      data-part="share-principal"
                    />
                  }
                >
                  <TextField
                    label="Add people"
                    variant="search"
                    placeholder="Search people by name or email"
                    value={query()}
                    onInput={(e) => setQuery(e.currentTarget.value)}
                    data-part="share-search"
                  />
                </Show>
                <Select<Level>
                  label="Access"
                  options={LEVELS.map((l) => ({ value: l.value, label: l.label, description: l.can }))}
                  value={level()}
                  onChange={setLevel}
                  class="fleet-share__level"
                />
                <Show when={!isAdmin() || !people().length}>
                  <Button
                    size="sm"
                    variant="secondary"
                    icon="users"
                    disabled={!principal().trim() || busy()}
                    onClick={addPrincipal}
                    data-part="share-add-principal"
                  >
                    Add
                  </Button>
                </Show>
              </div>
              <Show when={isAdmin() && people().length}>
                <div class="fleet-share__results" role="listbox" aria-label="People">
                  <For each={people()}>
                    {(p) => (
                      <button
                        type="button"
                        role="option"
                        aria-selected={false}
                        class="fleet-share__person fleet-share__result"
                        data-candidate={p.principal}
                        disabled={already(p.principal) || busy()}
                        onClick={() => addPerson(p.principal)}
                      >
                        <Avatar name={p.name} size="sm" />
                        <span class="fleet-share__who">
                          <span class="label">{p.name}</span>
                          <span class="nc-meta">{p.detail}</span>
                        </span>
                        <span class="nc-meta">
                          {already(p.principal) ? "Has access" : `${p.label} · ${levelLabel(level())}`}
                        </span>
                      </button>
                    )}
                  </For>
                </div>
              </Show>
              <span class="nc-nav__label">Who has access</span>
              <div class="fleet-share__list" data-part="share-list">
                <Show when={s().owner}>
                  {(id) => (
                    <Person
                      grant={{
                        principal: principalOf(id()),
                        level: "manage",
                        createdBy: principalOf(id()),
                        createdAt: "",
                      }}
                      users={users() ?? []}
                      groups={groups() ?? []}
                      meId={me()?.id}
                      note="Owner"
                    />
                  )}
                </Show>
                <For each={s().grants.filter((g) => g.principal !== principalOf(s().owner ?? ""))}>
                  {(g) => (
                    <Person
                      grant={g}
                      users={users() ?? []}
                      groups={groups() ?? []}
                      meId={me()?.id}
                      editable={canManage()}
                      busy={busy()}
                      onLevel={(l) =>
                        void run(() => grants.grant(resource(), g.principal, l), "change access")
                      }
                      onRemove={() => void run(() => grants.revoke(resource(), g.principal), "remove access")}
                    />
                  )}
                </For>
              </div>
              <Show when={!canManage()}>
                <span class="nc-meta">Changing access needs manage on this host.</span>
              </Show>
            </>
          )}
        </Show>
      </div>
    </Dialog>
  )
}

function Person(props: {
  grant: GrantInfo
  users: UserInfo[]
  groups: GroupInfo[]
  meId?: string
  note?: string
  editable?: boolean
  busy?: boolean
  onLevel?: (l: Level) => void
  onRemove?: () => void
}): JSX.Element {
  const name = () => nameOf(props.grant.principal, props.users, props.groups) ?? props.grant.principal
  const isMe = () => !!props.meId && props.grant.principal === principalOf(props.meId)
  return (
    <div class="fleet-share__person" data-principal={props.grant.principal}>
      <Avatar name={name()} size="sm" />
      <span class="fleet-share__who">
        <span class="label">
          {name()}
          {isMe() ? " (you)" : ""}
        </span>
        <span class="nc-meta">{props.grant.principal}</span>
      </span>
      <Show
        when={props.editable}
        fallback={<Badge tone="neutral">{props.note ?? levelLabel(props.grant.level)}</Badge>}
      >
        <Select<Level>
          aria-label={`Access for ${name()}`}
          options={LEVELS.map((l) => ({ value: l.value, label: l.label }))}
          value={props.grant.level}
          onChange={(l) => props.onLevel?.(l)}
          class="fleet-share__level"
        />
        <IconButton
          label={`Remove ${name()}`}
          icon="close"
          disabled={props.busy}
          onClick={() => props.onRemove?.()}
        />
      </Show>
    </div>
  )
}
