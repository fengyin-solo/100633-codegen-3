<template>
  <section class="page" data-module="cleaning">
    <header class="page-head">
      <div>
        <h2>保洁作业单台账</h2>
        <p class="page-desc">
          外部车单文件按清运日期整批导入，逐行核对保洁区域、保洁班组与清运量；格式不对或数量缺失的行另起记缘由。
          同一车次重复导入按车次编号覆盖旧版、不叠加；清运量与当天巡检遗留问题数对账，明显不一致的挂待核，
          由监管员在「廊内巡检任务」侧处理。月底按保洁区域归总另存，页面与下载取同一份快照。
        </p>
      </div>
      <div class="page-actions">
        <button class="btn primary" type="button" :disabled="busy" @click="pickFile">
          {{ busy ? '正在入账…' : '导入车单文件' }}
        </button>
        <input ref="fileInput" class="hidden-file" type="file" accept=".csv,text/csv" @change="onFileChange" />
      </div>
    </header>

    <p class="page-desc" style="margin: 0 0 10px">
      上传口：车单 CSV，表头须为「车次编号,清运日期,保洁区域,保洁班组,清运量(车)」；
      保洁区域限 {{ areaList }}，保洁班组限 {{ teamList }}。下载口：月底归总另存后下载月度归总 CSV。
    </p>

    <div class="stat-row">
      <article v-for="item in stats" :key="item.label" class="stat-card">
        <span class="stat-label">{{ item.label }}</span>
        <strong class="stat-value">{{ item.value }}</strong>
      </article>
    </div>

    <nav class="tab-bar">
      <button
        v-for="tab in tabs"
        :key="tab.key"
        class="tab-item"
        :class="{ active: activeTab === tab.key }"
        type="button"
        @click="switchTab(tab.key)"
      >
        {{ tab.label }}
        <em v-if="tabBadge(tab.key)" class="tab-badge">{{ tabBadge(tab.key) }}</em>
      </button>
    </nav>

    <p v-if="notice" class="result-note" :class="{ 'error-text': !noticeOk }">{{ notice }}</p>

    <!-- 作业单台账 -->
    <div v-if="activeTab === 'orders'">
      <form class="filter-bar" @submit.prevent="reloadOrders">
        <label class="filter-item">
          <span>清运月份</span>
          <input v-model="monthFilter" placeholder="如 2026-05" />
        </label>
        <label v-for="field in filterFields" :key="field" class="filter-item">
          <span>{{ field }}</span>
          <input v-model="filters[field]" :placeholder="`按${field}检索`" />
        </label>
        <label class="filter-item">
          <span>状态</span>
          <select v-model="statusFilter">
            <option value="">全部</option>
            <option>已入账</option>
            <option>待核</option>
          </select>
        </label>
        <button class="btn" type="submit">查询</button>
        <button class="btn ghost" type="button" @click="resetFilters">重置条件</button>
      </form>

      <table class="data-table">
        <thead>
          <tr>
            <th v-for="column in columns" :key="column">{{ column }}</th>
            <th>当前状态</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="row in filteredOrders" :key="String(row.id)" :class="{ 'row-pending': row.status === '待核' }">
            <td v-for="column in columns" :key="column" :title="column === '对账结论' ? String(row[column]) : ''">
              {{ row[column] ?? '—' }}
            </td>
            <td>
              {{ row.status }}
              <span v-if="row['核定冻结'] === '是'" class="freeze-tag">已核定冻结</span>
            </td>
          </tr>
          <tr v-if="!filteredOrders.length">
            <td :colspan="columns.length + 1" class="empty-state">暂无符合条件的保洁作业单</td>
          </tr>
        </tbody>
      </table>
      <footer class="page-foot"><span>共 {{ filteredOrders.length }} 条；待核单请到「廊内巡检任务」页面由监管员核定</span></footer>
    </div>

    <!-- 废行簿 -->
    <div v-if="activeTab === 'rejects'">
      <table class="data-table">
        <thead>
          <tr>
            <th v-for="column in rejectColumns" :key="column">{{ column }}</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="row in rejects" :key="String(row.id)">
            <td v-for="column in rejectColumns" :key="column" :title="column === '缘由' || column === '原始内容' ? String(row[column]) : ''">
              {{ row[column] ?? '—' }}
            </td>
          </tr>
          <tr v-if="!rejects.length">
            <td :colspan="rejectColumns.length" class="empty-state">暂无废行：导入时格式不对或数量缺失的行会另记在这里</td>
          </tr>
        </tbody>
      </table>
    </div>

    <!-- 月底归总另存 -->
    <div v-if="activeTab === 'summary'">
      <form class="filter-bar" @submit.prevent="saveSummary">
        <label class="filter-item">
          <span>归总月份</span>
          <input v-model="summaryMonth" placeholder="YYYY-MM" />
        </label>
        <button class="btn primary" type="submit">按区域归总并另存</button>
        <button class="btn" type="button" @click="downloadSnapshot">下载另存文件</button>
      </form>
      <p class="page-desc" style="margin: 0 0 8px">
        归总范围：所选月份按清运日期落在该月、且非废行的全部作业单（已入账与待核分开列）。
        另存后页面列出的明细与下载的 CSV 取自同一份快照；之后台账再有同月变动不会偷偷改旧快照，需重新另存。
      </p>

      <table v-if="snapshot.length" class="data-table">
        <thead>
          <tr>
            <th v-for="column in summaryColumns" :key="column">{{ column }}</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="row in snapshot" :key="String(row.id)" :class="{ 'row-total': row['保洁区域'] === '合计' }">
            <td v-for="column in summaryColumns" :key="column">{{ row[column] ?? '—' }}</td>
          </tr>
        </tbody>
      </table>
      <p v-else class="empty-state">该月份尚未归总另存</p>

      <p class="status-legend" style="margin-top: 10px">
        <span class="legend-item">已另存月份：</span>
        <button v-for="month in savedMonths" :key="month" class="link" type="button" @click="loadSnapshot(month)">
          {{ month }}
        </button>
        <span v-if="!savedMonths.length" class="page-desc">暂无</span>
      </p>
    </div>

    <!-- 交接清单 + 口径/仲裁 -->
    <div v-if="activeTab === 'handover'">
      <h3 style="font-size: 14px">其它入口交接清单（与「运维值班交接」页面同源）</h3>
      <table class="data-table">
        <thead>
          <tr>
            <th v-for="column in handoverColumns" :key="column">{{ column }}</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="row in handovers" :key="String(row.id)">
            <td v-for="column in handoverColumns" :key="column" :title="column === '内容' ? String(row[column]) : ''">
              {{ row[column] ?? '—' }}
            </td>
          </tr>
          <tr v-if="!handovers.length">
            <td :colspan="handoverColumns.length" class="empty-state">暂无交接结论</td>
          </tr>
        </tbody>
      </table>

      <h3 style="font-size: 14px; margin-top: 18px">口径版本（改版口径只对新记录生效，既有记录按当时口径保留原判）</h3>
      <table class="data-table">
        <thead>
          <tr><th>口径版本</th><th>适用期间</th><th>对账阈值</th><th>取值残缺补齐与判定</th></tr>
        </thead>
        <tbody>
          <tr v-for="item in caliberRows" :key="item.version">
            <td>{{ item.version }}</td>
            <td>{{ item.desc.period }}</td>
            <td>{{ item.desc.tolerance }}</td>
            <td>{{ item.desc.rule }}</td>
          </tr>
        </tbody>
      </table>

      <h3 style="font-size: 14px; margin-top: 18px">冲突仲裁规则</h3>
      <ol class="rule-list">
        <li v-for="rule in arbitrationRules" :key="rule">{{ rule }}</li>
      </ol>
      <p class="page-desc">
        依据：车单是清运现场带车次编号的原始凭证，优先级高于群消息与手工补录；监管员现场核定的证据力高于阈值自动判定；
        并发互斥保证同一批车单不会被拆成两笔；归总快照冻结保证月底报表可复核。
      </p>
    </div>
  </section>
