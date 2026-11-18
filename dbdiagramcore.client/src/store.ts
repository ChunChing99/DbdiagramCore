import { computed, ref, shallowRef, watch } from 'vue'
import { quoteIdent } from '@/dbml/generator'
import { parseDbml } from '@/dbml/parser'
import { SAMPLE_DBML } from '@/dbml/sample'
import type { Range, Schema } from '@/dbml/types'
import { autoLayout, computeSizes, placeMissing, type Point, type Positions } from '@/diagram/layout'

const SOURCE_KEY = 'dbdiagram.source'
const LAYOUT_KEY = 'dbdiagram.layout'

function load<T>(key: string): T | undefined {
  try {
    const v = localStorage.getItem(key)
    return v === null ? undefined : (JSON.parse(v) as T)
  } catch {
    return undefined
  }
}
function save(key: string, value: unknown) {
  try {
    localStorage.setItem(key, JSON.stringify(value))
  } catch {
    /* storage full or unavailable */
  }
}
function debounce<A extends unknown[]>(fn: (...a: A) => void, ms: number) {
  let t: ReturnType<typeof setTimeout> | undefined
  let pending: A | undefined
  const run = (...a: A) => {
    clearTimeout(t)
    pending = a
    t = setTimeout(run.flush, ms)
  }
  /** Run a pending call now. */
  run.flush = () => {
    clearTimeout(t)
    if (!pending) return
    const a = pending
    pending = undefined
    fn(...a)
  }
  /** Drop a pending call without running it. */
  run.cancel = () => {
    clearTimeout(t)
    pending = undefined
  }
  return run
}

export const source = ref<string>(load<string>(SOURCE_KEY) ?? SAMPLE_DBML)
export const parsed = computed(() => parseDbml(source.value))
export const errorCount = computed(() => parsed.value.errors.filter((e) => e.severity === 'error').length)

/** The diagram keeps showing the last error-free schema while the text is broken. */
const lastGood = shallowRef<Schema>(parsed.value)
watch(parsed, (s) => {
  if (!s.errors.some((e) => e.severity === 'error')) lastGood.value = s
})
export const schema = computed(() => (errorCount.value ? lastGood.value : parsed.value))
export const canEdit = computed(() => errorCount.value === 0)
export const sizes = computed(() => computeSizes(schema.value))

export const positions = ref<Positions>(load<Positions>(LAYOUT_KEY) ?? {})
/** Where new tables without a stored position should appear (set by the canvas to its viewport center). */
export const dropPoint = ref<Point>({ x: 80, y: 80 })

watch(
  schema,
  (s, old) => {
    const pos = { ...positions.value }
    // a single table renamed (in the editor or the dialog) keeps its position
    if (old) {
      const oldIds = new Set(old.tables.map((t) => t.id))
      const newIds = new Set(s.tables.map((t) => t.id))
      const removed = [...oldIds].filter((id) => !newIds.has(id))
      const added = [...newIds].filter((id) => !oldIds.has(id))
      if (removed.length === 1 && added.length === 1 && pos[removed[0]!] && !pos[added[0]!]) {
        pos[added[0]!] = pos[removed[0]!]!
        delete pos[removed[0]!]
      }
    }
    const missing = s.tables.filter((t) => !pos[t.id])
    if (!missing.length) {
      if (old) positions.value = pos
      return
    }
    if (missing.length === s.tables.length) positions.value = autoLayout(s, sizes.value)
    else positions.value = placeMissing(s, sizes.value, pos, dropPoint.value)
  },
  { immediate: true },
)

// ---------- projects (saved on the server as Dbml/{name}.dbml) ----------
const PROJECT_PARAM = 'project'
/** Relative to the page, so it works when the app is hosted under a sub-path. */
const API = 'api/dbml'

