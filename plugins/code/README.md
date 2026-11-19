# GitHub

Repositories attached to a space, with their pull requests kept in sync and their issues synced both ways as
Projects issues, reviews, merges and comments from Crow, links to what you track in Crow, notifications, and
tools for agents. Ported from the prototype's `github` plugin.

The plugin's id is `code`, because Rookery ships a host plugin called `github` (`gh`, the CLI) and plugin ids
are one namespace. Its URLs, view ids and the service stay under the name people read: the namespace is
`github` (`/<space>/github/pulls`), the service is `github`, and the extension point is `github.linkPatterns`.

## Set up

1. **Connect.** Open GitHub › Connect. An admin can create a GitHub App from Crow (GitHub asks to confirm it
   and sends the browser back), or you enter the ids of an app you made in Settings › Connections (type
   "GitHub App installation"). Anyone can add a personal access token (type "GitHub personal access token");
   comments, reviews and merges are then made as that person. A different API URL
   (`https://HOST/api/v3`) is GitHub Enterprise Server. **Test** says who the connection is, what it reaches
   and how much of the rate limit is left.
2. **Attach.** In a space, Repositories › Attach a repository, and pick the project its issues go to (a new
   one named after it by default). Polling starts at once (every minute by default; idle polls cost no rate
   limit). Where GitHub can reach `/hooks/code/events` on this server, give the app a webhook secret and its
   deliveries are applied at once.
3. **Map people.** A person who adds their own token is known by their GitHub login; that drives "mine",
   review requests and notifications.

## For other plugins

- Service `github` (`interface.ts`): `createPullRequest`, `linkSession`, `unlinkSession`, `pullRequestsFor`,
  and the issue-source methods Projects calls (`pushIssue`, `linkableRepositories`, `projectLinked`,
  `projectUnlinked`).
- Extension point `github.linkPatterns`: tell the plugin how your issue keys look and how to resolve them.
- The source `github` of Projects' `projects.issueSources`; the link provider of `agents.codeHosts`.
- Entities `gh-repo://`, `gh-pr://`; tools `code.read`, `code.search`, `code.checks`, `code.comment`,
  `code.openPullRequest`.

## Try it without GitHub

`bun plugins/code/test/mock/github.ts` is the mock GitHub the tests use: token and app authentication, ETags,
pagination, rate limits, webhooks and refusals. `test/http.test.ts` drives it.

## What is not ported

- **Legacy issue storage.** The prototype kept GitHub issues in its own `issues` collection before issues were
  Projects issues, and converted them at start. A new deployment has no such rows, so the collection, the
  conversion and the `gh-issue://` alias are not ported. Issues are Projects issues from the first sync.
- **The prototype's Markdown renderer** (`lib/markdown.ts`, `components/Md.tsx`). Descriptions and comments
  render with Nocturne's read-only rich text editor, as Docs and Projects do.
- **Space-scoped and per-kind notification settings.** Rookery settings are default/global/user, so the three
  notification kinds and the poll interval are global or personal, not per space.
