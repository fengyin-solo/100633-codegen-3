/**
 * 保洁作业单台账 —— 纯领域逻辑。
 *
 * 这一层不碰浏览器与 localStorage，只负责：车单 CSV 解析、逐行校验、口径版本、
 * 巡检核对、月底归总、冲突仲裁、提交互斥。能在 Node 下直接单测，换后端时整层可搬走。
 */
import type { EntryRow } from './types'

/* ------------------------------------------------------------------ *
 * 口径版本：改版后的口径只对新记录生效，存量按当年那版保留原判。
 * ------------------------------------------------------------------ */

export type PolicyVersion = {
  key: string
  label: string
  years: string
  /** 残缺清运量按当年口径补的默认值（车）；null 表示该口径不允许补，需监管员核定。 */
  fallbackQty: number | null
  /** 是否要求与当日巡检遗留问题数核对。 */
  reconcile: boolean
  /** 清运量与遗留问题数允许相差几车，仍算对得上。 */
  tolerance: number
  note: string
}

// 早年只有纸质车单：一车一记，不具备与电子巡检核对的条件，按 1 车补齐、不挂待核。
export const POLICY_PAPER: PolicyVersion = {
  key: 'paper',
  label: '纸质版(2023年以前)',
  years: '≤2023',
  fallbackQty: 1,
  reconcile: false,
  tolerance: 0,
  note: '纸质车单一车一记，无电子巡检可比对，残缺车次按1车补录，保留原判不重新核对。',
}

export const POLICY_2024: PolicyVersion = {
  key: 'v2024',
  label: '2024版(2024-2025)',
  years: '2024-2025',
  fallbackQty: 1,
  reconcile: true,
  tolerance: 1,
  note: '清运量按车计，与同区域当日巡检遗留问题数相差不超过1车即对得上。',
}

export const POLICY_2026: PolicyVersion = {
  key: 'v2026',
  label: '2026版(现行)',
  years: '2026-至今',
  fallbackQty: null,
  reconcile: true,
  tolerance: 1,
  note: '现行口径：车次编号、保洁区域、保洁班组、清运量缺一不可，缺失即退行；核对容差1车。',
}

export const POLICIES: PolicyVersion[] = [POLICY_PAPER, POLICY_2024, POLICY_2026]

/** 存量回填：以完工（作业）日期的年份选当年那版口径。 */
export function policyForYear(year: number): PolicyVersion {
  if (year <= 2023) return POLICY_PAPER
  if (year <= 2025) return POLICY_2024
  return POLICY_2026
}

export function policyByKey(key: string): PolicyVersion {
  return POLICIES.find((item) => item.key === key) ?? POLICY_2026
}

/** 新导入的记录一律盖现行口径，哪怕清运日期是过去的——改版只对新记录生效。 */
export const CURRENT_POLICY = POLICY_2026

/* ------------------------------------------------------------------ *
 * 状态
 * ------------------------------------------------------------------ */

export const CLEANING_STATUSES = ['已入账', '待核', '已核定', '已作废'] as const
export type CleaningStatus = (typeof CLEANING_STATUSES)[number]

export const SOURCE_RANK: Record<string, number> = {
  监管核定: 3,
  车单导入: 2,
  纸质补录: 1,
}

/* ------------------------------------------------------------------ *
 * CSV：外部车单走文件进来，月底归总走文件出去，进出都靠这两个函数。
 * 支持带引号、字段内含逗号/换行，去掉 Excel 常见的 BOM。
 * ------------------------------------------------------------------ */

export function parseCsv(text: string): string[][] {
  const src = text.replace(/^﻿/, '')
  const rows: string[][] = []
  let field = ''
  let row: string[] = []
  let inQuotes = false
  for (let i = 0; i < src.length; i += 1) {
    const ch = src[i]
    if (inQuotes) {
      if (ch === '"') {
        if (src[i + 1] === '"') {
          field += '"'
          i += 1
        } else {
          inQuotes = false
        }
      } else {
        field += ch
      }
    } else if (ch === '"') {
      inQuotes = true
    } else if (ch === ',') {
      row.push(field)
      field = ''
    } else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && src[i + 1] === '\n') i += 1
      row.push(field)
      rows.push(row)
      field = ''
      row = []
    } else {
      field += ch
    }
  }
  if (field !== '' || row.length > 0) {
    row.push(field)
    rows.push(row)
  }
  return rows.filter((cells) => !(cells.length === 1 && cells[0].trim() === ''))
}

function csvEscape(value: string | number): string {
  const s = String(value)
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s
}

export function toCsv(rows: (string | number)[][]): string {
  return `﻿${rows.map((cells) => cells.map(csvEscape).join(',')).join('\r\n')}`
}

