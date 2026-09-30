import { tokenize, type Token } from './lexer'
import type {
  Column,
  DbmlError,
  EnumDef,
  IndexDef,
  ProjectInfo,
  Range,
  Ref,
  RefEndpoint,
  RelationOp,
  Schema,
  SettingItem,
  SettingList,
  StickyNote,
  Table,
  TableGroup,
} from './types'

class ParseError extends Error {
  constructor(
    message: string,
    public from: number,
    public to: number,
  ) {
    super(message)
  }
}

const TOP_LEVEL = new Set(['table', 'ref', 'enum', 'tablegroup', 'project', 'note'])
const OPS = new Set(['>', '<', '-', '<>'])

interface RawEndpoint {
  rawTable: string
  columns: string[]
  tableRange: Range
  columnRanges: Range[]
}

interface RawRef {
  name?: string
  op: RelationOp
  opRange: Range
  from: RawEndpoint
  to: RawEndpoint
  settings?: SettingList
  inline: boolean
  range: Range
  /** Inline refs: owner table, resolved after parsing. */
  ownerTable?: Table
}

interface RawGroup extends Omit<TableGroup, 'tables'> {
  tables: string[]
}

export function tableIdOf(schema: string | undefined, name: string): string {
  return schema && schema !== 'public' ? `${schema}.${name}` : name
}

class Parser {
  pos = 0
  tokens: Token[]
  errors: DbmlError[] = []
  depth: number[] = []
  tables: Table[] = []
  enums: EnumDef[] = []
  groups: RawGroup[] = []
  notes: StickyNote[] = []
  rawRefs: RawRef[] = []
  project?: ProjectInfo

  constructor(private src: string) {
    const { tokens, errors } = tokenize(src)
    this.tokens = tokens
    for (const e of errors) this.errors.push({ message: e.message, from: e.from, to: e.to, severity: 'error' })
    let d = 0
    for (const t of tokens) {
      if (t.kind === 'punct' && t.value === '}') d = Math.max(0, d - 1)
      this.depth.push(d)
      if (t.kind === 'punct' && t.value === '{') d++
    }
  }

  // ---------- token helpers ----------
  get tok(): Token {
    return this.tokens[this.pos]!
  }
  peek(k = 1): Token {
    return this.tokens[Math.min(this.pos + k, this.tokens.length - 1)]!
  }
  prev(): Token {
    return this.tokens[Math.max(0, this.pos - 1)]!
  }
  next(): Token {
    const t = this.tok
    if (t.kind !== 'eof') this.pos++
    return t
  }
  atEof(): boolean {
    return this.tok.kind === 'eof'
  }
  isPunct(v: string, t = this.tok) {
    return t.kind === 'punct' && t.value === v
  }
  isKeyword(v: string, t = this.tok) {
    return t.kind === 'ident' && t.value.toLowerCase() === v
  }
  fail(message: string, t = this.tok): never {
    const to = t.kind === 'eof' ? t.from : t.to
    throw new ParseError(message + (t.kind === 'eof' ? '，但已到檔案結尾' : `，但遇到 '${this.src.slice(t.from, t.to)}'`), t.from, to)
  }
  expectPunct(v: string): Token {
    if (!this.isPunct(v)) this.fail(`預期 '${v}'`)
    return this.next()
  }
  isFirstOnLine(i = this.pos) {
    return i === 0 || this.tokens[i - 1]!.line < this.tokens[i]!.line
  }
  error(e: unknown) {
    if (e instanceof ParseError) this.errors.push({ message: e.message, from: e.from, to: e.to, severity: 'error' })
    else throw e
  }

  /** Name: ident | "quoted" | ident.ident */
  name(what: string): { parts: string[]; range: Range } {
    const parts: string[] = []
    const start = this.tok.from
    for (;;) {
      if (this.tok.kind !== 'ident' && this.tok.kind !== 'qident') this.fail(`預期${what}名稱`)
      parts.push(this.next().value)
      if (this.isPunct('.') && (this.peek().kind === 'ident' || this.peek().kind === 'qident')) {
        this.next()
        continue
      }
      break
    }
    return { parts, range: { from: start, to: this.prev().to } }
  }

