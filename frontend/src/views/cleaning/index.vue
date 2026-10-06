<template>
  <section class="page" data-module="cleaning">
    <header class="page-head">
      <div>
        <h2>保洁作业单台账</h2>
        <p class="page-desc">
          廊内保洁与垃圾清运整批进出：外部车单按清运日期导入，逐行核对保洁区域、班组与清运量；
          坏行另立缘由不进账，同车次覆盖不叠加，与当日巡检遗留问题核对，月底按区域归总另存。
        </p>
      </div>
      <div class="page-actions">
        <button class="btn" type="button" @click="getTemplate">下载导入模板</button>
        <button class="btn" type="button" @click="exportLedger">导出台账</button>
        <label class="btn primary file-btn">
          导入车单文件
          <input type="file" accept=".csv,text/csv" hidden @change="onFile" />
        </label>
      </div>
    </header>

    <div class="stat-row">
      <article class="stat-card">
        <span class="stat-label">已入账 / 已核定</span>
        <strong class="stat-value">{{ stats.booked }}</strong>
      </article>
      <article class="stat-card">
        <span class="stat-label">待核（监管员处理）</span>
        <strong class="stat-value" :class="{ warn: stats.pending > 0 }">{{ stats.pending }}</strong>
      </article>
      <article class="stat-card">
        <span class="stat-label">退行坏行（另立缘由）</span>
        <strong class="stat-value">{{ stats.rejected }}</strong>
      </article>
      <article class="stat-card">
        <span class="stat-label">存量回填</span>
        <strong class="stat-value small">{{ backfill.at ? '已回填' : '未回填' }}</strong>
      </article>
    </div>

    <p v-if="backfill.at" class="status-legend">
      <span class="legend-item">存量作业单已于 {{ backfill.at }} 按完工日期回填一次，既有记录按当时口径保留原判</span>
    </p>
    <p v-if="importReport" class="status-legend" :class="{ 'import-error': importReport.rolledBack }">
      <span class="legend-item">{{ importReport.message }}</span>
    </p>

    <!-- 月底按保洁区域归总：表格与另存文件取同一份数据 -->
    <div class="panel">
      <div class="panel-head">
        <h3>月底清运归总（按保洁区域）</h3>
        <div class="panel-tools">
          <select v-model="month" @change="reload">
            <option v-for="m in months" :key="m" :value="m">{{ m }}</option>
          </select>
          <button class="btn" type="button" @click="saveArchive">另存本月归总</button>
          <button class="btn" type="button" @click="exportMonth">下载本月归总文件</button>
        </div>
      </div>
      <table class="data-table">
        <thead>
          <tr><th>保洁区域</th><th>已入账单数</th><th>清运量合计(车)</th><th>已入账/已核定</th><th>待核单数(量不进合计)</th></tr>
        </thead>
        <tbody>
          <tr v-for="area in summary.areas" :key="area.area">
            <td>{{ area.area }}</td>
            <td>{{ area.bookedCount }}</td>
            <td>{{ area.totalQty }}</td>
            <td>{{ area.bookedCount }}</td>
            <td>{{ area.pendingCount }}<span v-if="area.pendingCount" class="pending-qty">（{{ area.pendingQty }}车待核）</span></td>
          </tr>
          <tr v-if="!summary.areas.length">
            <td colspan="5" class="empty-state">{{ month }} 暂无可归总的作业单</td>
          </tr>
          <tr v-else class="sum-row">
            <td>合计</td><td>{{ summary.totalOrders }}</td><td>{{ summary.totalQty }}</td><td>—</td><td>{{ summary.pendingCount }}</td>
          </tr>
        </tbody>
      </table>
      <p class="hint">另存与下载都来自上面这张表，下载文件内附同样口径的作业单明细，页面与文件是同一份。</p>
    </div>

    <div class="tabs">
      <button v-for="tab in tabs" :key="tab.key" class="tab" :class="{ active: activeTab === tab.key }" type="button" @click="activeTab = tab.key">
        {{ tab.label }}
        <span v-if="tab.key === 'reject' && rejects.length" class="badge">{{ rejects.length }}</span>
      </button>
    </div>

    <!-- 作业单台账 -->
    <form v-if="activeTab === 'ledger'" class="filter-bar" @submit.prevent="reload">
      <label class="filter-item">
        <span>保洁区域</span>
        <select v-model="filterArea">
          <option value="">全部区域</option>
          <option v-for="area in areas" :key="area" :value="area">{{ area }}</option>
        </select>
      </label>
      <label class="filter-item">
        <span>状态</span>
        <select v-model="filterStatus">
          <option value="">全部状态</option>
          <option v-for="s in statuses" :key="s" :value="s">{{ s }}</option>
        </select>
      </label>
      <button class="btn" type="submit">查询</button>
      <button class="btn ghost" type="button" @click="resetFilter">重置</button>
    </form>

    <table v-if="activeTab === 'ledger'" class="data-table">
      <thead>
        <tr>
          <th v-for="col in ledgerCols" :key="col">{{ col }}</th>
          <th>状态</th>
        </tr>
      </thead>
      <tbody>
        <tr v-for="row in filteredRows" :key="String(row.id)" :class="{ 'row-pending': String(row.status) === '待核' }">
          <td v-for="col in ledgerCols" :key="col">{{ row[col] ?? '—' }}</td>
          <td>
            <span :class="['status-tag', tagClass(row.status)]">{{ row.status }}</span>
          </td>
        </tr>
        <tr v-if="!filteredRows.length">
          <td :colspan="ledgerCols.length + 1" class="empty-state">暂无符合条件的保洁作业单</td>
        </tr>
      </tbody>
    </table>

    <!-- 坏行：格式不对/数量缺失的原始行另起一份，写清缘由，不进账 -->
    <table v-if="activeTab === 'reject'" class="data-table">
      <thead>
        <tr><th>批次</th><th>原始行号</th><th>原始内容</th><th>缘由 / 仲裁说明</th></tr>
      </thead>
      <tbody>
        <tr v-for="row in rejects" :key="String(row.id)">
          <td>{{ row['批次'] }}</td>
          <td>{{ row['原始行号'] }}</td>
          <td class="raw-cell">{{ row['原始内容'] }}</td>
          <td class="error-text">{{ row['缘由'] }}</td>
        </tr>
        <tr v-if="!rejects.length">
          <td colspan="4" class="empty-state">还没有被退行的坏行</td>
        </tr>
      </tbody>
    </table>

    <!-- 交接清单：与「运维值班交接」页读的是同一份 -->
    <div v-if="activeTab === 'handover'" class="panel-tools" style="margin-bottom:8px">
      <button class="btn" type="button" @click="exportHandover">下载交接清单文件</button>
    </div>
    <table v-if="activeTab === 'handover'" class="data-table">
      <thead>
        <tr><th>时间</th><th>类别</th><th>事项</th></tr>
      </thead>
      <tbody>
        <tr v-for="row in handover" :key="String(row.id)">
          <td>{{ row['时间'] }}</td><td>{{ row['类别'] }}</td><td>{{ row['事项'] }}</td>
        </tr>
      </tbody>
    </table>

    <div v-if="activeTab === 'rules'" class="panel rules">
      <h3>口径、覆盖、仲裁与并发规则</h3>
      <ul>
        <li><b>口径版本</b>：纸质版(2023年以前，一车一记、残缺补1车、不参与核对)／2024版(2024-2025，容差1车)／2026版(现行)。改版后的口径只对新导入记录生效，既有记录按当时口径保留原判。</li>
        <li><b>存量回填</b>：历史单据以完工日期为轴回填一次，取值残缺的按当年那版补齐；回填不改判。</li>
        <li><b>同车次覆盖</b>：车次编号是业务主键，重复导入不叠加，按车次整笔覆盖旧版。</li>
        <li><b>冲突仲裁</b>：权威等级「监管核定 ＞ 车单导入 ＞ 纸质补录」，同源再比导入批次时间、新者胜。依据：监管核定是线下核对后的终局结论，电子车单是当场原始凭据，纸质补录仅为回溯估计；故车单不能反向推翻已核定单据（该笔写入坏行表并注明）。</li>
        <li><b>巡检核对</b>：清运量与同区域当日巡检遗留问题数相差≤1车为一致；明显不一致或当日无巡检可比，挂待核，由监管员在「廊内巡检任务」页处理。待核与作废单据不进月底归总。</li>
        <li><b>并发</b>：同一时刻两笔提交只让先到的入账，后到的整笔回退、零写入。</li>
        <li><b>单一数据源</b>：台账、交接清单、月底另存同库同事务更新；保洁页与值班交接页看到的交接清单是同一份。</li>
        <li><b>文件进出</b>：上传只有「导入车单文件」一个口子，下载分模板、台账、月底归总、交接清单；进出都走文件。</li>
      </ul>
    </div>

    <footer class="page-foot">
      <span>共 {{ filteredRows.length }} 条作业单 · 数据保存在本机浏览器</span>
      <span v-if="errorMessage" class="error-text">{{ errorMessage }}</span>
    </footer>
  </section>