</template>

<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'

import {
  downloadMonthSummary,
  ensureBackfill,
  importManifestFile,
  listHandover,
  listOrders,
  listRejects,
  listSummaries,
  saveMonthSummary,
  snapshotStale,
} from '@/api/cleaning-service'
import { ARBITRATION_RULES, CALIBER_DESC, CLEANING_AREAS, CLEANING_TEAMS } from '@/data/cleaning'
import type { CleaningOrder, HandoverRow, RejectRow, SummaryRow } from '@/data/cleaning'
import { useSessionStore } from '@/stores/session'

const session = useSessionStore()

const columns = ['作业单号', '车次编号', '清运日期', '完工日期', '保洁区域', '保洁班组', '清运量(车)', '来源', '口径版本', '对账结论']
const rejectColumns = ['文件名', '行号', '原始内容', '缘由', '批次号', '导入时间']
const summaryColumns = ['月份', '保洁区域', '作业单数', '已入账单数', '待核单数', '清运量合计(车)', '待核清运量(车)', '保存时间']
const handoverColumns = ['时间', '类型', '内容', '批次号', '月份', '操作人']
const filterFields = ['保洁区域', '保洁班组', '车次编号', '作业单号']

const tabs = [
  { key: 'orders', label: '作业单台账' },
  { key: 'rejects', label: '废行簿' },
  { key: 'summary', label: '月底归总另存' },
  { key: 'handover', label: '交接清单 / 口径' },
] as const
type TabKey = (typeof tabs)[number]['key']

