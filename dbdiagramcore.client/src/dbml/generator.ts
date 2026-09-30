import type { IndexDef, InlineRef, RelationOp } from './types'

export interface ColumnDraft {
  name: string
  type: string
  pk: boolean
  notNull: boolean
  unique: boolean
  increment: boolean
  default?: string
  note?: string
  inlineRefs: InlineRef[]
}

export interface TableDraft {
  schema?: string
  name: string
  alias?: string
  headerColor?: string
  note?: string
  columns: ColumnDraft[]
  indexes: IndexDef[]
}

export function quoteIdent(name: string): string {
  return /^[\p{L}_][\p{L}\p{N}_]*$/u.test(name) ? name : `"${name.replace(/(["\\])/g, '\\$1')}"`
}

export function quoteString(s: string): string {
  if (s.includes('\n')) return `'''${s.replace(/'''/g, "\\'''")}'''`
  return `'${s.replace(/(['\\])/g, '\\$1')}'`
}

export function tableRefName(schema: string | undefined, name: string): string {
  return schema ? `${quoteIdent(schema)}.${quoteIdent(name)}` : quoteIdent(name)
}

/** Quote a table id (`name` or `schema.name`) for use in a ref endpoint. */
export function quoteTableId(id: string, schema?: string, name?: string): string {
  if (schema !== undefined && name !== undefined) return tableRefName(schema, name)
  return id
    .split('.')
    .map((p) => quoteIdent(p))
    .join('.')
}

export function endpointText(table: string, columns: string[]): string {
  const cols = columns.length === 1 ? quoteIdent(columns[0]!) : `(${columns.map(quoteIdent).join(', ')})`
  return `${table}.${cols}`
}

export function refText(fromTable: string, fromCols: string[], op: RelationOp, toTable: string, toCols: string[]): string {
  return `Ref: ${endpointText(fromTable, fromCols)} ${op} ${endpointText(toTable, toCols)}`
}

function columnSettings(c: ColumnDraft): string[] {
  const s: string[] = []
  if (c.pk) s.push('pk')
  if (c.increment) s.push('increment')
  if (c.notNull && !c.pk) s.push('not null')
  if (c.unique) s.push('unique')
  if (c.default !== undefined && c.default !== '') s.push(`default: ${c.default}`)
  if (c.note) s.push(`note: ${quoteString(c.note)}`)
  for (const r of c.inlineRefs) s.push(`ref: ${r.op} ${endpointText(r.table, r.columns)}`)
  return s
}

function indexText(idx: IndexDef): string {
  const cols = idx.columns.map((c) => (c.startsWith('`') ? c : quoteIdent(c)))
  let t = cols.length === 1 ? cols[0]! : `(${cols.join(', ')})`
  const s: string[] = []
  if (idx.pk) s.push('pk')
  if (idx.unique) s.push('unique')
  if (idx.name) s.push(`name: ${quoteString(idx.name)}`)
  if (idx.type) s.push(`type: ${idx.type}`)
  if (idx.note) s.push(`note: ${quoteString(idx.note)}`)
  if (s.length) t += ` [${s.join(', ')}]`
  return t
}

export function generateTable(t: TableDraft): string {
  let head = `Table ${tableRefName(t.schema, t.name)}`
  if (t.alias) head += ` as ${quoteIdent(t.alias)}`
  if (t.headerColor) head += ` [headercolor: ${t.headerColor}]`
  const lines = [`${head} {`]
  for (const c of t.columns) {
    const s = columnSettings(c)
    lines.push(`  ${quoteIdent(c.name)} ${c.type || 'varchar'}${s.length ? ` [${s.join(', ')}]` : ''}`)
  }
  if (t.indexes.length) {
    lines.push('', '  indexes {')
    for (const idx of t.indexes) lines.push(`    ${indexText(idx)}`)
    lines.push('  }')
  }
  if (t.note) lines.push('', `  Note: ${quoteString(t.note)}`)
  lines.push('}')
  return lines.join('\n')
}
