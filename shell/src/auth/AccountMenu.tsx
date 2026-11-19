// Signed-in user menu at the bottom of the sidebar plus the About Crow dialog.
import { Avatar, Badge, Button, Dialog, Icon, Menu, type MenuEntry, Popover } from "@aiviarium/nocturne"
import { createSignal, type JSX, Show, untrack } from "solid-js"
import type { ShellApp } from "../app/state"
import { setTheme, shown, theme } from "../theme"
import "./auth.css"

export function AccountMenu(props: { app: ShellApp; onNavigate?: () => void }): JSX.Element {
  const [open, setOpen] = createSignal(false)
  const [trigger, setTrigger] = createSignal<HTMLElement>()
  const me = () => props.app.session.me()

  const close = () => {
    setOpen(false)
    queueMicrotask(() => trigger()?.focus())
  }

  const buildItems = (): MenuEntry[] => {
    const user = me()?.user
    const currentTheme = theme()
    return [
      {
        type: "custom",
        content: (
          <div class="crow-account__who" data-part="account-who">
            <Avatar name={user?.name ?? ""} size="lg" />
            <span class="crow-account__text">
              <span class="label crow-account__name">{user?.name}</span>
              <span class="nc-meta crow-account__email">{user?.email}</span>
            </span>
            <Badge tone={user?.admin ? "accent" : "neutral"}>{user?.admin ? "Admin" : "Member"}</Badge>
          </div>
        ),
      },
      { type: "separator" },
      { type: "label", label: "Theme" },
      { id: "theme.dark", label: "Dark", checked: currentTheme === "dark" },
      { id: "theme.light", label: "Light", checked: currentTheme === "light" },
      { id: "theme.system", label: "System", checked: currentTheme === "system" },
      { type: "separator" },
      { id: "crow.about", label: "About Crow" },
      { id: "crow.signOut", label: "Sign out", danger: true },
    ]
  }

  const choose = (id: string) => {
    setOpen(false)
    trigger()?.focus()
    if (id === "theme.dark") setTheme("dark")
    else if (id === "theme.light") setTheme("light")
    else if (id === "theme.system") setTheme("system")
    else if (id === "crow.about") props.app.setAboutOpen(true)
    else if (id === "crow.signOut") void props.app.signOut()
    props.onNavigate?.()
  }

  return (
    <Show when={me()}>
      {(m) => (
        <>
          <button
            ref={setTrigger}
            type="button"
            class="nc-nav-item crow-user"
            data-part="user-menu"
            aria-haspopup="menu"
            aria-expanded={open()}
            onClick={() => setOpen(!open())}
            onKeyDown={(e) => {
              if (e.key === "ArrowUp" || e.key === "ArrowDown") {
                e.preventDefault()
                setOpen(true)
              }
            }}
          >
            <span class="crow-user__lead">
              <Avatar name={m().user.name} size="sm" />
            </span>
            <span class="nc-nav-item__label">{m().user.name}</span>
            <span class="nc-nav-item__meta" aria-hidden="true">
              <Icon name="chevron-down" />
            </span>
          </button>
          <Show when={open()}>
            <Popover open anchor={trigger()} placement="top-start" offset={6} onClose={close}>
              <Menu
                label="Account"
                items={untrack(buildItems)}
                minWidth="240px"
                onRequestClose={close}
                onSelect={choose}
              />
            </Popover>
          </Show>
        </>
      )}
    </Show>
  )
}

export function AboutDialog(props: { app: ShellApp }): JSX.Element {
  const me = () => props.app.session.me()
  return (
    <Dialog
      open={props.app.aboutOpen()}
      onClose={() => props.app.setAboutOpen(false)}
      title="About Crow"
      size="sm"
      footer={
        <Button variant="secondary" onClick={() => props.app.setAboutOpen(false)}>
          Close
        </Button>
      }
    >
      <dl class="crow-about" data-part="about">
        <dt class="nc-meta">Server</dt>
        <dd class="mono">v{me()?.kernelVersion ?? "—"}</dd>
        <dt class="nc-meta">API</dt>
        <dd class="mono">v{me()?.apiVersion ?? "—"}</dd>
        <dt class="nc-meta">Signed in as</dt>
        <dd>{me()?.user.email ?? me()?.user.name ?? "—"}</dd>
        <dt class="nc-meta">Theme</dt>
        <dd>{shown()}</dd>
      </dl>
    </Dialog>
  )
}
