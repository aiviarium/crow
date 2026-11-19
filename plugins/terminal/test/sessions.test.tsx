// The terminal session list: the picker, the new-terminal form, the person's terminals with the host's
// preview, and the host's other sessions. Rendered with fake `terminals.*` and `env.*` answers.
import { afterEach, describe, expect, test } from "bun:test"
import type { Checkout, EnvInfo, EnvSession, TerminalInfo } from "@rookery/client"
import type { ClientRookery, ViewHandle } from "@rookery/sdk/client"
import { render } from "solid-js/web"
import type { HostsApi } from "../src/hosts"
import { SessionsView } from "../src/SessionsView"
import type { TerminalsApi } from "../src/termApi"

const cleanup: Array<() => void> = []
afterEach(() => {
  while (cleanup.length) cleanup.pop()!()
  document.body.innerHTML = ""
})

const settle = () => new Promise((r) => setTimeout(r, 20))

function env(name: string, overrides: Partial<EnvInfo> = {}): EnvInfo {
  return {
    name,
    uri: `env://${name}`,
    kind: "managed",
    state: "online",
    level: "use",
    supports: {
      terminal: true,
      process: true,
      files: true,
      connect: true,
      checkouts: true,
      desktop: false,
      privileged: false,
      persistentSessions: true,
      deploy: false,
    },
    ...overrides,
  }
}

function terminal(id: string, overrides: Partial<TerminalInfo> = {}): TerminalInfo {
  return {
    id,
    uri: `terminal://${id}`,
    env: "env://studio",
    title: "bash on studio",
    command: ["bash", "-l"],
    state: "running",
    size: { cols: 80, rows: 24 },
    viewers: 1,
    offset: 0,
    createdAt: new Date().toISOString(),
    recording: false,
    level: "use",
    ...overrides,
  }
}

function view(path: string): ViewHandle & { titles: string[] } {
  const titles: string[] = []
  return {
    id: "terminal.sessions",
    plugin: "terminal",
    path,
    params: {},
    titles,
    setTitle: (t: string) => titles.push(t),
    setDirty: () => {},
    setLoading: () => {},
  }
}

function fakes(opts: {
  envs: EnvInfo[]
  terminals?: TerminalInfo[]
  sessions?: EnvSession[]
  opened?: string[]
  titles?: string[]
}): { rookery: ClientRookery; terminals: TerminalsApi; hosts: HostsApi } {
  const terminals: TerminalsApi = {
    open: async () => terminal("term_new"),
    get: async (id) => terminal(id),
    list: async () => opts.terminals ?? [],
    sessions: async () => opts.sessions ?? [],
    adopt: async (_env, session) => terminal("term_adopted", { sessionId: session }),
    rename: async () => {},
    close: async () => {},
    screen: async () => ({
      size: { cols: 80, rows: 24 },
      lines: [],
      cursor: { row: 0, col: 0, visible: true },
      title: "",
      altScreen: false,
      offset: 0,
    }),
    onChanged: () => () => {},
    connect: () => {
      throw new Error("not rendered here")
    },
  }
  const hosts: HostsApi = {
    list: async () => opts.envs,
    get: async (name) => env(name),
    checkouts: async () => [] as Checkout[],
    onChanged: () => () => {},
  }
  const rookery = {
    workbench: {
      openView: (id: string, o?: { path?: string }) => opts.opened?.push(`${id}:${o?.path ?? ""}`),
      toast: () => {},
      href: () => null,
    },
    views: {
      href: (id: string, o?: { path?: string }) => `/${id}/${o?.path ?? ""}`,
    },
    commands: { run: async () => {} },
  } as unknown as ClientRookery
  return { rookery, terminals, hosts }
}

describe("SessionsView", () => {
  test("lists the person's terminals and the host's other sessions", async () => {
    const opened: string[] = []
    const f = fakes({
      envs: [env("studio"), env("forge", { state: "offline" })],
      terminals: [terminal("term_1", { sessionId: "s-2" })],
      sessions: [
        {
          id: "s-1",
          kind: "terminal",
          title: "htop",
          command: ["htop"],
          user: "ops",
          started: new Date().toISOString(),
          lost: false,
          preview: "CPU 1%",
        },
        {
          id: "s-2",
          kind: "terminal",
          title: "mine",
          command: ["bash"],
          user: "ops",
          started: new Date().toISOString(),
          lost: false,
          terminal: "term_1",
          preview: "last lines",
        },
      ],
      opened,
    })
    const v = view("studio")
    const dispose = render(
      () => <SessionsView view={v} rookery={f.rookery} terminals={f.terminals} hosts={f.hosts} />,
      document.body,
    )
    cleanup.push(dispose)
    await settle()

    expect(v.titles).toContain("Terminals")
    expect(document.body.textContent).toContain("New terminal on studio")
    expect(document.body.textContent).toContain("bash on studio")
    // The session already adopted as term_1 is not offered again; htop is.
    expect(document.body.textContent).toContain("htop")
    expect(document.body.textContent).toContain("Other sessions on studio")
    expect(document.body.querySelectorAll("[data-terminal-row]")).toHaveLength(1)

    const row = document.body.querySelector<HTMLButtonElement>("[data-terminal-row] .term-card__title")
    expect(row).not.toBeNull()
    row!.click()
    expect(opened).toEqual(["terminal.session:term_1"])

    // The preview of the host's screen comes from `terminals.sessions`, not from the terminal record.
    expect(document.body.querySelector("[data-terminal-row] .term-card__preview")?.textContent).toBe(
      "last lines",
    )
  })

  test("says there is no host when the list is empty", async () => {
    const f = fakes({ envs: [] })
    const dispose = render(
      () => <SessionsView view={view("")} rookery={f.rookery} terminals={f.terminals} hosts={f.hosts} />,
      document.body,
    )
    cleanup.push(dispose)
    await settle()
    expect(document.body.textContent).toContain("No hosts")
  })
})
