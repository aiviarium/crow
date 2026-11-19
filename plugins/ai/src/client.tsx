// The client half of the Models plugin: the Models page, "Ask AI" in the editor, and dictation in text
// inputs, wired to the ai router's RPC methods through Rookery's plugin host handle.
import { defineClient } from "@rookery/sdk/client"
import { createSignal } from "solid-js"
import { assistant } from "./client/assist"
import { calls, type TaskInfo } from "./client/calls"
import { ModelsPage } from "./client/page"
import { speechSource } from "./client/speech"
import type { ClientRookeryWithAi } from "./client/types"
import "./client.css"

export default defineClient((baseRookery) => {
  const rookery = baseRookery as ClientRookeryWithAi
  const api = calls(rookery.host)
  const [tasks, setTasks] = createSignal<TaskInfo[]>([])
  const available = (task: string) => tasks().some((t) => t.task === task && t.available)

  // Which tasks this person has, so features that need one hide without it.
  const refreshTasks = () => {
    api.tasks().then(setTasks, () => setTasks([]))
  }
  refreshTasks()

  // An admin may map a task while this window is open.
  if (typeof window !== "undefined") window.addEventListener("focus", refreshTasks)
  const timer = setInterval(refreshTasks, 60_000)
  ;(timer as { unref?: () => void }).unref?.()

  rookery.views.register("ai.models", (props) => {
    props.view.setTitle("Models")
    return <ModelsPage rookery={rookery} calls={api} refreshTasks={refreshTasks} />
  })

  rookery.commands.register("ai.models", {
    title: "Open Models",
    run: () => {
      rookery.workbench.openView("ai.models")
    },
  })

  const assist = assistant(api)
  rookery.assist?.provide((req) => {
    if (!available("text")) return (async function* () {})()
    return assist(req)
  })
  rookery.speech?.provide(
    speechSource({
      calls: api,
      available: () => available("transcription"),
      language: async () =>
        (await rookery.settings.get("ai.dictationLanguage" as never).catch(() => undefined)) as
          | string
          | undefined,
    }),
  )
})