/** Same file name the server derives from a project name. */
export function fileName(name: string) {
  return name
    .trim()
    .replace(/[\\/:*?"<>|]/g, '_')
    .replace(/^[. ]+|[. ]+$/g, '')
}
export const currentProject = computed(() => parsed.value.project?.name?.trim() || undefined)
/** Saved project names, most recently modified first. */
export const projects = ref<string[]>([])
const layoutKey = (name: string) => `${LAYOUT_KEY}:${fileName(name)}`

export async function refreshProjects() {
  try {
    const r = await fetch(API)
    if (r.ok) projects.value = await r.json()
  } catch {
    /* server unavailable */
  }
}

/** Last content known to be on the server, per file name. */
const serverCopy = new Map<string, string>()
/** Settles when the most recent save request has finished. */
let lastSave: Promise<unknown> = Promise.resolve()
function saveToServer(name: string, content: string) {
  const file = fileName(name)
  if (!file || serverCopy.get(file) === content) return
  serverCopy.set(file, content)
  lastSave = fetch(API, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name, content }),
  })
    .then((r) => {
      if (!r.ok) throw new Error(r.statusText)
      if (!projects.value.includes(file)) refreshProjects()
    })
    .catch(() => serverCopy.delete(file))
}

const saveSource = debounce((v: string) => save(SOURCE_KEY, v), 400)
/** With a Project name, the autosave is also written to the server. */
const saveServer = debounce((name: string | undefined, v: string) => {
  if (name) saveToServer(name, v)
}, 1000)
/** The layout is kept per project in the browser, plus the current one. */
const saveLayout = debounce((v: Positions) => {
  save(LAYOUT_KEY, v)
  if (currentProject.value) save(layoutKey(currentProject.value), v)
}, 300)
watch(source, saveSource)
watch([currentProject, source], ([name, v]) => saveServer(name, v))
watch(positions, saveLayout, { deep: true })

/** Project named by the `?project=` URL parameter. */
export function urlProject() {
  return new URLSearchParams(location.search).get(PROJECT_PARAM)?.trim() || undefined
}
export function setUrlProject(name: string | undefined, push = false) {
  const url = new URL(location.href)
  if (name) url.searchParams.set(PROJECT_PARAM, name)
  else url.searchParams.delete(PROJECT_PARAM)
  if (url.href === location.href) return
  if (push) history.pushState(null, '', url)
  else history.replaceState(null, '', url)
}
// keep the URL on the open project; a broken document keeps its last URL
watch(currentProject, (name) => {
  if (name || !errorCount.value) setUrlProject(name)
})

/** Load a saved project from the server. Returns false when it isn't found or the server is unreachable. */
export async function openProject(name: string, push = true): Promise<boolean> {
  let text: string
  try {
    const r = await fetch(`${API}/${encodeURIComponent(name)}`)
    if (!r.ok) return false
    text = await r.text()
  } catch {
    return false
  }
  saveSource.flush()
  saveServer.flush()
  saveLayout.flush()
  serverCopy.set(fileName(name), text)
  positions.value = load<Positions>(layoutKey(name)) ?? {}
  source.value = text
  setUrlProject(name, push)
  return true
}

/** Start a new document; pending saves of the current one are written first. */
export function newDocument(text: string) {
  saveSource.flush()
  saveServer.flush()
  saveLayout.flush()
  positions.value = {}
  source.value = text
}

/** Why `newName` can't be used for a project currently named `oldName`, or '' when it can. */
export function projectNameError(newName: string, oldName?: string) {
  const to = fileName(newName)
  if (!newName.trim()) return ''
  if (!to) return '專案名稱無效'
  const sameFile = oldName !== undefined && to.toLowerCase() === fileName(oldName).toLowerCase()
  if (!sameFile && projects.value.some((p) => p.toLowerCase() === to.toLowerCase())) return `專案「${to}」已存在，請使用其他名稱`
  return ''
}

