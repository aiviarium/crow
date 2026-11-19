// A grid of widget instances: the dashboards plugin's pages and any future home widgets area. Renders each
// instance's component in a card, and while editing offers drag and resize (@aiviarium/nocturne's WidgetGrid),
// settings, removal and the picker that adds a widget.
import {
  Button,
  ContextMenu,
  Dialog,
  EmptyState,
  ICON_PATHS,
  Icon,
  IconButton,
  type IconName,
  type JsonSchema,
  placeInGrid,
  SchemaForm,
  schemaHasFields,
  TextField,
  Widget,
  WidgetGrid,
} from "@aiviarium/nocturne"
import {
  type Accessor,
  createEffect,
  createMemo,
  createSignal,
  ErrorBoundary,
  For,
  type JSX,
  on,
  onCleanup,
  onMount,
  Show,
} from "solid-js"
import { Dynamic } from "solid-js/web"
import {
  limits,
  newInstanceId,
  settingsWithDefaults,
  widgetComponent,
  widgetType,
  widgetTypes,
} from "./registry"
import { groupForPicker } from "./settings"
import type { WidgetAreaProps, WidgetComponent, WidgetHandle, WidgetInstance, WidgetType } from "./types"
import "./widgets.css"

const stripLimits = ({ minW: _a, minH: _b, maxW: _c, maxH: _d, ...rest }: Record<string, unknown>) => rest

const iconName = (name: string | undefined, fallback: IconName): IconName =>
  name && name in ICON_PATHS ? (name as IconName) : fallback

export function WidgetArea(props: WidgetAreaProps): JSX.Element {
  const [picking, setPicking] = createSignal(false)
  const [configuring, setConfiguring] = createSignal<string | null>(null)
  const byId = createMemo(() => new Map(props.instances.map((i) => [i.id, i])))
  const items = createMemo(() =>
    props.instances.map((i) => ({ id: i.id, x: i.x, y: i.y, w: i.w, h: i.h, ...limits(widgetType(i.type)) })),
  )
  const emit = (next: WidgetInstance[]) => props.onChange(next)
  // Instances whose widget renders nothing right now. Outside editing they take no space (WidgetGrid's
  // `empty`); while editing they show as a placeholder, so they can be moved, configured and removed.
  const [empty, setEmpty] = createSignal<ReadonlySet<string>>(new Set())
  const markEmpty = (id: string, is: boolean) =>
    setEmpty((prev) => {
      if (prev.has(id) === is) return prev
      const next = new Set(prev)
      if (is) next.add(id)
      else next.delete(id)
      return next
    })
  const hidden = createMemo(() => props.instances.filter((i) => empty().has(i.id)).map((i) => i.id))
  const allHidden = () =>
    !props.editing && props.instances.length > 0 && hidden().length === props.instances.length

  const arranged = (grid: Array<{ id: string; x: number; y: number; w: number; h: number }>) =>
    emit(
      props.instances.map((i) => {
        const g = grid.find((x) => x.id === i.id)
        return g ? { ...i, x: g.x, y: g.y, w: g.w, h: g.h } : i
      }),
    )
  const add = (type: WidgetType) => {
    const size = type.sizes.default
    const at = placeInGrid(items(), size)
    emit([
      ...props.instances,
      {
        id: newInstanceId(),
        type: type.id,
        ...at,
        w: size.w,
        h: size.h,
        settings: settingsWithDefaults(type, {}),
      },
    ])
    setPicking(false)
  }
  const remove = (id: string) => emit(props.instances.filter((i) => i.id !== id))
  const patch = (id: string, settings: Record<string, unknown>) =>
    emit(props.instances.map((i) => (i.id === id ? { ...i, settings: { ...i.settings, ...settings } } : i)))
  const replace = (id: string, settings: Record<string, unknown>) =>
    emit(props.instances.map((i) => (i.id === id ? { ...i, settings } : i)))

  return (
    <div
      class="crow-widgets"
      data-part="widget-area"
      data-area={props.area}
      data-all-hidden={allHidden() ? "" : undefined}
    >
      <Show when={props.editing}>
        <div class="crow-widgets__bar" data-part="widget-toolbar">
          <IconButton
            label="Add widget"
            icon="plus"
            data-part="add-widget"
            onClick={() => setPicking(true)}
          />
        </div>
      </Show>
      <Show
        when={props.instances.length > 0}
        fallback={
          <EmptyState
            icon="grid"
            title="No widgets yet"
            description={props.editing ? "Add one to start." : "Edit this page to add widgets."}
          >
            <Show when={props.editing}>
              <Button variant="secondary" icon="plus" onClick={() => setPicking(true)}>
                Add widget
              </Button>
            </Show>
          </EmptyState>
        }
      >
        <Show when={allHidden() && props.area === "dashboard"}>
          <p class="nc-meta crow-widgets__quiet" data-part="widgets-quiet">
            Nothing to show right now. The widgets on this page appear when they have something to say.
          </p>
        </Show>
        <WidgetGrid
          label={props.label ?? "Widgets"}
          items={items()}
          empty={hidden()}
          editing={props.editing}
          onChange={arranged}
          itemLabel={(i) => widgetType(byId().get(i.id)?.type ?? "")?.title ?? "Widget"}
        >
          {(item) => (
            <WidgetCard
              instance={() => byId().get(item().id)!}
              size={() => ({ w: item().w, h: item().h })}
              area={props.area}
              editing={() => props.editing}
              onConfigure={() => setConfiguring(item().id)}
              onRemove={() => remove(item().id)}
              onUpdate={(p) => patch(item().id, p)}
              onEmpty={(is) => markEmpty(item().id, is)}
            />
          )}
        </WidgetGrid>
      </Show>
      <AddWidgetPicker open={picking()} area={props.area} onPick={add} onClose={() => setPicking(false)} />
      <SettingsDialog
        instance={configuring() ? byId().get(configuring()!) : undefined}
        onSave={(s) => {
          replace(configuring()!, s)
          setConfiguring(null)
        }}
        onClose={() => setConfiguring(null)}
      />
    </div>
  )
}

