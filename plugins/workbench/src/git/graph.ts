// The commit graph beside the history: which lane each commit sits in and the lines between rows, for
// commits in topological order (`git log --topo-order`, newest first).

export interface GraphEdge {
  /** Lane at the top of the row (this row's commit or a line passing through). */
  from: number
  /** Lane at the bottom of the row, where the line continues into the next row. */
  to: number
  /** Colour index of the line. */
  color: number
}

export interface GraphRow {
  sha: string
  /** The commit's lane. */
  lane: number
  color: number
  /** Lines from the top edge of the row into the commit's node (lanes that expected this commit). */
  into: number[]
  /** Lines from this row's top to its bottom edge, including the ones leaving the node. */
  edges: GraphEdge[]
  /** Lanes in use in this row, for the width. */
  width: number
}

interface Lane {
  sha: string
  color: number
}

export function computeGraph(commits: Array<{ sha: string; parents: string[] }>): GraphRow[] {
  const lanes: Array<Lane | null> = []
  const rows: GraphRow[] = []
  let nextColor = 0
  const free = () => {
    const i = lanes.indexOf(null)
    return i < 0 ? lanes.length : i
  }
  for (const c of commits) {
    // Lanes waiting for this commit: the first is where it goes, the rest merge into it.
    const waiting: number[] = []
    lanes.forEach((l, i) => {
      if (l?.sha === c.sha) waiting.push(i)
    })
    let lane: number
    let color: number
    if (waiting.length) {
      lane = waiting[0]!
      color = lanes[lane]!.color
    } else {
      lane = free()
      color = nextColor++
    }
    const before = lanes.map((l) => l)
    for (const i of waiting) lanes[i] = null
    // The first parent continues in this lane; other parents join a lane already waiting for them or
    // open a new one.
    const parentLanes: Array<{ lane: number; color: number }> = []
    const joins: GraphEdge[] = []
    c.parents.forEach((p, k) => {
      const existing = lanes.findIndex((l) => l?.sha === p)
      if (k === 0) {
        if (existing >= 0 && existing < lane) {
          // Already expected in a lane further left: draw into it, leave this one empty.
          parentLanes.push({ lane: existing, color: lanes[existing]!.color })
        } else if (existing > lane) {
          // Expected further right: this lane takes it over and that one joins here, so a first-parent line
          // keeps to the left.
          joins.push({ from: existing, to: lane, color: lanes[existing]!.color })
          lanes[existing] = null
          lanes[lane] = { sha: p, color }
          parentLanes.push({ lane, color })
        } else {
          lanes[lane] = { sha: p, color }
          parentLanes.push({ lane, color })
        }
      } else if (existing >= 0) {
        parentLanes.push({ lane: existing, color: lanes[existing]!.color })
      } else {
        const at = free()
        const col = nextColor++
        lanes[at] = { sha: p, color: col }
        parentLanes.push({ lane: at, color: col })
      }
    })
    const edges: GraphEdge[] = []
    // Lines passing through: lanes busy before and after that are not this commit's.
    before.forEach((l, i) => {
      if (!l || waiting.includes(i)) return
      const now = lanes.indexOf(l)
      if (now >= 0) edges.push({ from: i, to: now, color: l.color })
    })
    edges.push(...joins)
    for (const p of parentLanes) edges.push({ from: lane, to: p.lane, color: p.color })
    // Trim empty lanes at the end.
    while (lanes.length && lanes[lanes.length - 1] === null) lanes.pop()
    rows.push({
      sha: c.sha,
      lane,
      color,
      into: waiting,
      edges,
      width: Math.max(before.length, lanes.length, lane + 1),
    })
  }
  return rows
}
