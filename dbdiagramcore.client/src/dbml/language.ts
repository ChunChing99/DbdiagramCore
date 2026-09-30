import { HighlightStyle, StreamLanguage, syntaxHighlighting, type StreamParser } from '@codemirror/language'
import type { CompletionContext, CompletionResult, Completion } from '@codemirror/autocomplete'
import { tags as t } from '@lezer/highlight'
import type { Schema } from './types'

type Block = 'table' | 'indexes' | 'enum' | 'group' | 'project' | 'ref' | 'note' | 'other'

interface State {
  blockComment: boolean
  tripleString: boolean
  stack: Block[]
  settings: number
  /** Block kind announced by the keyword on the current statement, pushed at `{`. */
  pending: Block | null
  word: number
  afterKeyword: boolean
}

const KEYWORDS: Record<string, Block> = {
  table: 'table',
  ref: 'ref',
  enum: 'enum',
  tablegroup: 'group',
  project: 'project',
  note: 'note',
  indexes: 'indexes',
}

const SETTINGS = new Set([
  'pk', 'primary', 'key', 'not', 'null', 'unique', 'increment', 'default', 'note', 'ref', 'headercolor',
  'delete', 'update', 'name', 'type', 'color', 'cascade', 'restrict', 'set', 'no', 'action', 'true', 'false',
])