</template>

<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'

import {
  archiveMonth,
  backfillOnce,
  cleaningAreas,
  cleaningMonths,
  cleaningStats,
  downloadHandover,
  importTemplate,
  importVehicleSheet,
  listCleaning,
  listHandover,
  listRejects,
  monthSummary,
  downloadLedger,
  downloadMonthReport,
} from '@/api/cleaning-service'
import type { EntryRow } from '@/data/types'

const ledgerCols = ['作业单号', '车次编号', '清运日期', '完工日期', '保洁区域', '保洁班组', '清运量', '数据来源', '口径版本', '导入批次', '核对说明']
const statuses = ['已入账', '待核', '已核定', '已作废']
const tabs = [
  { key: 'ledger', label: '作业单台账' },
  { key: 'reject', label: '退行坏行' },
  { key: 'handover', label: '交接清单' },
  { key: 'rules', label: '口径与仲裁' },
] as const

const rows = ref<EntryRow[]>([])
const rejects = ref<EntryRow[]>([])
const handover = ref<EntryRow[]>([])
const areas = ref<string[]>([])
const months = ref<string[]>([])
const month = ref('2026-10')
const filterArea = ref('')
const filterStatus = ref('')
const activeTab = ref('ledger')
const errorMessage = ref('')
const importReport = ref<{ message: string; rolledBack?: boolean } | null>(null)
const backfill = ref<{ ran: boolean; at: string | null }>({ ran: false, at: null })

