// The share dialog: who has access to a resource (`space://`, `doc://`, `env://`, etc.), and adding,
// changing or revoking grants through Rookery's `access.grants`, `access.grant`, `access.revoke` and
// `users.search`.
import { Avatar, Button, Callout, ContextMenu, Dialog, Select, TextField } from "@aiviarium/nocturne"
import type { EntityInfo, Grant, GrantInfo, GrantList, Person, PersonList } from "@rookery/client"
import { createResource, createSignal, For, type JSX, Show } from "solid-js"
import type { ShellApp } from "./state"

const LEVELS: Array<{ value: Grant; label: string }> = [
  { value: "view", label: "Can view" },
  { value: "use", label: "Can edit" },
  { value: "manage", label: "Can manage" },
]

const levelLabel = (l: Grant) => LEVELS.find((x) => x.value === l)?.label ?? l

export function ShareDialogHost(props: { app: ShellApp }): JSX.Element {
  return (
    <Show when={props.app.shareUri()} keyed>
      {(uri) => <ShareDialog app={props.app} uri={uri} onClose={() => props.app.setShareUri(null)} />}
    </Show>
  )
}

function ShareDialog(props: { app: ShellApp; uri: string; onClose: () => void }): JSX.Element {
  const { conn, entities } = props.app
  const [entity] = createResource(
    () => props.uri,
    (uri) => conn.call<EntityInfo | null>("entities.resolve", { uri }).catch(() => null),
  )
  const [sharing, { mutate, refetch }] = createResource(
    () => props.uri,
    (resource) => conn.call<GrantList>("access.grants", { resource }),
  )
  const [held] = createResource(
    () => props.uri,
    (resource) =>
      conn
        .call<{ level: Grant | null }>("access.level", { resource })
        .then((r) => r.level)
        .catch(() => "manage" as Grant),
  )
  const canManage = () => !sharing.error && (held() ?? "manage") === "manage"
  const [query, setQuery] = createSignal("")
  const [level, setLevel] = createSignal<Grant>("use")
  const [knownNames, setKnownNames] = createSignal<Record<string, Person>>({})

  const [people] = createResource(
    () => (canManage() ? query().trim() : ""),
    async (text) => {
      if (!text) return [] as Person[]
      const res = await conn.call<PersonList>("users.search", {
        resource: props.uri,
        text,
        limit: 6,
      })
      const list = res?.people ?? []
      if (list.length) {
        setKnownNames((prev) => {
          const next = { ...prev }
          for (const p of list) next[`user:${p.id}`] = p
          return next
        })
      }
      return list
    },
  )

  const ownerPrincipal = () => {
    const o = sharing()?.owner
    if (!o) return null
    return o.startsWith("user:") ? o : `user:${o}`
  }

  const already = (userId: string) =>
    ownerPrincipal() === `user:${userId}` || !!sharing()?.grants.some((g) => g.principal === `user:${userId}`)

  const run = async (method: string, params: Record<string, unknown>, what: string) => {
    try {
      await conn.call(method, { resource: props.uri, ...params })
      const updated = await conn.call<GrantList>("access.grants", { resource: props.uri })
      mutate(updated)
      entities.invalidate(props.uri)
    } catch (e) {
      props.app.loader.runtime.toast?.({
        title: what,
        body: (e as Error).message,
        kind: "danger",
      })
      void refetch()
    }
  }

  const add = (user: Person) => {
    setKnownNames((prev) => ({ ...prev, [`user:${user.id}`]: user }))
    setQuery("")
    void run(
      "access.grant",
      { principal: `user:${user.id}`, level: level() },
      `Sharing with ${user.name} failed`,
    )
  }

  const title = () => entity()?.title ?? props.uri

  return (
    <Dialog
      open
      onClose={props.onClose}
      title={<>Share {title()}</>}
      description={
        props.uri.startsWith("space://")
          ? "Members can use everything in the space."
          : "People you add get access to this, on top of what they get from where it lives."
      }
      size="md"
      data-part="share-dialog"
      footer={
        <Button variant="secondary" onClick={props.onClose}>
          Done
        </Button>
      }
    >
      <Show when={sharing.error}>
        <Callout tone="danger">{String((sharing.error as Error)?.message ?? sharing.error)}</Callout>
      </Show>
      <Show when={sharing()}>
        {(s) => (
          <div class="crow-share">
            <Show when={canManage()}>
              <div class="crow-share__add">
                <TextField
                  label="Add people"
                  variant="search"
                  icon="search"
                  placeholder="Search people by name or email"
                  value={query()}
                  onInput={(e) => setQuery(e.currentTarget.value)}
                  data-part="share-search"
                />
                <Select<Grant>
                  label="Access"
                  options={LEVELS}
                  value={level()}
                  onChange={setLevel}
                  class="crow-share__level"
                />
              </div>
              <Show when={people()?.length}>
                <div class="crow-share__results" role="listbox" aria-label="People">
                  <For each={people()}>
                    {(p) => (
                      <button
                        type="button"
                        role="option"
                        aria-selected={false}
                        class="crow-share__person crow-share__result"
                        data-user={p.id}
                        disabled={already(p.id)}
                        onClick={() => add(p)}
                      >
                        <Avatar name={p.name} size="sm" />
                        <span class="crow-share__who">
                          <span class="label">{p.name}</span>
                          <Show when={p.email}>
                            <span class="nc-meta">{p.email}</span>
                          </Show>
                        </span>
                        <span class="nc-meta">
                          {already(p.id) ? "Has access" : `Add · ${levelLabel(level())}`}
                        </span>
                      </button>
                    )}
                  </For>
                </div>
              </Show>
            </Show>
            <span class="nc-nav__label">Who has access</span>
            <div class="crow-share__list" data-part="share-list">
              <Show when={ownerPrincipal()}>
                {(principal) => (
                  <PersonRow
                    app={props.app}
                    grant={{
                      principal: principal(),
                      level: "manage",
                      createdBy: principal(),
                      createdAt: "",
                    }}
                    known={knownNames()[principal()]}
                    note="Owner"
                  />
                )}
              </Show>
              <For each={s().grants.filter((g) => g.principal !== ownerPrincipal())}>
                {(g) => (
                  <PersonRow
                    app={props.app}
                    grant={g}
                    known={knownNames()[g.principal]}
                    editable={canManage()}
                    onLevel={(l) =>
                      void run("access.grant", { principal: g.principal, level: l }, "Changing access failed")
                    }
                    onRemove={() =>
                      void run("access.revoke", { principal: g.principal }, "Removing access failed")
                    }
                  />
                )}
              </For>
            </div>
            <Show when={!canManage()}>
              <span class="nc-meta">You can see who has access; changing it needs manage access.</span>
            </Show>
          </div>
        )}
      </Show>
    </Dialog>
  )
}

