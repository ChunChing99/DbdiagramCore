import type { Ref, Schema, Table } from '@/dbml/types'

export const HEADER_H = 36
export const ROW_H = 28
export const MIN_W = 200
export const MAX_W = 420
export const PAD_X = 12
export const COLORS = ['#316896', '#2980b9', '#16a085', '#27ae60', '#8e44ad', '#d35400', '#c0392b', '#f39c12', '#7f8c8d', '#2c3e50']
export const DEFAULT_HEADER = '#316896'
export const FONT = '"Segoe UI", "Microsoft JhengHei", system-ui, sans-serif'

export interface Point {
  x: number
  y: number
}
export interface Size {
  w: number
  h: number
}
export type Positions = Record<string, Point>

let ctx: CanvasRenderingContext2D | null = null
const cache = new Map<string, number>()
export function textWidth(text: string, font = `13px ${FONT}`): number {
  const key = font + '\u0000' + text
  let w = cache.get(key)
  if (w === undefined) {
    ctx ??= document.createElement('canvas').getContext('2d')
    if (ctx) {
      ctx.font = font
      w = ctx.measureText(text).width
    } else w = text.length * 7.5
    cache.set(key, w)
  }
  return w
}

export function tableSize(t: Table): Size {
  let w = textWidth(t.alias ? `${t.name} (${t.alias})` : t.name, `600 14px ${FONT}`) + PAD_X * 2 + 24
  for (const c of t.columns) {
    w = Math.max(w, textWidth(c.name) + textWidth(c.type, `12px ${FONT}`) + PAD_X * 2 + 56)
  }
  return { w: Math.round(Math.min(MAX_W, Math.max(MIN_W, w))), h: HEADER_H + Math.max(1, t.columns.length) * ROW_H }
}

export function computeSizes(schema: Schema): Record<string, Size> {
  const out: Record<string, Size> = {}
  for (const t of schema.tables) out[t.id] = tableSize(t)
  return out
}

/** "One" side is the parent, "many" side the child. */
function parentChild(r: Ref): [string, string] {
  return r.op === '<' ? [r.from.table, r.to.table] : [r.to.table, r.from.table]
}

const GAP_X = 140
const GAP_Y = 48

/**
 * Tables outside any TableGroup form the first block; each group is laid out as its
 * own block below it so group frames never overlap unrelated tables.
 */
export function autoLayout(schema: Schema, sizes: Record<string, Size>, origin: Point = { x: 40, y: 40 }): Positions {
  const owner = new Map<string, number>()
  schema.groups.forEach((g, i) => g.tables.forEach((id) => owner.has(id) || owner.set(id, i)))
  const blocks = [schema.tables.map((t) => t.id).filter((id) => !owner.has(id))]
  schema.groups.forEach((_, i) => blocks.push([...owner].filter(([, g]) => g === i).map(([id]) => id)))
  const pos: Positions = {}
  let y = origin.y
  for (const ids of blocks) {
    if (!ids.length) continue
    // leave room for the group frame header above grouped blocks
    const top = ids === blocks[0] ? y : y + 60
    Object.assign(pos, layoutBlock(ids, schema.refs, sizes, { x: origin.x, y: top }))
    const b = bounds(ids, pos, sizes)!
    y = b.y + b.h + 100
  }
  return pos
}