  /** Parse a `{` ... `}` block, calling `line` for each element. */
  block(line: () => void) {
    this.expectPunct('{')
    while (!this.isPunct('}')) {
      if (this.atEof()) this.fail("預期 '}'")
      const startLine = this.tok.line
      const startPos = this.pos
      try {
        line()
      } catch (e) {
        this.error(e)
        // skip the rest of the broken line
        if (this.pos === startPos) this.next()
        while (!this.atEof() && this.tok.line === startLine && !this.isPunct('}')) {
          if (this.isPunct('{')) this.skipBalanced()
          else this.next()
        }
      }
    }
    this.next()
  }

  skipBalanced() {
    let d = 0
    do {
      if (this.isPunct('{')) d++
      else if (this.isPunct('}')) d--
      this.next()
    } while (d > 0 && !this.atEof())
  }

  /** `[ item, item: value ]` */
  settings(): SettingList {
    const open = this.expectPunct('[')
    const items: SettingItem[] = []
    while (!this.isPunct(']')) {
      if (this.atEof()) this.fail("預期 ']'")
      // an item continuing on a new line without a trailing comma means `]` was forgotten
      if (items.length && this.tok.line !== this.prev().line && !this.isPunct(',', this.prev()))
        this.fail("預期 ']'", this.prev())
      const start = this.tok.from
      const keyParts: string[] = []
      while (this.tok.kind === 'ident' || this.tok.kind === 'qident') keyParts.push(this.next().value.toLowerCase())
      if (!keyParts.length) this.fail('預期設定名稱')
      const item: SettingItem = { key: keyParts.join(' '), range: { from: start, to: this.prev().to } }
      if (this.isPunct(':')) {
        this.next()
        const vStart = this.tok.from
        let d = 0
        while (!this.atEof()) {
          if (d === 0 && (this.isPunct(',') || this.isPunct(']'))) break
          if (this.isPunct('(') || this.isPunct('[')) d++
          if (this.isPunct(')') || this.isPunct(']')) d--
          this.next()
        }
        if (this.tok.from === vStart) this.fail(`設定 '${item.key}' 缺少值`)
        const vEnd = this.prev().to
        item.value = this.src.slice(vStart, vEnd)
        item.valueRange = { from: vStart, to: vEnd }
        item.range.to = vEnd
      }
      items.push(item)
      if (this.isPunct(',')) this.next()
      else if (!this.isPunct(']')) this.fail("預期 ',' 或 ']'")
    }
    const close = this.next()
    return { items, range: { from: open.from, to: close.to } }
  }

  /** Parse a setting value that is a string (or bare word). */
  stringValue(item: SettingItem): string | undefined {
    if (item.value === undefined) return undefined
    const { tokens } = tokenize(item.value)
    if (tokens.length === 2 && (tokens[0]!.kind === 'string' || tokens[0]!.kind === 'qident')) return tokens[0]!.value
    return item.value
  }

  noteValue(): string {
    // after `Note`: either `: 'text'` or `{ 'text' }`
    if (this.isPunct(':')) {
      this.next()
      if (this.tok.kind !== 'string') this.fail('預期註解字串')
      return this.next().value
    }
    this.expectPunct('{')
    if (this.tok.kind !== 'string') this.fail('預期註解字串')
    const v = this.next().value
    if (this.isPunct('[')) this.settings()
    this.expectPunct('}')
    return v
  }

  isNoteStart() {
    return this.isKeyword('note') && (this.isPunct(':', this.peek()) || this.isPunct('{', this.peek()))
  }

