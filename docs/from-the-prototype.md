# From the prototype

The prototype, `helightdev/crow`, was one repository: the kernel, the shell, the plugins, the components,
the language SDKs, the desktop app and the connector. The first version splits it across five projects,
and Crow keeps the shell and the plugins.

| Project | Holds |
| --- | --- |
| Rookery | The server, hosts, the plugin system and the frontend framework |
| Crow | The shell and the plugins below |
| Parrot | The agent CLIs, their drivers, terminals and TUI automation |
| Hatchery | Packages and registries |
| Nocturne | The components and tokens the shell and the plugins are built from |

The pages of the other four say what moved there. This page is Crow's.

## The shell

| In the prototype | Here |
| --- | --- |
| `crow serve`, `crow dev` | `rookery serve`, and `bun run dev` in a Crow checkout against it |
| `@crow/shell`, a folder the kernel served | `@crow/shell`, packed as the Hatchery package `crow/shell`, which contributes the shell and is installed like a plugin |
| Home, inbox and jobs in the shell | The same, in `shell/src/` |
| Admin, built into the shell | The `crow/fleet` plugin's admin pages: server settings, secrets, registries, plugins and the installation |
| Settings and the search and command palette, in the shell | Not in this version |
| `@crow/ui` | `@aiviarium/nocturne` ([Nocturne](https://nocturne.helight.dev/docs)) |

## The plugins

| Prototype plugin | Here |
| --- | --- |
| `fleet` | `crow/fleet`: hosts from Rookery, with machines, provisioners, jobs, desktops, ports and the admin pages. The berth provider is gone |
| `terminal` | `crow/terminal` |
| `agents` | `crow/agents`, on Parrot: the chat, tool steps, approvals and questions, over `agents.connect` |
| `agent-claude`, `agent-codex`, `agent-pi`, `agent-acp` | Parrot's `parrot-driver-*` programs and their eggs. Crow has no drivers |
| `ai`, `ai-router`, `model-anthropic` | `crow/ai`, with the router inside it, and `crow/model-anthropic` |
| `github` | `crow/code`, because Rookery has a host plugin called `github` and ids are one namespace. Its namespace, service and URLs stay `github` |
| `projects`, `docs`, `dashboards`, `workbench` | The same plugins, under the same names |

A plugin is still a folder with a manifest, a host half and a client half, but the manifest is
`rookery/plugin.json` and the package is a Hatchery egg with a `rookery` target. The prototype's
`interface.json` and `crow plugin check-interface` are not ported: `rookery plugin check` checks a package
against Rookery's contract instead
([Writing a plugin](https://rookery.helight.dev/docs/extend/writing-plugins)).

## The rest of the repository

| In the prototype | Here |
| --- | --- |
| `crates/crow-term`, `crow-tui`, `crow-models` | Parrot's `parrot-term`, `parrot-tui` and `parrot-models` |
| `crates/crow-kernel*`, `crow-store`, `crow-proto` | Rookery's server ([Rookery](https://rookery.helight.dev/docs/reference/from-the-prototype)) |
| `.crowplugin`, `plugins.lock` | Hatchery eggs and `eggs.lock` ([Hatchery](https://hatchery.helight.dev/docs/from-the-prototype)) |
| `sdks/` for TypeScript, Rust, Python, the JVM and C#, with conformance | `@rookery/client` and `@rookery/sdk` for the shell and plugins, and nothing else |
| `ui/` | Nocturne |
| `desktop/`, the Tauri app | Not in this version |
| `crates/crow-connector` | Not in this version |

## What is new

- Hosts are Rookery's: a profile, a `rookeryd` link and grants on `env://NAME`, with jobs for every change.
  The prototype's environments came from berth or a plugin's provider.
- A shell is a package, so a server without one says so and Crow is installed from a registry.
- Agent sessions are Parrot's, reached through one authorised stream to the host.
- Plugins bring host features, provisioners, app services, extension points and jobs, and Rookery checks
  every package before it installs it.

## Left out

| Left out | What instead |
| --- | --- |
| The desktop app, and the connector on a person's own machine | A browser, and a host reached over SSH |
| The search and command palette, settings pages in the shell | Each plugin's own pages, and the admin pages |
| The `crow://` links the desktop app opened | URLs of the shell's routes |
| App services over gRPC, with the `@crow/service` SDK | App services placed at a URL and called over JSON-RPC |
| Plugin tools offered to agents as MCP tools | `box mcp` on a host, for its desktop, and Parrot's own functions, which the runtime gives the agent CLI |

Rookery's [Not in this version](https://rookery.helight.dev/docs/reference/not-in-this-version) lists what
the release leaves out.
