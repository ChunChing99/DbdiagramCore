<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, reactive, ref, watch } from 'vue'
import { cardinality, type Column, type Ref, type RelationOp, type Table } from '@/dbml/types'
import { addRef, addTable, deleteRef, deleteTable, setRefOp, setTableColor } from '@/dbml/edit'
import {
  COLORS,
  DEFAULT_HEADER,
  FONT,
  HEADER_H,
  PAD_X,
  ROW_H,
  bounds,
  markerPath,
  routeRef,
  type Point,
} from '@/diagram/layout'
import {
  applyEdit,
  canEdit,
  cursorTable,
  dropPoint,
  errorCount,
  positions,
  relayout,
  reveal,
  schema,
  selected,
  sizes,
} from '@/store'
import { downloadBlob, svgToPng } from '@/diagram/export'

const emit = defineEmits<{ 'edit-table': [id: string]; toast: [msg: string] }>()

const VIEW_KEY = 'dbdiagram.view'

const root = ref<HTMLDivElement>()
const world = ref<SVGGElement>()
const view = reactive({ x: 0, y: 0, zoom: 1 })
const size = reactive({ w: 800, h: 600 })
const hoverTable = ref<string | null>(null)
const hoverCol = ref<{ table: string; col: string } | null>(null)
const selectedRef = ref<string | null>(null)
const exporting = ref(false)

const tooltip = ref<{ x: number; y: number; title: string; lines: string[] } | null>(null)
const menu = ref<{ x: number; y: number; table?: string; world: Point } | null>(null)
const refPop = ref<{ x: number; y: number; id: string } | null>(null)

// ---------- helpers ----------
const tables = computed(() => schema.value.tables)
const tableById = computed(() => new Map(tables.value.map((t) => [t.id, t])))

function headerColor(t: Table) {
  return t.headerColor || DEFAULT_HEADER
}
function textOn(bg: string) {
  const m = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(bg)
  if (!m) return '#fff'
  let h = m[1]!
  if (h.length === 3) h = h.replace(/(.)/g, '$1$1')
  const [r, g, b] = [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16))
  return 0.299 * r! + 0.587 * g! + 0.114 * b! > 170 ? '#1f2328' : '#fff'
}
function toWorld(clientX: number, clientY: number): Point {
  const r = root.value!.getBoundingClientRect()
  return { x: (clientX - r.left - view.x) / view.zoom, y: (clientY - r.top - view.y) / view.zoom }
}
function toLocal(clientX: number, clientY: number): Point {
  const r = root.value!.getBoundingClientRect()
  return { x: clientX - r.left, y: clientY - r.top }
}
function refLabel(r: Ref) {
  const e = (x: Ref['from']) => `${x.table}.${x.columns.length > 1 ? `(${x.columns.join(', ')})` : x.columns[0]}`
  return `${e(r.from)} ${r.op} ${e(r.to)}`
}
function requireEdit(): boolean {
  if (canEdit.value) return true
  emit('toast', `DBML 目前有 ${errorCount.value} 個錯誤，請先修正後再從圖表編輯`)
  return false
}

// ---------- relationships ----------
interface DrawnRef {
  key: string
  ref: Ref
  path: string
  markers: string[]
  mid: Point
  active: boolean
}
const drawnRefs = computed<DrawnRef[]>(() => {
  const out: DrawnRef[] = []
  for (const r of schema.value.refs) {
    const ta = tableById.value.get(r.from.table)
    const tb = tableById.value.get(r.to.table)
    const pa = positions.value[r.from.table]
    const pb = positions.value[r.to.table]
    if (!ta || !tb || !pa || !pb) continue
    const card = cardinality(r.op)
    const active =
      selectedRef.value === r.id ||
      hoverTable.value === r.from.table ||
      hoverTable.value === r.to.table ||
      selected.value.includes(r.from.table) ||
      selected.value.includes(r.to.table) ||
      (!!hoverCol.value &&
        ((hoverCol.value.table === r.from.table && r.from.columns.includes(hoverCol.value.col)) ||
          (hoverCol.value.table === r.to.table && r.to.columns.includes(hoverCol.value.col))))
    r.from.columns.forEach((c, k) => {
      const ia = ta.columns.findIndex((x) => x.name === c)
      const ib = tb.columns.findIndex((x) => x.name === r.to.columns[k])
      const route = routeRef(pa, sizes.value[ta.id]!, ia, pb, sizes.value[tb.id]!, ib, ta.id === tb.id)
      out.push({
        key: `${r.id}:${k}`,
        ref: r,
        path: route.path,
        markers: [markerPath(route.a, route.da, card.from), markerPath(route.b, route.db, card.to)],
        mid: route.mid,
        active,
      })
    })
  }
  // draw highlighted lines last so they sit on top
  return out.sort((a, b) => Number(a.active) - Number(b.active))
})