  // ---------- top level ----------
  parse() {
    while (!this.atEof()) {
      const start = this.pos
      try {
        this.topLevel()
      } catch (e) {
        this.error(e)
        if (this.pos === start) this.next()
        // resync to the next top-level keyword at brace depth 0
        while (!this.atEof()) {
          if (
            this.depth[this.pos] === 0 &&
            this.isFirstOnLine() &&
            this.tok.kind === 'ident' &&
            TOP_LEVEL.has(this.tok.value.toLowerCase())
          )
            break
          this.next()
        }
      }
    }
  }

  topLevel() {
    const t = this.tok
    if (t.kind !== 'ident') this.fail('預期 Table、Ref、Enum、TableGroup、Project 或 Note')
    switch (t.value.toLowerCase()) {
      case 'table':
        return this.table()
      case 'ref':
        return this.ref()
      case 'enum':
        return this.enumDef()
      case 'tablegroup':
        return this.tableGroup()
      case 'project':
        return this.projectDef()
      case 'note':
        return this.stickyNote()
      default:
        this.fail('預期 Table、Ref、Enum、TableGroup、Project 或 Note')
    }
  }

  table() {
    const kw = this.next()
    const { parts, range: nameRange } = this.name('資料表')
    if (parts.length > 2) throw new ParseError('資料表名稱格式錯誤', nameRange.from, nameRange.to)
    const schema = parts.length === 2 ? parts[0] : undefined
    const name = parts[parts.length - 1]!
    const table: Table = {
      id: tableIdOf(schema, name),
      schema,
      name,
      columns: [],
      indexes: [],
      range: { from: kw.from, to: kw.to },
      nameRange,
      headerEnd: nameRange.to,
    }
    if (this.isKeyword('as')) {
      this.next()
      if (this.tok.kind !== 'ident' && this.tok.kind !== 'qident') this.fail('預期別名')
      table.alias = this.next().value
      table.headerEnd = this.prev().to
    }
    if (this.isPunct('[')) {
      table.settings = this.settings()
      for (const s of table.settings.items) {
        if (s.key === 'headercolor') table.headerColor = s.value
        else if (s.key === 'note') table.note = this.stringValue(s)
      }
    }
    // register early so a broken body still shows the table
    this.tables.push(table)
    try {
      this.block(() => this.tableElement(table))
    } finally {
      table.range.to = this.prev().to
    }
  }

  tableElement(table: Table) {
    if (this.isNoteStart()) {
      this.next()
      table.note = this.noteValue()
      return
    }
    if (this.isKeyword('indexes') && this.isPunct('{', this.peek())) {
      this.next()
      this.block(() => table.indexes.push(this.indexDef()))
      return
    }
    this.column(table)
  }

  column(table: Table) {
    const nameTok = this.tok
    if (nameTok.kind !== 'ident' && nameTok.kind !== 'qident') this.fail('預期欄位名稱')
    this.next()
    const line = nameTok.line
    const typeStart = this.tok
    let typeEnd: Token | undefined
    while (!this.atEof() && this.tok.line === line && !this.isPunct('}')) {
      if (this.isPunct('[')) {
        if (this.isPunct(']', this.peek())) {
          this.next()
          typeEnd = this.next()
          continue
        }
        break
      }
      if (this.isPunct('(')) {
        while (!this.isPunct(')') && !this.atEof() && this.tok.line === line) this.next()
        if (!this.isPunct(')')) this.fail("預期 ')'")
      }
      typeEnd = this.next()
    }
    if (!typeEnd) this.fail(`欄位 '${nameTok.value}' 缺少資料型別`)
    let type = this.src.slice(typeStart.from, typeEnd.to)
    if (typeStart === typeEnd && typeStart.kind === 'qident') type = typeStart.value
    const col: Column = {
      name: nameTok.value,
      type,
      pk: false,
      notNull: false,
      unique: false,
      increment: false,
      inlineRefs: [],
      nameRange: { from: nameTok.from, to: nameTok.to },
      range: { from: nameTok.from, to: typeEnd.to },
    }
    if (this.isPunct('[') && this.tok.line === line) {
      col.settings = this.settings()
      col.range.to = col.settings.range.to
      for (const s of col.settings.items) {
        switch (s.key) {
          case 'pk':
          case 'primary key':
            col.pk = true
            break
          case 'not null':
            col.notNull = true
            break
          case 'null':
            col.notNull = false
            break
          case 'unique':
            col.unique = true
            break
          case 'increment':
            col.increment = true
            break
          case 'default':
            col.default = s.value
            break
          case 'note':
            col.note = this.stringValue(s)
            break
          case 'ref':
            try {
              const r = this.inlineRef(s, table, col)
              col.inlineRefs.push({ op: r.op, table: r.to.rawTable, columns: r.to.columns })
            } catch (e) {
              this.error(e)
            }
            break
          default:
            this.errors.push({ message: `未知的欄位設定 '${s.key}'`, ...s.range, severity: 'warning' })
        }
      }
    }
    if (table.columns.some((c) => c.name === col.name))
      this.errors.push({ message: `欄位 '${col.name}' 重複定義`, ...col.nameRange, severity: 'error' })
    table.columns.push(col)
  }

