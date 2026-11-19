// Small pictures the Nocturne board draws for issues: the state ring (dashed for backlog, a pie filling up
// while started, a check when done), the priority bars (an exclamation box for urgent), label dots, and
// people as avatars. Colours are tokens, by hue name.
import { Avatar, LabelChip, type LabelHue } from "@aiviarium/nocturne"
import { type JSX, Match, Show, Switch } from "solid-js"
import type { Category } from "../lib/model"

/** A hue name (`warning`, `sky`, `muted`, …) as a CSS colour from the tokens. */
export function hueVar(hue: string | null | undefined): string {
  switch (hue) {
    case "accent":
      return "var(--accent-strong)"
    case "success":
    case "warning":
    case "danger":
    case "info":
      return `var(--${hue})`
    case "sky":
    case "teal":
    case "mint":
    case "amber":
    case "ember":
    case "rose":
    case "orchid":
      return `var(--label-${hue})`
    case "slate":
      return "var(--text-2)"
    default:
      return "var(--text-3)"
  }
}

/** The LabelChip hue for a label colour (`muted` has none: its dot is drawn in text-3). */
export const chipHue = (hue: string | null | undefined): LabelHue | undefined =>
  hue && hue !== "muted" && hue !== "slate" ? (hue as LabelHue) : undefined

export function StateIcon(props: {
  category: Category | null | undefined
  color?: string | null
  size?: number
}) {
  const c = () => hueVar(props.color ?? (props.category === "completed" ? "accent" : null))
  const s = () => props.size ?? 14
  return (
    <svg
      width={s()}
      height={s()}
      viewBox="0 0 14 14"
      aria-hidden="true"
      class="projects__state-icon"
      data-category={props.category ?? "none"}
    >
      <Switch
        fallback={
          <circle
            cx="7"
            cy="7"
            r="5.5"
            fill="none"
            stroke-width="1.5"
            style={{ stroke: c() }}
            stroke-dasharray={props.category === "backlog" ? "1.8 1.8" : undefined}
          />
        }
      >
        <Match when={props.category === "started"}>
          <circle cx="7" cy="7" r="5.5" fill="none" stroke-width="1.5" style={{ stroke: c() }} />
          <path d="M7 3.5A3.5 3.5 0 0 1 7 10.5Z" style={{ fill: c() }} />
        </Match>
        <Match when={props.category === "completed"}>
          <circle cx="7" cy="7" r="6" style={{ fill: c() }} />
          <path
            d="M4.4 7.2 6.2 9 9.7 5.2"
            fill="none"
            stroke-width="1.5"
            stroke-linecap="round"
            stroke-linejoin="round"
            style={{ stroke: "var(--bg-1)" }}
          />
        </Match>
        <Match when={props.category === "cancelled"}>
          <circle cx="7" cy="7" r="6" style={{ fill: c() }} />
          <path
            d="M5 5l4 4M9 5l-4 4"
            stroke-width="1.5"
            stroke-linecap="round"
            style={{ stroke: "var(--bg-1)" }}
          />
        </Match>
      </Switch>
    </svg>
  )
}

export function PriorityIcon(props: { priority: number | null | undefined }) {
  const p = () => props.priority ?? 0
  return (
    <Switch
      fallback={
        <svg
          width="14"
          height="14"
          viewBox="0 0 14 14"
          aria-hidden="true"
          class="projects__priority"
          data-priority="0"
        >
          <path
            d="M2.5 7h2M6 7h2M9.5 7h2"
            stroke-width="1.5"
            stroke-linecap="round"
            style={{ stroke: "var(--text-3)" }}
          />
        </svg>
      }
    >
      <Match when={p() === 1}>
        <span class="projects__urgent" data-priority="1" aria-hidden="true">
          <svg width="10" height="10" viewBox="0 0 14 14" aria-hidden="true">
            <path
              d="M7 3v4.5M7 10.5v.2"
              stroke-width="2"
              stroke-linecap="round"
              style={{ stroke: "var(--bg-1)" }}
            />
          </svg>
        </span>
      </Match>
      <Match when={p() >= 2}>
        <svg
          width="14"
          height="14"
          viewBox="0 0 14 14"
          aria-hidden="true"
          class="projects__priority"
          data-priority={p()}
        >
          <rect x="1.5" y="8" width="2.5" height="4.5" rx="1" style={{ fill: "var(--text-2)" }} />
          <rect
            x="5.75"
            y="5"
            width="2.5"
            height="7.5"
            rx="1"
            style={{ fill: p() <= 3 ? "var(--text-2)" : "var(--line-strong)" }}
          />
          <rect
            x="10"
            y="2"
            width="2.5"
            height="10.5"
            rx="1"
            style={{ fill: p() <= 2 ? "var(--text-2)" : "var(--line-strong)" }}
          />
        </svg>
      </Match>
    </Switch>
  )
}

export function Person(props: { name: string; size?: "sm" | "md" | "lg"; title?: string }) {
  return (
    <span class="projects__person" title={props.title ?? props.name}>
      <Avatar name={props.name} size={props.size ?? "sm"} />
    </span>
  )
}

export function Unassigned() {
  return (
    <span class="projects__unassigned" aria-hidden="true">
      <svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true">
        <circle
          cx="8"
          cy="8"
          r="7"
          fill="none"
          stroke-width="1.2"
          stroke-dasharray="2 2"
          style={{ stroke: "var(--text-3)" }}
        />
        <path
          d="M8 4.8a1.9 1.9 0 1 0 0 3.8a1.9 1.9 0 1 0 0-3.8M4.9 11.6c.4-1.5 1.6-2.3 3.1-2.3s2.7.8 3.1 2.3"
          fill="none"
          stroke-width="1.2"
          style={{ stroke: "var(--text-3)" }}
        />
      </svg>
    </span>
  )
}

export function Label(props: { name: string; color?: string | null }): JSX.Element {
  return (
    <LabelChip
      hue={chipHue(props.color)}
      class="projects__label"
      data-muted={!chipHue(props.color) ? "" : undefined}
    >
      {props.name}
    </LabelChip>
  )
}

export function Key(props: { children: string }) {
  return <span class="mono projects__key">{props.children}</span>
}

export function Maybe(props: { when: unknown; children: JSX.Element }) {
  return <Show when={props.when}>{props.children}</Show>
}