/** Columns involved in a highlighted relationship. */
const activeCols = computed(() => {
  const s = new Set<string>()
  for (const d of drawnRefs.value)
    if (d.active) {
      for (const c of d.ref.from.columns) s.add(`${d.ref.from.table}\u0000${c}`)
      for (const c of d.ref.to.columns) s.add(`${d.ref.to.table}\u0000${c}`)
    }
  return s
})
const fkCols = computed(() => {
  const s = new Set<string>()
  for (const r of schema.value.refs) {
    const fk = r.op === '<' ? r.to : r.from
    for (const c of fk.columns) s.add(`${fk.table}\u0000${c}`)
  }
  return s
})

// ---------- groups ----------
const drawnGroups = computed(() =>
  schema.value.groups.flatMap((g) => {
    const b = bounds(g.tables, positions.value, sizes.value)
    if (!b) return []
    const color = g.color || '#8e9aaf'
    return [{ g, color, x: b.x - 24, y: b.y - 52, w: b.w + 48, h: b.h + 76 }]
  }),
)

// ---------- view ----------
function saveView() {
  try {
    localStorage.setItem(VIEW_KEY, JSON.stringify(view))
  } catch {
    /* ignore */
  }
}
watch(
  view,
  () => {
    dropPoint.value = { x: Math.round((size.w / 2 - view.x) / view.zoom - 100), y: Math.round((size.h / 2 - view.y) / view.zoom - 80) }
    saveView()
  },
  { deep: true },
)

function zoomAt(factor: number, cx = size.w / 2, cy = size.h / 2) {
  const z = Math.min(3, Math.max(0.1, view.zoom * factor))
  view.x = cx - ((cx - view.x) * z) / view.zoom
  view.y = cy - ((cy - view.y) * z) / view.zoom
  view.zoom = z
}
function fit() {
  const b = bounds(
    tables.value.map((t) => t.id),
    positions.value,
    sizes.value,
  )
  if (!b) return
  const z = Math.min(1.2, Math.max(0.1, Math.min((size.w - 80) / b.w, (size.h - 80) / b.h)))
  view.zoom = z
  view.x = (size.w - b.w * z) / 2 - b.x * z
  view.y = (size.h - b.h * z) / 2 - b.y * z
}
function arrange() {
  relayout()
  nextTick(fit)
}
function onWheel(e: WheelEvent) {
  e.preventDefault()
  const p = toLocal(e.clientX, e.clientY)
  if (e.ctrlKey || Math.abs(e.deltaY) >= Math.abs(e.deltaX)) zoomAt(Math.exp(-e.deltaY * (e.ctrlKey ? 0.01 : 0.0015)), p.x, p.y)
  else view.x -= e.deltaX
}

// ---------- pointer interactions ----------
type Drag =
  | { kind: 'pan'; sx: number; sy: number; ox: number; oy: number; moved: boolean }
  | { kind: 'move'; sx: number; sy: number; orig: Record<string, Point>; moved: boolean; table: string }
  | { kind: 'connect'; from: { table: string; col: string }; start: Point; cur: Point; target: { table: string; col: string } | null }
  | { kind: 'marquee'; start: Point; cur: Point }
const drag = ref<Drag | null>(null)

function closePopups() {
  menu.value = null
  refPop.value = null
}

function onBgDown(e: PointerEvent) {
  closePopups()
  root.value?.focus()
  if (e.button === 2) return
  if (e.shiftKey && e.button === 0) {
    const p = toWorld(e.clientX, e.clientY)
    drag.value = { kind: 'marquee', start: p, cur: p }
    return
  }
  drag.value = { kind: 'pan', sx: e.clientX, sy: e.clientY, ox: view.x, oy: view.y, moved: false }
}

function startMove(e: PointerEvent, ids: string[], primary: string) {
  const orig: Record<string, Point> = {}
  for (const id of ids) if (positions.value[id]) orig[id] = { ...positions.value[id]! }
  drag.value = { kind: 'move', sx: e.clientX, sy: e.clientY, orig, moved: false, table: primary }
}

function onTableDown(e: PointerEvent, t: Table) {
  if (e.button !== 0) return
  e.stopPropagation()
  closePopups()
  root.value?.focus()
  selectedRef.value = null
  if (e.shiftKey || e.ctrlKey || e.metaKey) {
    selected.value = selected.value.includes(t.id) ? selected.value.filter((x) => x !== t.id) : [...selected.value, t.id]
  } else if (!selected.value.includes(t.id)) selected.value = [t.id]
  startMove(e, selected.value.includes(t.id) ? selected.value : [t.id], t.id)
}

function onGroupDown(e: PointerEvent, ids: string[]) {
  if (e.button !== 0) return
  e.stopPropagation()
  closePopups()
  selected.value = [...ids]
  startMove(e, ids, '')
}