/** Layered layout: referenced tables on the left, referencing tables to their right. */
function layoutBlock(ids: string[], refs: Ref[], sizes: Record<string, Size>, origin: Point): Positions {
  const parents = new Map<string, Set<string>>(ids.map((id) => [id, new Set()]))
  const linked = new Set<string>()
  for (const r of refs) {
    const [p, c] = parentChild(r)
    if (p === c || !parents.has(p) || !parents.has(c)) continue
    parents.get(c)?.add(p)
    linked.add(p)
    linked.add(c)
  }
  const connected = ids.filter((id) => linked.has(id))
  const isolated = ids.filter((id) => !linked.has(id))

  // longest-path ranking with a relaxation bound so cycles terminate
  const rank = new Map<string, number>(connected.map((id) => [id, 0]))
  for (let iter = 0; iter < connected.length; iter++) {
    let changed = false
    for (const id of connected)
      for (const p of parents.get(id)!) {
        const want = (rank.get(p) ?? 0) + 1
        if (want > rank.get(id)! && want < connected.length) {
          rank.set(id, want)
          changed = true
        }
      }
    if (!changed) break
  }
  const layers: string[][] = []
  for (const id of connected) (layers[rank.get(id)!] ??= []).push(id)

  const pos: Positions = {}
  let x = origin.x
  for (const layer of layers.filter(Boolean)) {
    // order by the average position of parents to reduce crossings
    const bary = (id: string) => {
      const ps = [...parents.get(id)!].filter((p) => pos[p])
      return ps.length ? ps.reduce((s, p) => s + pos[p]!.y + sizes[p]!.h / 2, 0) / ps.length : Infinity
    }
    const ordered = layer.map((id, i) => ({ id, b: bary(id), i })).sort((a, b) => a.b - b.b || a.i - b.i)
    let y = origin.y
    let w = 0
    for (const { id, b } of ordered) {
      const s = sizes[id]!
      if (Number.isFinite(b)) y = Math.max(y, b - s.h / 2)
      pos[id] = { x, y: Math.round(y) }
      y += s.h + GAP_Y
      w = Math.max(w, s.w)
    }
    x += w + GAP_X
  }

  // unrelated tables in a grid after the layers
  if (isolated.length) {
    const cols = Math.max(1, Math.ceil(Math.sqrt(isolated.length)))
    const startX = connected.length ? x : origin.x
    let colX = startX
    for (let c = 0; c < cols; c++) {
      let y = origin.y
      let w = 0
      for (let i = c; i < isolated.length; i += cols) {
        const id = isolated[i]!
        pos[id] = { x: colX, y }
        y += sizes[id]!.h + GAP_Y
        w = Math.max(w, sizes[id]!.w)
      }
      colX += w + GAP_X / 2
    }
  }
  return pos
}

function overlaps(a: Point, as: Size, b: Point, bs: Size, margin = 24) {
  return a.x < b.x + bs.w + margin && b.x < a.x + as.w + margin && a.y < b.y + bs.h + margin && b.y < a.y + as.h + margin
}

/** Place tables that have no stored position next to a related table (or at `fallback`). */
export function placeMissing(schema: Schema, sizes: Record<string, Size>, positions: Positions, fallback: Point): Positions {
  const out: Positions = { ...positions }
  const placed = () => Object.keys(out).filter((id) => sizes[id])
  for (const t of schema.tables) {
    if (out[t.id]) continue
    const s = sizes[t.id]!
    let anchor: Point = fallback
    const rel = schema.refs.find((r) => (r.from.table === t.id && out[r.to.table]) || (r.to.table === t.id && out[r.from.table]))
    if (rel) {
      const other = rel.from.table === t.id ? rel.to.table : rel.from.table
      anchor = { x: out[other]!.x + sizes[other]!.w + GAP_X, y: out[other]!.y }
    }
    const p = { ...anchor }
    for (let guard = 0; guard < 200 && placed().some((id) => overlaps(p, s, out[id]!, sizes[id]!)); guard++) p.y += 40
    out[t.id] = { x: Math.round(p.x), y: Math.round(p.y) }
  }
  return out
}

export function bounds(ids: string[], positions: Positions, sizes: Record<string, Size>) {
  let x1 = Infinity
  let y1 = Infinity
  let x2 = -Infinity
  let y2 = -Infinity
  for (const id of ids) {
    const p = positions[id]
    const s = sizes[id]
    if (!p || !s) continue
    x1 = Math.min(x1, p.x)
    y1 = Math.min(y1, p.y)
    x2 = Math.max(x2, p.x + s.w)
    y2 = Math.max(y2, p.y + s.h)
  }
  return Number.isFinite(x1) ? { x: x1, y: y1, w: x2 - x1, h: y2 - y1 } : null
}

