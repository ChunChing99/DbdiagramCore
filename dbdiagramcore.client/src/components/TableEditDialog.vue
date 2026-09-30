<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import { deleteTable, tableToDraft, updateTable, type EditableColumn, type EditableTable } from '@/dbml/edit'
import { tableIdOf } from '@/dbml/parser'
import { COLORS } from '@/diagram/layout'
import { applyEdit, canEdit, errorCount, parsed, reveal } from '@/store'

const props = defineProps<{ tableId: string }>()
const emit = defineEmits<{ close: []; toast: [msg: string] }>()

const TYPES = ['integer', 'bigint', 'smallint', 'serial', 'decimal(10, 2)', 'numeric', 'float', 'boolean', 'varchar(255)', 'varchar', 'text', 'char(1)', 'uuid', 'json', 'jsonb', 'date', 'time', 'timestamp', 'timestamptz', 'datetime', 'blob']

const table = computed(() => parsed.value.tables.find((t) => t.id === props.tableId))
const draft = ref<EditableTable | null>(null)
const indexText = ref<{ columns: string; unique: boolean; pk: boolean; name: string; type?: string; note?: string }[]>([])
const error = ref('')
const nameInput = ref<HTMLInputElement>()

onMounted(() => {
  if (!table.value) return
  draft.value = tableToDraft(table.value)
  indexText.value = draft.value.indexes.map((i) => ({ columns: i.columns.join(', '), unique: i.unique, pk: i.pk, name: i.name ?? '', type: i.type, note: i.note }))
  setTimeout(() => nameInput.value?.select())
})

const enums = computed(() => parsed.value.enums.map((e) => e.id))

function addColumn() {
  const cols = draft.value!.columns
  let name = 'column'
  for (let i = 1; cols.some((c) => c.name === name); i++) name = `column_${i}`
  cols.push({ name, type: 'varchar', pk: false, notNull: false, unique: false, increment: false, inlineRefs: [] })
}
function move(i: number, d: number) {
  const cols = draft.value!.columns
  const j = i + d
  if (j < 0 || j >= cols.length) return
  ;[cols[i], cols[j]] = [cols[j]!, cols[i]!]
}
function removeColumn(i: number) {
  draft.value!.columns.splice(i, 1)
}
function refText(c: EditableColumn) {
  return c.inlineRefs.map((r) => `${r.op} ${r.table}.${r.columns.join(',')}`).join('  ')
}

