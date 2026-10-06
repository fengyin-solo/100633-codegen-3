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

    <section class="hold-panel">
      <header class="hold-head">
        <h3>保洁对账待核（监管员处理）</h3>
        <p class="page-desc">
          保洁作业单导入时，清运量与当天本区域巡检上报的遗留问题数明显不一致、或当天无巡检上报可对的，先挂待核，在这里核定。
          数据与「保洁作业单台账」是同一份：核定后作业单即入账并冻结，同车次再导入不翻案；结论同步写入值班交接清单。
        </p>
      </header>

      <p v-if="holdMessage" class="result-note" :class="{ 'error-text': !holdOk }">{{ holdMessage }}</p>

      <table class="data-table">
        <thead>
          <tr>
            <th v-for="column in holdColumns" :key="column">{{ column }}</th>
            <th>对账结论</th>
            <th>核定</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="row in holds" :key="String(row.id)">
            <td v-for="column in holdColumns" :key="column">{{ row[column] ?? '—' }}</td>
            <td class="verdict-cell">{{ row['对账结论'] }}</td>
            <td class="hold-actions">
              <button class="btn small" type="button" @click="openResolve(row)">核定入账</button>
            </td>
          </tr>
          <tr v-if="!holds.length">
            <td :colspan="holdColumns.length + 2" class="empty-state">暂无保洁对账待核单</td>
          </tr>
        </tbody>
      </table>

      <form v-if="resolving" class="resolve-form" @submit.prevent="submitResolve">
        <strong>核定作业单 {{ resolving['作业单号'] }}（车次 {{ resolving['车次编号'] }}，清运 {{ resolving['清运量(车)'] }} 车）</strong>
        <label class="filter-item">
          <span>核定结论（监管员意见）</span>
          <textarea v-model="resolveText" rows="2" placeholder="如：经核实清运 3 车属实，巡检遗留项为重复上报，按车单入账"></textarea>
        </label>
        <div>
          <button class="btn primary" type="submit">确认核定并冻结</button>
          <button class="btn ghost" type="button" @click="resolving = null">取消</button>
        </div>
      </form>
    </section>
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
import { ensureBackfill, listHolds, resolveHold } from '@/api/cleaning-service'
import type { CleaningOrder } from '@/data/cleaning'
import type { EntryRow } from '@/data/types'
import { useSessionStore } from '@/stores/session'

const session = useSessionStore()

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

// 保洁对账待核：取的就是保洁台账里 status=待核 的行，不另存一份。
const holdColumns = ['作业单号', '车次编号', '清运日期', '保洁区域', '保洁班组', '清运量(车)', '口径版本']
const holds = ref<CleaningOrder[]>([])
const resolving = ref<CleaningOrder | null>(null)
const resolveText = ref('')
const holdMessage = ref('')
const holdOk = ref(true)

const statusSummary = computed(() =>
  statuses.map((status: string) => ({
    status,
    count: rows.value.filter((row) => String(row.status) === status).length,
  })),
)

function reloadHolds() {
  holds.value = listHolds()
}

function openResolve(row: CleaningOrder) {
  resolving.value = row
  resolveText.value = ''
  holdMessage.value = ''
}

function submitResolve() {
  if (!resolving.value) return
  const conclusion = resolveText.value.trim()
  if (!conclusion) {
    holdMessage.value = '请填写核定结论'
    holdOk.value = false
    return
  }
  const result = resolveHold(Number(resolving.value.id), session.operator, conclusion)
  holdMessage.value = result.message
  holdOk.value = result.ok
  if (result.ok) {
    resolving.value = null
    reloadHolds()
  }
}

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
  // 巡检状态变了，对账结论依据的数据也可能变：待核面板跟着刷新（同一台账，不重算已冻结单）。
  reloadHolds()
}

function reload() {
  errorMessage.value = ''
  try {
    const payload = listEntries(meta.key, filters.value)
    rows.value = payload.items
    total.value = payload.total
  } catch (error) {
    errorMessage.value = error instanceof Error ? error.message : '廊内巡检任务列表读取失败'
  }
}

onMounted(() => {
  ensureBackfill(session.operator)
  reload()
  reloadHolds()
})
</script>