/* ------------------------------------------------------------------ *
 * 车单表头与逐行校验
 * 外部车单约定列：车次编号,清运日期,保洁区域,保洁班组,清运量
 * ------------------------------------------------------------------ */

export const IMPORT_HEADERS = ['车次编号', '清运日期', '保洁区域', '保洁班组', '清运量']

export type ImportCell = {
  车次编号: string
  清运日期: string
  保洁区域: string
  保洁班组: string
  清运量: number
}

export type RowCheck =
  | { ok: true; data: ImportCell }
  | { ok: false; reasons: string[] }

const DATE_RE = /^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})$/

/** 归一化成 YYYY-MM-DD；格式不对返回空串（退行的缘由之一）。 */
export function normalizeDate(raw: string): string {
  const m = raw.trim().match(DATE_RE)
  if (!m) return ''
  const year = Number(m[1])
  const month = Number(m[2])
  const day = Number(m[3])
  if (month < 1 || month > 12 || day < 1 || day > 31) return ''
  return `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`
}

/**
 * 逐行核对：车次编号/日期/区域/班组/清运量任一缺失或格式不对，
 * 这一行不进账，另起一行写清缘由；其余照常入账。
 */
export function checkImportRow(cells: string[]): RowCheck {
  const reasons: string[] = []
  const tripNo = (cells[0] ?? '').trim()
  const dateRaw = (cells[1] ?? '').trim()
  const area = (cells[2] ?? '').trim()
  const crew = (cells[3] ?? '').trim()
  const qtyRaw = (cells[4] ?? '').trim()

  if (!tripNo) reasons.push('车次编号缺失')
  const date = normalizeDate(dateRaw)
  if (!date) reasons.push(`清运日期格式不对（原值：${dateRaw || '空'}），应为YYYY-MM-DD`)
  if (!area) reasons.push('保洁区域缺失')
  if (!crew) reasons.push('保洁班组缺失')

  let qty = NaN
  if (!qtyRaw) {
    reasons.push('清运量缺失')
  } else {
    qty = Number(qtyRaw)
    if (!Number.isFinite(qty) || qty <= 0) {
      reasons.push(`清运量须为正数（原值：${qtyRaw}）`)
    }
  }

  if (reasons.length > 0) return { ok: false, reasons }
  return { ok: true, data: { 车次编号: tripNo, 清运日期: date, 保洁区域: area, 保洁班组: crew, 清运量: qty } }
}

/* ------------------------------------------------------------------ *
 * 巡检核对
 * patrolIndex：Map<保洁区域, Map<YYYY-MM-DD, 遗留问题数>>
 * 明显不一致（超过当年容差）或当天没有巡检可比对 → 挂待核。
 * ------------------------------------------------------------------ */

export type ReconcileOutcome = {
  status: CleaningStatus
  reason: string
  issues: number | null
}

export function reconcileQty(
  area: string,
  date: string,
  qty: number,
  policy: PolicyVersion,
  patrolIndex: Map<string, Map<string, number>>,
): ReconcileOutcome {
  if (!policy.reconcile) {
    return { status: '已入账', reason: '纸质口径不参与巡检核对，保留原判', issues: null }
  }
  const byDate = patrolIndex.get(area)
  const issues = byDate?.get(date)
  if (issues === undefined) {
    return { status: '待核', reason: `当日（${date}）巡检任务无遗留问题上报，无法核对`, issues: null }
  }
  if (Math.abs(qty - issues) <= policy.tolerance) {
    return { status: '已入账', reason: `清运${qty}车 对 当日遗留问题${issues}项，容差内一致`, issues }
  }
  return {
    status: '待核',
    reason: `清运${qty}车 与 当日遗留问题${issues}项 明显不一致（容差${policy.tolerance}车）`,
    issues,
  }
}

/** 从巡检记录构造区域×日期的遗留问题数索引（巡检路线包含保洁区域名即视为同区域）。 */
export function buildPatrolIndex(patrolRows: EntryRow[], areas: string[]): Map<string, Map<string, number>> {
  const index = new Map<string, Map<string, number>>()
  for (const row of patrolRows) {
    const route = String(row['巡检路线'] ?? '')
    const date = normalizeDate(String(row['完成时间'] ?? row['计划日期'] ?? ''))
    const issues = Number(row['发现问题数'])
    if (!date || !Number.isFinite(issues)) continue
    const area = areas.find((candidate) => route.includes(candidate))
    if (!area) continue
    if (!index.has(area)) index.set(area, new Map())
    index.get(area)!.set(date, issues)
  }
  return index
}

/* ------------------------------------------------------------------ *
 * 月底按保洁区域归总：页面列的与另存出去的，取同一份归总结果。
 * ------------------------------------------------------------------ */

