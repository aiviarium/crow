// Markdown in and out for a page tree: a folder of `.md` files with front matter for properties. The kernel
// turns one document into Markdown and back (`documents.read { format: markdown }`, `appendMarkdown`); this
// module does the folder around it: file names and folders from the tree, links between pages as relative
// paths, attachments, and the reverse (folders and folder notes to a tree, relative and `[[wiki]]` links to
// mentions of the new pages, images to blobs). Pure functions, so tests run them without a kernel.
import { parseFrontMatter, stringifyFrontMatter } from "./frontmatter"

// ── Paths ───────────────────────────────────────────────────────────────────────────────────────────

/** A file or folder name for a title: no path separators or characters file systems refuse. */
export function fileName(title: string): string {
  const s = title
    .replace(/[\\/:*?"<>|#^[\]\p{Cc}]/gu, " ")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/^\.+/, "")
    .slice(0, 80)
    .trim()
  return s || "Untitled"
}

export function dirname(path: string): string {
  const i = path.lastIndexOf("/")
  return i < 0 ? "" : path.slice(0, i)
}

export function basename(path: string): string {
  return path.slice(path.lastIndexOf("/") + 1)
}

const stripMd = (name: string) => name.replace(/\.(md|markdown)$/i, "")

/** `a/./b/../c` → `a/c`. Paths are relative and use `/`; leading `..` that go nowhere are dropped. */
export function normalize(path: string): string {
  const out: string[] = []
  for (const part of path.split("/")) {
    if (!part || part === ".") continue
    if (part === "..") out.pop()
    else out.push(part)
  }
  return out.join("/")
}

/** The relative path from folder `fromDir` to `to`. */
export function relative(fromDir: string, to: string): string {
  const a = fromDir ? fromDir.split("/") : []
  const b = to.split("/")
  let i = 0
  while (i < a.length && i < b.length - 1 && a[i] === b[i]) i++
  return [...a.slice(i).map(() => ".."), ...b.slice(i)].join("/")
}

const encodePath = (p: string) => p.split("/").map(encodeURIComponent).join("/")

// ── Rewriting links outside code ────────────────────────────────────────────────────────────────────

/** Applies `fn` to the parts of Markdown that are not code (fenced blocks, indented blocks, code spans). */
export function outsideCode(md: string, fn: (text: string) => string): string {
  const lines = md.split("\n")
  const out: string[] = []
  let fence: string | null = null
  let buf: string[] = []
  const flush = () => {
    if (!buf.length) return
    out.push(
      buf
        .join("\n")
        .split(/(`+[^`]*`+)/)
        .map((part, i) => (i % 2 ? part : fn(part)))
        .join(""),
    )
    buf = []
  }
  for (const line of lines) {
    const f = /^\s{0,3}(`{3,}|~{3,})/.exec(line)
    if (fence) {
      out.push(line)
      if (f && f[1]!.startsWith(fence)) fence = null
      continue
    }
    if (f) {
      flush()
      fence = f[1]!
      out.push(line)
      continue
    }
    buf.push(line)
  }
  flush()
  return out.join("\n")
}

// ── Export ──────────────────────────────────────────────────────────────────────────────────────────

export interface ExportPage {
  id: string
  title: string
  /** The parent page's id; null or outside the export for the root. */
  parent: string | null
  /** The page's Markdown as the kernel writes it (mentions of pages are `[label](doc://<id>)`). */
  markdown: string
  /** Front matter: title and icon first, then the properties by name. */
  meta: Record<string, unknown>
}

export interface ExportResult {
  files: Array<{ path: string; text: string }>
  /** Blobs the Markdown refers to, and where they go in the folder. */
  attachments: Array<{ path: string; blob: string }>
}

/**
 * The files of a page tree, in order (`pages` parents first, siblings in order). A page is `Title.md`; a page
 * with subpages also has a folder `Title/` beside it holding them. Mentions of exported pages become relative
 * links, `/blobs/<id>` images and files become `_attachments/<name>` (`blobName` names them).
 */
export function exportTree(pages: ExportPage[], blobName: (id: string) => string = (id) => id): ExportResult {
  const ids = new Set(pages.map((p) => p.id))
  const hasKids = new Set(pages.filter((p) => p.parent && ids.has(p.parent)).map((p) => p.parent!))
  const folderOf = new Map<string, string>()
  const pathOf = new Map<string, string>()
  const used = new Map<string, Set<string>>()
  for (const p of pages) {
    const dir = p.parent && ids.has(p.parent) ? folderOf.get(p.parent)! : ""
    const names = used.get(dir) ?? new Set<string>()
    used.set(dir, names)
    let name = fileName(p.title)
    for (let n = 2; names.has(name.toLowerCase()); n++) name = `${fileName(p.title)} ${n}`
    names.add(name.toLowerCase())
    const base = dir ? `${dir}/${name}` : name
    pathOf.set(p.id, `${base}.md`)
    if (hasKids.has(p.id)) folderOf.set(p.id, base)
  }
  const attachments = new Map<string, string>()
  const files = pages.map((p) => {
    const path = pathOf.get(p.id)!
    const dir = dirname(path)
    const body = outsideCode(p.markdown, (t) =>
      t
        .replace(/\]\(doc:\/\/([0-9a-f-]{8,})\)/gi, (m, id: string) => {
          const to = pathOf.get(id)
          return to ? `](${encodePath(relative(dir, to))})` : m
        })
        .replace(/\]\(\/blobs\/([0-9a-zA-Z-]+)\)/g, (_m, id: string) => {
          let at = attachments.get(id)
          if (!at) {
            at = `_attachments/${fileName(blobName(id))}`
            for (let n = 2; [...attachments.values()].includes(at); n++)
              at = `_attachments/${n}-${fileName(blobName(id))}`
            attachments.set(id, at)
          }
          return `](${encodePath(relative(dir, at))})`
        }),
    )
    return { path, text: stringifyFrontMatter(p.meta) + body }
  })
  return { files, attachments: [...attachments].map(([blob, path]) => ({ path, blob })) }
}

// ── Import ──────────────────────────────────────────────────────────────────────────────────────────

export interface ImportFile {
  path: string
  text: string
}

export interface PlannedPage {
  /** The file's path, or the folder's for a page made for a folder without a note. */
  key: string
  title: string
  /** The parent's key; null at the top of the import. */
  parent: string | null
  /** Front matter without the keys about the page itself (title, icon, cover). */
  props: Record<string, unknown>
  icon?: string
  /** The Markdown after the front matter (and after a leading `# Title` that repeats the title). */
  body: string
  /** The file's folder, for resolving its relative links. */
  dir: string
}

const isMd = (p: string) => /\.(md|markdown)$/i.test(p)
const FOLDER_NOTES = ["index", "readme", "_index"]
const natural = (a: string, b: string) => a.localeCompare(b, "en", { numeric: true, sensitivity: "base" })

/**
 * Pages for a folder of Markdown files: one per file, and one per folder (its folder note `Name.md` beside it
 * or `index.md`/`README.md`/`Name/Name.md` inside it, or an empty page named after it). Files whose paths share
 * one top folder (a picked folder) keep it as the root page. Siblings come in natural order of their names.
 * Hidden files and folders (`.obsidian`) are left out.
 */
export function planImport(input: ImportFile[]): PlannedPage[] {
  const files = input
    .map((f) => ({ ...f, path: normalize(f.path.replace(/\\/g, "/")) }))
    .filter((f) => isMd(f.path) && !f.path.split("/").some((p) => p.startsWith(".") || p === "node_modules"))
  const byPath = new Map(files.map((f) => [f.path, f]))
  const dirs = new Set<string>()
  for (const f of files) {
    let d = dirname(f.path)
    while (d) {
      dirs.add(d)
      d = dirname(d)
    }
  }
  // The page that stands for each folder.
  const noteOf = new Map<string, string>()
  for (const d of dirs) {
    const name = basename(d)
    const candidates = [`${d}.md`, ...FOLDER_NOTES.flatMap((n) => [`${d}/${n}.md`]), `${d}/${name}.md`]
    const found = candidates.find(
      (c) => byPath.has(c) || [...byPath.keys()].some((k) => k.toLowerCase() === c.toLowerCase()),
    )
    if (found) noteOf.set(d, [...byPath.keys()].find((k) => k.toLowerCase() === found.toLowerCase())!)
  }
  const noteFiles = new Map([...noteOf].map(([d, f]) => [f, d]))
  const keyOfDir = (d: string) => noteOf.get(d) ?? d
  const pages: PlannedPage[] = []
  for (const d of [...dirs].sort(natural)) {
    if (noteOf.has(d)) continue
    pages.push({ key: d, title: basename(d), parent: null, props: {}, body: "", dir: d })
  }
  for (const f of files) {
    const { data, body } = parseFrontMatter(f.text)
    const fm = { ...data }
    let title = typeof fm.title === "string" && fm.title.trim() ? fm.title.trim() : ""
    let rest = body.replace(/^(?:[ \t]*\r?\n)+/, "")
    const h1 = /^#\s+(.+?)\s*#*\s*(?:\r?\n|$)/.exec(rest)
    if (h1 && (!title || h1[1]!.trim() === title)) {
      title ||= h1[1]!.trim()
      rest = rest.slice(h1[0].length).replace(/^(?:[ \t]*\r?\n)+/, "")
    }
    const folder = noteFiles.get(f.path)
    title ||=
      folder && FOLDER_NOTES.includes(stripMd(basename(f.path)).toLowerCase())
        ? basename(folder)
        : stripMd(basename(f.path))
    const icon = typeof fm.icon === "string" ? fm.icon : undefined
    delete fm.title
    delete fm.icon
    delete fm.cover
    pages.push({
      key: f.path,
      title,
      parent: null,
      props: fm,
      body: rest,
      dir: dirname(f.path),
      ...(icon ? { icon } : {}),
    })
  }
  // Parents: a folder's page sits in the folder above; a file in its folder (unless it is that folder's note).
  for (const p of pages) {
    const isFolderPage = dirs.has(p.key) || noteFiles.has(p.key)
    const ownDir = noteFiles.get(p.key) ?? (dirs.has(p.key) ? p.key : null)
    const container = isFolderPage ? dirname(ownDir!) : dirname(p.key)
    p.parent = container ? keyOfDir(container) : null
    if (p.parent === p.key) p.parent = null
  }
  // Natural order by name within each parent: folders' pages and files together.
  const sortKey = (p: PlannedPage) => basename(noteFiles.get(p.key) ?? p.key).replace(/\.(md|markdown)$/i, "")
  pages.sort((a, b) => natural(sortKey(a), sortKey(b)))
  // Parents before children.
  const order: PlannedPage[] = []
  const placed = new Set<string>()
  const byKey = new Map(pages.map((p) => [p.key, p]))
  const place = (p: PlannedPage, guard = new Set<string>()) => {
    if (placed.has(p.key) || guard.has(p.key)) return
    guard.add(p.key)
    if (p.parent && byKey.has(p.parent)) place(byKey.get(p.parent)!, guard)
    placed.add(p.key)
    order.push(p)
  }
  for (const p of pages) place(p)
  return order
}

/**
 * The body of an imported page with its links pointing into Crow: relative links to imported `.md` files (or
 * folders) and `[[wiki links]]` become mentions (`[label](doc://<id>)`), images and embeds of uploaded files
 * become `/blobs/<id>` links. Unresolved wiki links keep their text.
 */
export function rewriteLinks(
  page: Pick<PlannedPage, "body" | "dir">,
  pageId: (key: string) => string | undefined,
  byTitle: (title: string) => string | undefined,
  asset: (path: string) => string | undefined,
): string {
  const resolve = (target: string) => {
    let t = target.trim()
    if (t.startsWith("<") && t.endsWith(">")) t = t.slice(1, -1)
    const [pathPart] = t.split(/[#?]/)
    if (!pathPart || /^[a-z][a-z0-9+.-]*:/i.test(pathPart) || pathPart.startsWith("/")) return null
    let p: string
    try {
      p = normalize(`${page.dir}/${decodeURIComponent(pathPart)}`)
    } catch {
      p = normalize(`${page.dir}/${pathPart}`)
    }
    return p
  }
  return outsideCode(page.body, (text) =>
    text
      // Obsidian embeds of files: ![[image.png]] or ![[image.png|300]]
      .replace(/!\[\[([^\]|#]+)(?:[|#][^\]]*)?\]\]/g, (m, name: string) => {
        const url = asset(normalize(`${page.dir}/${name.trim()}`)) ?? asset(name.trim())
        return url ? `![${basename(name.trim())}](${url})` : m
      })
      // Wiki links: [[Page]], [[Page|Label]], [[Page#Heading]]
      .replace(/\[\[([^\]|#]+)(?:#[^\]|]*)?(?:\|([^\]]+))?\]\]/g, (_m, target: string, label?: string) => {
        const t = target.trim()
        const id =
          byTitle(t) ??
          byTitle(basename(t)) ??
          pageId(normalize(`${t}.md`)) ??
          pageId(normalize(`${page.dir}/${t}.md`))
        const shown = (label ?? t).trim()
        return id ? `[${shown}](doc://${id})` : shown
      })
      // Images: ![alt](path)
      .replace(/!\[([^\]]*)\]\(([^)\s]+)(\s+"[^"]*")?\)/g, (m, alt: string, target: string) => {
        const p = resolve(target)
        const url = p ? asset(p) : undefined
        return url ? `![${alt}](${url})` : m
      })
      // Links: [label](path.md) and links to folders
      .replace(
        /(^|[^!])\[([^\]]*)\]\(([^)\s]+)(\s+"[^"]*")?\)/g,
        (m, lead: string, label: string, target: string) => {
          const p = resolve(target)
          if (p === null) return m
          const id = pageId(p) ?? pageId(p.replace(/\/$/, "")) ?? (isMd(p) ? undefined : pageId(`${p}.md`))
          if (id) return `${lead}[${label || "page"}](doc://${id})`
          const url = asset(p)
          return url ? `${lead}[${label}](${url})` : m
        },
      ),
  )
}
