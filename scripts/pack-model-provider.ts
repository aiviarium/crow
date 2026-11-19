// Stage the provider host half for `rookery plugin add dist/model-anthropic`.
import { copyFile, mkdir } from "node:fs/promises"
import { join } from "node:path"
import source from "../plugins/model-anthropic/plugin.json"

const root = join(import.meta.dir, "..")
const provider = join(root, "plugins", "model-anthropic")
const dest = join(root, "dist", "model-anthropic")
const target = join(dest, "rookery")
await mkdir(target, { recursive: true })
await copyFile(join(provider, "package.kdl"), join(dest, "package.kdl"))
const result = await Bun.build({
  entrypoints: [join(provider, "src", "managed.ts")],
  outdir: target,
  target: "bun",
  format: "esm",
})
if (!result.success) throw new AggregateError(result.logs, "Building the model provider failed")

const connection = source.contributes.connectionTypes[0]
if (!connection) throw new Error("The Anthropic connection type is missing")
await Bun.write(
  join(target, "plugin.json"),
  JSON.stringify(
    {
      id: source.id,
      name: source.name,
      version: source.version,
      apiVersion: source.apiVersion,
      description: "Anthropic text generation for Crow's text and fast tasks.",
      host: "managed.js",
      contributes: {
        connectionTypes: [
          {
            id: connection.id,
            title: connection.title,
            fields: { type: "object", required: ["apiKey"], properties: { apiKey: { type: "string" } } },
            secret: connection.secret,
            scopes: ["global"],
          },
        ],
      },
    },
    null,
    2,
  ),
)
console.log(dest)
