<template>
  <section class="page" data-module="duty">
    <header class="page-head">
      <div>
        <h2>运维值班交接管理</h2>
        <p class="page-desc">维护值班交接记录，围绕交接编号、值班班组、值班日期、班次做登记、筛选与状态流转。</p>
      </div>
      <div class="page-actions">
        <button class="btn primary" type="button" @click="openCreate">登记值班交接记录</button>
        <button class="btn" type="button" @click="exportRows">导出运维值班交接清单</button>
      </div>
    </header>

    <div class="stat-row">
      <article v-for="item in stats" :key="item.label" class="stat-card">
        <span class="stat-label">{{ item.label }}</span>
        <strong class="stat-value">{{ item.value }}</strong>
      </article>
    </div>

    <p class="status-legend">
      <span v-for="item in statusSummary" :key="item.status" class="legend-item">
        {{ item.status }}：{{ item.count }}
      </span>
    </p>

    <form class="filter-bar" @submit.prevent="reload">
      <label v-for="field in filterFields" :key="field" class="filter-item">
        <span>{{ field }}</span>
        <input v-model="filters[field]" :placeholder="`按${field}检索`" />
      </label>
      <button class="btn" type="submit">查询</button>
      <button class="btn ghost" type="button" @click="resetFilters">重置条件</button>
    </form>

    <table class="data-table">
      <thead>
        <tr>
          <th v-for="column in columns" :key="column">{{ column }}</th>
          <th>当前状态</th>
          <th>可执行动作</th>
        </tr>
      </thead>
      <tbody>
        <tr v-for="row in rows" :key="String(row.id)">
          <td v-for="column in columns" :key="column">{{ row[column] ?? '—' }}</td>
          <td>{{ row.status }}</td>
          <td class="row-actions">
            <button
              v-for="action in actions"
              :key="action"
              class="link"
              type="button"
              @click="runAction(action, row)"
            >
              {{ action }}
            </button>
          </td>
        </tr>
        <tr v-if="!rows.length">
          <td :colspan="columns.length + 2" class="empty-state">暂无运维值班交接数据，可先登记值班交接记录</td>
        </tr>
      </tbody>
    </table>

    <footer class="page-foot">
      <span>共 {{ total }} 条运维值班交接记录</span>
      <span v-if="errorMessage" class="error-text">{{ errorMessage }}</span>
    </footer>

    <!-- 保洁交接清单：与保洁作业单台账读的是同一份存储，结论两处一致 -->
    <div class="panel">
      <div class="panel-head">
        <h3>保洁作业单 · 交接清单（与保洁台账同源）</h3>
        <button class="btn" type="button" @click="exportCleaningHandover">下载清单文件</button>
      </div>
      <table class="data-table">
        <thead>
          <tr><th>时间</th><th>类别</th><th>事项</th></tr>
        </thead>
        <tbody>
          <tr v-for="row in cleaningHandover" :key="String(row.id)">
            <td>{{ row['时间'] }}</td>
            <td>{{ row['类别'] }}</td>
            <td>{{ row['事项'] }}</td>
          </tr>
        </tbody>
      </table>
      <p class="hint">车单导入、待核核定、月底另存、存量回填的结论都在这里，与「保洁作业单台账」页是同一份。</p>
    </div>
  </section>
</template>

<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'

import {
  downloadEntries,
  listEntries,
  moduleMeta,
  runAction as applyAction,
} from '@/api/local-service'
import { downloadHandover, listHandover } from '@/api/cleaning-service'
import type { EntryRow } from '@/data/types'

const meta = moduleMeta('duty')
const columns = ["交接编号", "值班班组", "值班日期", "班次", "值班人员", "交接事项", "交接人员", "交接状态"]
const actions = ["发起交接", "确认交接", "登记遗留"]
const statuses = ["待交接", "交接中", "已交接", "有遗留"]
const stats = [{"label": "待交接班次", "value": 0}, {"label": "已交接班次", "value": 0}, {"label": "有遗留事项", "value": 0}]

const rows = ref<EntryRow[]>([])
const total = ref(0)
const errorMessage = ref('')
const filters = ref<Record<string, string>>({})
const filterFields = columns.slice(0, 3)
const statusSummary = computed(() =>
  statuses.map((status: string) => ({
    status,
    count: rows.value.filter((row) => String(row.status) === status).length,
  })),
)

function resetFilters() {
  filters.value = {}
  reload()
}

function exportRows() {
  downloadEntries(meta.key)
}

function openCreate() {
  errorMessage.value = '值班交接记录登记入口尚未接入审批流'
}

function runAction(action: string, row: EntryRow) {
  errorMessage.value = ''
  const result = applyAction(meta.key, Number(row.id), action)
  if (!result.ok) {
    errorMessage.value = result.message
    return
  }
  reload()
}

function reload() {
  errorMessage.value = ''
  try {
    const payload = listEntries(meta.key, filters.value)
    rows.value = payload.items
    total.value = payload.total
    cleaningHandover.value = listHandover()
  } catch (error) {
    errorMessage.value = error instanceof Error ? error.message : '运维值班交接列表读取失败'
  }
}

const cleaningHandover = ref<EntryRow[]>([])

function exportCleaningHandover() {
  downloadHandover()
}

onMounted(reload)
</script>

<style scoped>
.panel { background: #fff; border: 1px solid var(--border); border-radius: 8px; padding: 12px; margin-top: 18px; }
.panel-head { display: flex; justify-content: space-between; align-items: center; margin-bottom: 8px; }
.panel-head h3 { margin: 0; font-size: 15px; }
.hint { color: var(--muted); font-size: 12px; margin: 8px 0 0; }
</style>