  inlineRef(s: SettingItem, table: Table, col: Column): RawRef {
    if (!s.valueRange) throw new ParseError('ref 設定缺少值', s.range.from, s.range.to)
    // rewind onto the value tokens, parse them, then restore the position
    const saved = this.pos
    let i = this.pos
    while (i > 0 && this.tokens[i - 1]!.from >= s.valueRange.from) i--
    this.pos = i
    let opTok: Token, to: RawEndpoint
    try {
      opTok = this.tok
      if (opTok.kind !== 'punct' || !OPS.has(opTok.value)) this.fail("預期關聯符號 '>'、'<'、'-' 或 '<>'")
      this.next()
      to = this.endpoint()
      if (this.tok.from < s.valueRange.to) this.fail('ref 設定格式錯誤')
    } finally {
      this.pos = saved
    }
    const raw: RawRef = {
      op: opTok.value as RelationOp,
      opRange: { from: opTok.from, to: opTok.to },
      from: { rawTable: table.id, columns: [col.name], tableRange: table.nameRange, columnRanges: [col.nameRange] },
      to,
      inline: true,
      range: s.range,
      ownerTable: table,
    }
    this.rawRefs.push(raw)
    return raw
  }

  indexDef(): IndexDef {
    const line = this.tok.line
    const idx: IndexDef = { columns: [], pk: false, unique: false }
    const one = () => {
      if (this.tok.kind === 'expr') idx.columns.push('`' + this.next().value + '`')
      else if (this.tok.kind === 'ident' || this.tok.kind === 'qident') idx.columns.push(this.next().value)
      else this.fail('預期索引欄位')
    }
    if (this.isPunct('(')) {
      this.next()
      for (;;) {
        one()
        if (this.isPunct(',')) {
          this.next()
          continue
        }
        break
      }
      this.expectPunct(')')
    } else one()
    if (this.isPunct('[') && this.tok.line === line) {
      for (const s of this.settings().items) {
        if (s.key === 'pk') idx.pk = true
        else if (s.key === 'unique') idx.unique = true
        else if (s.key === 'name') idx.name = this.stringValue(s)
        else if (s.key === 'type') idx.type = this.stringValue(s)
        else if (s.key === 'note') idx.note = this.stringValue(s)
      }
    }
    return idx
  }