export type AreaSummary = {
  area: string
  orderCount: number
  totalQty: number
  bookedCount: number
  pendingCount: number
  pendingQty: number
}

export type MonthSummary = {
  month: string
  generatedAt: string
  areas: AreaSummary[]
  totalOrders: number
  totalQty: number
  pendingCount: number
}

export function monthOf(date: string): string {
  return date.slice(0, 7)
}

/**
 * 月底按保洁区域归总。已作废剔除；待核单列出来供监管跟进，但其清运量
 * 不计入正式合计（核为“一致入账”后才进），避免未经核对的量污染报表。
 */
export function summarizeMonth(orders: EntryRow[], month: string, nowIso: string): MonthSummary {
  const scoped = orders.filter(
    (row) => String(row.status) !== '已作废' && monthOf(businessDate(row)) === month,
  )
  const byArea = new Map<string, AreaSummary>()
  for (const row of scoped) {
    const area = String(row['保洁区域'] ?? '未填区域')
    const qty = Number(row['清运量']) || 0
    const acc = byArea.get(area) ?? {
      area, orderCount: 0, totalQty: 0, bookedCount: 0, pendingCount: 0, pendingQty: 0,
    }
    acc.orderCount += 1
    if (String(row.status) === '待核') {
      acc.pendingCount += 1
      acc.pendingQty += qty
    } else {
      acc.bookedCount += 1
      acc.totalQty += qty // 合计只累加已入账/已核定
    }
    byArea.set(area, acc)
  }
  const areas = [...byArea.values()].sort((a, b) => a.area.localeCompare(b.area, 'zh'))
  return {
    month,
    generatedAt: nowIso,
    areas,
    totalOrders: areas.reduce((s, a) => s + a.bookedCount, 0),
    totalQty: areas.reduce((s, a) => s + a.totalQty, 0),
    pendingCount: areas.reduce((s, a) => s + a.pendingCount, 0),
  }
}

/** 作业日期轴：车单导入取清运日期，历史单据取完工日期。 */
export function businessDate(row: EntryRow): string {
  return String(row['作业日期'] ?? row['清运日期'] ?? row['完工日期'] ?? '')
}

/* ------------------------------------------------------------------ *
 * 冲突仲裁
 * 1) 车次编号相同即同一笔，重复导入不叠加；
 * 2) 权威等级：监管核定 ＞ 车单导入 ＞ 纸质补录；
 * 3) 同源冲突比导入批次时间，新者覆盖旧者。
 * 依据：监管员核定是线下核对后的终局结论，电子车单是司机当场原始凭据，
 *      纸质补录只是回溯估计，可信度依次递减。
 * ------------------------------------------------------------------ */

export type Arbitration = { winner: 'existing' | 'incoming'; reason: string }

export function arbitrate(existing: EntryRow, incoming: EntryRow): Arbitration {
  const rankOld = SOURCE_RANK[String(existing['数据来源'])] ?? 0
  const rankNew = SOURCE_RANK[String(incoming['数据来源'])] ?? 0
  if (rankOld > rankNew) {
    return {
      winner: 'existing',
      reason: `旧版为「${existing['数据来源']}」，权威高于新批次的「${incoming['数据来源']}」，以核定结论为准，车单不反向推翻`,
    }
  }
  if (rankNew > rankOld) {
    return { winner: 'incoming', reason: `新批次来源「${incoming['数据来源']}」权威更高，覆盖旧版` }
  }
  const tOld = String(existing['导入批次'] ?? '')
  const tNew = String(incoming['导入批次'] ?? '')
  if (tOld === tNew) {
    return { winner: 'existing', reason: '同一导入批次内车次重复，保留先到一行' }
  }
  return { winner: 'incoming', reason: '同为车单导入，按导入批次时间新者覆盖旧版，不叠加' }
}

/* ------------------------------------------------------------------ *
 * 提交互斥：同一时刻两笔提交并发进来，先到的入账，后到的整笔回退。
 * JS 单线程，提交过程又是同步的，所以用不可重入锁即可精确表达：
 * 锁被占期间进来的第二笔直接拒绝、不产生任何写入。
 * ------------------------------------------------------------------ */

export class CommitLock {
  private held = false

  /** 尝试拿锁；拿不到说明已有一笔在途，调用方必须整笔回退。 */
  tryAcquire(): boolean {
    if (this.held) return false
    this.held = true
    return true
  }

  release(): void {
    this.held = false
  }
}

/** 把“拿锁—提交—放行”收成一个原子动作；被挤掉的那笔返回 rolledBack。 */
export function atomicCommit<T>(lock: CommitLock, fn: () => T): T | { rolledBack: true } {
  if (!lock.tryAcquire()) return { rolledBack: true }
  try {
    return fn()
  } finally {
    lock.release()
  }
}
