// The public API of the Projects plugin: the `projects` service, which other plugins (GitHub, agents through
// the tools) call with their ctx. Issue sources use the `issues.*`, `comments.*` and `sources.*` methods;
// their params stay open (`looseObject`) because a source sends what it has.
//
// `@rookery/sdk` does not yet export `defineInterface`, so this module exports the typed Zod schemas
// directly alongside `interface.json`.
import { z } from "@rookery/sdk"

const Project = z.string().describe("Project key or space id; the current project by default")
const Issue = z.string().describe("Key (CROW-12) or URI (issue://…)")

/** An issue as the service returns it. */
export const Brief = z.looseObject({
  uri: z.string(),
  key: z.string(),
  title: z.string(),
  state: z.string().nullish(),
  category: z.string().nullish(),
  priority: z.number().nullish(),
  assignee: z.string().nullish(),
  labels: z.array(z.string()).nullish(),
  parent: z.string().nullish(),
  cycle: z.string().nullish(),
  due: z.string().nullish(),
  estimate: z.number().nullish(),
})

/** Fields an issue is created or updated with. */
const Fields = {
  state: z.string().optional().describe("State name"),
  priority: z.number().int().min(0).max(4).optional().describe("0 none, 1 urgent, 2 high, 3 medium, 4 low"),
  assignee: z.string().nullish().describe('user://… or "me"'),
  labels: z.array(z.string()).optional().describe("Label names or label:// URIs"),
  estimate: z.number().nullish(),
  due: z.string().nullish(),
  parent: z.string().nullish().describe("The parent issue's key or URI"),
  cycle: z.string().nullish(),
}

/** Which repository of which source a call is about. */
const Source = {
  provider: z.string().describe("The source's id in projects.issueSources"),
  repository: z.string(),
  repoSpace: z.string().nullish(),
}

export const projectsInterface = {
  services: {
    projects: {
      createIssue: {
        params: z.looseObject({
          title: z.string(),
          project: Project.optional(),
          description: z.string().optional().describe("Markdown"),
          link: z.string().nullish().describe("The issue source link to create it through"),
          ...Fields,
        }),
        result: Brief,
      },
      getIssue: {
        params: z.object({ issue: Issue }),
        result: Brief.extend({ text: z.string() }),
      },
      updateIssue: {
        params: z.looseObject({ issue: Issue, title: z.string().optional(), ...Fields }),
        result: Brief,
      },
      searchIssues: {
        description: "Issues matching a query in the filter language, newest first.",
        params: z.object({
          query: z.string().optional(),
          project: Project.optional(),
          limit: z.number().int().optional(),
        }),
        result: z.object({ issues: z.array(Brief) }),
      },
      comment: {
        params: z.object({ issue: Issue, body: z.string().describe("Markdown") }),
        result: z.object({ comment: z.string(), issue: z.string() }),
      },
      listStates: {
        params: z.object({ project: Project.optional() }),
        result: z.object({ states: z.array(z.object({ name: z.string(), category: z.string() })) }),
      },
      listLabels: {
        params: z.object({ project: Project.optional() }),
        result: z.object({ labels: z.array(z.object({ name: z.string(), workspace: z.boolean() })) }),
      },
      link: {
        description: "Links an issue to another issue (a relation) or to any entity (a reference).",
        params: z.object({
          issue: Issue,
          entity: z.string().describe("An issue key, or any entity's URI"),
          kind: z.enum(["blocks", "relates", "duplicate"]).optional(),
        }),
        result: z.object({ linked: z.boolean() }),
      },
      resolveKeys: {
        description:
          "For GitHub's link patterns: issue keys to issue URIs, null for keys that are not issues.",
        params: z.looseObject({ keys: z.array(z.string()).optional(), space: z.string().optional() }),
        result: z.record(z.string(), z.string().nullable()),
      },
      issueText: {
        description: "The text of an issue for an agent or a model; null when there is no such issue.",
        params: z.object({ issue: Issue }),
        result: z.object({ title: z.string(), text: z.string() }).nullable(),
      },
      startAgent: {
        description: "Starts an agent session on an issue, in a checkout on a branch of its own.",
        params: z.looseObject({}),
        result: z.unknown(),
      },
      "issues.upsertFromSource": {
        description: "Issues the source has, created or updated here.",
        params: z.looseObject({
          ...Source,
          items: z.array(z.looseObject({ external: z.string() })),
          quiet: z.boolean().optional(),
        }),
        result: z.looseObject({
          linked: z.boolean(),
          space: z.string().optional(),
          issues: z.array(
            z.object({
              external: z.string(),
              id: z.string(),
              key: z.string(),
              created: z.boolean(),
              changed: z.boolean(),
            }),
          ),
        }),
      },
      "comments.upsertFromSource": {
        description: "One issue's comments, by the issue's id at the source or its number.",
        params: z.looseObject({
          ...Source,
          issue: z.string().optional(),
          number: z.number().optional(),
          comments: z.array(z.looseObject({ external: z.string() })),
          complete: z
            .boolean()
            .optional()
            .describe("Every comment the source has: synced ones not listed go"),
          quiet: z.boolean().optional(),
        }),
        result: z.looseObject({ linked: z.boolean() }),
      },
      "issues.listFromSource": {
        description: "The issues synced through a repository.",
        params: z.looseObject({
          ...Source,
          externals: z.array(z.string()).optional(),
          comments: z.boolean().optional(),
        }),
        result: z.array(z.looseObject({})),
      },
      "issues.removedAtSource": {
        description: "The source no longer has the issue.",
        params: z.looseObject({
          ...Source,
          external: z.string(),
          removed: z.enum(["deleted", "transferred"]),
        }),
        result: z.looseObject({ linked: z.boolean() }),
      },
      "sources.link": {
        description:
          "Links a repository to a project, creating the project (as the caller) when none is named.",
        params: z.looseObject({
          ...Source,
          name: z.string(),
          url: z.string().nullish(),
          connection: z.string().nullish(),
          project: z.string().nullish(),
          projectName: z.string().nullish(),
          key: z.string().nullish(),
        }),
        result: z.looseObject({}),
      },
      "sources.unlink": {
        params: z.object({ link: z.string() }),
        result: z.looseObject({ removed: z.boolean() }),
      },
      "sources.projects": {
        description: "The links of a source's repositories to projects, with each project's key.",
        params: z.looseObject({
          provider: z.string(),
          repository: z.string().optional(),
          repoSpace: z.string().optional(),
        }),
        result: z.array(
          z.looseObject({
            id: z.string(),
            space: z.string().describe("The project's space"),
            provider: z.string(),
            repository: z.string(),
            name: z.string().nullish().describe("The repository's name at the source"),
            repoSpace: z.string().nullish(),
            key: z.string().nullable().describe("The project's key"),
          }),
        ),
      },
      "sources.find": {
        description: "The Crow issue of a source's issue, by number or id at the source; null when none.",
        params: z.looseObject({
          ...Source,
          number: z.number().optional(),
          external: z.string().optional(),
        }),
        result: z.looseObject({}).nullable(),
      },
    },
  },
} as const

export default projectsInterface
