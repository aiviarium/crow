// The workbench's halves load, and the two pure helpers the shell's URLs depend on: the workspace's
// `<env>/<path>` view path and the links to a file and a commit.
import { describe, expect, test } from "bun:test"
import type { ClientRookery } from "@rookery/sdk/client"
import { createApi } from "../src/api"
import client from "../src/client"
import host from "../src/host"
import { parseWorkspacePath, workspacePath } from "../src/ui/Home"

describe("workbench plugin", () => {
  test("is a client half and a host half", () => {
    expect(client.__rookery).toBe("client")
    expect(host.__rookery).toBe("host")
  })

  test("the workspace's view path survives a round trip, spaces and all", () => {
    const path = workspacePath("studio", "/srv/work/my app")
    expect(path).toBe("studio/srv/work/my%20app")
    expect(parseWorkspacePath(path)).toEqual({ env: "studio", path: "/srv/work/my app" })
    expect(parseWorkspacePath(workspacePath("env://forge", "/srv/app"))).toEqual({
      env: "forge",
      path: "/srv/app",
    })
  })

  test("links to a file and a commit are routes the workbench serves", async () => {
    const api = createApi({} as ClientRookery)
    expect(await api.link("env://studio", "/srv/work/a b.ts")).toEqual({
      uri: "code://studio/srv/work/a b.ts",
      href: "/workbench/file/studio/srv/work/a%20b.ts",
    })
    expect(await api.commitLink("studio", "/srv/work", "abc1234")).toEqual({
      uri: "commit://studio/srv/work@abc1234",
      href: "/workbench/commit/studio/srv/work%40abc1234",
    })
  })
})
