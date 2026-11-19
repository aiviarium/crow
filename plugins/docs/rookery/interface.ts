// The public API of the Docs plugin: the `docs` service, for other plugins (and agents' tools) to read and
// write pages with their ctx. A page is named by its id, its URI (doc://…) or its path of titles.
//
// The interface is declared with `defineInterface`; the extension host writes `interface.json` and
// `interface.d.ts` from it.
import { defineInterface, z } from "@rookery/sdk"

const Page = z.string().describe("The page: its id, doc://… URI, or path of titles")
const Space = z.string().nullish().describe("The space to look in; the caller's by default")

const PageRef = z.looseObject({ id: z.string(), uri: z.string(), title: z.string() })

export default defineInterface({
  services: {
    docs: {
      read: {
        description: "A page as Markdown.",
        params: z.object({ page: Page, space: Space }),
        result: PageRef.extend({ space: z.string().nullish(), markdown: z.string() }),
      },
      search: {
        description: "Pages whose text matches, best first.",
        params: z.object({ text: z.string(), space: Space, limit: z.number().int().optional() }),
        result: z.array(PageRef.extend({ space: z.string().nullish(), parent: z.string().nullish() })),
      },
      list: {
        description: "The page tree under a page (or the space's top), to a depth.",
        params: z.object({ page: Page.nullish(), space: Space, depth: z.number().int().optional() }),
        result: z.object({
          space: z.string(),
          pages: z.array(PageRef.extend({ depth: z.number(), parent: z.string().nullable() })),
        }),
      },
      create: {
        description: "Creates a page, from Markdown or a document, with properties.",
        params: z.looseObject({
          title: z.string().optional(),
          parent: z.string().nullish(),
          space: Space,
          index: z.number().int().optional().describe("Position among the siblings; the end by default"),
          icon: z.string().nullish(),
          markdown: z.string().optional(),
          properties: z.record(z.string(), z.unknown()).optional().describe("Values by property name"),
        }),
        result: PageRef.extend({ space: z.string().nullish() }),
      },
      append: {
        params: z.object({ page: Page, markdown: z.string(), space: Space }),
        result: z.looseObject({ id: z.string() }),
      },
      replaceSection: {
        description:
          "Replaces the blocks under a heading, until the next heading of the same or a higher level.",
        params: z.object({ page: Page, heading: z.string(), markdown: z.string(), space: Space }),
        result: z.unknown(),
      },
      setProperties: {
        params: z.object({ page: Page, properties: z.record(z.string(), z.unknown()), space: Space }),
        result: z.unknown(),
      },
      exportMarkdown: {
        description: "A page, and its subpages unless told not to, as Markdown files.",
        params: z.object({ page: Page, subpages: z.boolean().optional(), space: Space }),
        result: z.unknown(),
      },
    },
  },
})
