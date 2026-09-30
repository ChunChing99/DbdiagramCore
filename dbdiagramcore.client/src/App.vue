<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'
import DbmlEditor from './components/DbmlEditor.vue'
import DiagramCanvas from './components/DiagramCanvas.vue'
import TableEditDialog from './components/TableEditDialog.vue'
import { SAMPLE_DBML } from './dbml/sample'
import { toSql, type Dialect } from './dbml/sql'
import { downloadText } from './diagram/export'
import {
  currentProject,
  errorCount,
  fileName,
  openProject,
  parsed,
  positions,
  projects,
  refreshProjects,
  relayout,
  reveal,
  setUrlProject,
  source,
  urlProject,
} from './store'

const canvas = ref<InstanceType<typeof DiagramCanvas>>()
const editingTable = ref<string | null>(null)
const exportOpen = ref(false)
const projectsOpen = ref(false)
const errorsOpen = ref(false)
const fileInput = ref<HTMLInputElement>()

// ---------- split pane ----------
const WIDTH_KEY = 'dbdiagram.editorWidth'
const editorWidth = ref(Number(localStorage.getItem(WIDTH_KEY)) || 460)
let resizing = false
function startResize(e: PointerEvent) {
  resizing = true
  ;(e.target as Element).setPointerCapture(e.pointerId)
}
function onResize(e: PointerEvent) {
  if (!resizing) return
  editorWidth.value = Math.min(Math.max(260, e.clientX), window.innerWidth - 300)
}
function endResize() {
  if (!resizing) return
  resizing = false
  localStorage.setItem(WIDTH_KEY, String(editorWidth.value))
}

// ---------- toast ----------
const toastMsg = ref('')
let toastTimer: ReturnType<typeof setTimeout> | undefined
function toast(msg: string) {
  toastMsg.value = msg
  clearTimeout(toastTimer)
  toastTimer = setTimeout(() => (toastMsg.value = ''), 3000)
}

// ---------- status ----------
const warnings = computed(() => parsed.value.errors.filter((e) => e.severity === 'warning').length)
const stats = computed(() => `${parsed.value.tables.length} 個資料表 · ${parsed.value.refs.length} 個關聯`)
function lineOf(offset: number) {
  return source.value.slice(0, offset).split('\n').length
}
function jumpError(from: number, to: number) {
  reveal({ from, to })
  errorsOpen.value = false
}