/** The frame of one widget: the card, the edit-mode tools, the component in an error boundary. */
function WidgetCard(props: {
  instance: Accessor<WidgetInstance>
  size: Accessor<{ w: number; h: number }>
  area: WidgetAreaProps["area"]
  editing: Accessor<boolean>
  onConfigure: () => void
  onRemove: () => void
  onUpdate: (patch: Record<string, unknown>) => void
  onEmpty: (empty: boolean) => void
}): JSX.Element {
  const type = () => widgetType(props.instance().type)
  // Whether the widget rendered anything: a widget with nothing to say renders nothing.
  const [blank, setBlank] = createSignal(false)
  let body: HTMLDivElement | undefined
  const check = () => {
    if (!body) return
    const is = !body.firstElementChild && !(body.textContent ?? "").trim()
    setBlank(is)
    props.onEmpty(is)
  }
  onMount(() => {
    check()
    if (!body || typeof MutationObserver === "undefined") return
    const watch = new MutationObserver(check)
    watch.observe(body, { childList: true, characterData: true, subtree: true })
    onCleanup(() => watch.disconnect())
  })
  const component = (): WidgetComponent | undefined => widgetComponent(props.instance().type)
  const [ticks, setTicks] = createSignal(0)
  const refresh = type()?.refreshSecs
  if (refresh) {
    const t = setInterval(() => setTicks((n) => n + 1), refresh * 1000)
    onCleanup(() => clearInterval(t))
  }

  const handle: WidgetHandle = {
    get type() {
      return props.instance().type
    },
    get plugin() {
      return type()?.plugin ?? ""
    },
    get instance() {
      return props.instance().id
    },
    area: props.area,
    get settings() {
      return settingsWithDefaults(type(), props.instance().settings)
    },
    get size() {
      return props.size()
    },
    get editing() {
      return props.editing()
    },
    refreshed: ticks,
    update: (p) => props.onUpdate(p),
  }
  const configurable = () => !!type()?.settings && schemaHasFields(type()!.settings as JsonSchema)
  const card = () => (
    <div
      class="crow-widget"
      data-part="widget"
      data-widget={props.instance().type}
      data-instance={props.instance().id}
      data-plugin={type()?.plugin}
      data-blank={blank() ? "" : undefined}
      tabIndex={props.editing() ? 0 : undefined}
      onKeyDown={(e) => {
        if (
          props.editing() &&
          e.target === e.currentTarget &&
          (e.key === "Delete" || e.key === "Backspace")
        ) {
          e.preventDefault()
          props.onRemove()
        }
      }}
    >
      <Show when={props.editing() && configurable()}>
        <div class="crow-widget__tools" data-no-drag>
          <IconButton
            label={`Configure ${type()?.title ?? "widget"}`}
            icon="settings"
            data-part="configure-widget"
            onClick={props.onConfigure}
          />
        </div>
      </Show>
      <div class="crow-widget__body" ref={body}>
        <Show
          when={type() && component()}
          fallback={
            // Loading, or a widget whose plugin is gone: only the person arranging the page needs to know.
            <Show when={props.editing()}>
              <div class="nc-widget crow-widget__missing nc-meta">
                <Icon name="activity" size="sm" />
                {type() ? "Loading…" : `The widget ${props.instance().type} is not available.`}
              </div>
            </Show>
          }
        >
          <ErrorBoundary
            fallback={(err) => {
              console.error(`[widgets] ${props.instance().type} failed`, err)
              return (
                <Show when={props.editing()}>
                  <div class="nc-widget crow-widget__missing nc-meta" role="alert">
                    <Icon name="activity" size="sm" />
                    {type()?.title} failed: {String((err as Error)?.message ?? err)}
                  </div>
                </Show>
              )
            }}
          >
            <Dynamic component={component()} widget={handle} />
          </ErrorBoundary>
        </Show>
      </div>
      <Show when={props.editing() && blank()}>
        <Widget
          fill
          class="crow-widget__placeholder"
          data-part="widget-placeholder"
          title={type()?.title ?? props.instance().type}
        >
          <span class="nc-meta">Nothing to show right now. Hidden on the page until it has something.</span>
        </Widget>
      </Show>
    </div>
  )
  return (
    <Show when={props.editing()} fallback={card()}>
      <ContextMenu
        class="crow-widget-menu"
        label={type()?.title ?? "Widget"}
        items={() => [
          ...(configurable()
            ? [
                {
                  id: "configure",
                  label: `Configure ${type()?.title ?? "widget"}`,
                  icon: "settings" as const,
                },
              ]
            : []),
          {
            id: "remove",
            label: `Remove ${type()?.title ?? "widget"}`,
            icon: "trash" as const,
            danger: true,
          },
        ]}
        onSelect={(id) => (id === "configure" ? props.onConfigure() : props.onRemove())}
      >
        {card()}
      </ContextMenu>
    </Show>
  )
}