function onHandleDown(e: PointerEvent, t: Table, c: Column, side: 1 | -1) {
  if (e.button !== 0) return
  e.stopPropagation()
  closePopups()
  root.value!.setPointerCapture(e.pointerId)
  const p = positions.value[t.id]!
  const i = t.columns.indexOf(c)
  const start = { x: side === 1 ? p.x + sizes.value[t.id]!.w : p.x, y: p.y + HEADER_H + i * ROW_H + ROW_H / 2 }
  drag.value = { kind: 'connect', from: { table: t.id, col: c.name }, start, cur: start, target: null }
}

function columnAt(p: Point): { table: string; col: string } | null {
  for (let i = tables.value.length - 1; i >= 0; i--) {
    const t = tables.value[i]!
    const pos = positions.value[t.id]
    const s = sizes.value[t.id]
    if (!pos || !s) continue
    if (p.x < pos.x - 8 || p.x > pos.x + s.w + 8 || p.y < pos.y || p.y > pos.y + s.h) continue
    const row = Math.floor((p.y - pos.y - HEADER_H) / ROW_H)
    const c = t.columns[row]
    return c ? { table: t.id, col: c.name } : null
  }
  return null
}

function onMove(e: PointerEvent) {
  const d = drag.value
  if (!d) return
  if (d.kind === 'pan') {
    view.x = d.ox + e.clientX - d.sx
    view.y = d.oy + e.clientY - d.sy
    if (!d.moved && Math.abs(e.clientX - d.sx) + Math.abs(e.clientY - d.sy) > 3) {
      d.moved = true
      // capture only once dragging so clicks / double-clicks still reach their targets
      root.value?.setPointerCapture(e.pointerId)
    }
  } else if (d.kind === 'move') {
    const dx = (e.clientX - d.sx) / view.zoom
    const dy = (e.clientY - d.sy) / view.zoom
    if (!d.moved && Math.abs(dx) + Math.abs(dy) < 3 / view.zoom) return
    if (!d.moved) root.value?.setPointerCapture(e.pointerId)
    d.moved = true
    tooltip.value = null
    const next = { ...positions.value }
    for (const [id, o] of Object.entries(d.orig)) next[id] = { x: Math.round(o.x + dx), y: Math.round(o.y + dy) }
    positions.value = next
  } else if (d.kind === 'connect') {
    d.cur = toWorld(e.clientX, e.clientY)
    const target = columnAt(d.cur)
    d.target = target && !(target.table === d.from.table && target.col === d.from.col) ? target : null
  } else if (d.kind === 'marquee') {
    d.cur = toWorld(e.clientX, e.clientY)
  }
}

function onUp() {
  const d = drag.value
  drag.value = null
  if (!d) return
  if (d.kind === 'pan' && !d.moved) {
    selected.value = []
    selectedRef.value = null
  } else if (d.kind === 'move' && !d.moved && d.table) {
    const t = tableById.value.get(d.table)
    if (t) reveal(t.nameRange, false)
  } else if (d.kind === 'connect' && d.target) {
    if (!requireEdit()) return
    const from = tableById.value.get(d.from.table)!.columns.find((c) => c.name === d.from.col)!
    const to = tableById.value.get(d.target.table)!.columns.find((c) => c.name === d.target!.col)!
    // the primary-key end is the "one" side
    const [many, one] = from.pk && !to.pk ? [d.target, d.from] : [d.from, d.target]
    applyEdit((src, s) => addRef(src, s, many.table, many.col, one.table, one.col, '>'))
    emit('toast', `已新增關聯 ${many.table}.${many.col} > ${one.table}.${one.col}`)
  } else if (d.kind === 'marquee') {
    const x1 = Math.min(d.start.x, d.cur.x)
    const x2 = Math.max(d.start.x, d.cur.x)
    const y1 = Math.min(d.start.y, d.cur.y)
    const y2 = Math.max(d.start.y, d.cur.y)
    selected.value = tables.value
      .filter((t) => {
        const p = positions.value[t.id]
        const s = sizes.value[t.id]
        return p && s && p.x < x2 && p.x + s.w > x1 && p.y < y2 && p.y + s.h > y1
      })
      .map((t) => t.id)
  }
}

const marquee = computed(() => {
  const d = drag.value
  if (d?.kind !== 'marquee') return null
  return { x: Math.min(d.start.x, d.cur.x), y: Math.min(d.start.y, d.cur.y), w: Math.abs(d.cur.x - d.start.x), h: Math.abs(d.cur.y - d.start.y) }
})
const connectLine = computed(() => {
  const d = drag.value
  if (d?.kind !== 'connect') return null
  const end = d.cur
  const mx = (d.start.x + end.x) / 2
  return `M ${d.start.x} ${d.start.y} C ${mx} ${d.start.y} ${mx} ${end.y} ${end.x} ${end.y}`
})
const connectTarget = computed(() => (drag.value?.kind === 'connect' ? drag.value.target : null))

