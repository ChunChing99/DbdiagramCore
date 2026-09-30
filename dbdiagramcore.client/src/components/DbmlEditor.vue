<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { EditorState } from '@codemirror/state'
import { EditorView, keymap, lineNumbers, highlightActiveLine, highlightActiveLineGutter, drawSelection, highlightSpecialChars, dropCursor } from '@codemirror/view'
import { defaultKeymap, history, historyKeymap, indentWithTab } from '@codemirror/commands'
import { bracketMatching, foldGutter, foldKeymap, indentOnInput, indentUnit } from '@codemirror/language'
import { autocompletion, closeBrackets, closeBracketsKeymap, completionKeymap } from '@codemirror/autocomplete'
import { lintGutter, setDiagnostics, lintKeymap, type Diagnostic } from '@codemirror/lint'
import { highlightSelectionMatches, searchKeymap } from '@codemirror/search'
import { dbmlCompletion, dbmlHighlight, dbmlLanguage } from '@/dbml/language'
import { cursorOffset, parsed, revealRequest, source } from '@/store'

const host = ref<HTMLDivElement>()
let view: EditorView | undefined

const theme = EditorView.theme(
  {
    '&': { height: '100%', fontSize: '13.5px', backgroundColor: '#1e2127', color: '#abb2bf' },
    '.cm-scroller': { fontFamily: '"Cascadia Code", Consolas, "Microsoft JhengHei", monospace', lineHeight: '1.6' },
    '.cm-content': { caretColor: '#fff' },
    '.cm-cursor': { borderLeftColor: '#fff' },
    '.cm-gutters': { backgroundColor: '#1e2127', color: '#5c6370', border: 'none' },
    '.cm-activeLine': { backgroundColor: '#2c313a80' },
    '.cm-activeLineGutter': { backgroundColor: '#2c313a', color: '#abb2bf' },
    '&.cm-focused .cm-selectionBackground, .cm-selectionBackground, ::selection': { backgroundColor: '#3e4451 !important' },
    '.cm-selectionMatch': { backgroundColor: '#3e445180' },
    '.cm-matchingBracket': { backgroundColor: '#3e4451', outline: '1px solid #5c6370' },
    '.cm-tooltip': { backgroundColor: '#252931', border: '1px solid #3e4451', color: '#abb2bf' },
    '.cm-tooltip-autocomplete > ul > li[aria-selected]': { backgroundColor: '#2f5f9e', color: '#fff' },
    '.cm-panels': { backgroundColor: '#252931', color: '#abb2bf' },
    '.cm-foldGutter span': { color: '#5c6370' },
    '.cm-reveal': { backgroundColor: '#e5c07b33', transition: 'background-color .6s' },
  },
  { dark: true },
)

function toDiagnostics(): Diagnostic[] {
  const len = view?.state.doc.length ?? 0
  return parsed.value.errors.map((e) => ({
    from: Math.min(e.from, len),
    to: Math.min(Math.max(e.to, e.from), len),
    severity: e.severity,
    message: e.message,
  }))
}

onMounted(() => {
  view = new EditorView({
    parent: host.value!,
    state: EditorState.create({
      doc: source.value,
      extensions: [
        lineNumbers(),
        EditorView.lineWrapping,
        highlightActiveLineGutter(),
        highlightSpecialChars(),
        history(),
        foldGutter(),
        drawSelection(),
        dropCursor(),
        indentOnInput(),
        indentUnit.of('  '),
        bracketMatching(),
        closeBrackets(),
        autocompletion({ override: [dbmlCompletion(() => parsed.value)] }),
        highlightActiveLine(),
        highlightSelectionMatches(),
        lintGutter(),
        dbmlLanguage,
        dbmlHighlight,
        theme,
        keymap.of([...closeBracketsKeymap, ...defaultKeymap, ...searchKeymap, ...historyKeymap, ...foldKeymap, ...completionKeymap, ...lintKeymap, indentWithTab]),
        EditorView.updateListener.of((u) => {
          if (u.docChanged) {
            const text = u.state.doc.toString()
            if (text !== source.value) source.value = text
          }
          if (u.selectionSet || u.docChanged) cursorOffset.value = u.state.selection.main.head
        }),
      ],
    }),
  })
  view.dispatch(setDiagnostics(view.state, toDiagnostics()))
})

onBeforeUnmount(() => view?.destroy())

// external changes (diagram edits, import) become a minimal undoable change
watch(source, (text) => {
  if (!view) return
  const cur = view.state.doc.toString()
  if (cur === text) return
  let start = 0
  const max = Math.min(cur.length, text.length)
  while (start < max && cur.charCodeAt(start) === text.charCodeAt(start)) start++
  let endA = cur.length
  let endB = text.length
  while (endA > start && endB > start && cur.charCodeAt(endA - 1) === text.charCodeAt(endB - 1)) {
    endA--
    endB--
  }
  view.dispatch({ changes: { from: start, to: endA, insert: text.slice(start, endB) } })
})

watch(parsed, () => {
  if (view) view.dispatch(setDiagnostics(view.state, toDiagnostics()))
})

watch(revealRequest, (r) => {
  if (!view || !r) return
  const len = view.state.doc.length
  const from = Math.min(r.from, len)
  view.dispatch({
    selection: { anchor: from, head: Math.min(r.to, len) },
    effects: EditorView.scrollIntoView(from, { y: 'center' }),
  })
  if (r.focus) view.focus()
})

function jumpTo(from: number) {
  if (!view) return
  view.dispatch({ selection: { anchor: from }, effects: EditorView.scrollIntoView(from, { y: 'center' }) })
  view.focus()
}
defineExpose({ jumpTo })
</script>

<template>
  <div ref="host" class="dbml-editor"></div>
</template>

<style scoped>
.dbml-editor {
  height: 100%;
  overflow: hidden;
}
</style>
