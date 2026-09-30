export type TokenKind = 'ident' | 'string' | 'qident' | 'expr' | 'number' | 'color' | 'punct' | 'eof'

export interface Token {
  kind: TokenKind
  /** Unescaped value (string content, identifier, punctuation text...). */
  value: string
  from: number
  to: number
  line: number
}

export class LexError extends Error {
  constructor(
    message: string,
    public from: number,
    public to: number,
  ) {
    super(message)
  }
}

const IDENT_START = /[\p{L}_]/u
const IDENT_PART = /[\p{L}\p{N}_$]/u
const PUNCT2 = ['<>']
const PUNCT1 = '{}[]():,.<>-;~'

/** Remove the common indentation of a triple-quoted string, like DBML does. */
function dedent(text: string): string {
  let lines = text.split(/\r?\n/)
  if (lines.length > 1 && lines[0]!.trim() === '') lines = lines.slice(1)
  if (lines.length > 1 && lines[lines.length - 1]!.trim() === '') lines = lines.slice(0, -1)
  const indents = lines.filter((l) => l.trim() !== '').map((l) => /^[ \t]*/.exec(l)![0].length)
  const min = indents.length ? Math.min(...indents) : 0
  return lines.map((l) => l.slice(min)).join('\n')
}

function unescape(text: string): string {
  return text.replace(/\\(.)/gs, (_, c: string) => {
    switch (c) {
      case 'n':
        return '\n'
      case 't':
        return '\t'
      case 'r':
        return '\r'
      default:
        return c
    }
  })
}

export function tokenize(src: string): { tokens: Token[]; errors: LexError[] } {
  const tokens: Token[] = []
  const errors: LexError[] = []
  let i = 0
  let line = 0
  const n = src.length

  const push = (kind: TokenKind, value: string, from: number, startLine: number) =>
    tokens.push({ kind, value, from, to: i, line: startLine })

  while (i < n) {
    const c = src[i]!
    if (c === '\n') {
      line++
      i++
      continue
    }
    if (c === ' ' || c === '\t' || c === '\r' || c === '﻿') {
      i++
      continue
    }
    const start = i
    const startLine = line
    // comments
    if (c === '/' && src[i + 1] === '/') {
      while (i < n && src[i] !== '\n') i++
      continue
    }
    if (c === '/' && src[i + 1] === '*') {
      const end = src.indexOf('*/', i + 2)
      const stop = end < 0 ? n : end + 2
      for (let k = i; k < stop; k++) if (src[k] === '\n') line++
      if (end < 0) errors.push(new LexError('註解未結束 (缺少 */)', start, n))
      i = stop
      continue
    }
    if (c === "'") {
      if (src.startsWith("'''", i)) {
        const end = src.indexOf("'''", i + 3)
        const stop = end < 0 ? n : end + 3
        for (let k = i; k < stop; k++) if (src[k] === '\n') line++
        if (end < 0) errors.push(new LexError("多行字串未結束 (缺少 ''')", start, n))
        const body = src.slice(i + 3, end < 0 ? n : end)
        i = stop
        push('string', dedent(body.replace(/\\'/g, "'")), start, startLine)
        continue
      }
      i++
      let closed = false
      while (i < n) {
        if (src[i] === '\\') {
          i += 2
          continue
        }
        if (src[i] === "'") {
          closed = true
          i++
          break
        }
        if (src[i] === '\n') break
        i++
      }
      if (!closed) errors.push(new LexError('字串未結束 (缺少 \')', start, i))
      push('string', unescape(src.slice(start + 1, closed ? i - 1 : i)), start, startLine)
      continue
    }
    if (c === '"') {
      i++
      let closed = false
      while (i < n && src[i] !== '\n') {
        if (src[i] === '\\') {
          i += 2
          continue
        }
        if (src[i] === '"') {
          closed = true
          i++
          break
        }
        i++
      }
      if (!closed) errors.push(new LexError('識別字未結束 (缺少 ")', start, i))
      push('qident', unescape(src.slice(start + 1, closed ? i - 1 : i)), start, startLine)
      continue
    }
    if (c === '`') {
      i++
      while (i < n && src[i] !== '`') {
        if (src[i] === '\n') line++
        i++
      }
      if (i >= n) errors.push(new LexError('運算式未結束 (缺少 `)', start, n))
      else i++
      push('expr', src.slice(start + 1, src[i - 1] === '`' && i - 1 > start ? i - 1 : i), start, startLine)
      continue
    }
    if (c === '#') {
      i++
      while (i < n && /[0-9a-fA-F]/.test(src[i]!)) i++
      push('color', src.slice(start, i), start, startLine)
      continue
    }
    if (/[0-9]/.test(c)) {
      while (i < n && /[0-9.]/.test(src[i]!)) i++
      // identifiers like 2fa_code
      if (i < n && IDENT_START.test(src[i]!)) {
        while (i < n && IDENT_PART.test(src[i]!)) i++
        push('ident', src.slice(start, i), start, startLine)
      } else {
        push('number', src.slice(start, i), start, startLine)
      }
      continue
    }
    if (IDENT_START.test(c)) {
      while (i < n && IDENT_PART.test(src[i]!)) i++
      push('ident', src.slice(start, i), start, startLine)
      continue
    }
    const two = src.slice(i, i + 2)
    if (PUNCT2.includes(two)) {
      i += 2
      push('punct', two, start, startLine)
      continue
    }
    if (PUNCT1.includes(c)) {
      i++
      push('punct', c, start, startLine)
      continue
    }
    i++
    errors.push(new LexError(`無法辨識的字元 '${c}'`, start, i))
  }
  tokens.push({ kind: 'eof', value: '', from: n, to: n, line })
  return { tokens, errors }
}