// ---------- hover / tooltip ----------
function onColEnter(e: PointerEvent, t: Table, c: Column) {
  hoverCol.value = { table: t.id, col: c.name }
  if (drag.value) return
  const lines: string[] = [`型別：${c.type}`]
  const flags = [c.pk && '主鍵', c.increment && '自動遞增', c.notNull && '不可為空', c.unique && '唯一'].filter(Boolean)
  if (flags.length) lines.push(flags.join('、'))
  if (c.default !== undefined) lines.push(`預設值：${c.default}`)
  const en = schema.value.enums.find((x) => x.id === c.type || x.name === c.type)
  if (en) lines.push(`列舉值：${en.values.map((v) => v.name).join(', ')}`)
  for (const r of schema.value.refs)
    if ((r.from.table === t.id && r.from.columns.includes(c.name)) || (r.to.table === t.id && r.to.columns.includes(c.name))) lines.push(`關聯：${refLabel(r)}`)
  if (c.note) lines.push(`註解：${c.note}`)
  const p = toLocal(e.clientX, e.clientY)
  tooltip.value = { x: p.x + 14, y: p.y + 14, title: `${t.name}.${c.name}`, lines }
}
function onColLeave() {
  hoverCol.value = null
  tooltip.value = null
}
function onHeaderEnter(e: PointerEvent, t: Table) {
  if (drag.value || !t.note) return
  const p = toLocal(e.clientX, e.clientY)
  tooltip.value = { x: p.x + 14, y: p.y + 14, title: t.id, lines: [t.note] }
}

// ---------- menus ----------
function onTableMenu(e: MouseEvent, t: Table) {
  e.stopPropagation()
  const p = toLocal(e.clientX, e.clientY)
  if (!selected.value.includes(t.id)) selected.value = [t.id]
  refPop.value = null
  menu.value = { x: p.x, y: p.y, table: t.id, world: toWorld(e.clientX, e.clientY) }
}
function onBgMenu(e: MouseEvent) {
  const p = toLocal(e.clientX, e.clientY)
  refPop.value = null
  menu.value = { x: p.x, y: p.y, world: toWorld(e.clientX, e.clientY) }
}
function onRefClick(e: MouseEvent, r: Ref) {
  e.stopPropagation()
  closePopups()
  selectedRef.value = r.id
  const p = toLocal(e.clientX, e.clientY)
  refPop.value = { x: p.x, y: p.y, id: r.id }
}
const popRef = computed(() => schema.value.refs.find((r) => r.id === refPop.value?.id))
const menuTable = computed(() => (menu.value?.table ? tableById.value.get(menu.value.table) : undefined))

// ---------- edit actions ----------
function newTableAt(p: Point) {
  closePopups()
  if (!requireEdit()) return
  dropPoint.value = { x: Math.round(p.x), y: Math.round(p.y) }
  let id = ''
  applyEdit((src, s) => {
    const r = addTable(src, s)
    id = r.id
    return r.src
  })
  selected.value = [id]
  nextTick(() => emit('edit-table', id))
}
function newTableCenter() {
  newTableAt({ x: (size.w / 2 - view.x) / view.zoom - 100, y: (size.h / 2 - view.y) / view.zoom - 60 })
}
function removeTables(ids: string[]) {
  closePopups()
  if (!ids.length || !requireEdit()) return
  if (!confirm(`確定要刪除資料表 ${ids.join('、')}？相關的關聯也會一併移除。`)) return
  for (const id of ids) applyEdit((src, s) => deleteTable(src, s, id))
  selected.value = []
}
function colorTables(ids: string[], color: string | undefined) {
  if (!requireEdit()) return
  for (const id of ids)
    applyEdit((src, s) => {
      const t = s.tables.find((x) => x.id === id)
      return t ? setTableColor(src, t, color) : src
    })
}
function changeRefOp(op: RelationOp) {
  const r = popRef.value
  if (!r || !requireEdit()) return
  applyEdit((src, s) => {
    const cur = s.refs.find((x) => x.id === r.id)
    return cur ? setRefOp(src, cur, op) : src
  })
}
function removeRef() {
  const r = popRef.value
  if (!r || !requireEdit()) return
  applyEdit((src, s) => {
    const cur = s.refs.find((x) => x.id === r.id)
    return cur ? deleteRef(src, cur) : src
  })
  refPop.value = null
  selectedRef.value = null
}

function onKey(e: KeyboardEvent) {
  if ((e.target as HTMLElement).closest('input, textarea')) return
  if (e.key === 'Delete' || e.key === 'Backspace') {
    if (selectedRef.value) {
      refPop.value = { x: 0, y: 0, id: selectedRef.value }
      removeRef()
    } else removeTables(selected.value)
  } else if (e.key === 'Escape') {
    closePopups()
    selected.value = []
    selectedRef.value = null
  } else if (e.key === 'a' && (e.ctrlKey || e.metaKey)) {
    e.preventDefault()
    selected.value = tables.value.map((t) => t.id)
  } else if (e.key === 'Enter' && selected.value.length === 1) {
    emit('edit-table', selected.value[0]!)
  }
}