  endpoint(): RawEndpoint {
    const parts: { value: string; range: Range }[] = []
    let columns: { value: string; range: Range }[] | undefined
    for (;;) {
      if (this.isPunct('(')) {
        this.next()
        columns = []
        for (;;) {
          if (this.tok.kind !== 'ident' && this.tok.kind !== 'qident') this.fail('預期欄位名稱')
          const t = this.next()
          columns.push({ value: t.value, range: { from: t.from, to: t.to } })
          if (this.isPunct(',')) {
            this.next()
            continue
          }
          break
        }
        this.expectPunct(')')
        break
      }
      if (this.tok.kind !== 'ident' && this.tok.kind !== 'qident') this.fail('預期資料表或欄位名稱')
      const t = this.next()
      parts.push({ value: t.value, range: { from: t.from, to: t.to } })
      if (this.isPunct('.')) {
        this.next()
        continue
      }
      break
    }
    if (!columns) {
      const last = parts.pop()
      if (!last || !parts.length) this.fail("關聯端點須為 '資料表.欄位' 格式", this.prev())
      columns = [last]
    }
    if (!parts.length) this.fail('關聯端點缺少資料表名稱', this.prev())
    return {
      rawTable: parts.map((p) => p.value).join('.'),
      columns: columns.map((c) => c.value),
      tableRange: { from: parts[0]!.range.from, to: parts[parts.length - 1]!.range.to },
      columnRanges: columns.map((c) => c.range),
    }
  }

  refBody(start: number, name: string | undefined): RawRef {
    const from = this.endpoint()
    const opTok = this.tok
    if (opTok.kind !== 'punct' || !OPS.has(opTok.value)) this.fail("預期關聯符號 '>'、'<'、'-' 或 '<>'")
    this.next()
    const to = this.endpoint()
    const raw: RawRef = {
      name,
      op: opTok.value as RelationOp,
      opRange: { from: opTok.from, to: opTok.to },
      from,
      to,
      inline: false,
      range: { from: start, to: this.prev().to },
    }
    if (this.isPunct('[') && this.tok.line === this.prev().line) {
      raw.settings = this.settings()
      raw.range.to = raw.settings.range.to
    }
    return raw
  }

  ref() {
    const kw = this.next()
    let name: string | undefined
    if ((this.tok.kind === 'ident' || this.tok.kind === 'qident') && (this.isPunct(':', this.peek()) || this.isPunct('{', this.peek())))
      name = this.next().value
    if (this.isPunct(':')) {
      this.next()
      this.rawRefs.push(this.refBody(kw.from, name))
      return
    }
    const refs: RawRef[] = []
    this.block(() => refs.push(this.refBody(this.tok.from, name)))
    // a long-form block is one statement; the whole block is its range
    for (const r of refs) {
      if (refs.length === 1) r.range = { from: kw.from, to: this.prev().to }
      this.rawRefs.push(r)
    }
  }

  enumDef() {
    const kw = this.next()
    const { parts } = this.name('列舉')
    const schema = parts.length === 2 ? parts[0] : undefined
    const name = parts[parts.length - 1]!
    const e: EnumDef = { id: tableIdOf(schema, name), schema, name, values: [], range: { from: kw.from, to: kw.to } }
    this.block(() => {
      const line = this.tok.line
      if (this.tok.kind !== 'ident' && this.tok.kind !== 'qident' && this.tok.kind !== 'string') this.fail('預期列舉值')
      const v = { name: this.next().value } as { name: string; note?: string }
      if (this.isPunct('[') && this.tok.line === line) {
        for (const s of this.settings().items) if (s.key === 'note') v.note = this.stringValue(s)
      }
      e.values.push(v)
    })
    e.range.to = this.prev().to
    this.enums.push(e)
  }

  tableGroup() {
    const kw = this.next()
    const { parts } = this.name('群組')
    const g: RawGroup = { name: parts.join('.'), tables: [], members: [], range: { from: kw.from, to: kw.to } }
    if (this.isPunct('[')) {
      for (const s of this.settings().items) {
        if (s.key === 'color') g.color = s.value
        else if (s.key === 'note') g.note = this.stringValue(s)
      }
    }
    this.block(() => {
      if (this.isNoteStart()) {
        this.next()
        g.note = this.noteValue()
        return
      }
      const { parts: p, range } = this.name('資料表')
      g.members.push({ raw: p.join('.'), range })
    })
    g.range.to = this.prev().to
    this.groups.push(g)
  }