const dbmlParser: StreamParser<State> = {
  name: 'dbml',
  startState: () => ({ blockComment: false, tripleString: false, stack: [], settings: 0, pending: null, word: 0, afterKeyword: false }),
  copyState: (s) => ({ ...s, stack: [...s.stack] }),
  token(stream, s) {
    if (stream.sol()) {
      s.word = 0
      s.afterKeyword = false
    }
    if (s.blockComment) {
      if (stream.skipTo('*/')) {
        stream.pos += 2
        s.blockComment = false
      } else stream.skipToEnd()
      return 'comment'
    }
    if (s.tripleString) {
      if (stream.skipTo("'''")) {
        stream.pos += 3
        s.tripleString = false
      } else stream.skipToEnd()
      return 'string'
    }
    if (stream.eatSpace()) return null
    if (stream.match('//')) {
      stream.skipToEnd()
      return 'comment'
    }
    if (stream.match('/*')) {
      s.blockComment = true
      return 'comment'
    }
    if (stream.match("'''")) {
      s.tripleString = true
      return 'string'
    }
    if (stream.match(/^'(?:[^'\\]|\\.)*'?/)) return 'string'
    if (stream.match(/^`[^`]*`?/)) return 'expr'
    if (stream.match(/^#[0-9a-fA-F]+/)) return 'color'
    if (stream.match(/^\d+(\.\d+)?\b/)) return 'number'

    const top = s.stack[s.stack.length - 1] ?? null
    const quoted = stream.match(/^"(?:[^"\\]|\\.)*"?/)
    if (quoted || stream.match(/^[\p{L}_][\p{L}\p{N}_$]*/u)) {
      const word = stream.current()
      const lower = word.toLowerCase()
      const idx = s.word++
      if (s.settings > 0) return SETTINGS.has(lower) ? 'setting' : 'name'
      if (!quoted && idx === 0 && lower in KEYWORDS && (top === null || top === 'table' || top === 'group' || top === 'project')) {
        if (top === null || lower === 'note' || lower === 'indexes') {
          s.pending = KEYWORDS[lower]!
          s.afterKeyword = true
          return 'keyword'
        }
      }
      if (!quoted && lower === 'as' && top === null) return 'keyword'
      if (s.afterKeyword) {
        return 'definition'
      }
      if (top === 'table') return idx === 0 ? 'column' : 'type'
      return 'name'
    }
    const ch = stream.next()!
    if (ch === '{') {
      s.stack.push(s.pending ?? 'other')
      s.pending = null
      s.afterKeyword = false
      return 'brace'
    }
    if (ch === '}') {
      s.stack.pop()
      return 'brace'
    }
    if (ch === '[') {
      if (stream.peek() === ']') {
        stream.next()
        return 'type'
      }
      s.settings++
      return 'bracket'
    }
    if (ch === ']') {
      s.settings = Math.max(0, s.settings - 1)
      return 'bracket'
    }
    if (ch === ':') {
      s.afterKeyword = false
      return 'punctuation'
    }
    if ('<>-'.includes(ch)) {
      stream.eat('>')
      return 'operator'
    }
    return 'punctuation'
  },
  blankLine(s) {
    s.word = 0
  },
  languageData: {
    commentTokens: { line: '//', block: { open: '/*', close: '*/' } },
    closeBrackets: { brackets: ['(', '[', '{', "'", '"', '`'] },
  },
  tokenTable: {
    keyword: t.keyword,
    definition: t.definition(t.className),
    column: t.propertyName,
    type: t.typeName,
    setting: t.attributeName,
    name: t.variableName,
    expr: t.special(t.string),
    color: t.color,
    brace: t.brace,
    bracket: t.squareBracket,
    punctuation: t.punctuation,
    operator: t.operator,
  },
}

export const dbmlLanguage = StreamLanguage.define(dbmlParser)

export const dbmlHighlight = syntaxHighlighting(
  HighlightStyle.define([
    { tag: t.keyword, color: '#c678dd', fontWeight: '600' },
    { tag: t.definition(t.className), color: '#e5c07b', fontWeight: '600' },
    { tag: t.propertyName, color: '#e6e6e6' },
    { tag: t.typeName, color: '#56b6c2' },
    { tag: t.attributeName, color: '#d19a66' },
    { tag: t.variableName, color: '#61afef' },
    { tag: t.string, color: '#98c379' },
    { tag: t.special(t.string), color: '#e06c75' },
    { tag: t.number, color: '#d19a66' },
    { tag: t.color, color: '#e5c07b' },
    { tag: t.comment, color: '#7f848e', fontStyle: 'italic' },
    { tag: t.operator, color: '#ff9d5c', fontWeight: '700' },
    { tag: [t.brace, t.squareBracket, t.punctuation], color: '#abb2bf' },
  ]),
)

const TYPES = [
  'integer', 'int', 'bigint', 'smallint', 'serial', 'bigserial', 'decimal(10, 2)', 'numeric', 'float', 'double', 'real',
  'boolean', 'bool', 'varchar(255)', 'varchar', 'char', 'text', 'uuid', 'json', 'jsonb', 'date', 'time',
  'timestamp', 'timestamptz', 'datetime', 'blob', 'bytea',
]

const SETTING_COMPLETIONS: Completion[] = [
  { label: 'pk', type: 'keyword', detail: '主鍵' },
  { label: 'primary key', type: 'keyword', detail: '主鍵' },
  { label: 'not null', type: 'keyword', detail: '不可為空' },
  { label: 'null', type: 'keyword' },
  { label: 'unique', type: 'keyword', detail: '唯一' },
  { label: 'increment', type: 'keyword', detail: '自動遞增' },
  { label: 'default: ', type: 'keyword', detail: '預設值' },
  { label: 'note: ', type: 'keyword', detail: '註解' },
  { label: 'ref: > ', type: 'keyword', detail: '關聯' },
  { label: 'headercolor: ', type: 'keyword', detail: '標題顏色' },
  { label: 'delete: cascade', type: 'keyword' },
  { label: 'update: cascade', type: 'keyword' },
]

const TOP_COMPLETIONS: Completion[] = [
  { label: 'Table', type: 'keyword', apply: 'Table name {\n  id integer [pk, increment]\n}', detail: '資料表' },
  { label: 'Ref', type: 'keyword', apply: 'Ref: ', detail: '關聯' },
  { label: 'Enum', type: 'keyword', apply: 'Enum name {\n  value\n}', detail: '列舉' },
  { label: 'TableGroup', type: 'keyword', apply: 'TableGroup name {\n  \n}', detail: '資料表群組' },
  { label: 'Project', type: 'keyword', apply: "Project name {\n  database_type: 'PostgreSQL'\n}", detail: '專案' },
  { label: 'Note', type: 'keyword', detail: '註解' },
  { label: 'indexes', type: 'keyword', apply: 'indexes {\n    \n  }', detail: '索引' },
]

/** Autocomplete driven by the latest parsed schema. */
export function dbmlCompletion(getSchema: () => Schema) {
  return (ctx: CompletionContext): CompletionResult | null => {
    const schema = getSchema()
    const line = ctx.state.doc.lineAt(ctx.pos)
    const before = line.text.slice(0, ctx.pos - line.from)

    // table.column
    const dotted = /([\p{L}\p{N}_"]+)\.([\p{L}\p{N}_]*)$/u.exec(before)
    if (dotted) {
      const tname = dotted[1]!.replace(/"/g, '')
      const table = schema.tables.find((x) => x.id === tname || x.name === tname || x.alias === tname)
      if (table)
        return {
          from: ctx.pos - dotted[2]!.length,
          options: table.columns.map((c) => ({ label: c.name, type: 'property', detail: c.type })),
        }
    }
    const word = ctx.matchBefore(/[\p{L}\p{N}_]*/u)
    if (!word || (word.from === word.to && !ctx.explicit)) return null

    const tableNames: Completion[] = schema.tables.map((x) => ({ label: x.id, type: 'class', detail: '資料表' }))
    const openBracket = before.lastIndexOf('[') > before.lastIndexOf(']')
    if (openBracket) {
      if (/ref\s*:\s*[<>-]+\s*[\p{L}\p{N}_]*$/u.test(before)) return { from: word.from, options: tableNames }
      return { from: word.from, options: SETTING_COMPLETIONS, validFor: /^[\w ]*$/ }
    }
    if (/^\s*Ref\b.*[:{]\s*[\p{L}\p{N}_.]*$/iu.test(before) || /[<>-]\s*[\p{L}\p{N}_]*$/u.test(before))
      return { from: word.from, options: tableNames }
    // second word of a column line -> data type
    if (/^\s+[\p{L}\p{N}_"]+\s+[\p{L}\p{N}_]*$/u.test(before))
      return {
        from: word.from,
        options: [
          ...TYPES.map((x) => ({ label: x, type: 'type' })),
          ...schema.enums.map((e) => ({ label: e.id, type: 'enum', detail: '列舉' })),
        ],
      }
    if (/^\s*[\p{L}_]*$/u.test(before)) return { from: word.from, options: TOP_COMPLETIONS }
    return null
  }
}