// ---------- file actions ----------
function projectName() {
  return (parsed.value.project?.name || 'dbdiagram').replace(/[\\/:*?"<>|]/g, '_')
}
function loadSample() {
  if (source.value.trim() && !confirm('載入範例會取代目前的內容，確定嗎？')) return
  positions.value = {}
  source.value = SAMPLE_DBML
  setTimeout(() => canvas.value?.fit(), 50)
}
function newDoc() {
  if (source.value.trim() && !confirm('建立新文件會清除目前的內容，確定嗎？')) return
  positions.value = {}
  source.value = 'Table users {\n  id integer [pk, increment]\n  name varchar\n}\n'
  setTimeout(() => canvas.value?.fit(), 50)
}
function importFile(e: Event) {
  const f = (e.target as HTMLInputElement).files?.[0]
  if (!f) return
  f.text().then((text) => {
    positions.value = {}
    source.value = text
    toast(`已匯入 ${f.name}`)
    setTimeout(() => {
      relayout()
      canvas.value?.fit()
    }, 50)
  })
  ;(e.target as HTMLInputElement).value = ''
}
function exportAs(kind: 'dbml' | Dialect | 'png' | 'svg') {
  exportOpen.value = false
  if (kind === 'dbml') return downloadText(source.value, `${projectName()}.dbml`)
  if (kind === 'png' || kind === 'svg') return canvas.value?.exportImage(kind)
  if (errorCount.value) return toast('DBML 有錯誤，請先修正後再匯出 SQL')
  const ext = { postgres: 'postgresql', mysql: 'mysql', mssql: 'sqlserver' }[kind]
  downloadText(toSql(parsed.value, kind), `${projectName()}.${ext}.sql`, 'application/sql')
}

// ---------- projects ----------
const currentFile = computed(() => (currentProject.value ? fileName(currentProject.value) : undefined))
function toggleProjects() {
  projectsOpen.value = !projectsOpen.value
  if (projectsOpen.value) refreshProjects()
}
async function loadProject(name: string, push = true) {
  if (!(await openProject(name, push))) {
    toast(`找不到專案「${name}」`)
    return false
  }
  setTimeout(() => canvas.value?.fit(), 50)
  return true
}
async function chooseProject(name: string) {
  projectsOpen.value = false
  if (name === currentFile.value) return
  if (!currentProject.value && source.value.trim() && !confirm('目前內容沒有 Project 名稱，不會存到伺服器，切換專案後將被取代，確定嗎？'))
    return
  if (await loadProject(name)) toast(`已開啟專案「${name}」`)
}
async function openFromUrl() {
  const name = urlProject()
  if (name && fileName(name) !== currentFile.value && (await loadProject(name, false))) return
  setUrlProject(currentProject.value)
}

function onDocDown(e: PointerEvent) {
  const el = e.target as HTMLElement
  if (!el.closest('.export-menu')) exportOpen.value = false
  if (!el.closest('.project-menu')) projectsOpen.value = false
  if (!el.closest('.status')) errorsOpen.value = false
}
function onKey(e: KeyboardEvent) {
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') {
    e.preventDefault()
    exportAs('dbml')
  }
}
onMounted(() => {
  document.addEventListener('pointerdown', onDocDown)
  document.addEventListener('keydown', onKey)
  window.addEventListener('popstate', openFromUrl)
  openFromUrl()
  refreshProjects()
})
onBeforeUnmount(() => {
  document.removeEventListener('pointerdown', onDocDown)
  document.removeEventListener('keydown', onKey)
  window.removeEventListener('popstate', openFromUrl)
})
</script>

<template>
  <div class="app" @pointermove="onResize" @pointerup="endResize">
    <header class="topbar">
      <div class="brand">
        <svg width="22" height="22" viewBox="0 0 24 24" aria-hidden="true">
          <rect x="2" y="3" width="9" height="7" rx="1.5" fill="#4ea1ff" />
          <rect x="13" y="14" width="9" height="7" rx="1.5" fill="#ffb454" />
          <path d="M11 6.5 H15 V14" fill="none" stroke="#c9d1d9" stroke-width="1.6" />
        </svg>
        <span>DBDiagram</span>
        <div class="dropdown project-menu">
          <button class="project" title="選擇已儲存的專案" @click="toggleProjects">
            / {{ currentProject ?? '選擇專案' }} <span class="caret">▾</span>
          </button>
          <div v-if="projectsOpen" class="dropdown-menu left">
            <button v-for="p in projects" :key="p" :class="{ active: p === currentFile }" @click="chooseProject(p)">
              {{ p }}
            </button>
            <div v-if="!projects.length" class="empty">尚無已儲存的專案</div>
          </div>
        </div>
      </div>
      <nav>
        <button @click="newDoc">新文件</button>
        <button @click="loadSample">載入範例</button>
        <button @click="fileInput?.click()">匯入 DBML</button>
        <input ref="fileInput" type="file" accept=".dbml,.txt,text/plain" hidden @change="importFile" />
        <div class="dropdown export-menu">
          <button class="primary" @click="exportOpen = !exportOpen">匯出 ▾</button>
          <div v-if="exportOpen" class="dropdown-menu">
            <button @click="exportAs('png')">圖片 PNG</button>
            <button @click="exportAs('svg')">圖片 SVG</button>
            <hr />
            <button @click="exportAs('dbml')">DBML 檔案 <kbd>Ctrl+S</kbd></button>
            <button @click="exportAs('postgres')">PostgreSQL</button>
            <button @click="exportAs('mysql')">MySQL</button>
            <button @click="exportAs('mssql')">SQL Server</button>
          </div>
        </div>
      </nav>
    </header>

    <main class="main">
      <section class="editor-pane" :style="{ width: editorWidth + 'px' }">
        <DbmlEditor class="editor" />
        <div class="status" :class="{ bad: errorCount }">
          <button v-if="errorCount" class="status-btn" @click="errorsOpen = !errorsOpen">✕ {{ errorCount }} 個錯誤</button>
          <span v-else class="ok">✓ 語法正確</span>
          <span v-if="warnings" class="warnings">⚠ {{ warnings }}</span>
          <span class="spacer"></span>
          <span class="stats">{{ stats }}</span>
          <div v-if="errorsOpen && errorCount" class="error-list">
            <button
              v-for="(e, i) in parsed.errors"
              :key="i"
              :class="e.severity"
              @click="jumpError(e.from, e.to)"
            >
              <span class="ln">第 {{ lineOf(e.from) }} 行</span>{{ e.message }}
            </button>
          </div>
        </div>
      </section>
      <div class="resizer" @pointerdown="startResize"></div>
      <section class="diagram-pane">
        <DiagramCanvas ref="canvas" @edit-table="editingTable = $event" @toast="toast" />
      </section>
    </main>

    <TableEditDialog v-if="editingTable" :key="editingTable" :table-id="editingTable" @close="editingTable = null" @toast="toast" />
    <transition name="fade">
      <div v-if="toastMsg" class="toast">{{ toastMsg }}</div>
    </transition>
  </div>
</template>

<style scoped>
.app {
  display: flex;
  flex-direction: column;
  height: 100vh;
}
.topbar {
  height: 48px;
  flex: none;
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 0 14px;
  background: #161b22;
  color: #e6edf3;
  border-bottom: 1px solid #30363d;
}
.brand {
  display: flex;
  align-items: center;
  gap: 8px;
  font-weight: 600;
  font-size: 15px;
}
.project-menu > button.project {
  background: none;
  border: 1px solid transparent;
  color: #8b949e;
  font-weight: 400;
  font-size: 15px;
  padding: 3px 8px;
}
.project-menu > button.project:hover {
  background: #21262d;
  border-color: #30363d;
  color: #e6edf3;
}
.caret {
  font-size: 11px;
}
.dropdown-menu.left {
  left: 0;
  right: auto;
  max-height: 60vh;
  overflow-y: auto;
  font-weight: 400;
}
.dropdown-menu button.active {
  background: #eaf2fe;
  color: #1f6fd9;
  font-weight: 600;
}
.dropdown-menu .empty {
  padding: 7px 10px;
  font-size: 13px;
  color: #8c959f;
}
nav {
  display: flex;
  gap: 6px;
  align-items: center;
}
nav > button,
.dropdown > button {
  background: #21262d;
  border: 1px solid #30363d;
  color: #e6edf3;
  padding: 5px 12px;
  border-radius: 6px;
  font: inherit;
  font-size: 13px;
  cursor: pointer;
}
nav > button:hover,
.dropdown > button:hover {
  background: #30363d;
}
.dropdown > button.primary {
  background: #2f80ed;
  border-color: #2f80ed;
}
.dropdown > button.primary:hover {
  background: #1f6fd9;
}
.dropdown {
  position: relative;
}
.dropdown-menu {
  position: absolute;
  right: 0;
  top: calc(100% + 6px);
  background: #fff;
  border: 1px solid #d0d7de;
  border-radius: 8px;
  box-shadow: 0 8px 24px rgb(0 0 0 / 0.18);
  padding: 6px;
  min-width: 190px;
  z-index: 50;
  display: flex;
  flex-direction: column;
}
.dropdown-menu button {
  text-align: left;
  background: none;
  border: none;
  padding: 7px 10px;
  border-radius: 5px;
  font: inherit;
  font-size: 13px;
  color: #24292f;
  cursor: pointer;
  display: flex;
  justify-content: space-between;
}
.dropdown-menu button:hover {
  background: #eef1f4;
}
.dropdown-menu hr {
  border: none;
  border-top: 1px solid #eef0f3;
  margin: 4px 0;
}
kbd {
  font-size: 11px;
  color: #8c959f;
  font-family: inherit;
}
.main {
  flex: 1;
  display: flex;
  min-height: 0;
}
.editor-pane {
  flex: none;
  display: flex;
  flex-direction: column;
  min-width: 0;
  background: #1e2127;
}
.editor {
  flex: 1;
  min-height: 0;
}
.status {
  position: relative;
  flex: none;
  height: 30px;
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 0 12px;
  font-size: 12px;
  background: #21252b;
  color: #9da5b4;
  border-top: 1px solid #181a1f;
}
.ok {
  color: #7ec16e;
}
.status-btn {
  background: none;
  border: none;
  color: #ff7b72;
  font: inherit;
  cursor: pointer;
  padding: 2px 0;
}
.status-btn:hover {
  text-decoration: underline;
}
.warnings {
  color: #e3b341;
}
.spacer {
  flex: 1;
}
.error-list {
  position: absolute;
  left: 8px;
  right: 8px;
  bottom: calc(100% + 6px);
  max-height: 260px;
  overflow: auto;
  background: #252931;
  border: 1px solid #3e4451;
  border-radius: 6px;
  box-shadow: 0 -6px 20px rgb(0 0 0 / 0.3);
  padding: 4px;
  z-index: 20;
}
.error-list button {
  display: block;
  width: 100%;
  text-align: left;
  background: none;
  border: none;
  color: #e6e6e6;
  font: inherit;
  font-size: 12px;
  padding: 5px 8px;
  border-radius: 4px;
  cursor: pointer;
}
.error-list button:hover {
  background: #2f343f;
}
.error-list button.error .ln {
  color: #ff7b72;
}
.error-list button.warning .ln {
  color: #e3b341;
}
.ln {
  display: inline-block;
  min-width: 64px;
  margin-right: 6px;
}
.resizer {
  flex: none;
  width: 5px;
  cursor: col-resize;
  background: #181a1f;
  transition: background 0.15s;
}
.resizer:hover {
  background: #2f80ed;
}
.diagram-pane {
  flex: 1;
  min-width: 0;
  position: relative;
}
.toast {
  position: fixed;
  bottom: 28px;
  left: 50%;
  transform: translateX(-50%);
  background: #1f2328;
  color: #fff;
  padding: 9px 18px;
  border-radius: 8px;
  font-size: 13px;
  box-shadow: 0 6px 20px rgb(0 0 0 / 0.25);
  z-index: 200;
}
.fade-enter-active,
.fade-leave-active {
  transition: opacity 0.2s;
}
.fade-enter-from,
.fade-leave-to {
  opacity: 0;
}
</style>
