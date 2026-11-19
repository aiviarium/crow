export {
  clearWidgetRegistry,
  defineBuiltinWidget,
  limits,
  newInstanceId,
  registerManifestWidgets,
  registerWidget,
  SHELL,
  type SharedWidgetStore,
  settingsWithDefaults,
  WIDGET_REGISTRY_SYMBOL,
  widgetComponent,
  widgetType,
  widgetTypes,
} from "./registry"
export { groupForPicker } from "./settings"
export type {
  WidgetArea as WidgetAreaKind,
  WidgetAreaProps,
  WidgetComponent,
  WidgetHandle,
  WidgetInstance,
  WidgetProps,
  Widgets,
  WidgetType,
} from "./types"
export { WidgetArea } from "./WidgetArea"
