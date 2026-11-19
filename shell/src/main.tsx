import * as nocturne from "@aiviarium/nocturne"
import * as rookeryClient from "@rookery/client"
import { publishSharedModules } from "@rookery/client"
import { render } from "solid-js/web"
import { App } from "./app/App"
import { createShellApp } from "./app/state"
import "./styles.css"

// The modules a plugin's client half imports without bundling them: the page has one copy of each.
publishSharedModules({
  "@aiviarium/nocturne": nocturne,
  "@rookery/client": rookeryClient,
})

const app = createShellApp()
void app.boot()

const root = document.getElementById("root")
if (root) {
  render(() => <App app={app} />, root)
}