function AddWidgetPicker(props: {
  open: boolean
  area: WidgetAreaProps["area"]
  onPick: (t: WidgetType) => void
  onClose: () => void
}): JSX.Element {
  const [query, setQuery] = createSignal("")
  // Each time the picker opens it starts with nothing typed.
  createEffect(
    on(
      () => props.open,
      () => setQuery(""),
    ),
  )
  const groups = createMemo(() => groupForPicker(widgetTypes(), props.area, query()))
  const first = () => groups()[0]?.[1][0]
  return (
    <Dialog
      open={props.open}
      onClose={props.onClose}
      title="Add a widget"
      size="lg"
      data-part="widget-picker"
      initialFocus={() =>
        document.querySelector<HTMLInputElement>("[data-part=widget-picker] input") ?? undefined
      }
    >
      <div class="crow-picker">
        <TextField
          variant="search"
          label="Search widgets"
          placeholder="Search widgets"
          value={query()}
          onInput={(e) => setQuery(e.currentTarget.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && first()) props.onPick(first()!)
          }}
        />
        <Show when={groups().length === 0}>
          <p class="nc-meta">No widget matches.</p>
        </Show>
        <For each={groups()}>
          {([group, types]) => (
            <section class="crow-picker__group">
              <h3 class="section nc-muted">{group}</h3>
              <div class="crow-picker__grid">
                <For each={types}>
                  {(t) => (
                    <button
                      type="button"
                      class="crow-picker__item"
                      data-widget-type={t.id}
                      onClick={() => props.onPick(t)}
                    >
                      <span class="crow-picker__icon">
                        <Icon name={iconName(t.icon ?? undefined, "grid")} />
                      </span>
                      <span class="crow-picker__text">
                        <span class="label">{t.title}</span>
                        <Show when={t.description}>
                          <span class="nc-meta">{t.description}</span>
                        </Show>
                      </span>
                      <span class="nc-meta nc-mono crow-picker__size">
                        {t.sizes.default.w}×{t.sizes.default.h}
                      </span>
                    </button>
                  )}
                </For>
              </div>
            </section>
          )}
        </For>
      </div>
    </Dialog>
  )
}

function SettingsDialog(props: {
  instance: WidgetInstance | undefined
  onSave: (settings: Record<string, unknown>) => void
  onClose: () => void
}): JSX.Element {
  const type = () => (props.instance ? widgetType(props.instance.type) : undefined)
  return (
    <Dialog
      open={!!props.instance && !!type()?.settings}
      onClose={props.onClose}
      title={type() ? `${type()!.title} settings` : "Settings"}
      data-part="widget-settings"
    >
      <Show when={props.instance && type()?.settings}>
        <SchemaForm
          schema={type()!.settings as JsonSchema}
          value={stripLimits(settingsWithDefaults(type(), props.instance!.settings))}
          submitLabel="Save"
          onSubmit={props.onSave}
          onCancel={props.onClose}
        />
      </Show>
    </Dialog>
  )
}