// ---------- export ----------
async function exportImage(kind: 'png' | 'svg') {
  const b = bounds(
    tables.value.map((t) => t.id),
    positions.value,
    sizes.value,
  )
  if (!b || !world.value) return
  for (const g of drawnGroups.value) {
    b.w = Math.max(b.x + b.w, g.x + g.w) - Math.min(b.x, g.x)
    b.h = Math.max(b.y + b.h, g.y + g.h) - Math.min(b.y, g.y)
    b.x = Math.min(b.x, g.x)
    b.y = Math.min(b.y, g.y)
  }
  const pad = 40
  exporting.value = true
  const oldHover = [hoverTable.value, hoverCol.value, selectedRef.value]
  hoverTable.value = hoverCol.value = selectedRef.value = null
  await nextTick()
  const inner = world.value.innerHTML.replace(/<!--.*?-->/gs, '')
  exporting.value = false
  ;[hoverTable.value, hoverCol.value, selectedRef.value] = oldHover as [string | null, { table: string; col: string } | null, string | null]
  const w = Math.ceil(b.w + pad * 2)
  const h = Math.ceil(b.h + pad * 2)
  const svg =
    `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="${b.x - pad} ${b.y - pad} ${w} ${h}" font-family='${FONT}'>` +
    `<defs><filter id="shadow" x="-10%" y="-10%" width="120%" height="130%"><feDropShadow dx="0" dy="2" stdDeviation="3" flood-color="#1f2328" flood-opacity="0.12"/></filter></defs>` +
    `<rect x="${b.x - pad}" y="${b.y - pad}" width="${w}" height="${h}" fill="#ffffff"/>${inner}</svg>`
  const name = 'dbdiagram'
  if (kind === 'svg') downloadBlob(new Blob([svg], { type: 'image/svg+xml' }), `${name}.svg`)
  else downloadBlob(await svgToPng(svg, w, h, 2), `${name}.png`)
}

// ---------- lifecycle ----------
let ro: ResizeObserver | undefined
onMounted(() => {
  const el = root.value!
  ro = new ResizeObserver(() => {
    size.w = el.clientWidth
    size.h = el.clientHeight
  })
  ro.observe(el)
  size.w = el.clientWidth
  size.h = el.clientHeight
  let saved: typeof view | undefined
  try {
    saved = JSON.parse(localStorage.getItem(VIEW_KEY) ?? 'null') ?? undefined
  } catch {
    /* ignore */
  }
  if (saved && Number.isFinite(saved.zoom)) Object.assign(view, saved)
  else nextTick(fit)
  window.addEventListener('pointerdown', onWindowDown)
})
onBeforeUnmount(() => {
  ro?.disconnect()
  window.removeEventListener('pointerdown', onWindowDown)
})
function onWindowDown(e: PointerEvent) {
  if (!root.value?.contains(e.target as Node)) closePopups()
}

defineExpose({ fit, arrange, exportImage, newTableCenter })

const gridSize = computed(() => 20 * view.zoom)
</script>

