// Widgets are declared in plugin.json; client halves register their components through `rookery.widgets.register`.
import type { ClientRookery, Disposable, WidgetComponent, WidgetProps } from "@rookery/sdk/client"

export type { WidgetComponent, WidgetProps }

export function registerWidget(rookery: ClientRookery, id: string, component: WidgetComponent): Disposable {
  return rookery.widgets.register(id, component)
}
