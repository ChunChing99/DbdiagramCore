/** Offsets into the DBML source text (from inclusive, to exclusive). */
export interface Range {
  from: number
  to: number
}

export interface DbmlError {
  message: string
  from: number
  to: number
  severity: 'error' | 'warning'
}

/** One item in a `[a, b: c]` settings list. */
export interface SettingItem {
  key: string
  value?: string
  range: Range
  valueRange?: Range
}

export interface SettingList {
  items: SettingItem[]
  /** Range from `[` to `]` inclusive. */
  range: Range
}

export type RelationOp = '>' | '<' | '-' | '<>'

export interface InlineRef {
  op: RelationOp
  /** Target table as written, e.g. `users`, `public.users`, `U`. */
  table: string
  columns: string[]
}

export interface Column {
  name: string
  type: string
  pk: boolean
  notNull: boolean
  unique: boolean
  increment: boolean
  default?: string
  note?: string
  inlineRefs: InlineRef[]
  nameRange: Range
  /** Whole column definition line. */
  range: Range
  settings?: SettingList
}

export interface IndexDef {
  /** Column names or backtick expressions (kept with backticks). */
  columns: string[]
  pk: boolean
  unique: boolean
  name?: string
  type?: string
  note?: string
}

export interface Table {
  /** Unique id: `schema.name` when a schema is given, otherwise `name`. */
  id: string
  schema?: string
  name: string
  alias?: string
  headerColor?: string
  note?: string
  columns: Column[]
  indexes: IndexDef[]
  range: Range
  nameRange: Range
  /** Position right after the table name/alias, used to insert settings. */
  headerEnd: number
  settings?: SettingList
}

export interface RefEndpoint {
  /** Resolved table id. */
  table: string
  columns: string[]
  /** Table part as written (may be an alias or schema-qualified). */
  rawTable: string
  tableRange: Range
  columnRanges: Range[]
}

export interface Ref {
  id: string
  name?: string
  op: RelationOp
  from: RefEndpoint
  to: RefEndpoint
  onDelete?: string
  onUpdate?: string
  color?: string
  inline: boolean
  /** Standalone: whole `Ref ...` statement. Inline: the `ref: > t.c` setting item. */
  range: Range
  opRange: Range
  /** For inline refs: the settings list that contains it. */
  settings?: SettingList
}

export interface EnumValue {
  name: string
  note?: string
}

export interface EnumDef {
  id: string
  schema?: string
  name: string
  values: EnumValue[]
  range: Range
}

export interface TableGroup {
  name: string
  color?: string
  note?: string
  tables: string[]
  members: { raw: string; range: Range }[]
  range: Range
}

export interface StickyNote {
  name: string
  content: string
  range: Range
}

export interface ProjectInfo {
  name?: string
  databaseType?: string
  note?: string
}

export interface Schema {
  project?: ProjectInfo
  tables: Table[]
  refs: Ref[]
  enums: EnumDef[]
  groups: TableGroup[]
  notes: StickyNote[]
  errors: DbmlError[]
}

export function cardinality(op: RelationOp): { from: '1' | '*'; to: '1' | '*' } {
  switch (op) {
    case '>':
      return { from: '*', to: '1' }
    case '<':
      return { from: '1', to: '*' }
    case '-':
      return { from: '1', to: '1' }
    case '<>':
      return { from: '*', to: '*' }
  }
}
