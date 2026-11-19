// The public API of the GitHub plugin: the `github` service. Agent sessions, the workbench and the `code`
// commands open pull requests and link sessions to branches through it; Projects calls the issue-source
// methods it names in its contribution to `projects.issueSources`, and the agents plugin the ones in
// `agents.codeHosts`.
//
// `@rookery/sdk` does not yet export `defineInterface`, so this module exports the typed Zod schemas directly
// alongside `interface.json`.
import { z } from "@rookery/sdk"

/** A pull request as the service returns it. */
export const PullRequestRef = z.object({
  uri: z.string().describe("gh-pr://…"),
  repo: z.string().describe("owner/name"),
  number: z.number().nullable(),
  title: z.string(),
  state: z.enum(["open", "closed", "merged"]),
  url: z.string().nullable(),
  head: z.string().nullable(),
  headSha: z.string().nullable(),
})

const Space = z
  .string()
  .optional()
  .describe("The space whose attached repositories to use; the caller's by default")

/** A link between a project and a repository, as Projects sends it. */
const ProjectLink = z.looseObject({
  id: z.string(),
  space: z.string().describe("The project's space"),
  name: z.string().optional(),
  repository: z.string().describe("gh-repo://…"),
  repoSpace: z.string().nullish().describe("The space the repository is attached to"),
})

export const githubInterface = {
  services: {
    github: {
      createPullRequest: {
        description: "Opens a pull request through the caller's GitHub connection.",
        params: z.object({
          repo: z
            .string()
            .describe("owner/name, or the repository's git URL; the head branch must be on GitHub"),
          head: z.string(),
          base: z.string().optional(),
          title: z.string(),
          body: z.string().optional(),
          draft: z.boolean().optional(),
          reviewers: z.array(z.string()).optional().describe("GitHub logins"),
          space: Space,
        }),
        result: z.object({
          number: z.number(),
          url: z.string(),
          title: z.string(),
          existing: z
            .boolean()
            .describe("A pull request for this branch was already open; nothing was created"),
          uri: z.string().optional().describe("gh-pr://…, when the repository is attached to a space"),
        }),
      },
      linkSession: {
        description:
          "Says that an agent session worked on a branch: every pull request from it, now or later, references the session. Call it again when the session pushes, with headSha.",
        params: z.object({
          session: z.string().describe("session://<id>"),
          branch: z.string(),
          headSha: z.string().optional(),
          repo: z.string().optional(),
          space: Space,
        }),
        result: z.object({ pulls: z.array(PullRequestRef) }),
      },
      unlinkSession: {
        description: "Removes the link of a session to one branch, or to all of its branches.",
        params: z.object({ session: z.string(), branch: z.string().optional(), space: Space }),
        result: z.object({ removed: z.number() }),
      },
      pullRequestsFor: {
        description: "The pull requests from a branch, newest first.",
        params: z.object({
          branch: z.string(),
          repo: z.string().optional(),
          headSha: z.string().optional(),
          space: Space,
        }),
        result: z.array(PullRequestRef),
      },
      pushIssue: {
        description:
          "projects.issueSources: writes a change made in Crow to the GitHub issue, as the caller.",
        params: z.looseObject({
          link: ProjectLink.extend({ name: z.string() }),
          create: z.boolean(),
          external: z.string().nullish(),
          number: z.number().nullish(),
          fields: z.array(z.enum(["title", "body", "state", "labels", "assignee"])),
          issue: z.looseObject({ id: z.string(), key: z.string(), title: z.string() }),
          comment: z.looseObject({ op: z.enum(["create", "edit", "delete"]), id: z.string() }).optional(),
        }),
        result: z.looseObject({}),
      },
      linkableRepositories: {
        description: "projects.issueSources: the attached repositories the caller can see.",
        params: z.looseObject({ space: z.string().optional() }),
        result: z.object({
          repositories: z.array(z.looseObject({ repository: z.string(), name: z.string() })),
        }),
      },
      projectLinked: {
        description: "projects.issueSources: a project was linked to one of its repositories; sync it now.",
        params: z.object({ link: ProjectLink }),
        result: z.object({ ok: z.boolean() }),
      },
      projectUnlinked: {
        description: "projects.issueSources: a project was unlinked from one of its repositories.",
        params: z.object({ link: ProjectLink }),
        result: z.object({ ok: z.boolean() }),
      },
    },
  },
} as const

export default githubInterface