function save() {
  const d = draft.value
  if (!d || !table.value) return
  error.value = ''
  d.name = d.name.trim()
  d.schema = d.schema?.trim() || undefined
  d.alias = d.alias?.trim() || undefined
  d.note = d.note?.trim() || undefined
  d.headerColor = d.headerColor?.trim() || undefined
  if (!d.name) return (error.value = '請輸入資料表名稱')
  const newId = tableIdOf(d.schema, d.name)
  if (newId !== table.value.id && parsed.value.tables.some((t) => t.id === newId)) return (error.value = `資料表 '${newId}' 已存在`)
  if (d.headerColor && !/^#[0-9a-f]{3,8}$/i.test(d.headerColor)) return (error.value = '標題顏色須為 #RRGGBB 格式')
  const seen = new Set<string>()
  for (const c of d.columns) {
    c.name = c.name.trim()
    c.type = c.type.trim()
    c.note = c.note?.trim() || undefined
    c.default = c.default?.trim() || undefined
    if (!c.name) return (error.value = '欄位名稱不可空白')
    if (!c.type) return (error.value = `欄位 '${c.name}' 缺少型別`)
    if (seen.has(c.name)) return (error.value = `欄位 '${c.name}' 重複`)
    seen.add(c.name)
  }
  d.indexes = indexText.value
    .map((i) => ({
      columns: i.columns.split(',').map((x) => x.trim()).filter(Boolean),
      unique: i.unique,
      pk: i.pk,
      name: i.name.trim() || undefined,
      type: i.type,
      note: i.note,
    }))
    .filter((i) => i.columns.length)
  if (!applyEdit((src, s) => updateTable(src, s, props.tableId, d))) return (error.value = `DBML 有 ${errorCount.value} 個錯誤，請先修正`)
  emit('toast', `已更新資料表 ${newId}`)
  emit('close')
}

function remove() {
  if (!confirm(`確定要刪除資料表 ${props.tableId}？相關的關聯也會一併移除。`)) return
  applyEdit((src, s) => deleteTable(src, s, props.tableId))
  emit('close')
}

function showInEditor() {
  if (table.value) reveal(table.value.range)
  emit('close')
}
</script>

<template>
  <div class="overlay" @pointerdown.self="emit('close')" @keydown.esc="emit('close')">
    <div v-if="draft" class="dialog" role="dialog" aria-modal="true" @keydown.enter.ctrl="save">
      <header>
        <h2>編輯資料表</h2>
        <button class="icon" title="關閉" @click="emit('close')">✕</button>
      </header>

      <div v-if="!canEdit" class="warn">DBML 目前有 {{ errorCount }} 個錯誤，請先在編輯器中修正才能儲存。</div>

      <div class="body">
        <div class="grid">
          <label>名稱<input ref="nameInput" v-model="draft.name" /></label>
          <label>Schema<input v-model="draft.schema" placeholder="public" /></label>
          <label>別名<input v-model="draft.alias" placeholder="(選填)" /></label>
        </div>
        <label class="full">註解<textarea v-model="draft.note" rows="2" placeholder="(選填)"></textarea></label>
        <div class="colors">
          <span class="lbl">標題顏色</span>
          <button
            v-for="c in COLORS"
            :key="c"
            class="swatch"
            :class="{ on: draft.headerColor === c }"
            :style="{ background: c }"
            :title="c"
            @click="draft.headerColor = c"
          ></button>
          <button class="swatch none" :class="{ on: !draft.headerColor }" title="預設" @click="draft.headerColor = undefined">∅</button>
          <input v-model="draft.headerColor" class="color-input" placeholder="#316896" />
        </div>

        <h3>欄位</h3>
        <table class="cols">
          <thead>
            <tr>
              <th>名稱</th>
              <th>型別</th>
              <th title="主鍵">PK</th>
              <th title="不可為空">NN</th>
              <th title="唯一">UQ</th>
              <th title="自動遞增">AI</th>
              <th title="例如 'abc'、0、true、`now()`">預設值</th>
              <th>註解</th>
              <th>關聯</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="(c, i) in draft.columns" :key="i">
              <td><input v-model="c.name" class="w-name" /></td>
              <td><input v-model="c.type" class="w-type" list="dbml-types" /></td>
              <td><input v-model="c.pk" type="checkbox" /></td>
              <td><input v-model="c.notNull" type="checkbox" :disabled="c.pk" /></td>
              <td><input v-model="c.unique" type="checkbox" /></td>
              <td><input v-model="c.increment" type="checkbox" /></td>
              <td><input v-model="c.default" class="w-def" /></td>
              <td><input v-model="c.note" class="w-note" /></td>
              <td class="ref">{{ refText(c) }}</td>
              <td class="row-actions">
                <button class="icon" title="上移" :disabled="i === 0" @click="move(i, -1)">↑</button>
                <button class="icon" title="下移" :disabled="i === draft.columns.length - 1" @click="move(i, 1)">↓</button>
                <button class="icon danger" title="刪除欄位" @click="removeColumn(i)">✕</button>
              </td>
            </tr>
          </tbody>
        </table>
        <datalist id="dbml-types">
          <option v-for="t in [...TYPES, ...enums]" :key="t" :value="t" />
        </datalist>
        <button class="link" @click="addColumn">＋ 新增欄位</button>

        <h3>索引</h3>
        <div v-for="(idx, i) in indexText" :key="i" class="index-row">
          <input v-model="idx.columns" placeholder="欄位，以逗號分隔" class="w-idx" />
          <input v-model="idx.name" placeholder="索引名稱 (選填)" />
          <label><input v-model="idx.unique" type="checkbox" /> unique</label>
          <label><input v-model="idx.pk" type="checkbox" /> pk</label>
          <button class="icon danger" title="刪除索引" @click="indexText.splice(i, 1)">✕</button>
        </div>
        <button class="link" @click="indexText.push({ columns: '', unique: false, pk: false, name: '' })">＋ 新增索引</button>

        <p v-if="error" class="error">{{ error }}</p>
      </div>

      <footer>
        <button class="danger-btn" @click="remove">刪除資料表</button>
        <button class="plain" @click="showInEditor">在編輯器中顯示</button>
        <span class="spacer"></span>
        <button class="plain" @click="emit('close')">取消</button>
        <button class="primary" :disabled="!canEdit" @click="save">儲存</button>
      </footer>
    </div>
  </div>
</template>

<style scoped>
.overlay {
  position: fixed;
  inset: 0;
  background: rgb(15 20 25 / 0.45);
  display: flex;
  align-items: center;
  justify-content: center;
  z-index: 100;
  padding: 16px;
}
.dialog {
  background: #fff;
  color: #24292f;
  border-radius: 10px;
  width: min(1040px, 100%);
  max-height: calc(100vh - 32px);
  display: flex;
  flex-direction: column;
  box-shadow: 0 16px 48px rgb(0 0 0 / 0.25);
}
header,
footer {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 14px 20px;
}
header {
  border-bottom: 1px solid #eef0f3;
  justify-content: space-between;
}
footer {
  border-top: 1px solid #eef0f3;
}
h2 {
  font-size: 16px;
  font-weight: 600;
}
h3 {
  font-size: 13px;
  font-weight: 600;
  margin: 18px 0 8px;
  color: #57606a;
}
.body {
  padding: 16px 20px;
  overflow: auto;
}
.grid {
  display: grid;
  grid-template-columns: 2fr 1fr 1fr;
  gap: 12px;
}
label {
  display: flex;
  flex-direction: column;
  gap: 4px;
  font-size: 12px;
  color: #57606a;
}
.full {
  margin-top: 12px;
}
input,
textarea {
  font: inherit;
  font-size: 13px;
  padding: 5px 8px;
  border: 1px solid #d0d7de;
  border-radius: 5px;
  color: #24292f;
  background: #fff;
  min-width: 0;
}
input:focus,
textarea:focus {
  outline: 2px solid #2f80ed55;
  border-color: #2f80ed;
}
input[type='checkbox'] {
  width: 15px;
  height: 15px;
}
.colors {
  display: flex;
  align-items: center;
  gap: 6px;
  margin-top: 12px;
  flex-wrap: wrap;
}
.lbl {
  font-size: 12px;
  color: #57606a;
  margin-right: 4px;
}
.swatch {
  width: 22px;
  height: 22px;
  border-radius: 5px;
  border: 1px solid rgb(0 0 0 / 0.1);
  cursor: pointer;
  padding: 0;
}
.swatch.on {
  outline: 2px solid #24292f;
  outline-offset: 1px;
}
.swatch.none {
  background: #fff;
  color: #6e7781;
  font-size: 11px;
}
.color-input {
  width: 90px;
  font-family: Consolas, monospace;
}
.cols {
  width: 100%;
  border-collapse: collapse;
  font-size: 13px;
}
.cols th {
  text-align: left;
  font-weight: 500;
  font-size: 12px;
  color: #6e7781;
  padding: 4px;
}
.cols td {
  padding: 3px 4px;
  border-top: 1px solid #f0f2f4;
}
.w-name {
  width: 150px;
}
.w-type {
  width: 140px;
}
.w-def {
  width: 110px;
}
.w-note {
  width: 150px;
}
.ref {
  font-family: Consolas, monospace;
  font-size: 12px;
  color: #1d4f91;
  white-space: nowrap;
}
.row-actions {
  white-space: nowrap;
}
.index-row {
  display: flex;
  gap: 8px;
  align-items: center;
  margin-bottom: 6px;
}
.index-row label {
  flex-direction: row;
  align-items: center;
  gap: 4px;
}
.w-idx {
  width: 260px;
}
button {
  font: inherit;
  cursor: pointer;
}
.icon {
  border: none;
  background: transparent;
  padding: 3px 7px;
  border-radius: 4px;
  color: #57606a;
}
.icon:hover:not(:disabled) {
  background: #eef1f4;
}
.icon:disabled {
  opacity: 0.3;
  cursor: default;
}
.danger {
  color: #cf222e;
}
.link {
  border: none;
  background: none;
  color: #0969da;
  padding: 6px 0;
  font-size: 13px;
}
.plain,
.primary,
.danger-btn {
  font-size: 13px;
  padding: 6px 14px;
  border-radius: 6px;
  border: 1px solid #d0d7de;
  background: #f6f8fa;
  color: #24292f;
}
.primary {
  background: #2f80ed;
  border-color: #2f80ed;
  color: #fff;
}
.primary:disabled {
  opacity: 0.5;
  cursor: default;
}
.danger-btn {
  color: #cf222e;
  background: #fff;
}
.spacer {
  flex: 1;
}
.warn {
  margin: 12px 20px 0;
  padding: 8px 12px;
  background: #fff4e5;
  border: 1px solid #f0b46a;
  border-radius: 6px;
  font-size: 13px;
  color: #8a4b00;
}
.error {
  color: #cf222e;
  font-size: 13px;
  margin-top: 12px;
}
</style>
