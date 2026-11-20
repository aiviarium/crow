// The shell's editor services (`EditorServices` from `@aiviarium/nocturne`):
// the block types plugins declare in `contributes.blocks` with the components registered through
// `rookery.blocks.register` (`app.loader.blocks()`), plus `@` entity mentions and blob uploads.
import {
  type EditorBlockType,
  type EditorServices,
  EditorServicesProvider,
  Icon,
  type MentionItem,
  type UploadedFile,
} from "@aiviarium/nocturne"
import type { BlobInfo, BlockEntry, EntityList, PluginInfo } from "@rookery/client"
import { type Accessor, createMemo, createResource, type JSX, type ParentProps, Show } from "solid-js"
import { iconFor, splitUri, typeTitle } from "./entities"
import type { ShellApp } from "./state"

/** A new block's attributes: the defaults of the manifest's JSON Schema. */
export function defaultsOf(schema: unknown): Record<string, unknown> {
  const props =
    (schema as { properties?: Record<string, { default?: unknown }> } | undefined)?.properties ?? {}
  return Object.fromEntries(
    Object.entries(props)
      .filter(([, p]) => p && "default" in p)
      .map(([k, p]) => [k, p.default]),
  )
}

/** Every block type the active plugins declare, with the component of each that registered one. */
export function blockTypes(
  plugins: Readonly<Record<string, PluginInfo>>,
  blocks: Readonly<Record<string, BlockEntry>> = {},
): EditorBlockType[] {
  const out: EditorBlockType[] = []
  for (const p of Object.values(plugins)) {
    for (const b of p.manifest?.contributes?.blocks ?? []) {
      const entry = blocks[b.id]
      out.push({
        id: b.id,
        title: b.title,
        ...(b.description ? { description: b.description } : {}),
        ...(b.icon ? { icon: b.icon } : {}),
        ...(b.keywords ? { keywords: b.keywords } : {}),
        defaults: defaultsOf(b.attrs),
        plugin: p.id,
        ...(entry ? { component: entry.component as EditorBlockType["component"] } : {}),
        available: !!entry,
        ...(b.width ? { width: b.width } : {}),
        ...(entry?.options?.forceWidth ? { forceWidth: entry.options.forceWidth } : {}),
      })
    }
  }
  return out
}

/** An accessor over the block types, kept current as plugins load and register their components. */
export function blockTypeSource(app: ShellApp): Accessor<EditorBlockType[]> {
  return createMemo(() => {
    const blocks = app.loader.blocks?.() ?? {}
    return blockTypes(app.loader.plugins, blocks)
  })
}

function base64(bytes: ArrayBuffer): string {
  let binary = ""
  const all = new Uint8Array(bytes)
  for (let i = 0; i < all.length; i += 0x8000) {
    binary += String.fromCharCode(...all.subarray(i, i + 0x8000))
  }
  return btoa(binary)
}

/** Wraps the shell's views so every editor under them can show the plugins' blocks, mentions, and uploads. */
export function CrowEditorServices(props: ParentProps<{ app: ShellApp }>): JSX.Element {
  const types = blockTypeSource(props.app)

  const mentionSchemes = createMemo(() => [
    ...new Set(
      (props.app.composerContributions?.() ?? [])
        .filter((c) => c.type === "mention")
        .flatMap((c) => c.schemes ?? []),
    ),
  ])

  const searchMentions = async (query: string): Promise<MentionItem[]> => {
    const text = query.trim()
    const schemes = mentionSchemes()
    if (!text && !schemes.length) return []
    const res = await props.app.conn
      .call<EntityList>("entities.search", {
        text: text || "a",
        limit: 8,
        ...(!text && schemes.length ? { schemes } : {}),
      })
      .catch(() => ({ entities: [] }))
    const plugins = props.app.loader.plugins
    return (res.entities ?? [])
      .filter((e) => !e.deletedAt && e.scheme !== "document")
      .map((e) => ({
        uri: e.uri,
        title: e.title,
        subtitle: e.subtitle ?? typeTitle(plugins, e.scheme),
        icon: iconFor(plugins, e.scheme),
      }))
  }

  const MentionChip = (p: { uri: string; label: string }): JSX.Element => {
    const Chip = props.app.entities?.EntityChip
    if (!Chip) return <span class="nc-chip">{p.label || p.uri}</span>
    return <Chip uri={p.uri} label={p.label} />
  }

  const MentionPreview = (p: { uri: string; label: string }): JSX.Element => {
    const [entity] = createResource(
      () => p.uri,
      (uri) => props.app.entities?.resolve(uri) ?? Promise.resolve(null),
    )
    const scheme = () => splitUri(p.uri).scheme
    const plugins = () => props.app.loader.plugins
    return (
      <div class="crow-mention-card" data-entity={p.uri}>
        <div class="crow-mention-card__head">
          <span class="crow-mention-card__icon">
            <Icon name={iconFor(plugins(), scheme())} size="sm" />
          </span>
          <span class="crow-mention-card__title label">{entity()?.title ?? p.label}</span>
        </div>
        <Show
          when={entity.loading || entity()}
          fallback={<span class="nc-meta">Not available: deleted, or not shared with you.</span>}
        >
          <span class="nc-meta">
            {typeTitle(plugins(), scheme())}
            {entity()?.subtitle ? ` · ${entity()!.subtitle}` : ""}
          </span>
          <button
            type="button"
            class="nc-btn nc-btn--secondary nc-btn--sm"
            onClick={() => props.app.entities?.open(p.uri)}
          >
            Open
          </button>
        </Show>
      </div>
    )
  }

  const upload = async (file: File): Promise<UploadedFile> => {
    const blob = await props.app.conn.call<BlobInfo>("blobs.put", {
      data: base64(await file.arrayBuffer()),
      contentType: file.type || "application/octet-stream",
      ...(file.name ? { name: file.name } : {}),
    })
    return {
      src: `/blobs/${encodeURIComponent(blob.id)}`,
      name: blob.name ?? file.name,
      size: blob.size,
      mime: blob.contentType ?? file.type,
      blob: `blob://${blob.id}`,
    }
  }

  const services: EditorServices = {
    blocks: types,
    searchMentions,
    MentionChip,
    MentionPreview,
    openMention: (uri) => props.app.entities?.open(uri),
    upload,
  }
  return <EditorServicesProvider value={services}>{props.children}</EditorServicesProvider>
}
