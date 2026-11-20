import type { Component } from "solid-js"
import {
  setShellWidgetSource,
  WidgetArea,
  type WidgetAreaProps,
  type WidgetComponent,
} from "../../../plugins/dashboards/src/widgets"
import type { ShellApp } from "./state"

export function createShellWidgetArea(app: () => ShellApp): Component<WidgetAreaProps> {
  return (props: WidgetAreaProps) => {
    setShellWidgetSource({
      types: () => app().loader.widgetTypes(),
      component: (id: string) => app().loader.widgets()[id]?.component as WidgetComponent | undefined,
    })
    return (
      <WidgetArea
        instances={props.instances}
        onChange={props.onChange}
        editing={props.editing}
        area={props.area}
        label={props.label}
      />
    )
  }
}