// ---------- relationship routing ----------

export interface RoutedRef {
  path: string
  a: Point
  b: Point
  /** Direction pointing away from each table: -1 left, 1 right. */
  da: 1 | -1
  db: 1 | -1
  mid: Point
}

function rounded(points: Point[], r = 10): string {
  let d = `M ${points[0]!.x} ${points[0]!.y}`
  for (let i = 1; i < points.length - 1; i++) {
    const p = points[i - 1]!
    const c = points[i]!
    const n = points[i + 1]!
    const l1 = Math.hypot(c.x - p.x, c.y - p.y)
    const l2 = Math.hypot(n.x - c.x, n.y - c.y)
    const rr = Math.min(r, l1 / 2, l2 / 2)
    if (rr < 0.5) {
      d += ` L ${c.x} ${c.y}`
      continue
    }
    const s = { x: c.x - ((c.x - p.x) / l1) * rr, y: c.y - ((c.y - p.y) / l1) * rr }
    const e = { x: c.x + ((n.x - c.x) / l2) * rr, y: c.y + ((n.y - c.y) / l2) * rr }
    d += ` L ${s.x} ${s.y} Q ${c.x} ${c.y} ${e.x} ${e.y}`
  }
  const last = points[points.length - 1]!
  return d + ` L ${last.x} ${last.y}`
}

export function rowY(pos: Point, index: number) {
  return pos.y + HEADER_H + index * ROW_H + ROW_H / 2
}

export function routeRef(pa: Point, sa: Size, ia: number, pb: Point, sb: Size, ib: number, self: boolean): RoutedRef {
  const ya = rowY(pa, ia)
  const yb = rowY(pb, ib)
  const STUB = 24
  let da: 1 | -1
  let db: 1 | -1
  if (!self && pa.x + sa.w + STUB * 2 <= pb.x) {
    da = 1
    db = -1
  } else if (!self && pb.x + sb.w + STUB * 2 <= pa.x) {
    da = -1
    db = 1
  } else {
    // horizontally overlapping: leave both from the same side
    const leftRoom = Math.min(pa.x, pb.x)
    const useLeft = !self && Math.abs(pa.x - pb.x) > Math.abs(pa.x + sa.w - (pb.x + sb.w)) && leftRoom > 0
    da = db = useLeft ? -1 : 1
  }
  const a = { x: da === 1 ? pa.x + sa.w : pa.x, y: ya }
  const b = { x: db === 1 ? pb.x + sb.w : pb.x, y: yb }
  let pts: Point[]
  if (da !== db) {
    const mx = (a.x + b.x) / 2
    pts = [a, { x: mx, y: a.y }, { x: mx, y: b.y }, b]
  } else {
    const ox = da === 1 ? Math.max(a.x, b.x) + STUB * 1.6 : Math.min(a.x, b.x) - STUB * 1.6
    pts = [a, { x: ox, y: a.y }, { x: ox, y: b.y }, b]
  }
  const mid = { x: pts[1]!.x, y: (a.y + b.y) / 2 }
  return { path: rounded(pts), a, b, da, db, mid }
}

/** Crow's-foot (many) or bar (one) marker drawn at an endpoint. */
export function markerPath(p: Point, dir: 1 | -1, card: '1' | '*'): string {
  const x = p.x
  const y = p.y
  if (card === '*') {
    const tip = x + dir * 14
    return `M ${tip} ${y} L ${x} ${y - 7} M ${tip} ${y} L ${x} ${y + 7} M ${x} ${y} L ${tip} ${y}`
  }
  const bx = x + dir * 10
  return `M ${bx} ${y - 7} L ${bx} ${y + 7}`
}
