import * as nocturne from "@aiviarium/nocturne"
import { publishSharedModules } from "@rookery/client"
import { render } from "solid-js/web"
import { App } from "./app/App"
import { createShellApp } from "./app/state"
import "./styles.css"

publishSharedModules({
  "@aiviarium/nocturne": nocturne,
})

const app = createShellApp()
void app.boot()

const root = document.getElementById("root")
if (root) {
  render(() => <App app={app} />, root)
}