<template>
  <div
    ref="root"
    class="canvas"
    tabindex="0"
    :class="{ panning: drag?.kind === 'pan' && drag.moved, connecting: drag?.kind === 'connect' }"
    @wheel="onWheel"
    @keydown="onKey"
    @pointermove="onMove"
    @pointerup="onUp"
    @pointercancel="onUp"
    @contextmenu.prevent
  >
    <svg
      class="svg"
      :width="size.w"
      :height="size.h"
      @pointerdown="onBgDown"
      @dblclick="newTableAt(toWorld($event.clientX, $event.clientY))"
      @contextmenu.prevent="onBgMenu"
    >
      <defs>
        <pattern id="grid" :width="gridSize" :height="gridSize" patternUnits="userSpaceOnUse" :x="view.x" :y="view.y">
          <circle :cx="1" :cy="1" r="1" fill="#c9d1db" />
        </pattern>
        <filter id="shadow" x="-10%" y="-10%" width="120%" height="130%">
          <feDropShadow dx="0" dy="2" stdDeviation="3" flood-color="#1f2328" flood-opacity="0.12" />
        </filter>
      </defs>
      <rect width="100%" height="100%" fill="url(#grid)" />

      <g :transform="`translate(${view.x} ${view.y}) scale(${view.zoom})`">
        <g ref="world" :font-family="FONT">
          <!-- table groups -->
          <g v-for="gr in drawnGroups" :key="'g:' + gr.g.name">
            <rect :x="gr.x" :y="gr.y" :width="gr.w" :height="gr.h" rx="12" :fill="gr.color" fill-opacity="0.07" :stroke="gr.color" stroke-opacity="0.5" stroke-dasharray="6 4" />
            <g class="grab" @pointerdown="onGroupDown($event, gr.g.tables)" @dblclick.stop>
              <rect :x="gr.x" :y="gr.y" :width="gr.w" height="36" rx="12" :fill="gr.color" fill-opacity="0.15" />
              <text :x="gr.x + 14" :y="gr.y + 23" font-size="14" font-weight="600" :fill="gr.color">{{ gr.g.name }}</text>
            </g>
          </g>

          <!-- relationships -->
          <g v-for="d in drawnRefs" :key="d.key" class="ref" @pointerdown.stop @dblclick.stop @click="onRefClick($event, d.ref)">
            <path :d="d.path" fill="none" stroke="transparent" stroke-width="14" />
            <path
              :d="d.path"
              fill="none"
              :stroke="d.active ? '#2f80ed' : d.ref.color || '#8a99ad'"
              :stroke-width="d.active ? 2.2 : 1.4"
            />
            <path :d="d.markers.join(' ')" fill="none" :stroke="d.active ? '#2f80ed' : d.ref.color || '#8a99ad'" :stroke-width="d.active ? 2.2 : 1.4" />
          </g>

          <!-- tables -->
          <g
            v-for="t in tables"
            :key="t.id"
            :transform="`translate(${positions[t.id]?.x ?? 0} ${positions[t.id]?.y ?? 0})`"
            class="table"
            @pointerdown="onTableDown($event, t)"
            @pointerenter="hoverTable = t.id"
            @pointerleave="hoverTable = null"
            @dblclick.stop="emit('edit-table', t.id)"
            @contextmenu.prevent="onTableMenu($event, t)"
          >
            <rect :width="sizes[t.id]!.w" :height="sizes[t.id]!.h" rx="8" fill="#ffffff" stroke="#d0d7de" filter="url(#shadow)" />
            <path
              :d="`M 0 8 A 8 8 0 0 1 8 0 H ${sizes[t.id]!.w - 8} A 8 8 0 0 1 ${sizes[t.id]!.w} 8 V ${HEADER_H} H 0 Z`"
              :fill="headerColor(t)"
              @pointerenter="onHeaderEnter($event, t)"
              @pointerleave="tooltip = null"
            />
            <text :x="PAD_X" :y="23" font-size="14" font-weight="600" :fill="textOn(headerColor(t))" pointer-events="none">
              {{ t.name }}<tspan v-if="t.alias" font-weight="400" fill-opacity="0.75"> ({{ t.alias }})</tspan>
            </text>
            <text v-if="t.note" :x="sizes[t.id]!.w - PAD_X" y="23" text-anchor="end" font-size="12" :fill="textOn(headerColor(t))" fill-opacity="0.8" pointer-events="none">✎</text>

            <g
              v-for="(c, i) in t.columns"
              :key="c.name"
              :transform="`translate(0 ${HEADER_H + i * ROW_H})`"
              @pointerenter="onColEnter($event, t, c)"
              @pointerleave="onColLeave"
            >
              <rect
                x="1"
                :width="sizes[t.id]!.w - 2"
                :height="i === t.columns.length - 1 ? ROW_H - 1 : ROW_H"
                :fill="
                  connectTarget && connectTarget.table === t.id && connectTarget.col === c.name
                    ? '#d6e8ff'
                    : activeCols.has(t.id + '\u0000' + c.name)
                      ? '#eaf3ff'
                      : '#ffffff'
                "
              />
              <line v-if="i > 0" x1="0" :x2="sizes[t.id]!.w" y1="0" y2="0" stroke="#eef0f3" />
              <g v-if="c.pk" transform="translate(9 9)" pointer-events="none">
                <circle cx="4" cy="5" r="3.2" fill="none" stroke="#e2a400" stroke-width="1.6" />
                <path d="M 7 5 H 13 M 11 5 V 8 M 13 5 V 7.5" fill="none" stroke="#e2a400" stroke-width="1.6" stroke-linecap="round" />
              </g>
              <text
                :x="PAD_X + 18"
                :y="ROW_H / 2 + 4.5"
                font-size="13"
                :fill="fkCols.has(t.id + '\u0000' + c.name) ? '#1d4f91' : '#24292f'"
                :font-weight="c.pk ? 600 : 400"
                pointer-events="none"
              >
                {{ c.name }}<tspan v-if="c.notNull && !c.pk" fill="#cf222e" font-size="11"> *</tspan>
              </text>
              <text :x="sizes[t.id]!.w - PAD_X" :y="ROW_H / 2 + 4.5" text-anchor="end" font-size="12" fill="#6e7781" pointer-events="none">
                {{ c.type }}
              </text>
              <template v-if="!exporting && (hoverCol?.table === t.id && hoverCol.col === c.name)">
                <circle class="handle" cx="0" :cy="ROW_H / 2" r="5.5" @pointerdown="onHandleDown($event, t, c, -1)" />
                <circle class="handle" :cx="sizes[t.id]!.w" :cy="ROW_H / 2" r="5.5" @pointerdown="onHandleDown($event, t, c, 1)" />
              </template>
            </g>
            <text v-if="!t.columns.length" :x="PAD_X" :y="HEADER_H + 18" font-size="12" font-style="italic" fill="#8c959f">(無欄位)</text>

            <rect
              v-if="!exporting && (selected.includes(t.id) || cursorTable === t.id)"
              x="-3"
              y="-3"
              :width="sizes[t.id]!.w + 6"
              :height="sizes[t.id]!.h + 6"
              rx="10"
              fill="none"
              :stroke="selected.includes(t.id) ? '#2f80ed' : '#e5a50a'"
              stroke-width="2"
              pointer-events="none"
            />
          </g>
        </g>

        <path v-if="connectLine" :d="connectLine" fill="none" stroke="#2f80ed" stroke-width="2" stroke-dasharray="6 4" pointer-events="none" />
        <rect
          v-if="marquee"
          :x="marquee.x"
          :y="marquee.y"
          :width="marquee.w"
          :height="marquee.h"
          fill="#2f80ed"
          fill-opacity="0.08"
          stroke="#2f80ed"
          stroke-dasharray="4 3"
          :stroke-width="1 / view.zoom"
        />
      </g>
    </svg>

    <div v-if="errorCount" class="banner">
      DBML 有 {{ errorCount }} 個錯誤 — 圖表顯示最後一次正確的結果，暫停從圖表編輯
    </div>

    <div class="toolbar">
      <button title="新增資料表" @click="newTableCenter">＋ 資料表</button>
      <span class="sep"></span>
      <button title="自動排列" @click="arrange">⇄ 自動排列</button>
      <button title="符合畫面" @click="fit">⛶</button>
      <span class="sep"></span>
      <button title="縮小" @click="zoomAt(1 / 1.2)">−</button>
      <button class="zoom" title="重設為 100%" @click="zoomAt(1 / view.zoom)">{{ Math.round(view.zoom * 100) }}%</button>
      <button title="放大" @click="zoomAt(1.2)">＋</button>
    </div>

    <div class="hint">拖曳欄位兩側圓點可建立關聯 · 雙擊資料表編輯 · 雙擊空白處新增 · Shift+拖曳框選</div>

    <div v-if="tooltip" class="tooltip" :style="{ left: tooltip.x + 'px', top: tooltip.y + 'px' }">
      <div class="tt-title">{{ tooltip.title }}</div>
      <div v-for="(l, i) in tooltip.lines" :key="i" class="tt-line">{{ l }}</div>
    </div>

    <div v-if="menu" class="menu" :style="{ left: menu.x + 'px', top: menu.y + 'px' }" @pointerdown.stop>
      <template v-if="menuTable">
        <div class="menu-title">{{ menuTable.id }}</div>
        <button @click="emit('edit-table', menuTable.id); closePopups()">編輯資料表…</button>
        <button @click="reveal(menuTable.range, true); closePopups()">在編輯器中顯示</button>
        <div class="menu-label">標題顏色</div>
        <div class="swatches">
          <button
            v-for="c in COLORS"
            :key="c"
            class="swatch"
            :style="{ background: c }"
            :title="c"
            @click="colorTables(selected.length ? selected : [menuTable.id], c); closePopups()"
          ></button>
          <button class="swatch none" title="預設" @click="colorTables(selected.length ? selected : [menuTable.id], undefined); closePopups()">∅</button>
        </div>
        <button class="danger" @click="removeTables(selected.length ? selected : [menuTable.id])">
          刪除{{ selected.length > 1 ? ` ${selected.length} 個` : '' }}資料表
        </button>
      </template>
      <template v-else>
        <button @click="newTableAt(menu.world)">在此新增資料表</button>
        <button @click="arrange(); closePopups()">自動排列</button>
        <button @click="fit(); closePopups()">符合畫面</button>
      </template>
    </div>

    <div v-if="refPop && popRef" class="menu refpop" :style="{ left: refPop.x + 'px', top: refPop.y + 'px' }" @pointerdown.stop>
      <div class="menu-title mono">{{ refLabel(popRef) }}</div>
      <div class="ops">
        <button :class="{ on: popRef.op === '>' }" title="多對一" @click="changeRefOp('>')">多對一 &gt;</button>
        <button :class="{ on: popRef.op === '<' }" title="一對多" @click="changeRefOp('<')">一對多 &lt;</button>
        <button :class="{ on: popRef.op === '-' }" title="一對一" @click="changeRefOp('-')">一對一 -</button>
        <button :class="{ on: popRef.op === '<>' }" title="多對多" @click="changeRefOp('<>')">多對多 &lt;&gt;</button>
      </div>
      <div v-if="popRef.onDelete || popRef.onUpdate" class="menu-label">
        <span v-if="popRef.onDelete">on delete: {{ popRef.onDelete }} </span>
        <span v-if="popRef.onUpdate">on update: {{ popRef.onUpdate }}</span>
      </div>
      <button @click="reveal(popRef.range, true); closePopups()">在編輯器中顯示</button>
      <button class="danger" @click="removeRef">刪除關聯</button>
    </div>
  </div>
