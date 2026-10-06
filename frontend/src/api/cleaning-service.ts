/**
 * 保洁作业单台账 —— 本地服务（localStorage）。
 *
 * 与其它模块一样：页面不做业务判断，所有写入都在这里。台账与交接清单、
 * 月底另存取同一份存储：一次事务里一并落库，杜绝两边对不上。
 */
import {
  arbitrate,
  buildPatrolIndex,
  businessDate,
  checkImportRow,
  CURRENT_POLICY,
  IMPORT_HEADERS,
  monthOf,
  parseCsv,
  reconcileQty,
  summarizeMonth,
  toCsv,
  type ImportCell,
} from '@/data/cleaning'
import { CLEANING_BACKFILL_FLAG, listRows, saveRows } from '@/data/local-store'
import type { EntryRow } from '@/data/types'

const CLEANING_KEY = 'cleaning'
const REJECT_KEY = 'cleaningReject'
const HANDOVER_KEY = 'cleaningHandover'
const ARCHIVE_KEY = 'cleaningArchive'

// 已知保洁区域，供巡检路线匹配与校验提示使用。
const KNOWN_AREAS = ['东区舱', '西区舱', '南区舱', '北区舱', '中控舱']

/** 模块内一次性互斥锁：同刻两笔提交只放进第一笔。 */
const commitLock = { acquired: false }

/* ------------------------------------------------------------------ */

function nextId(rows: EntryRow[]): number {
  return rows.reduce((max, row) => Math.max(max, Number(row.id) || 0), 0) + 1
}

// 导入批次时间戳精确到毫秒，再加进程内单调序号：同秒并发的两笔也能分出先后批次。
let batchSeq = 0
function nowStamp(): string {
  batchSeq += 1
  return `${plainTime()}.${String(new Date().getMilliseconds()).padStart(3, '0')}#${batchSeq}`
}

