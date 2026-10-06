<template>
  <section class="page" data-module="patrol">
    <header class="page-head">
      <div>
        <h2>廊内巡检任务管理</h2>
        <p class="page-desc">维护巡检任务，围绕巡检编号、巡检路线、巡检班组、计划日期做登记、筛选与状态流转。</p>
      </div>
      <div class="page-actions">
        <button class="btn primary" type="button" @click="openCreate">登记巡检任务</button>
        <button class="btn" type="button" @click="exportRows">导出廊内巡检任务清单</button>
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

    <!-- 保洁清运量与当日巡检遗留问题对不上的作业单，监管员在这里核定 -->
    <div class="panel">
      <div class="panel-head">
        <h3>保洁清运待核（监管员处理）</h3>
        <span class="panel-sub">来源：保洁作业单台账，与当日巡检遗留问题数明显不一致或无法比对的单据</span>
      </div>
      <table class="data-table">
        <thead>
          <tr>
            <th>作业单号</th><th>车次编号</th><th>清运日期</th><th>保洁区域</th><th>保洁班组</th>
            <th>清运量(车)</th><th>巡检遗留问题数</th><th>待核缘由</th><th>核定</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="row in pendingRows" :key="String(row.id)">
            <td>{{ row['作业单号'] }}</td>
            <td>{{ row['车次编号'] }}</td>
            <td>{{ row['清运日期'] }}</td>
            <td>{{ row['保洁区域'] }}</td>
            <td>{{ row['保洁班组'] }}</td>
            <td>{{ row['清运量'] }}</td>
            <td>{{ row['巡检遗留问题数'] ?? '当日无巡检' }}</td>
            <td class="reason-cell">{{ row['核对说明'] }}</td>
            <td class="review-cell">
              <input v-model="notes[Number(row.id)]" placeholder="核定意见（可选）" class="note-input" />
              <button class="link ok" type="button" @click="review(row, '一致入账')">一致入账</button>
              <button class="link bad" type="button" @click="review(row, '不符作废')">不符作废</button>
            </td>
          </tr>
          <tr v-if="!pendingRows.length">
            <td colspan="9" class="empty-state">没有挂待核的保洁作业单，清运量与巡检对得上</td>
          </tr>
        </tbody>
      </table>
      <p v-if="reviewMessage" class="hint" :class="{ 'error-text': reviewError }">{{ reviewMessage }}</p>
      <p class="hint">核定结论会同步写入「运维值班交接 / 保洁交接清单」，台账与清单一次更新、两边同一份。</p>
    </div>

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
          <td :colspan="columns.length + 2" class="empty-state">暂无廊内巡检任务数据，可先登记巡检任务</td>
        </tr>
      </tbody>
    </table>

    <footer class="page-foot">
      <span>共 {{ total }} 条廊内巡检任务记录</span>
      <span v-if="errorMessage" class="error-text">{{ errorMessage }}</span>
    </footer>
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
import { pendingReviews, reviewOrder } from '@/api/cleaning-service'
import type { EntryRow } from '@/data/types'

const meta = moduleMeta('patrol')
const columns = ["巡检编号", "巡检路线", "巡检班组", "计划日期", "完成时间", "发现问题数", "巡检人员", "巡检状态"]
const actions = ["开始巡检", "确认完成", "上报问题"]
const statuses = ["待巡检", "巡检中", "已完成", "已上报"]
const stats = [{"label": "待巡检任务", "value": 0}, {"label": "巡检中任务", "value": 0}, {"label": "本月发现问题数", "value": 0}]

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
  errorMessage.value = '巡检任务登记入口尚未接入审批流'
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
    pendingRows.value = pendingReviews()
  } catch (error) {
    errorMessage.value = error instanceof Error ? error.message : '廊内巡检任务列表读取失败'
  }
}

const pendingRows = ref<EntryRow[]>([])
const notes = ref<Record<number, string>>({})
const reviewMessage = ref('')
const reviewError = ref(false)

function review(row: EntryRow, verdict: '一致入账' | '不符作废') {
  reviewError.value = false
  const result = reviewOrder(Number(row.id), verdict, notes.value[Number(row.id)] ?? '')
  reviewMessage.value = result.message
  reviewError.value = !result.ok
  if (result.ok) {
    delete notes.value[Number(row.id)]
    reload()
  }
}

onMounted(reload)
</script>

<style scoped>
.panel { background: #fff; border: 1px solid var(--border); border-radius: 8px; padding: 12px; margin: 12px 0; }
.panel-head { display: flex; justify-content: space-between; align-items: baseline; margin-bottom: 8px; }
.panel-head h3 { margin: 0; font-size: 15px; }
.panel-sub { color: var(--muted); font-size: 12px; }
.reason-cell { color: #92400e; font-size: 12px; max-width: 260px; }
.review-cell { display: flex; gap: 8px; align-items: center; flex-wrap: wrap; }
.note-input { padding: 4px 8px; border: 1px solid var(--border); border-radius: 6px; font-size: 12px; width: 150px; }
.link.ok { color: #166534; }
.link.bad { color: #991b1b; }
.hint { color: var(--muted); font-size: 12px; margin: 8px 0 0; }
</style>
