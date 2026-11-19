// Small pure helpers over a widget type's declaration; no shell state, so they can be tested.
import type { WidgetArea, WidgetType } from "./types"

/** The settings of an instance with the defaults of the type's settings schema filled in. */
export function settingsWithDefaults(
  type: Pick<WidgetType, "settings"> | undefined,
  given: Record<string, unknown> | undefined,
): Record<string, unknown> {
  const props = ((type?.settings as { properties?: Record<string, { default?: unknown }> } | undefined)
    ?.properties ?? {}) as Record<string, { default?: unknown }>
  const out: Record<string, unknown> = {}
  for (const [k, p] of Object.entries(props)) if (p && "default" in p) out[k] = p.default
  return { ...out, ...(given ?? {}) }
}

/** What a type's size limits mean for the grid's items. */
export function limits(type: Pick<WidgetType, "sizes"> | undefined) {
  const s = type?.sizes
  return {
    minW: s?.min?.w ?? undefined,
    minH: s?.min?.h ?? undefined,
    maxW: s?.max?.w ?? undefined,
    maxH: s?.max?.h ?? undefined,
  }
}

/** The widget types a picker offers in an area, grouped by category (the plugin's name when missing). */
export function groupForPicker<
  T extends Pick<WidgetType, "id" | "title" | "description" | "category" | "areas" | "plugin">,
>(types: T[], area: WidgetArea, query: string): Array<[string, T[]]> {
  const q = query.trim().toLowerCase()
  const map = new Map<string, T[]>()
  for (const t of types) {
    if (t.areas && !t.areas.includes(area)) continue
    if (q && !`${t.title} ${t.description ?? ""} ${t.category ?? ""}`.toLowerCase().includes(q)) continue
    const g =
      t.category ?? (t.plugin === "crow" ? "General" : t.plugin.charAt(0).toUpperCase() + t.plugin.slice(1))
    if (!map.has(g)) map.set(g, [])
    map.get(g)!.push(t)
  }
  return [...map.entries()].sort(([a], [b]) => a.localeCompare(b))
}
