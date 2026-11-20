// The editor blocks and dashboard widgets this plugin contributes, registered with the shell via
// `rookery.blocks.register` and `rookery.widgets.register`.

import type { EditorBlockType } from "@aiviarium/nocturne"
import type { ClientRookery, Disposable } from "@rookery/sdk/client"
import type { JSX } from "solid-js"

/** What a block's component is handed, as the shared editor defines it. */
export type BlockViewProps = Parameters<NonNullable<EditorBlockType["component"]>>[0]

export interface BlockOptions {
  forceWidth?: (attrs: Record<string, unknown>) => "reading" | "wide" | "full" | null | undefined
}

const noop = (): Disposable => ({ dispose() {} })

/** Registers the component of a block `contributes.blocks` declares with the shell. */
export function registerBlock(
  rookery: ClientRookery,
  id: string,
  component: (props: BlockViewProps) => JSX.Element,
  options?: BlockOptions,
): Disposable {
  return rookery.blocks?.register(id, component as never, options) ?? noop()
}

// ── widgets ──────────────────────────────────────────────────────────────────────────────────────────

export interface WidgetProps {
  widget: {
    id: string
    type: string
    settings: Record<string, unknown>
    size: { w: number; h: number }
    editing: boolean
  }
}

export type WidgetComponent = (props: WidgetProps) => JSX.Element

/** Registers the component of a widget `contributes.widgets` declares with the shell. */
export function registerWidget(rookery: ClientRookery, id: string, component: WidgetComponent): Disposable {
  return rookery.widgets?.register(id, component as never) ?? noop()
}