// 交接清单等展示用时间：精确到秒。
function plainTime(): string {
  const d = new Date()
  const p = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`
}

/* ------------------------------------------------------------------ *
 * 交接清单：台账页与「运维值班交接」共用这一份存储，结论只有一个来源。
 * ------------------------------------------------------------------ */

export function listHandover(): EntryRow[] {
  return listRows(HANDOVER_KEY)
}

function appendHandover(kind: string, content: string): EntryRow[] {
  const rows = listHandover()
  const row: EntryRow = {
    id: nextId(rows),
    status: '已交接',
    pending: false,
    abnormal: false,
    时间: plainTime(),
    类别: kind,
    事项: content,
  }
  const next = [...rows, row]
  saveRows(HANDOVER_KEY, next)
  return next
}

/* ------------------------------------------------------------------ *
 * 存量回填（只做一次，幂等）
 * 以完工日期为轴选当年口径；取值残缺按当年那版补齐；既有记录保留原判。
 * ------------------------------------------------------------------ */

export function backfillOnce(): { ran: boolean; at: string | null } {
  // 回填本体在存储层首次装载时执行（读到即已回填）。这里只回报是否已回填及时间。
  const raw = typeof window !== 'undefined' ? window.localStorage?.getItem(CLEANING_BACKFILL_FLAG) : null
  return { ran: Boolean(raw), at: raw ? raw.replace('T', ' ').slice(0, 19) : null }
}

/* ------------------------------------------------------------------ *
 * 文件导入（唯一入口）
 * 同一车次重复导入按车次编号覆盖；坏行另起一行写清缘由、不进账；
 * 同一时刻并发提交只让先到的整笔入账。
 * ------------------------------------------------------------------ */

export type ImportReport = {
  accepted: number
  overwritten: number
  rejected: number
  rejectedRows: { line: number; raw: string; reason: string }[]
  message: string
  batch: string
}

export function importVehicleSheet(text: string): ImportReport | { rolledBack: true; message: string } {
  // 先占锁：同一时刻第二笔直接整笔回退。
  if (!atomicCommitGuard()) {
    return { rolledBack: true, message: '同一时刻已有一笔车单在导入，本笔整笔回退，未写入任何记录' }
  }
  try {
    const batch = nowStamp()
    const grid = parseCsv(text)
    const body = grid.filter((cells) => cells.some((c) => c.trim() !== ''))
    // 首行表头校验：文件口子只认约定列。
    const header = body[0]?.map((c) => c.trim()) ?? []
    const hasHeader = IMPORT_HEADERS.every((h, i) => header[i] === h)
    const dataRows = hasHeader ? body.slice(1) : body

    const valid: { cell: ImportCell; line: number }[] = []
    const rejectedRows: ImportReport['rejectedRows'] = []

    dataRows.forEach((cells, idx) => {
      const line = hasHeader ? idx + 2 : idx + 1
      const check = checkImportRow(cells)
      if (check.ok) {
        valid.push({ cell: check.data, line })
      } else {
        // 格式不对或数量缺失的那一行：另起一行写清缘由，其余照常入账。
        rejectedRows.push({ line, raw: cells.join(','), reason: check.reasons.join('；') })
      }
    })

    const orders = listRows(CLEANING_KEY)
    const rejects = listRows(REJECT_KEY)
    const areas = collectAreas(orders)
    const patrolIndex = buildPatrolIndex(listRows('patrol'), areas)

    // 车单按清运日期排序导入入账。
    valid.sort((a, b) => a.cell.清运日期.localeCompare(b.cell.清运日期))

    let accepted = 0
    let overwritten = 0
    let rejectId = nextId(rejects)
    const rejectNext = [...rejects]
    const orderNext = [...orders]

    for (const item of valid) {
      const { cell } = item
      const outcome = reconcileQty(
        cell.保洁区域,
        cell.清运日期,
        cell.清运量,
        CURRENT_POLICY,
        patrolIndex,
      )
      const incoming: EntryRow = {
        id: 0,
        status: outcome.status,
        pending: outcome.status === '待核',
        abnormal: false,
        作业单号: '',
        车次编号: cell.车次编号,
        清运日期: cell.清运日期,
        完工日期: cell.清运日期,
        作业日期: cell.清运日期,
        保洁区域: cell.保洁区域,
        保洁班组: cell.保洁班组,
        清运量: cell.清运量,
        数据来源: '车单导入',
        口径版本: CURRENT_POLICY.label,
        导入批次: batch,
        核对说明: outcome.reason,
        巡检遗留问题数: outcome.issues ?? '',
      }

      const dupIndex = orderNext.findIndex(
        (row) => String(row['车次编号']) === cell.车次编号 && String(row.status) !== '已作废',
      )
      if (dupIndex >= 0) {
        // 同车次：冲突仲裁后覆盖，绝不叠加。
        const verdict = arbitrate(orderNext[dupIndex], incoming)
        if (verdict.winner === 'existing') {
          orderNext[dupIndex] = {
            ...orderNext[dupIndex],
            仲裁说明: verdict.reason,
          }
          // 仲裁拦退与坏行一样“另起一行写清缘由、不进账”，统一在下方落库。
          rejectedRows.push({ line: item.line, raw: `${cell.车次编号},${cell.清运日期},${cell.保洁区域},${cell.保洁班组},${cell.清运量}`, reason: verdict.reason })
          continue
        }
        incoming.id = orderNext[dupIndex].id
        incoming['作业单号'] = String(orderNext[dupIndex]['作业单号'] ?? '')
        incoming['仲裁说明'] = verdict.reason
        orderNext[dupIndex] = incoming
        overwritten += 1
      } else {
        incoming.id = nextId(orderNext)
        incoming['作业单号'] = `CLEA-${String(incoming.id).padStart(4, '0')}`
        orderNext.push(incoming)
        accepted += 1
      }
    }

    for (const r of rejectedRows) {
      const trip = r.raw.split(',')[0] || ''
      rejectNext.push({
        id: rejectId++,
        status: '未入账',
        pending: false,
        abnormal: true,
        批次: batch,
        原始行号: r.line,
        车次编号: trip,
        原始内容: r.raw,
        缘由: r.reason,
      })
    }

    // 台账与拒收台账同一事务落库。
    saveRows(CLEANING_KEY, orderNext)
    saveRows(REJECT_KEY, rejectNext)

    appendHandover(
      '车单导入',
      `批次 ${batch}：入账${accepted}单，按车次覆盖旧版${overwritten}单，退行/拦退${rejectedRows.length}行（不进账）。`,
    )

    return {
      accepted,
      overwritten,
      rejected: rejectedRows.length,
      rejectedRows,
      batch,
      message: `本批按清运日期入账：新增${accepted}单、覆盖${overwritten}单、退行/拦退${rejectedRows.length}行`,
    }
  } finally {
    commitLock.acquired = false
  }
}

function atomicCommitGuard(): boolean {
  if (commitLock.acquired) return false
  commitLock.acquired = true
  return true
}

function collectAreas(orders: EntryRow[]): string[] {
  const set = new Set<string>(KNOWN_AREAS)
  for (const row of orders) {
    const area = String(row['保洁区域'] ?? '').trim()
    if (area) set.add(area)
  }
  return [...set]
}

/* ------------------------------------------------------------------ *
 * 待核核定（监管员在巡检那边处理）
 * 核定时台账状态、核对说明与交接清单一次性更新，两边同一份。
 * ------------------------------------------------------------------ */

export function reviewOrder(id: number, verdict: '一致入账' | '不符作废', note: string): { ok: boolean; message: string } {
  if (!atomicCommitGuard()) {
    return { ok: false, message: '同一时刻已有一笔提交在处理，本笔整笔回退' }
  }
  try {
    const orders = listRows(CLEANING_KEY)
    const index = orders.findIndex((row) => Number(row.id) === id)
    if (index < 0) return { ok: false, message: '没有找到这张保洁作业单' }
    const row = orders[index]
    if (String(row.status) !== '待核') {
      return { ok: false, message: `单据当前为「${row.status}」，无需核定` }
    }
    const confirmed = verdict === '一致入账'
    const updated: EntryRow = {
      ...row,
      status: confirmed ? '已核定' : '已作废',
      pending: false,
      abnormal: !confirmed,
      数据来源: '监管核定',
      核定结论: confirmed ? '核定一致，准予入账' : '核定不符，作废退出归总',
      核定意见: note,
      核定时间: plainTime(),
    }
    const next = [...orders]
    next[index] = updated
    saveRows(CLEANING_KEY, next)
    appendHandover(
      '待核核定',
      `${row['作业单号']}（车次${row['车次编号']}）经监管员核定为「${updated['核定结论']}」。意见：${note || '无'}`,
    )
    return { ok: true, message: `已${updated['核定结论']}，结论同步写入交接清单` }
  } finally {
    commitLock.acquired = false
  }
}

/* ------------------------------------------------------------------ *
 * 查询
 * ------------------------------------------------------------------ */

export function listCleaning(filters: { area?: string; month?: string; status?: string } = {}): EntryRow[] {
  return listRows(CLEANING_KEY)
    .filter((row) => (!filters.area ? true : String(row['保洁区域']) === filters.area))
    .filter((row) => (!filters.month ? true : monthOf(businessDate(row)) === filters.month))
    .filter((row) => (!filters.status ? true : String(row.status) === filters.status))
    .sort((a, b) => businessDate(b).localeCompare(businessDate(a)))
}

export function listRejects(): EntryRow[] {
  return listRows(REJECT_KEY).slice().sort((a, b) => Number(b.id) - Number(a.id))
}

export function pendingReviews(): EntryRow[] {
  return listRows(CLEANING_KEY)
    .filter((row) => String(row.status) === '待核')
    .sort((a, b) => businessDate(a).localeCompare(businessDate(b)))
}

export function cleaningAreas(): string[] {
  return collectAreas(listRows(CLEANING_KEY))
}

export function cleaningMonths(): string[] {
  const set = new Set(listRows(CLEANING_KEY).map((row) => monthOf(businessDate(row))))
  return [...set].filter(Boolean).sort().reverse()
}

/* ------------------------------------------------------------------ *
 * 月底归总另存：页面上的汇总表与下载出去的文件，来自同一个 summarizeMonth。
 * ------------------------------------------------------------------ */

export function archiveMonth(month: string): { ok: boolean; message: string } {
  if (!atomicCommitGuard()) {
    return { ok: false, message: '同一时刻已有一笔提交在处理，本笔整笔回退' }
  }
  try {
    const orders = listRows(CLEANING_KEY)
    // 归总自己剔除已作废、把待核单列；这里交全部单据，保证页面待核列有数。
    const summary = summarizeMonth(orders, month, plainTime())
    const archives = listRows(ARCHIVE_KEY)
    const stamp = summary.generatedAt
    const archiveRow: EntryRow = {
      id: nextId(archives),
      status: '已另存',
      pending: false,
      abnormal: false,
      月份: month,
      另存时间: stamp,
      区域数: summary.areas.length,
      作业单数: summary.totalOrders,
      清运总量: summary.totalQty,
      待核数: summary.pendingCount,
    }
    const index = archives.findIndex((row) => String(row['月份']) === month)
    const next = [...archives]
    if (index >= 0) next[index] = { ...archiveRow, id: archives[index].id }
    else next.push(archiveRow)
    saveRows(ARCHIVE_KEY, next)
    appendHandover(
      '月底另存',
      `${month}保洁清运归总已另存：${summary.areas.length}个区域、${summary.totalOrders}单、合计${summary.totalQty}车，另存与页面为同一份数据。`,
    )
    return { ok: true, message: `${month} 归总已另存（${summary.totalOrders}单 / ${summary.totalQty}车）` }
  } finally {
    commitLock.acquired = false
  }
}

export function listArchives(): EntryRow[] {
  return listRows(ARCHIVE_KEY).slice().sort((a, b) => String(b['月份']).localeCompare(String(a['月份'])))
}

export function monthSummary(month: string) {
  // 归总内部剔除已作废、待核单列且不计入正式合计。
  return summarizeMonth(listRows(CLEANING_KEY), month, plainTime())
}

/* ------------------------------------------------------------------ *
 * 文件出口（下载）
 * ------------------------------------------------------------------ */

function download(filename: string, content: string): void {
  const blob = new Blob([content], { type: 'text/csv;charset=utf-8' })
  const url = URL.createObjectURL(blob)
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = filename
  document.body.appendChild(anchor)
  anchor.click()
  document.body.removeChild(anchor)
  URL.revokeObjectURL(url)
}

export function importTemplate(): void {
  download('保洁车单导入模板.csv', toCsv([IMPORT_HEADERS, ['CL-20261006-01', '2026-10-06', '东区舱', '甲班', '2']]))
}

export function downloadLedger(): void {
  const orders = listCleaning()
  const header = ['作业单号', '车次编号', '清运日期', '完工日期', '保洁区域', '保洁班组', '清运量(车)', '数据来源', '口径版本', '当前状态', '核对说明', '导入批次']
  const rows: (string | number)[][] = [header]
  for (const row of orders) {
    rows.push([
      String(row['作业单号'] ?? ''), String(row['车次编号'] ?? ''), String(row['清运日期'] ?? ''),
      String(row['完工日期'] ?? ''), String(row['保洁区域'] ?? ''), String(row['保洁班组'] ?? ''),
      Number(row['清运量']) || 0, String(row['数据来源'] ?? ''), String(row['口径版本'] ?? ''),
      String(row.status), String(row['核对说明'] ?? ''), String(row['导入批次'] ?? ''),
    ])
  }
  download('保洁作业单台账.csv', toCsv(rows))
}

export function downloadMonthReport(month: string): void {
  const summary = monthSummary(month)
  const rows: (string | number)[][] = []
  rows.push([`${month} 保洁清运归总表（另存时间 ${summary.generatedAt}）`])
  rows.push(['保洁区域', '已入账单数', '清运量合计(车)', '已入账/已核定', '待核单数(量不进合计)'])
  for (const area of summary.areas) {
    rows.push([area.area, area.bookedCount, area.totalQty, area.bookedCount, area.pendingCount])
  }
  rows.push(['合计', summary.totalOrders, summary.totalQty, '', summary.pendingCount])
  rows.push([])
  rows.push(['作业单明细（与页面列表一致）'])
  rows.push(['作业单号', '车次编号', '清运日期', '保洁区域', '保洁班组', '清运量(车)', '状态'])
  for (const row of listCleaning({ month }).filter((r) => ['已入账', '已核定'].includes(String(r.status)))) {
    rows.push([
      String(row['作业单号'] ?? ''), String(row['车次编号'] ?? ''), String(row['清运日期'] ?? ''),
      String(row['保洁区域'] ?? ''), String(row['保洁班组'] ?? ''), Number(row['清运量']) || 0, String(row.status),
    ])
  }
  download(`保洁清运归总-${month}.csv`, toCsv(rows))
}

export function downloadHandover(): void {
  const rows: (string | number)[][] = [['时间', '类别', '事项']]
  for (const row of listHandover()) {
    rows.push([String(row['时间']), String(row['类别']), String(row['事项'])])
  }
  download('保洁交接清单.csv', toCsv(rows))
}

/** 供概览页统计。 */
export function cleaningStats() {
  const rows = listRows(CLEANING_KEY)
  return {
    total: rows.length,
    booked: rows.filter((r) => ['已入账', '已核定'].includes(String(r.status))).length,
    pending: rows.filter((r) => String(r.status) === '待核').length,
    rejected: listRows(REJECT_KEY).length,
  }
}
