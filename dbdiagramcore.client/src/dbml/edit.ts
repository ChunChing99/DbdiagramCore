/**
 * Text-level edit operations. Each takes the current source and its parsed schema
 * and returns the new source, touching only the affected ranges so comments and
 * formatting elsewhere survive.
 */
import { tableIdOf } from './parser'
import { generateTable, quoteIdent, quoteTableId, refText, type ColumnDraft, type TableDraft } from './generator'
import type { Range, Ref, RelationOp, Schema, SettingItem, SettingList, Table } from './types'

interface Patch extends Range {
  text: string
}

export function applyPatches(src: string, patches: Patch[]): string {
  const sorted = [...patches].sort((a, b) => b.from - a.from)
  let out = src
  let lastFrom = Infinity
  for (const p of sorted) {
    if (p.to > lastFrom) continue // overlapping patch: skip rather than corrupt the text
    out = out.slice(0, p.from) + p.text + out.slice(p.to)
    lastFrom = p.from
  }
  return out
}

/** Expand a range to whole lines when nothing else lives on those lines. */
function lineExtent(src: string, r: Range): Range {
  let from = r.from
  let to = r.to
  while (from > 0 && (src[from - 1] === ' ' || src[from - 1] === '\t')) from--
  while (to < src.length && (src[to] === ' ' || src[to] === '\t' || src[to] === '\r')) to++
  const startsLine = from === 0 || src[from - 1] === '\n'
  const endsLine = to === src.length || src[to] === '\n'
  if (!startsLine || !endsLine) return r
  if (to < src.length) to++
  // swallow one following blank line so blocks do not leave gaps behind
  let k = to
  while (k < src.length && (src[k] === ' ' || src[k] === '\t' || src[k] === '\r')) k++
  if (src[k] === '\n') to = k + 1
  return { from, to }
}

function removal(src: string, r: Range): Patch {
  return { ...lineExtent(src, r), text: '' }
}

/** Rewrite a settings list keeping `keep` items (as written) plus `extra` new items. */
function rebuildSettings(src: string, list: SettingList, keep: SettingItem[], extra: string[] = []): Patch {
  const texts = keep.map((i) => src.slice(i.range.from, i.range.to)).concat(extra)
  if (!texts.length) {
    let from = list.range.from
    while (from > 0 && (src[from - 1] === ' ' || src[from - 1] === '\t')) from--
    return { from, to: list.range.to, text: '' }
  }
  return { ...list.range, text: `[${texts.join(', ')}]` }
}

function append(src: string, text: string): string {
  const base = src.replace(/\s+$/, '')
  return (base ? base + '\n\n' : '') + text + '\n'
}

export function resolveTable(schema: Schema, raw: string): Table | undefined {
  return (
    schema.tables.find((t) => t.id === raw) ??
    schema.tables.find((t) => t.alias === raw) ??
    (raw.startsWith('public.') ? schema.tables.find((t) => t.id === raw.slice(7)) : undefined)
  )
}

function inside(r: Range, outer: Range) {
  return r.from >= outer.from && r.to <= outer.to
}

/** Remove refs: standalone statements are deleted, inline refs are dropped from their column settings. */
function refRemovals(src: string, refs: Ref[]): Patch[] {
  const patches: Patch[] = []
  const byList = new Map<SettingList, Set<number>>()
  for (const r of refs) {
    if (!r.inline) patches.push(removal(src, r.range))
    else if (r.settings) {
      let s = byList.get(r.settings)
      if (!s) byList.set(r.settings, (s = new Set()))
      s.add(r.range.from)
    }
  }
  for (const [list, drop] of byList)
    patches.push(rebuildSettings(src, list, list.items.filter((i) => !drop.has(i.range.from))))
  return patches
}

export type EditableColumn = ColumnDraft & { origName?: string }
export type EditableTable = Omit<TableDraft, 'columns'> & { columns: EditableColumn[] }

export function tableToDraft(t: Table): EditableTable {
  return {
    schema: t.schema,
    name: t.name,
    alias: t.alias,
    headerColor: t.headerColor,
    note: t.note,
    columns: t.columns.map((c) => ({
      origName: c.name,
      name: c.name,
      type: c.type,
      pk: c.pk,
      notNull: c.notNull,
      unique: c.unique,
      increment: c.increment,
      default: c.default,
      note: c.note,
      inlineRefs: c.inlineRefs.map((r) => ({ ...r, columns: [...r.columns] })),
    })),
    indexes: t.indexes.map((i) => ({ ...i, columns: [...i.columns] })),
  }
}