const stats = computed(() => cleaningStats())
const summary = computed(() => monthSummary(month.value))

const filteredRows = computed(() =>
  rows.value
    .filter((r) => (filterArea.value ? String(r['保洁区域']) === filterArea.value : true))
    .filter((r) => (filterStatus.value ? String(r.status) === filterStatus.value : true)),
)

function tagClass(status: string): string {
  if (status === '待核') return 'tag-pending'
  if (status === '已作废') return 'tag-void'
  if (status === '已核定') return 'tag-confirmed'
  return 'tag-booked'
}

function resetFilter() {
  filterArea.value = ''
  filterStatus.value = ''
}

function reload() {
  rows.value = listCleaning()
  rejects.value = listRejects()
  handover.value = listHandover()
  areas.value = cleaningAreas()
  months.value = cleaningMonths()
  if (!months.value.includes(month.value) && months.value[0]) month.value = months.value[0]
  backfill.value = backfillOnce()
}

function getTemplate() {
  importTemplate()
}

function exportLedger() {
  downloadLedger()
}

function exportMonth() {
  downloadMonthReport(month.value)
}

function exportHandover() {
  downloadHandover()
}

function saveArchive() {
  errorMessage.value = ''
  const result = archiveMonth(month.value)
  importReport.value = { message: result.message, rolledBack: !result.ok }
  if (!result.ok) errorMessage.value = result.message
  reload()
}

async function onFile(event: Event) {
  const input = event.target as HTMLInputElement
  const file = input.files?.[0]
  if (!file) return
  errorMessage.value = ''
  try {
    const text = await file.text()
    const result = importVehicleSheet(text)
    importReport.value = {
      message: 'rolledBack' in result ? result.message : result.message,
      rolledBack: 'rolledBack' in result,
    }
    reload()
  } catch (e) {
    errorMessage.value = e instanceof Error ? e.message : '车单文件读取失败'
  } finally {
    input.value = ''
  }
}

// 交接清单页也提供同一个文件出口。
onMounted(reload)
</script>

<style scoped>
.warn { color: #b54708; }
.small { font-size: 15px; }
.panel { background: #fff; border: 1px solid var(--border); border-radius: 8px; padding: 12px; margin-bottom: 14px; }
.panel-head { display: flex; justify-content: space-between; align-items: center; margin-bottom: 8px; }
.panel-head h3 { margin: 0; font-size: 15px; }
.panel-tools { display: flex; gap: 8px; align-items: center; }
.sum-row td { font-weight: 600; background: #f1f5f9; }
.pending-qty { color: #b54708; font-size: 12px; margin-left: 2px; }
.hint { color: var(--muted); font-size: 12px; margin: 8px 0 0; }
.tabs { display: flex; gap: 6px; margin: 6px 0 10px; }
.tab { border: 1px solid var(--border); background: #fff; border-radius: 6px 6px 0 0; padding: 6px 14px; cursor: pointer; font-size: 13px; }
.tab.active { background: var(--brand); color: #fff; border-color: var(--brand); }
.badge { background: #b54708; color: #fff; border-radius: 999px; padding: 0 7px; margin-left: 4px; font-size: 11px; }
.raw-cell { font-family: ui-monospace, Menlo, monospace; font-size: 12px; color: var(--muted); }
.row-pending { background: #fff7ed; }
.status-tag { border-radius: 999px; padding: 2px 10px; font-size: 12px; }
.tag-booked { background: #dcfce7; color: #166534; }
.tag-confirmed { background: #dbeafe; color: #1e40af; }
.tag-pending { background: #fef3c7; color: #92400e; }
.tag-void { background: #fee2e2; color: #991b1b; }
.import-error .legend-item { background: #fee2e2; color: #991b1b; }
.file-btn { display: inline-flex; align-items: center; cursor: pointer; }
.rules ul { margin: 8px 0 0; padding-left: 18px; line-height: 1.9; font-size: 13px; }
</style>
