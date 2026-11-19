// Dashboard widget contribution types and client handle contract.
// Mirrors the `contributes.widgets` manifest shape (`WidgetContribution` from `@rookery/client`)
// until `@rookery/sdk/client` exposes `rookery.widgets` directly.
import type { WidgetArea as ManifestWidgetArea, WidgetContribution } from "@rookery/client"
import type { Disposable } from "@rookery/sdk/client"
import type { Component, JSX } from "solid-js"

export type WidgetArea = ManifestWidgetArea

/** A widget placed on a grid: which widget, where, how big, and its settings. Stored with the layout. */
export interface WidgetInstance {
  /** Unique within the layout. */
  id: string
  /** The widget's id from the manifest: e.g. `projects.myIssues`. */
  type: string
  x: number
  y: number
  w: number
  h: number
  settings?: Record<string, unknown>
}

/** A widget a plugin (or the shell) declares. */
export type WidgetType = WidgetContribution & { plugin: string }

/** What a widget's component gets. Every member that can change is a getter: read it where it is used. */
export interface WidgetHandle {
  /** The widget's id: e.g. `projects.myIssues`. */
  readonly type: string
  readonly plugin: string
  /** This instance in its layout. */
  readonly instance: string
  readonly area: WidgetArea
  /** The settings, with the defaults of the settings schema filled in. */
  readonly settings: Readonly<Record<string, unknown>>
  /** Its size on the grid, in cells. */
  readonly size: Readonly<{ w: number; h: number }>
  /** The grid is being edited: do not start anything the user would trigger by clicking. It is also when a problem
   * only the arranger can fix is shown; otherwise render nothing. */
  readonly editing: boolean
  /** A number that goes up every `refreshSecs` (and when the connection comes back), for widgets that
   * fetch with `rookery.host.call`: `createResource(handle.refreshed, ...)`. Live queries need no refresh. */
  refreshed(): number
  /** Keeps some of the widget's own state with its settings. */
  update(patch: Record<string, unknown>): void
}

export interface WidgetProps {
  widget: WidgetHandle
}

export type WidgetComponent = (props: WidgetProps) => JSX.Element

export interface WidgetAreaProps {
  /** The layout. */
  instances: WidgetInstance[]
  /** Called when the person arranged, resized, added, configured or removed widgets. */
  onChange(next: WidgetInstance[]): void
  /** Widgets can be arranged, configured and removed, and the picker is offered. */
  editing: boolean
  area: WidgetArea
  /** Names the grid. */
  label?: string
}

export interface Widgets {
  /** Registers the component of a widget declared in `contributes.widgets`. */
  register(id: string, component: WidgetComponent): Disposable
  /** Every widget declared by any plugin and the shell, as a Solid accessor. */
  types(): WidgetType[]
  /** `<widgets.Area instances={…} onChange={…} editing={…} area="dashboard" />` */
  readonly Area: Component<WidgetAreaProps>
}
