// Entity UI adapters: delegates to `rookery.entities.*` when M2b is present, with plain fallbacks otherwise.
import { type JSX, Show } from "solid-js"
import type {
  ClientRookeryWithDocs,
  EntityCardProps,
  EntityChipProps,
  EntityRowProps,
  MentionPickerProps,
} from "../types"
import { openEntity } from "./api"

export function EntityChip(props: EntityChipProps & { rookery: ClientRookeryWithDocs }): JSX.Element {
  return (
    <Show
      when={props.rookery.entities?.Chip}
      fallback={
        <Show when={!props.plain} fallback={<span>{props.label ?? props.uri}</span>}>
          <button type="button" class="nc-chip" onClick={() => openEntity(props.rookery, props.uri)}>
            {props.label ?? props.uri}
          </button>
        </Show>
      }
    >
      {(Chip) => {
        const C = Chip()
        return <C uri={props.uri} label={props.label} plain={props.plain} />
      }}
    </Show>
  )
}

export function EntityCard(props: EntityCardProps & { rookery: ClientRookeryWithDocs }): JSX.Element {
  return (
    <Show when={props.rookery.entities?.Card} fallback={props.fallback ?? null}>
      {(Card) => {
        const C = Card()
        return (
          <C
            uri={props.uri}
            density={props.density}
            record={props.record}
            groupedBy={props.groupedBy}
            fallback={props.fallback}
          />
        )
      }}
    </Show>
  )
}

export function EntityRow(props: EntityRowProps & { rookery: ClientRookeryWithDocs }): JSX.Element {
  return (
    <Show when={props.rookery.entities?.Row} fallback={props.fallback ?? null}>
      {(Row) => {
        const R = Row()
        return <R uri={props.uri} record={props.record} onOpen={props.onOpen} fallback={props.fallback} />
      }}
    </Show>
  )
}

export function EntityMentionPicker(
  props: MentionPickerProps & { rookery: ClientRookeryWithDocs },
): JSX.Element {
  return (
    <Show
      when={props.rookery.entities?.MentionPicker}
      fallback={
        <Show when={props.open}>
          <span class="nc-meta">Entity picker requires Rookery entities (M2b).</span>
        </Show>
      }
    >
      {(Picker) => {
        const P = Picker()
        return (
          <P
            query={props.query}
            anchor={props.anchor}
            open={props.open}
            schemes={props.schemes}
            onPick={props.onPick}
            onClose={props.onClose}
          />
        )
      }}
    </Show>
  )
}
