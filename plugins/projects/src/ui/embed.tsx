// An issue drawn outside Projects (a document's database, a search result): the same card as the board's and
// the same row as the list's, registered as the `issue` scheme's renderers (crow.entities.card, .row). The
// caller usually has the issue's record; otherwise it is looked up. The project's states and labels come from
// a light store that does not follow every issue.
import type { ClientRookery } from "@rookery/sdk/client"
import { type Accessor, createMemo, createResource, onCleanup, Show } from "solid-js"
import type { IssueRow } from "../lib/model"
import { CardBody } from "./board"
import { IssueRowCells } from "./list"
import { type EntityRendererProps, entitiesOf } from "./sdk"
import { acquireLookups, type ProjectStore } from "./store"

function useIssue(crow: ClientRookery, p: EntityRendererProps): Accessor<IssueRow | undefined> {
  const [space] = createResource(
    () => (p.record ? null : p.uri),
    async (uri) => (await entitiesOf(crow).resolve(uri))?.spaceId ?? null,
  )
  const live = createMemo(() => {
    const sp = space()
    return sp ? crow.data.space(sp).issues.live({ where: { id: p.id }, limit: 1 }) : null
  })
  return () => (p.record as IssueRow | undefined) ?? (live()?.()[0] as unknown as IssueRow | undefined)
}

function useLookups(
  crow: ClientRookery,
  issue: Accessor<IssueRow | undefined>,
): Accessor<ProjectStore | null> {
  return createMemo(() => {
    const sp = issue()?.spaceId
    if (!sp) return null
    const { store, release } = acquireLookups(crow, sp)
    onCleanup(release)
    return store
  })
}

/** The board's card of an issue, inside the caller's BoardCard. */
export function IssueCardEmbed(props: { crow: ClientRookery; p: EntityRendererProps }) {
  const issue = useIssue(props.crow, props.p)
  const store = useLookups(props.crow, issue)
  // A board grouped by state (or its category) has the state in its lanes, as Projects' board does.
  const groupBy = () =>
    props.p.groupedBy === "state" || props.p.groupedBy === "stateCategory"
      ? ("state" as const)
      : ("none" as const)
  return (
    <Show when={issue() && store() ? { issue: issue()!, store: store()! } : null}>
      {(x) => (
        <CardBody crow={props.crow} store={x().store} issue={x().issue} display={{ groupBy: groupBy() }} />
      )}
    </Show>
  )
}

/** The list's row of an issue, read-only; a click opens it. */
export function IssueRowEmbed(props: { crow: ClientRookery; p: EntityRendererProps }) {
  const issue = useIssue(props.crow, props.p)
  const store = useLookups(props.crow, issue)
  return (
    <Show when={issue()}>
      {(i) => (
        // biome-ignore lint/a11y/useKeyWithClickEvents lint/a11y/noStaticElementInteractions: the title's link is the keyboard's way in
        <div
          class="projects__row projects__row--embed"
          data-issue={i().id}
          data-key={i().key}
          data-selected={props.p.selected ? "" : undefined}
          onClick={(e) => {
            if ((e.target as HTMLElement).closest("a")) return
            props.p.onOpen()
          }}
        >
          <IssueRowCells crow={props.crow} store={store()} issue={i()} readOnly onChange={() => {}} />
        </div>
      )}
    </Show>
  )
}
