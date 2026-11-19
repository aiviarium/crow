// Templates. A space's own are pages marked `template` (saved from any page, with or without its subpages);
// these four are built in and always offered. `{{date}}` in a title or body becomes today's date.
import type { PropDef } from "./props"

export interface BuiltinTemplate {
  id: string
  title: string
  description: string
  icon: string
  /** The new page's title; `{{date}}` is replaced. */
  pageTitle: string
  markdown: string
  /** Properties the page gets (as its own, when it is not under a database). */
  schema?: PropDef[]
  props?: Record<string, unknown>
}

export const BUILTIN: BuiltinTemplate[] = [
  {
    id: "builtin:meeting",
    title: "Meeting notes",
    description: "Attendees, agenda, notes, decisions and action items.",
    icon: "users:sky",
    pageTitle: "Meeting {{date}}",
    schema: [
      { id: "date", name: "Date", type: "date" },
      { id: "attendees", name: "Attendees", type: "relation", schemes: ["user"] },
    ],
    props: { date: "{{date}}" },
    markdown: `## Agenda

-

## Notes

## Decisions

-

## Action items

- [ ]
`,
  },
  {
    id: "builtin:decision",
    title: "Decision record",
    description: "Context, the options weighed, the decision and its consequences.",
    icon: "check:mint",
    pageTitle: "New decision",
    schema: [
      {
        id: "status",
        name: "Status",
        type: "select",
        options: [
          { id: "proposed", name: "Proposed", hue: "amber" },
          { id: "accepted", name: "Accepted", hue: "mint" },
          { id: "superseded", name: "Superseded", hue: "neutral" },
        ],
      },
      { id: "decided", name: "Decided", type: "date" },
    ],
    props: { status: "proposed" },
    markdown: `## Context

What is the issue we are seeing that motivates this decision?

## Options

1.
2.

## Decision

## Consequences

What becomes easier or harder because of this change?
`,
  },
  {
    id: "builtin:runbook",
    title: "Runbook",
    description: "When to use it, the steps, how to check, and how to roll back.",
    icon: "terminal:teal",
    pageTitle: "New runbook",
    schema: [
      { id: "owner", name: "Owner", type: "person" },
      { id: "review", name: "Review", type: "date" },
    ],
    markdown: `Use this when

## Steps

- [ ]
- [ ]

## Check

> [!TIP]
> How do you know it worked?

## Roll back

\`\`\`sh
\`\`\`
`,
  },
  {
    id: "builtin:weekly",
    title: "Weekly notes",
    description: "What happened, what is next, and what is in the way.",
    icon: "calendar:orchid",
    pageTitle: "Week of {{date}}",
    markdown: `## Done

-

## Next

- [ ]

## Blocked

-
`,
  },
]

/** Today as `YYYY-MM-DD`. */
export const today = (now = new Date()) =>
  `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`

/** Replaces `{{date}}` in a string. */
export const fill = (s: string, now = new Date()) => s.replaceAll("{{date}}", today(now))