</template>

<style scoped>
.canvas {
  position: relative;
  width: 100%;
  height: 100%;
  overflow: hidden;
  background: #f6f8fa;
  outline: none;
  user-select: none;
  cursor: default;
}
.canvas.panning {
  cursor: grabbing;
}
.canvas.connecting {
  cursor: crosshair;
}
.svg {
  display: block;
}
.table {
  cursor: move;
}
.grab {
  cursor: move;
}
.ref {
  cursor: pointer;
}
.handle {
  fill: #fff;
  stroke: #2f80ed;
  stroke-width: 2;
  cursor: crosshair;
}
.handle:hover {
  fill: #2f80ed;
}
.banner {
  position: absolute;
  top: 12px;
  left: 50%;
  transform: translateX(-50%);
  background: #fff4e5;
  border: 1px solid #f0b46a;
  color: #8a4b00;
  padding: 6px 14px;
  border-radius: 6px;
  font-size: 13px;
  box-shadow: 0 2px 8px rgb(0 0 0 / 0.08);
  pointer-events: none;
}
.toolbar {
  position: absolute;
  right: 16px;
  bottom: 16px;
  display: flex;
  align-items: center;
  gap: 2px;
  background: #fff;
  border: 1px solid #d0d7de;
  border-radius: 8px;
  padding: 4px;
  box-shadow: 0 2px 10px rgb(0 0 0 / 0.08);
}
.toolbar button {
  border: none;
  background: transparent;
  padding: 6px 10px;
  border-radius: 5px;
  font-size: 13px;
  color: #24292f;
  cursor: pointer;
  font-family: inherit;
}
.toolbar button:hover {
  background: #eef1f4;
}
.toolbar .zoom {
  min-width: 56px;
  font-variant-numeric: tabular-nums;
}
.sep {
  width: 1px;
  height: 20px;
  background: #d0d7de;
  margin: 0 4px;
}
.hint {
  position: absolute;
  left: 16px;
  bottom: 20px;
  font-size: 12px;
  color: #8c959f;
  pointer-events: none;
}
.tooltip {
  position: absolute;
  max-width: 340px;
  background: #1f2328;
  color: #e6edf3;
  font-size: 12px;
  line-height: 1.55;
  padding: 8px 10px;
  border-radius: 6px;
  pointer-events: none;
  box-shadow: 0 4px 14px rgb(0 0 0 / 0.2);
  z-index: 5;
}
.tt-title {
  font-weight: 600;
  margin-bottom: 2px;
}
.tt-line {
  white-space: pre-wrap;
  word-break: break-word;
}
.menu {
  position: absolute;
  z-index: 10;
  min-width: 190px;
  background: #fff;
  border: 1px solid #d0d7de;
  border-radius: 8px;
  padding: 6px;
  box-shadow: 0 8px 24px rgb(0 0 0 / 0.14);
  display: flex;
  flex-direction: column;
  font-size: 13px;
}
.menu > button,
.ops button {
  text-align: left;
  border: none;
  background: transparent;
  padding: 6px 10px;
  border-radius: 5px;
  cursor: pointer;
  color: #24292f;
  font-family: inherit;
  font-size: 13px;
}
.menu > button:hover,
.ops button:hover {
  background: #eef1f4;
}
.menu .danger {
  color: #cf222e;
}
.menu-title {
  font-weight: 600;
  padding: 4px 10px 6px;
  border-bottom: 1px solid #eef0f3;
  margin-bottom: 4px;
}
.mono {
  font-family: Consolas, monospace;
  font-size: 12px;
}
.menu-label {
  font-size: 11px;
  color: #6e7781;
  padding: 6px 10px 2px;
}
.swatches {
  display: flex;
  flex-wrap: wrap;
  gap: 5px;
  padding: 4px 10px 8px;
  max-width: 190px;
}
.swatch {
  width: 20px;
  height: 20px;
  border-radius: 4px;
  border: 1px solid rgb(0 0 0 / 0.1);
  cursor: pointer;
  padding: 0;
}
.swatch.none {
  background: #fff;
  font-size: 11px;
  color: #6e7781;
}
.ops {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 2px;
  margin-bottom: 4px;
}
.ops button.on {
  background: #ddeeff;
  color: #0b5cad;
  font-weight: 600;
}
</style>
