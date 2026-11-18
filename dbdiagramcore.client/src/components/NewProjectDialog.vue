<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import { quoteIdent, quoteString } from '@/dbml/generator'
import { projectNameError } from '@/store'

/** With `rename`, the dialog renames that project instead of creating a new one. */
const props = defineProps<{ rename?: string }>()
const emit = defineEmits<{ close: []; create: [name: string, dbml: string]; rename: [name: string] }>()

const DB_TYPES = ['PostgreSQL', 'MySQL', 'SQL Server', 'Oracle', 'SQLite']

const name = ref(props.rename ?? '')
const dbType = ref('SQL Server')
const note = ref('')
const busy = ref(false)
const nameInput = ref<HTMLInputElement>()

onMounted(() => setTimeout(() => nameInput.value?.select()))

const error = computed(() => projectNameError(name.value, props.rename))
const canSubmit = computed(() => !busy.value && !!name.value.trim() && !error.value && name.value.trim() !== props.rename)

function buildDbml(projectName: string) {
  const settings = [`  database_type: ${quoteString(dbType.value)}`]
  if (note.value.trim()) settings.push(`  Note: ${quoteString(note.value.trim())}`)
  return `Project ${quoteIdent(projectName)} {
${settings.join('\n')}
}

Table users {
  id integer [pk, increment]
  name varchar
}
`
}

function submit() {
  if (!canSubmit.value) return
  const n = name.value.trim()
  if (props.rename !== undefined) {
    busy.value = true
    emit('rename', n)
  } else emit('create', n, buildDbml(n))
}
/** Lets the parent re-enable the dialog after a failed rename. */
defineExpose({ done: () => (busy.value = false) })
</script>

<template>
  <div class="overlay" @pointerdown.self="emit('close')" @keydown.esc="emit('close')">
    <form class="dialog" @submit.prevent="submit">
      <header>{{ rename !== undefined ? '重新命名專案' : '新文件' }}</header>
      <div class="body">
        <label>
          專案名稱 <span class="req">*</span>
          <input ref="nameInput" v-model="name" placeholder="例如 ecommerce" maxlength="100" />
        </label>
        <p v-if="error" class="error">{{ error }}</p>
        <template v-if="rename === undefined">
          <label>
            資料庫類型
            <select v-model="dbType">
              <option v-for="t in DB_TYPES" :key="t" :value="t">{{ t }}</option>
            </select>
          </label>
          <label>
            說明 (選填)
            <input v-model="note" placeholder="專案說明" />
          </label>
        </template>
      </div>
      <footer>
        <button type="button" class="plain" @click="emit('close')">取消</button>
        <button type="submit" class="primary" :disabled="!canSubmit">{{ rename !== undefined ? '重新命名' : '建立' }}</button>
      </footer>
    </form>
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
  width: min(420px, 100%);
  box-shadow: 0 16px 48px rgb(0 0 0 / 0.25);
  font-size: 13px;
}
header {
  padding: 14px 18px;
  font-size: 15px;
  font-weight: 600;
  border-bottom: 1px solid #eef0f3;
}
.body {
  padding: 16px 18px;
  display: flex;
  flex-direction: column;
  gap: 12px;
}
label {
  display: flex;
  flex-direction: column;
  gap: 5px;
  color: #57606a;
}
.req {
  color: #cf222e;
}
input,
select {
  font: inherit;
  padding: 6px 8px;
  border: 1px solid #d0d7de;
  border-radius: 6px;
  color: #24292f;
  background: #fff;
}
input:focus,
select:focus {
  outline: none;
  border-color: #2f80ed;
  box-shadow: 0 0 0 3px rgb(47 128 237 / 0.15);
}
.error {
  margin: -6px 0 0;
  color: #cf222e;
}
footer {
  display: flex;
  justify-content: flex-end;
  gap: 8px;
  padding: 12px 18px;
  border-top: 1px solid #eef0f3;
}
footer button {
  font: inherit;
  padding: 6px 14px;
  border-radius: 6px;
  cursor: pointer;
  border: 1px solid #d0d7de;
  background: #f6f8fa;
  color: #24292f;
}
footer button.primary {
  background: #2f80ed;
  border-color: #2f80ed;
  color: #fff;
}
footer button:disabled {
  opacity: 0.5;
  cursor: default;
}
</style>
