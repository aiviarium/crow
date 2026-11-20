# A server with Crow on it

Crow is the web shell a Rookery server serves, and the plugins that fill it: hosts, terminals, agent
sessions, models, projects, docs, dashboards, the workbench and GitHub. Rookery has no interface of its
own, so a server without Crow answers `/` with a page that says no shell is installed.

This page installs a server, puts Crow on it and takes the first steps. Rookery's own documentation has
the server in full, and is linked rather than repeated.

| What | For |
| --- | --- |
| Docker with Compose, and Bun 1.3 or newer | The server here, and building Crow's packages |
| A Crow checkout | `bun run pack` |
| An address a browser reaches | `ROOKERY_PUBLIC_URL`: the sign-in links and the session cookie name it |

## 1. Run the server

[A Rookery server](https://rookery.helight.dev/docs/use/server#run-it-with-compose) has a compose file
with `rookery serve` and a PostgreSQL of its own. Write it where you keep the server's settings, with
your address in `ROOKERY_PUBLIC_URL`, and start it:

```bash
docker compose up -d --wait
```

The first start makes the database and migrates it. Leave `ROOKERY_SHELL_DIR` unset: the shell is a Crow
package, served from `/` once it is installed.

## 2. Build Crow's packages

```bash
cd crow
bun run bootstrap     # .deps/ and the packages, once per checkout
bun run pack          # the shell and every plugin, into dist/registry
```

`bun run pack` builds the shell and each plugin's halves, and writes a static
[Hatchery registry](https://hatchery.helight.dev/docs/registries) to `dist/registry`. Crow publishes no
registry of its own, so this folder is the one to install from.

| Package | Is |
| --- | --- |
| `crow/shell` | The page the server serves at `/` |
| `crow/fleet` | Hosts, machines, provisioners, jobs, desktops, ports and the server's admin pages |
| `crow/terminal` | Terminals on a host, in the main area and the bottom panel |
| `crow/agents` | Agent sessions on a host, through Parrot |
| `crow/ai` | Model connections, a model per task, usage and limits |
| `crow/model-anthropic` | The Anthropic provider that `crow/ai` calls |
| `crow/projects` | Projects, issues, cycles and labels |
| `crow/docs` | Documents and a knowledge base |
| `crow/dashboards` | Pages of widgets on a grid |
| `crow/workbench` | Editor, diffs and version control on a host |
| `crow/code` | GitHub: repositories, pull requests, issues and reviews. Its id is `code` because Rookery has a plugin called `github` of its own |

## 3. Install them on the server

The server reads a `dir` registry on its own machine, so give it Crow's folder in the compose file:

```yaml title="In the rookery service's volumes"
      - ./crow/dist/registry:/srv/registry:ro
```

Run `docker compose up -d` again so the container has the folder, then add the registry and the
packages. The commands run inside the container, where the `rookery` command line reaches the server's
socket as its admin, with no token:

```bash
docker compose up -d
docker compose exec rookery rookery plugin registry add dir /srv/registry --min-age 0
docker compose exec rookery rookery plugin add crow/shell
for id in fleet terminal agents ai model-anthropic projects docs dashboards workbench code; do
  docker compose exec -T rookery rookery plugin add "crow/$id"
done
docker compose exec rookery rookery plugin list
```

The shell is the page. Every other package adds its views to the sidebar, and a page reload shows a
package that was installed after it loaded. `--min-age 0` installs a new version at once, which a
registry in a folder does not wait for anyway.

With the `rookery` command line on your own machine, signed in with `rookery login`, an egg or a package
folder from the checkout goes to the server instead:

```bash
rookery plugin add ./dist/registry/crow/fleet
rookery plugin add ./dist/registry/crow/fleet/fleet-0.1.0.egg
```

## 4. Sign in as the first admin

```bash
docker compose exec rookery rookery server setup-key
```

Open the link it prints in a browser. It signs in the first admin once, and works for a day. The link
names `ROOKERY_PUBLIC_URL`, so open it where that address reaches. Other people join with a link an
admin makes ([Sign-in links](https://rookery.helight.dev/docs/use/server#with-a-sign-in-link)).

Crow's home says how many plugins are connected. The sidebar lists Fleet, Terminals, Agents, Models,
Projects, Docs, Dashboards and Workbench, and GitHub's pull requests, issues and repositories.

## 5. Add a host

**Fleet › Add host** takes a machine that exists: its name, address, SSH user and port, a key, the SSH
agent or a password, and a type.

| Type | What is on the host, and what Rookery does with it |
| --- | --- |
| `workstation` | The whole profile: a desktop, the accounts and what its plugins install |
| `node` | A server's part of the profile: applying, roll-outs and plugin features |
| `managed` | `rookeryd` and `box`: sessions, the channel, files and actions |
| `ssh` | Nothing of Rookery: a terminal and commands over SSH |

**Add host** saves the host, and with **Run first contact** ticked it also trusts the machine's key and
installs Rookery's own. **New machine** asks a provisioner for one instead
([Provisioners](https://rookery.helight.dev/docs/deploy/provisioners)).

The host's page then has **Apply**, which writes the profile to the machine. An apply is a job: its log is
under **Recent jobs** and on the job's page, and the host's state changes when it ends.

The command line does the same:

```bash
rookery host add studio 192.0.2.10 --user ops     # save a machine that exists
rookery apply studio                              # the job, with its log
rookery job logs -f                               # follow it
```

## 6. The first steps after that

| To | Do |
| --- | --- |
| Open a terminal | **Terminal** on the host's Connect card, or the bottom panel |
| See the desktop | **Desktop** on the host's page, for a `workstation` ([The desktop](https://rookery.helight.dev/docs/use/access#the-desktop)) |
| Share a host | **Share…** gives an account or a group `view`, `use` or `manage` ([Who may use it](https://rookery.helight.dev/docs/use/server#who-may-use-it)) |
| Start an agent | **Agents**: pick a host with an agent feature, then a session. The host runs Parrot, which Rookery stages with the apply ([Host agent sessions](https://rookery.helight.dev/docs/use/server#host-agent-sessions)) |
| Use a model | **Models**: add an Anthropic connection, map the Text, Fast and Transcription tasks, and try one |
| Install a host plugin | **Admin › Plugins**, for the plugins Rookery ships, such as `github` and `unity` ([Plugins](https://rookery.helight.dev/docs/extend/plugins)) |
| Change the server | **Admin › Server settings**, **Secrets**, **Registries** and **Installation** |
| Bring the hosts up to date | **Admin › Installation › Rollout**, or `rookery rollout` ([Updates](https://rookery.helight.dev/docs/use/updates)) |

Agents need two things before a session starts. The host's profile names an agent feature, such as
`claude/cli`, which comes from a package with a Rookery target ([Behind Rookery](https://parrot.helight.dev/docs/rookery)),
and the server has `ROOKERY_PARROT_BIN` set to a Parrot binary to send. Without the binary, an apply of a
profile with agent features stops before it changes the host.

## Where things are

| What | Where |
| --- | --- |
| The database | The `db` service, with no published port |
| The server's settings and secret key | The `rookery-config` volume |
| The server's data, keys written from the database and its socket | The `rookery-data` volume |
| Crow's packages, as installed | `/config/rookery/plugins/` in the `rookery` container, with Hatchery's `eggs.lock` |
| Crow's registry folder, on your machine | `dist/registry` of the checkout, and it is not committed |