  projectDef() {
    this.next()
    const p: ProjectInfo = {}
    if (this.tok.kind === 'ident' || this.tok.kind === 'qident') p.name = this.next().value
    this.block(() => {
      if (this.isNoteStart()) {
        this.next()
        p.note = this.noteValue()
        return
      }
      if (this.tok.kind !== 'ident') this.fail('預期專案設定')
      const key = this.next().value.toLowerCase()
      this.expectPunct(':')
      const v = this.next()
      if (key === 'database_type') p.databaseType = v.value
    })
    this.project = p
  }

  stickyNote() {
    const kw = this.next()
    let name = ''
    if (this.tok.kind === 'ident' || this.tok.kind === 'qident') name = this.next().value
    const content = this.noteValue()
    this.notes.push({ name, content, range: { from: kw.from, to: this.prev().to } })
  }

  // ---------- semantic pass ----------
  resolve(): Schema {
    const byId = new Map<string, Table>()
    const byAlias = new Map<string, Table>()
    for (const t of this.tables) {
      if (byId.has(t.id)) this.errors.push({ message: `資料表 '${t.id}' 重複定義`, ...t.nameRange, severity: 'error' })
      else byId.set(t.id, t)
      if (t.alias) byAlias.set(t.alias, t)
    }
    const lookup = (raw: string): Table | undefined =>
      byId.get(raw) ?? byAlias.get(raw) ?? (raw.startsWith('public.') ? byId.get(raw.slice(7)) : undefined)

    const refs: Ref[] = []
    const resolveEnd = (e: RawEndpoint, owner?: Table): RefEndpoint | undefined => {
      const t = owner ?? lookup(e.rawTable)
      if (!t) {
        this.errors.push({ message: `找不到資料表 '${e.rawTable}'`, ...e.tableRange, severity: 'error' })
        return undefined
      }
      for (let i = 0; i < e.columns.length; i++) {
        if (!t.columns.some((c) => c.name === e.columns[i])) {
          this.errors.push({ message: `資料表 '${t.id}' 沒有欄位 '${e.columns[i]}'`, ...e.columnRanges[i]!, severity: 'error' })
          return undefined
        }
      }
      return { ...e, table: t.id }
    }
    this.rawRefs.forEach((r, i) => {
      const from = resolveEnd(r.from, r.ownerTable)
      const to = resolveEnd(r.to)
      if (!from || !to) return
      if (from.columns.length !== to.columns.length) {
        this.errors.push({ message: '複合關聯兩端的欄位數量不一致', ...r.range, severity: 'error' })
        return
      }
      const ref: Ref = { id: `ref${i}`, name: r.name, op: r.op, from, to, inline: r.inline, range: r.range, opRange: r.opRange }
      if (r.inline) {
        const col = r.ownerTable!.columns.find((c) => c.name === r.from.columns[0])
        ref.settings = col?.settings
      }
      for (const s of (!r.inline && r.settings?.items) || []) {
        if (s.key === 'delete') ref.onDelete = s.value
        else if (s.key === 'update') ref.onUpdate = s.value
        else if (s.key === 'color') ref.color = s.value
      }
      refs.push(ref)
    })

    const groups: TableGroup[] = this.groups.map((g) => {
      const tables: string[] = []
      for (const m of g.members) {
        const t = lookup(m.raw)
        if (t) tables.push(t.id)
        else this.errors.push({ message: `找不到資料表 '${m.raw}'`, ...m.range, severity: 'error' })
      }
      return { ...g, tables }
    })

    return {
      project: this.project,
      tables: this.tables,
      refs,
      enums: this.enums,
      groups,
      notes: this.notes,
      errors: this.errors.sort((a, b) => a.from - b.from),
    }
  }
}

export function parseDbml(src: string): Schema {
  const p = new Parser(src)
  p.parse()
  return p.resolve()
}
