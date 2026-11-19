// Left navigation sidebar: Crow brand header, Home link, plugin-contributed navigation items and
// dynamic sections, and the signed-in AccountMenu at the bottom.
import { Count, type IconName, Nav, NavItem } from "@aiviarium/nocturne"
import { createMemo, For, type JSX, Show } from "solid-js"
import { AccountMenu } from "../auth/AccountMenu"
import { BrandMark } from "./BrandMark"
import { HOME_VIEW, INBOX_ITEM_VIEW, INBOX_VIEW, JOB_VIEW, JOBS_VIEW, type ShellApp } from "./state"

export function Sidebar(props: { app: ShellApp; onNavigate?: () => void }): JSX.Element {
  const activeView = () => props.app.routeMatch()?.view ?? HOME_VIEW
  const activePlugin = () => props.app.routeMatch()?.plugin

  const pluginNavItems = createMemo(() => {
    const items: Array<{
      id: string
      plugin: string
      title: string
      href: string
      view?: string
      icon?: string
    }> = []
    for (const plugin of Object.values(props.app.loader.plugins)) {
      if (!plugin?.manifest || plugin.state === "invalid") continue
      for (const entry of plugin.manifest.contributes.nav ?? []) {
        const viewId = entry.view ?? undefined
        const href = viewId ? props.app.href(viewId) : undefined
        if (!href) continue
        items.push({
          id: entry.id,
          plugin: plugin.id,
          title: entry.title,
          href,
          view: viewId,
          icon: entry.icon ?? undefined,
        })
      }
    }
    return items
  })

  const badgeOf = (id: string): JSX.Element | undefined => {
    const val = props.app.loader.navBadges()[id]?.()
    if (val === undefined || val === "") return undefined
    return typeof val === "number" ? <Count value={val} /> : <span>{val}</span>
  }

  const unreadCount = () => props.app.inbox.unread()
  const activeJobsCount = () => props.app.jobs.activeCount()

  return (
    <div class="crow-sidebar" data-part="sidebar">
      <div class="crow-sidebar__head">
        <span class="crow-sidebar__workspace heading">
          <BrandMark />
          <span>Crow</span>
        </span>
      </div>

      <Nav label="Main navigation" class="crow-sidebar__nav">
        <NavItem
          label="Home"
          icon="home"
          href="/"
          current={activeView() === HOME_VIEW}
          onClick={() => props.onNavigate?.()}
        />
        <NavItem
          label="Inbox"
          icon="inbox"
          href="/inbox"
          meta={
            unreadCount() > 0 ? <Count value={unreadCount()} data-part="inbox-unread-count" /> : undefined
          }
          current={activeView() === INBOX_VIEW || activeView() === INBOX_ITEM_VIEW}
          onClick={() => props.onNavigate?.()}
        />
        <NavItem
          label="Jobs"
          icon="activity"
          href="/jobs"
          meta={
            activeJobsCount() > 0 ? (
              <Count value={activeJobsCount()} data-part="jobs-active-count" />
            ) : undefined
          }
          current={activeView() === JOBS_VIEW || activeView() === JOB_VIEW}
          onClick={() => props.onNavigate?.()}
        />

        <Show when={pluginNavItems().length > 0}>
          <span class="nc-nav__label">Plugins</span>
          <For each={pluginNavItems()}>
            {(item) => (
              <NavItem
                label={item.title}
                icon={item.icon as IconName | undefined}
                href={item.href}
                meta={badgeOf(item.id)}
                current={
                  (item.view !== undefined && activeView() === item.view) || activePlugin() === item.plugin
                }
                onClick={() => props.onNavigate?.()}
              />
            )}
          </For>
        </Show>

        <For each={Object.values(props.app.loader.navSections())}>
          {(entry) => (
            <For each={entry.section.items?.() ?? []}>
              {(item) => {
                const targetHref =
                  item.href ?? (item.view ? props.app.href(item.view, { path: item.path }) : null)
                return (
                  <NavItem
                    label={item.title}
                    icon={item.icon as IconName | undefined}
                    href={targetHref ?? undefined}
                    meta={
                      badgeOf(item.id) ?? (item.badge !== undefined ? <span>{item.badge}</span> : undefined)
                    }
                    current={item.current ?? (item.view !== undefined && activeView() === item.view)}
                    onClick={() => {
                      item.onSelect?.()
                      props.onNavigate?.()
                    }}
                  />
                )
              }}
            </For>
          )}
        </For>
      </Nav>

      <div class="crow-sidebar__foot">
        <AccountMenu app={props.app} onNavigate={props.onNavigate} />
      </div>
    </div>
  )
}