const activeTab = ref<TabKey>('orders')
const orders = ref<CleaningOrder[]>([])
const rejects = ref<RejectRow[]>([])
const handovers = ref<HandoverRow[]>([])
const summaries = ref<SummaryRow[]>([])
const snapshot = ref<SummaryRow[]>([])
const filters = ref<Record<string, string>>({})
const statusFilter = ref('')
const monthFilter = ref('')
const summaryMonth = ref('')
const notice = ref('')
const noticeOk = ref(true)
const busy = ref(false)
const fileInput = ref<HTMLInputElement | null>(null)

const stats = computed(() => {
  const all = orders.value
  const now = new Date()
  const month = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`
  const monthRows = all.filter((row) => String(row['清运日期'] ?? '').slice(0, 7) === month)
  const monthQty = monthRows
    .filter((row) => row.status !== '待核')
    .reduce((sum, row) => sum + (Number(row['清运量(车)']) || 0), 0)
  return [
    { label: '已入账作业单', value: all.filter((row) => row.status !== '待核').length },
    { label: '待核作业单', value: all.filter((row) => row.status === '待核').length },
    { label: '本月已入账清运(车)', value: monthQty },
    { label: '废行累计', value: rejects.value.length },
  ]
})

const filteredOrders = computed(() => {
  return orders.value.filter((row) => {
    if (statusFilter.value && String(row.status) !== statusFilter.value) return false
    if (monthFilter.value && String(row['清运日期'] ?? '').slice(0, 7) !== monthFilter.value.trim()) return false
    return Object.entries(filters.value).every(([field, value]) =>
      value.trim() === '' ? true : String(row[field] ?? '').includes(value.trim()),
    )
  })
})

const savedMonths = computed(() => {
  const months = new Set(summaries.value.map((row) => String(row['月份'] ?? '')))
  return [...months].sort().reverse()
})

const caliberRows = Object.entries(CALIBER_DESC).map(([version, desc]) => ({ version, desc }))
const arbitrationRules = ARBITRATION_RULES
const areaList = CLEANING_AREAS.join('、')
const teamList = CLEANING_TEAMS.join('、')

function tabBadge(key: TabKey): number {
  if (key === 'orders') return orders.value.filter((row) => row.status === '待核').length
  if (key === 'rejects') return rejects.value.length
  return 0
}

function flash(message: string, ok = true) {
  notice.value = message
  noticeOk.value = ok
}

function reloadAll() {
  orders.value = listOrders()
  rejects.value = listRejects()
  handovers.value = listHandover()
  summaries.value = listSummaries()
  if (summaryMonth.value) loadSnapshot(summaryMonth.value)
}

// 台账始终持有全量；查询条件只在 filteredOrders 里收敛，统计卡不受筛选影响。
function reloadOrders() {
  orders.value = listOrders()
}

function resetFilters() {
  filters.value = {}
  statusFilter.value = ''
  monthFilter.value = ''
  reloadOrders()
}

function switchTab(key: TabKey) {
  activeTab.value = key
  notice.value = ''
  reloadAll()
}

function pickFile() {
  fileInput.value?.click()
}

async function onFileChange(event: Event) {
  const input = event.target as HTMLInputElement
  const file = input.files?.[0]
  input.value = ''
  if (!file) return
  busy.value = true
  try {
    // 读取与入账在服务层互斥锁内完成；同一时刻后到的一笔整笔回退。
    const result = await importManifestFile(file, session.operator)
    reloadAll()
    flash(result.message, result.ok)
  } catch (error) {
    flash(error instanceof Error ? error.message : '车单文件导入失败', false)
  } finally {
    busy.value = false
  }
}

function saveSummary() {
  const month = summaryMonth.value.trim()
  const result = saveMonthSummary(month, session.operator)
  flash(result.message, result.ok)
  if (result.ok) {
    summaries.value = listSummaries()
    loadSnapshot(month)
    handovers.value = listHandover()
  }
}

function loadSnapshot(month: string) {
  summaryMonth.value = month
  snapshot.value = summaries.value.filter((row) => String(row['月份']) === month)
  if (snapshotStale(month)) {
    flash(`${month} 另存后台账又有同月变动，当前展示与下载仍是旧快照；如需最新口径请重新归总另存。`, true)
  } else {
    notice.value = ''
  }
}

function downloadSnapshot() {
  if (!summaryMonth.value.trim()) {
    flash('请先填写或点选要下载的归总月份', false)
    return
  }
  const result = downloadMonthSummary(summaryMonth.value.trim())
  flash(result.message, result.ok)
}

onMounted(() => {
  const backfill = ensureBackfill(session.operator)
  reloadAll()
  summaryMonth.value = (() => {
    const now = new Date()
    return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`
  })()
  if (backfill.ran) {
    flash(`存量保洁作业单已按完工日期为轴回填 ${backfill.filled} 笔，口径与原判已冻结，详见「交接清单 / 口径」页签。`, true)
    reloadAll()
  }
})
</script>
