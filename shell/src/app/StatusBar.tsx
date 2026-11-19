// Bottom status bar: stays empty when all is well; shows connection health and plugin status items.
import { For, type JSX } from "solid-js"
import { Dynamic } from "solid-js/web"
import { ConnectionStatus } from "./ConnectionStatus"
import type { ShellApp } from "./state"

export function StatusBar(props: { app: ShellApp }): JSX.Element {
  return (
    <>
      <ConnectionStatus app={props.app} />
      <For each={Object.entries(props.app.loader.statusItems())}>
        {([key, item]) => (
          <span class="crow-status-item" data-part="status-item" data-plugin={item.plugin} data-key={key}>
            <Dynamic component={item.component} />
          </span>
        )}
      </For>
    </>
  )
}
