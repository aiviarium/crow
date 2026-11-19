// What kind of file a name is, for its icon's colour in the tree and the tabs.
export type FileKind = "code" | "data" | "prose" | "image" | "other"

const KINDS: Array<[RegExp, FileKind]> = [
  [/\.(png|jpe?g|gif|webp|bmp|ico|svg|avif)$/i, "image"],
  [
    /\.(json|jsonc|ya?ml|toml|ini|env|lock|xml|csv|tsv)$|^(\.gitignore|\.npmrc|\.editorconfig|dockerfile|makefile)$/i,
    "data",
  ],
  [/\.(md|markdown|mdx|txt|rst|adoc)$|^(license|readme|changelog|notice)(\.|$)/i, "prose"],
]

export function fileKind(path: string): FileKind {
  const name = path.split("/").pop() ?? path
  for (const [re, k] of KINDS) if (re.test(name)) return k
  return /\.[a-z0-9]+$/i.test(name) ? "code" : "other"
}