/**
 * Rename the open project: the server file is renamed, the layout moves with it,
 * and the name in the `Project` block is rewritten. Returns an error message, or '' on success.
 */
export async function renameProject(newName: string): Promise<string> {
  const oldName = currentProject.value
  const range = parsed.value.project?.nameRange
  const name = newName.trim()
  if (!oldName || !range) return '目前文件沒有 Project 名稱'
  const err = projectNameError(name, oldName)
  if (err || !name) return err || '請輸入專案名稱'
  if (name === oldName) return ''

  const from = fileName(oldName)
  const to = fileName(name)
  saveSource.flush()
  saveServer.flush()
  saveLayout.flush()
  await lastSave
  if (from !== to) {
    try {
      const r = await fetch(`${API}/${encodeURIComponent(from)}/rename`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ newName: name }),
      })
      // 404: never saved to the server yet, so there is nothing to move
      if (!r.ok && r.status !== 404) return (await r.text()) || `重新命名失敗 (${r.status})`
    } catch {
      return '無法連線到伺服器'
    }
    const copy = serverCopy.get(from)
    serverCopy.delete(from)
    if (copy !== undefined) serverCopy.set(to, copy)
    const layout = load<Positions>(layoutKey(oldName))
    if (layout) save(layoutKey(name), layout)
    try {
      localStorage.removeItem(layoutKey(oldName))
    } catch {
      /* storage unavailable */
    }
  }
  // the source may have changed while waiting; re-read the name position
  const p = parsed.value.project
  if (!p?.nameRange || p.name?.trim() !== oldName) return '專案名稱已在編輯器中變更'
  const r = p.nameRange
  source.value = source.value.slice(0, r.from) + quoteIdent(name) + source.value.slice(r.to)
  refreshProjects()
  return ''
}

/**
 * Delete a saved project from the server, with its layout. When it is the open project,
 * the editor is cleared so the autosave doesn't write it back. Returns an error message, or '' on success.
 */
export async function deleteProject(name: string): Promise<string> {
  const file = fileName(name)
  if (!file) return '專案名稱無效'
  const isCurrent = () => !!currentProject.value && fileName(currentProject.value) === file
  saveSource.flush()
  saveServer.flush()
  saveLayout.flush()
  await lastSave
  try {
    const r = await fetch(`${API}/${encodeURIComponent(file)}`, { method: 'DELETE' })
    if (!r.ok && r.status !== 404) return (await r.text()) || `刪除失敗 (${r.status})`
  } catch {
    return '無法連線到伺服器'
  }
  serverCopy.delete(file)
  try {
    localStorage.removeItem(`${LAYOUT_KEY}:${file}`)
  } catch {
    /* storage unavailable */
  }
  projects.value = projects.value.filter((p) => p !== file)
  if (isCurrent()) {
    // edits made while waiting must not recreate the deleted file
    saveServer.cancel()
    saveLayout.cancel()
    positions.value = {}
    source.value = ''
  }
  return ''
}

export function relayout() {
  positions.value = autoLayout(schema.value, sizes.value)
}

/** Apply a text edit produced from the diagram. Refused while the DBML has errors. */
export function applyEdit(fn: (src: string, schema: Schema) => string): boolean {
  if (!canEdit.value) return false
  const next = fn(source.value, parsed.value)
  if (next !== source.value) source.value = next
  return true
}

// ---------- editor <-> diagram linking ----------
export const selected = ref<string[]>([])
export const cursorOffset = ref(-1)
export const revealRequest = ref<(Range & { n: number; focus: boolean }) | null>(null)
let revealN = 0
/** Select a range in the editor and scroll to it. */
export function reveal(r: Range, focus = true) {
  revealRequest.value = { ...r, n: ++revealN, focus }
}

/** Table under the editor cursor. */
export const cursorTable = computed(() => {
  const o = cursorOffset.value
  return parsed.value.tables.find((t) => o >= t.range.from && o <= t.range.to)?.id
})