function PersonRow(props: {
  app: ShellApp
  grant: GrantInfo
  known?: Person
  note?: string
  editable?: boolean
  onLevel?: (l: Grant) => void
  onRemove?: () => void
}): JSX.Element {
  const userUri = () =>
    props.grant.principal.startsWith("user:") ? `user://${props.grant.principal.slice(5)}` : null
  const [resolved] = createResource(
    () => (!props.known && userUri() ? userUri()! : null),
    (uri) => props.app.entities.resolve(uri),
  )
  const meUser = () => props.app.session.me()?.user
  const isMe = () => !!meUser() && props.grant.principal === `user:${meUser()!.id}`
  const name = () =>
    props.known?.name ?? resolved()?.title ?? (isMe() ? meUser()?.name : undefined) ?? props.grant.principal
  const email = () => props.known?.email ?? resolved()?.subtitle ?? (isMe() ? meUser()?.email : undefined)

  const row = (
    <div
      class="crow-share__person"
      data-principal={props.grant.principal}
      tabIndex={props.editable ? 0 : undefined}
      onKeyDown={(e) => {
        if (props.editable && e.target === e.currentTarget && (e.key === "Delete" || e.key === "Backspace")) {
          e.preventDefault()
          props.onRemove?.()
        }
      }}
    >
      <Avatar name={name()} size="sm" />
      <span class="crow-share__who">
        <span class="label">
          {name()}
          {isMe() ? " (you)" : ""}
        </span>
        <Show when={email()}>
          <span class="nc-meta">{email()}</span>
        </Show>
      </span>
      <Show
        when={props.editable}
        fallback={<span class="nc-meta">{props.note ?? levelLabel(props.grant.level)}</span>}
      >
        <Select<Grant>
          aria-label={`Access for ${name()}`}
          options={LEVELS}
          value={props.grant.level}
          onChange={(l) => props.onLevel?.(l)}
          class="crow-share__level"
        />
      </Show>
    </div>
  )

  return (
    <Show when={props.editable} fallback={row}>
      <ContextMenu
        label={name()}
        items={() => [{ id: "remove", label: `Remove ${name()}`, icon: "trash", danger: true }]}
        onSelect={() => props.onRemove?.()}
      >
        {row}
      </ContextMenu>
    </Show>
  )
}