/** Replace a table definition, propagating renames / deleted columns to refs and groups. */
export function updateTable(src: string, schema: Schema, tableId: string, draft: EditableTable): string {
  const t = schema.tables.find((x) => x.id === tableId)
  if (!t) return src
  const newId = tableIdOf(draft.schema, draft.name)
  const renamed = newId !== t.id
  const newRef = quoteTableId(newId, draft.schema || undefined, draft.name)

  const colMap = new Map<string, string | null>() // old name -> new name | null (deleted)
  for (const c of t.columns) colMap.set(c.name, null)
  for (const c of draft.columns) if (c.origName !== undefined && colMap.has(c.origName)) colMap.set(c.origName, c.name)

  const patches: Patch[] = []
  const removed: Ref[] = []
  for (const ref of schema.refs) {
    const ends = [ref.from, ref.to].filter((e) => e.table === t.id)
    if (!ends.length) continue
    if (ends.some((e) => e.columns.some((c) => colMap.get(c) === null))) {
      if (!inside(ref.range, t.range)) removed.push(ref)
      continue
    }
    for (const e of ends) {
      if (inside(e.tableRange, t.range)) continue
      if (renamed && e.rawTable !== t.alias) patches.push({ ...e.tableRange, text: newRef })
      e.columns.forEach((c, i) => {
        const nn = colMap.get(c)
        if (nn && nn !== c) patches.push({ ...e.columnRanges[i]!, text: quoteIdent(nn) })
      })
    }
  }
  patches.push(...refRemovals(src, removed))
  if (renamed)
    for (const g of schema.groups)
      for (const m of g.members) if (resolveTable(schema, m.raw)?.id === t.id) patches.push({ ...m.range, text: newRef })

  // self-references inside the table and index columns follow the renames
  const out: TableDraft = {
    ...draft,
    columns: draft.columns.map((c) => ({
      ...c,
      inlineRefs: c.inlineRefs.flatMap((r) => {
        if (resolveTable(schema, r.table)?.id !== t.id) return [r]
        const cols = r.columns.map((x) => colMap.get(x))
        if (cols.some((x) => !x)) return []
        return [{ ...r, table: r.table === t.alias ? r.table : newRef, columns: cols as string[] }]
      }),
    })),
    indexes: draft.indexes
      .map((i) => ({ ...i, columns: i.columns.flatMap((c) => (c.startsWith('`') ? [c] : colMap.has(c) ? (colMap.get(c) ? [colMap.get(c)!] : []) : [c])) }))
      .filter((i) => i.columns.length),
  }
  patches.push({ ...t.range, text: generateTable(out) })
  return applyPatches(src, patches)
}

export function deleteTable(src: string, schema: Schema, tableId: string): string {
  const t = schema.tables.find((x) => x.id === tableId)
  if (!t) return src
  const patches: Patch[] = [removal(src, t.range)]
  const refs = schema.refs.filter((r) => (r.from.table === t.id || r.to.table === t.id) && !inside(r.range, t.range))
  patches.push(...refRemovals(src, refs))
  for (const g of schema.groups)
    for (const m of g.members) if (resolveTable(schema, m.raw)?.id === t.id) patches.push(removal(src, m.range))
  return applyPatches(src, patches)
}

export function addTable(src: string, schema: Schema, base = 'new_table'): { src: string; id: string } {
  let name = base
  for (let i = 1; schema.tables.some((t) => t.id === name); i++) name = `${base}_${i}`
  const text = generateTable({
    name,
    columns: [
      { name: 'id', type: 'integer', pk: true, notNull: false, unique: false, increment: true, inlineRefs: [] },
      { name: 'created_at', type: 'timestamp', pk: false, notNull: false, unique: false, increment: false, inlineRefs: [] },
    ],
    indexes: [],
  })
  return { src: append(src, text), id: name }
}

export function addRef(src: string, schema: Schema, fromId: string, fromCol: string, toId: string, toCol: string, op: RelationOp = '>'): string {
  const ft = schema.tables.find((t) => t.id === fromId)
  const tt = schema.tables.find((t) => t.id === toId)
  if (!ft || !tt) return src
  return append(src, refText(quoteTableId(ft.id, ft.schema, ft.name), [fromCol], op, quoteTableId(tt.id, tt.schema, tt.name), [toCol]))
}

export function setRefOp(src: string, ref: Ref, op: RelationOp): string {
  return applyPatches(src, [{ ...ref.opRange, text: op }])
}

export function deleteRef(src: string, ref: Ref): string {
  return applyPatches(src, refRemovals(src, [ref]))
}

export function setTableColor(src: string, table: Table, color: string | undefined): string {
  const list = table.settings
  if (!list) return color ? applyPatches(src, [{ from: table.headerEnd, to: table.headerEnd, text: ` [headercolor: ${color}]` }]) : src
  const item = list.items.find((i) => i.key === 'headercolor')
  if (item?.valueRange && color) return applyPatches(src, [{ ...item.valueRange, text: color }])
  const keep = list.items.filter((i) => i !== item)
  return applyPatches(src, [rebuildSettings(src, list, keep, color ? [`headercolor: ${color}`] : [])])
}
