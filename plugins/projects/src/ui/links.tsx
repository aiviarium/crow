// `[[` links to docs pages in the editors of issues (description, the new issue's draft, comments): a linked
// page becomes a mention, so the reference index has it and the page lists the issue under "linked from".

import { EditorServicesProvider, type MentionItem, useEditorServices } from "@aiviarium/nocturne"
import type { ClientRookery } from "@rookery/sdk/client"
import type { JSX } from "solid-js"
import { entitiesOf } from "./sdk"

export function WithPageLinks(props: { crow: ClientRookery; children: JSX.Element }): JSX.Element {
  const base = useEditorServices()
  const search = async (q: string): Promise<MentionItem[]> => {
    const hits = await entitiesOf(props.crow)
      .search(q, { schemes: ["doc"], limit: 8 })
      .catch(() => [])
    return hits
      .filter((h) => !h.deletedAt)
      .map((h) => ({ uri: h.uri, title: h.title, subtitle: "Page", icon: "file" }))
  }
  return (
    <EditorServicesProvider value={{ ...base, links: { search } }}>{props.children}</EditorServicesProvider>
  )
}
