import { expect, test } from "bun:test"
import type { ClientRookery, ConnectionInfo } from "@rookery/sdk/client"
import { calls } from "../src/client/calls"
import { ANTHROPIC_TYPE, managedModels } from "../src/client/managed"

test("a model task uses the mapping in the plugin's collection", async () => {
  const connection: ConnectionInfo = {
    id: "test-connection",
    name: "An example provider",
    type: ANTHROPIC_TYPE,
    scope: "global",
    config: {},
    hasCredential: true,
    spaceId: null,
    updatedAt: "2026-01-01T00:00:00Z",
  }
  const mappings = new Map<string, Record<string, unknown>>()
  let sequence = 0
  const rookery = {
    connections: {
      types: async () => [{ id: ANTHROPIC_TYPE }],
      list: async () => [connection],
    },
    data: {
      mappings: {
        async find() {
          return { rows: [...mappings.values()], next: null }
        },
        async upsert(row: Record<string, unknown>) {
          const id = String(row.id ?? `mapping-${++sequence}`)
          const stored = { ...row, id, updatedAt: "2026-01-01T00:00:00Z" }
          mappings.set(id, stored)
          return stored
        },
        async delete(id: string) {
          return mappings.delete(id) ? {} : null
        },
      },
    },
    rpc: {
      async call(method: string, params: Record<string, unknown>) {
        if (method === "plugins.rpc") {
          expect(params).toMatchObject({
            plugin: "model-anthropic",
            method: "complete",
            params: { task: "fast", connection: connection.id, model: "test-model", prompt: "Hello" },
          })
          return { text: "Hello from the model", model: "test-model", usage: {} }
        }
        throw new Error(`Unexpected call ${method}`)
      },
    },
  } as unknown as ClientRookery
  const api = managedModels(rookery, calls(rookery.host)).calls
  await expect(
    api.setMapping({
      task: "fast",
      scope: "global",
      connection: connection.id,
      model: "test-model",
    }),
  ).resolves.toMatchObject({ connection: connection.id, model: "test-model" })

  const events = await Array.fromAsync(api.generate({ task: "fast", prompt: "Hello" }))
  expect(events[0]).toEqual({ type: "delta", text: "Hello from the model" })
  expect(events[1]).toMatchObject({ type: "done", generated: { model: "test-model" } })
  await api.removeMapping({ task: "fast", scope: "global" })
  await expect(api.mappings()).resolves.toEqual([])
})
