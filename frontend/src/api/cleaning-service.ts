/**
 * 保洁作业单台账的业务全部在这里：
 * 车单文件整批导入与逐行校验、废行另记、同车次覆盖、与巡检遗留问题对账、
 * 待核挂账/监管员核定、存量单据一次性回填、月底按区域归总另存、并发互斥，
 * 以及与「运维值班交接」清单的同源同步。页面组件不做业务判断。
 */
import { filterRows } from './local-service'
import { listRows, saveRows } from '@/data/local-store'
import {
  CALIBER_V1,
  CALIBER_V2,
  CALIBER_V3,
  CLEANING_AREAS,
  CLEANING_HANDOVER_KEY,
  CLEANING_KEY,
  CLEANING_REJECT_KEY,
  CLEANING_SUMMARY_KEY,
  CLEANING_TEAMS,
  ORDER_STATUS,
  caliberOf,
} from '@/data/cleaning'
import type { CaliberVersion, CleaningOrder, HandoverRow, RejectRow, SummaryRow } from '@/data/cleaning'
import type { EntryRow } from '@/data/types'

// ---------------------------------------------------------------------------
// 通用小工具
// ---------------------------------------------------------------------------

function pad(num: number): string {
  return String(num).padStart(2, '0')
}

function nowText(): string {
  const d = new Date()
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`
}

function nextId(rows: EntryRow[]): number {
  return rows.reduce((max, row) => Math.max(max, Number(row.id) || 0), 0) + 1
}

function toNumber(value: unknown): number | null {
  if (value === null || value === undefined) return null
  const text = String(value).trim()
  if (text === '') return null
  if (!/^\d+(\.\d+)?$/.test(text)) return null
  return Number(text)
}

function isValidDate(text: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(text)) return false
  const d = new Date(`${text}T00:00:00`)
  return !Number.isNaN(d.getTime())
}

// ---------------------------------------------------------------------------
// CSV：导入导出都走文件。解析支持引号、逗号、换行；写出对特殊字符加引号。
// ---------------------------------------------------------------------------

export function parseCsv(text: string): string[][] {
  const source = text.replace(/^﻿/, '')
  const rows: string[][] = []
  let field = ''
  let row: string[] = []
  let inQuotes = false
  for (let i = 0; i < source.length; i += 1) {
    const ch = source[i]
    if (inQuotes) {
      if (ch === '"') {
        if (source[i + 1] === '"') {
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
      if (ch === '\r' && source[i + 1] === '\n') i += 1
      row.push(field)
      rows.push(row)
      row = []
      field = ''
    } else {
      field += ch
    }
  }
  if (field !== '' || row.length > 0) {
    row.push(field)
    rows.push(row)
  }
  return rows.filter((cells) => cells.some((cell) => cell.trim() !== ''))
}

function csvCell(value: unknown): string {
  const text = value === null || value === undefined ? '' : String(value)
  if (/[",\n\r]/.test(text)) {
    return `"${text.replace(/"/g, '""')}"`
  }
  return text
}

function toCsv(header: string[], rows: EntryRow[], fields: string[]): string {
  const lines = [header.map(csvCell).join(',')]
  for (const row of rows) {
    lines.push(fields.map((field) => csvCell(row[field])).join(','))
  }
  return `﻿${lines.join('\r\n')}`
}

// ---------------------------------------------------------------------------
// 交接清单：保洁台账结论写进值班交接的「其它入口交接清单」，两边取同一份存储。
// ---------------------------------------------------------------------------

function appendHandover(partial: {
  类型: string
  内容: string
  批次号?: string
  月份?: string
  作业单号?: string
  车次编号?: string
  操作人?: string
}): HandoverRow {
  const rows = listRows(CLEANING_HANDOVER_KEY)
  const entry: HandoverRow = {
    id: nextId(rows),
    status: '结论',
    pending: false,
    abnormal: false,
    时间: nowText(),
    操作人: partial.操作人 ?? '保洁台账',
    ...partial,
  }
  saveRows(CLEANING_HANDOVER_KEY, [entry, ...rows])
  return entry
}

export function listHandover(): HandoverRow[] {
  return listRows(CLEANING_HANDOVER_KEY)
}

// ---------------------------------------------------------------------------
// 对账：清运量 vs 巡检任务当天上报的遗留问题数（同区域、同日期，可多条求和）
// ---------------------------------------------------------------------------

function patrolIssuesOn(dateText: string, area: string): number | null {
  const patrolRows = listRows('patrol')
  let total: number | null = null
  for (const row of patrolRows) {
    const status = String(row.status ?? '')
    if (status !== '已完成' && status !== '已上报') continue
    if (String(row['巡检路线'] ?? '').trim() !== area) continue
    const doneAt = String(row['完成时间'] ?? row['计划日期'] ?? '').slice(0, 10)
    if (doneAt !== dateText) continue
    const issues = toNumber(row['发现问题数'])
    if (issues !== null) {
      total = (total ?? 0) + issues
    }
  }
  return total
}

type Verdict = { verdict: string; pending: boolean }

function judgeOrder(args: { date: string; area: string; qty: number; caliber: CaliberVersion }): Verdict {
  const { date, area, qty, caliber } = args
  if (caliber === CALIBER_V1) {
    return { verdict: 'v1 纸质口径：当年无电子巡检遗留问题数，免对账，保留原判', pending: false }
  }
  const issues = patrolIssuesOn(date, area)
  if (issues === null) {
    if (caliber === CALIBER_V3) {
      return { verdict: '当天该区域无巡检上报，无法对账，先挂待核由监管员核定', pending: true }
    }
    return { verdict: '当天该区域无巡检上报可对，按 v2 联单口径保留原判', pending: false }
  }
  const tolerance = caliber === CALIBER_V2 ? 0.5 : 0.3
  const thresholdText = caliber === CALIBER_V2 ? '50%' : '30%'
  if (qty === 0 && issues === 0) {
    return { verdict: '对账一致：清运 0 车 / 巡检遗留 0 项', pending: false }
  }
  const diff = Math.abs(qty - issues)
  const base = Math.max(qty, issues)
  const ratio = base === 0 ? 0 : diff / base
  const percent = Math.round(ratio * 100)
  if (ratio > tolerance) {
    return {
      verdict: `清运量 ${qty} 车与当天巡检遗留 ${issues} 项差异 ${percent}%，超过 ${thresholdText} 阈值，挂待核`,
      pending: true,
    }
  }
  return {
    verdict: `对账一致：清运 ${qty} 车 / 巡检遗留 ${issues} 项，差异 ${percent}% ≤ ${thresholdText}`,
    pending: false,
  }
}

// ---------------------------------------------------------------------------
// 存量单据回填：以完工日期为轴只跑一次；取值残缺的按当年那版口径补齐，原判冻结。
// ---------------------------------------------------------------------------

let backfillChecked = false

export function ensureBackfill(operator = '系统回填'): { ran: boolean; filled: number } {
  const rows = listRows(CLEANING_KEY)
  const pendingRows = rows.filter((row) => String(row['口径版本'] ?? '') === '')
  if (pendingRows.length === 0) {
    backfillChecked = true
    return { ran: false, filled: 0 }
  }
  const counts: Record<string, number> = {
    [CALIBER_V1]: 0,
    [CALIBER_V2]: 0,
    [CALIBER_V3]: 0,
  }
  const next = rows.map((raw) => {
    const row: CleaningOrder = { ...raw }
    const finishDate = String(row['完工日期'] ?? '').trim() || String(row['清运日期'] ?? '').trim()
    row['完工日期'] = finishDate
    if (!row['来源']) row['来源'] = '纸质车单'
    const caliber = caliberOf(finishDate)
    counts[caliber] += 1
    const parsedQty = toNumber(row['清运量(车)'])
    let qty: number
    let note = ''

    if (caliber === CALIBER_V1) {
      qty = parsedQty ?? 1
      if (parsedQty === null) note = '清运量纸质残缺，按 v1 口径补 1 车/单；'
      row['清运量(车)'] = qty
      row['口径版本'] = caliber
      row['对账结论'] = `${note}v1 纸质口径：当年无电子巡检遗留问题数，免对账，保留原判`
      row.status = ORDER_STATUS.booked
      row.pending = false
      row.abnormal = false
      return row
    }

    if (caliber === CALIBER_V2) {
      if (parsedQty === null) {
        const issues = patrolIssuesOn(finishDate, String(row['保洁区域'] ?? ''))
        qty = issues ?? 1
        note = `清运量纸质残缺，按 v2 联单口径以当天巡检遗留问题数补齐为 ${qty} 车；`
      } else {
        qty = parsedQty
      }
    } else {
      qty = parsedQty ?? 1
      if (parsedQty === null) {
        // 现行口径下取值残缺又无外部车单可凭：暂补 1 车并挂待核，由监管员核定。
        row['清运量(车)'] = qty
        row['口径版本'] = caliber
        row['对账结论'] = '清运量残缺且无外部车单可凭，按现行口径暂补 1 车并挂待核，由监管员核定后冻结'
        row.status = ORDER_STATUS.pending
        row.pending = true
        row.abnormal = true
        return row
      }
    }

    row['清运量(车)'] = qty
    row['口径版本'] = caliber
    const judged = judgeOrder({ date: finishDate, area: String(row['保洁区域'] ?? ''), qty, caliber })
    row['对账结论'] = note + judged.verdict
    row.status = judged.pending ? ORDER_STATUS.pending : ORDER_STATUS.booked
    row.pending = judged.pending
    row.abnormal = judged.pending
    return row
  })

  saveRows(CLEANING_KEY, next)
  backfillChecked = true
  appendHandover({
    类型: '存量回填结论',
    操作人: operator,
    内容:
      `存量保洁作业单以完工日期为轴一次性回填 ${next.length} 笔（v1 口径 ${counts[CALIBER_V1]} 笔、` +
      `v2 口径 ${counts[CALIBER_V2]} 笔、v3 口径 ${counts[CALIBER_V3]} 笔）。` +
      '早年纸质记录取值残缺的：v1 按 1 车/单补录并保留原判免对账；v2 以当天巡检遗留问题数补齐；' +
      'v3 无外部车单可凭的暂补 1 车并挂待核。回填当日按各单当时口径判定一次后冻结，改版口径只对新记录生效。',
  })
  return { ran: true, filled: next.length }
}

export function backfillReady(): boolean {
  return backfillChecked
}

// ---------------------------------------------------------------------------
// 作业单查询 / 待核（待核不另建存储，就是台账里 status=待核 的行，天然同源）
// ---------------------------------------------------------------------------

export function listOrders(filters: Record<string, string> = {}): CleaningOrder[] {
  return filterRows(listRows(CLEANING_KEY), filters) as CleaningOrder[]
}

export function listRejects(): RejectRow[] {
  return listRows(CLEANING_REJECT_KEY) as RejectRow[]
}

export function listHolds(): CleaningOrder[] {
  return listRows(CLEANING_KEY).filter((row) => String(row.status) === ORDER_STATUS.pending) as CleaningOrder[]
}

/** 监管员在巡检侧核定待核单：台账与交接清单在同一次提交里同步更新。 */
export function resolveHold(id: number, operator: string, conclusion: string): { ok: boolean; message: string } {
  const rows = listRows(CLEANING_KEY)
  const index = rows.findIndex((row) => Number(row.id) === id)
  if (index < 0) return { ok: false, message: '没有找到这笔作业单' }
  const row = rows[index]
  if (String(row.status) !== ORDER_STATUS.pending) {
    return { ok: false, message: '这笔作业单不是待核状态' }
  }
  const updated: CleaningOrder = {
    ...row,
    status: ORDER_STATUS.booked,
    pending: false,
    abnormal: false,
    核定冻结: '是',
    核定人: operator,
    核定时点: nowText(),
    对账结论: `监管员${operator}核定：${conclusion}｜原判定：${row['对账结论'] ?? ''}`,
  }
  const nextRows = [...rows]
  nextRows[index] = updated
  saveRows(CLEANING_KEY, nextRows)
  appendHandover({
    类型: '待核核定结论',
    操作人: operator,
    作业单号: String(updated['作业单号'] ?? ''),
    车次编号: String(updated['车次编号'] ?? ''),
    内容: `作业单 ${updated['作业单号']}（车次 ${updated['车次编号']}）经监管员${operator}核定入账：${conclusion}。核定后冻结，同车次再导入不翻案。`,
  })
  return { ok: true, message: '已核定入账并冻结，结论同步写入交接清单' }
}

/** 撤销核定：解冻并按当前数据重新对账（可能重新挂待核）。 */
export function undoHoldResolution(id: number, operator: string): { ok: boolean; message: string } {
  const rows = listRows(CLEANING_KEY)
  const index = rows.findIndex((row) => Number(row.id) === id)
  if (index < 0) return { ok: false, message: '没有找到这笔作业单' }
  const row = rows[index] as CleaningOrder
  if (String(row['核定冻结'] ?? '') !== '是') {
    return { ok: false, message: '这笔作业单没有核定冻结记录' }
  }
  const qty = toNumber(row['清运量(车)']) ?? 0
  const caliber = (String(row['口径版本']) || caliberOf(String(row['清运日期']))) as CaliberVersion
  const judged = judgeOrder({ date: String(row['清运日期']), area: String(row['保洁区域']), qty, caliber })
  const updated: CleaningOrder = {
    ...row,
    status: judged.pending ? ORDER_STATUS.pending : ORDER_STATUS.booked,
    pending: judged.pending,
    abnormal: judged.pending,
    核定冻结: '否',
    对账结论: `监管员${operator}撤销核定，重新对账：${judged.verdict}｜原核定：${row['对账结论'] ?? ''}`,
  }
  const nextRows = [...rows]
  nextRows[index] = updated
  saveRows(CLEANING_KEY, nextRows)
  appendHandover({
    类型: '核定撤销',
    操作人: operator,
    作业单号: String(updated['作业单号'] ?? ''),
    车次编号: String(updated['车次编号'] ?? ''),
    内容: `作业单 ${updated['作业单号']}（车次 ${updated['车次编号']}）的核定冻结由 ${operator} 撤销，恢复系统对账口径。`,
  })
  return { ok: true, message: '已撤销核定并重新对账' }
}

// ---------------------------------------------------------------------------
// 车单文件整批导入
// ---------------------------------------------------------------------------

const IMPORT_HEADERS = ['车次编号', '清运日期', '保洁区域', '保洁班组', '清运量(车)'] as const

export type ImportResult = {
  ok: boolean
  rolledBack: boolean
  filename: string
  batchId: string
  createdAt: string
  created: number
  overwritten: number
  rejected: number
  pending: number
  rejectDetails: { lineNo: number; reasons: string; raw: string }[]
  message: string
}

// 同一时刻只允许一笔导入入账：后到的一笔整笔回退（不入一行、不写废行簿）。
let importLocked = false

export function importBusy(): boolean {
  return importLocked
}

export async function importManifestFile(file: File, operator = '值班管理员'): Promise<ImportResult> {
  if (importLocked) {
    const result: ImportResult = {
      ok: false,
      rolledBack: true,
      filename: file.name,
      batchId: '',
      createdAt: nowText(),
      created: 0,
      overwritten: 0,
      rejected: 0,
      pending: 0,
      rejectDetails: [],
      message: '已有一车单批次正在入账，按并发仲裁规则，本笔整笔回退（未入账任何行），请稍后重新导入。',
    }
    appendHandover({
      类型: '并发回退',
      操作人: operator,
      内容: `文件「${file.name}」与另一笔导入同时提交，后到者整笔回退，未写入台账。`,
    })
    return result
  }
  importLocked = true
  try {
    const text = await file.text()
    return commitManifest(text, file.name, operator)
  } finally {
    importLocked = false
  }
}

function newOrderNo(rows: CleaningOrder[], date: string): string {
  const year = date.slice(0, 4)
  const prefix = `CLN-${year}-`
  let max = 0
  for (const row of rows) {
    const no = String(row['作业单号'] ?? '')
    if (no.startsWith(prefix)) {
      const seq = Number(no.slice(prefix.length))
      if (!Number.isNaN(seq)) max = Math.max(max, seq)
    }
  }
  return `${prefix}${String(max + 1).padStart(3, '0')}`
}

function commitManifest(text: string, filename: string, operator: string): ImportResult {
  const createdAt = nowText()
  const batchId = `IMP-${createdAt.replace(/[-: ]/g, '')}-${Math.floor(Math.random() * 9000 + 1000)}`
  const fail = (message: string): ImportResult => ({
    ok: false,
    rolledBack: true,
    filename,
    batchId,
    createdAt,
    created: 0,
    overwritten: 0,
    rejected: 0,
    pending: 0,
    rejectDetails: [],
    message,
  })

  const grid = parseCsv(text)
  if (grid.length === 0) {
    const result = fail('文件内容为空，整批回退，未入账任何行。')
    appendHandover({ 类型: '导入整批回退', 批次号: batchId, 操作人: operator, 内容: `文件「${filename}」内容为空，整批回退。` })
    return result
  }
  const header = grid[0].map((cell) => cell.trim())
  const missing = IMPORT_HEADERS.filter((name) => !header.includes(name))
  if (missing.length > 0) {
    const result = fail(`表头缺少列：${missing.join('、')}。整批回退，未入账任何行。`)
    appendHandover({
      类型: '导入整批回退',
      批次号: batchId,
      操作人: operator,
      内容: `文件「${filename}」表头缺少「${missing.join('、')}」，整批回退，未写入台账。`,
    })
    return result
  }
  const col = (name: string) => header.indexOf(name)

  // 先在内存里把整批结果算齐，最后一次性落库：中途任何异常都不产生半批数据。
  const orders = [...listRows(CLEANING_KEY)] as CleaningOrder[]
  const rejects = [...listRows(CLEANING_REJECT_KEY)] as RejectRow[]
  const rejectDetails: ImportResult['rejectDetails'] = []
  let created = 0
  let overwritten = 0
  let pendingCount = 0
  // 车次编号 -> 当前批次在内存台账里的落点；同批次重复车次以后到的一行覆盖。
  const incomingIndex = new Map<string, number>()

  const dataRows = grid.slice(1).map((cells, idx) => ({ cells, lineNo: idx + 2 }))
  for (const { cells, lineNo } of dataRows) {
    const raw = cells.map(csvCell).join(',')
    const tripNo = (cells[col('车次编号')] ?? '').trim()
    const date = (cells[col('清运日期')] ?? '').trim()
    const area = (cells[col('保洁区域')] ?? '').trim()
    const team = (cells[col('保洁班组')] ?? '').trim()
    const qtyText = (cells[col('清运量(车)')] ?? '').trim()

    const reasons: string[] = []
    if (!tripNo) reasons.push('车次编号缺失')
    if (!isValidDate(date)) reasons.push(`清运日期「${date}」格式不对，应为 YYYY-MM-DD`)
    if (!area) reasons.push('保洁区域缺失')
    else if (!CLEANING_AREAS.includes(area as (typeof CLEANING_AREAS)[number])) {
      reasons.push(`保洁区域「${area}」不在登记范围（${CLEANING_AREAS.join('、')}）`)
    }
    if (!team) reasons.push('保洁班组缺失')
    else if (!CLEANING_TEAMS.includes(team as (typeof CLEANING_TEAMS)[number])) {
      reasons.push(`保洁班组「${team}」不在登记范围（${CLEANING_TEAMS.join('、')}）`)
    }
    const qty = toNumber(qtyText)
    if (qtyText === '') reasons.push('清运量缺失')
    else if (qty === null) reasons.push(`清运量「${qtyText}」格式不对，应为非负数字`)

    // 格式不对或数量缺失的那一行不进台账，另起一行写清缘由。
    if (reasons.length > 0) {
      rejects.push({
        id: nextId(rejects),
        status: '废行',
        pending: false,
        abnormal: true,
        批次号: batchId,
        文件名: filename,
        行号: lineNo,
        原始内容: raw,
        缘由: reasons.join('；'),
        导入时间: createdAt,
      })
      rejectDetails.push({ lineNo, reasons: reasons.join('；'), raw })
      continue
    }

    const caliber = caliberOf(date)
    // 上面 reasons 非空已 continue：这里 qty 必为非负数。
    const validQty = qty as number
    const judged = judgeOrder({ date, area, qty: validQty, caliber })

    // 同批次内重复车次：以后出现的一行为准（同一落点直接覆盖）。
    const sameBatchIndex = incomingIndex.get(tripNo)
    const existingIndex =
      sameBatchIndex !== undefined ? sameBatchIndex : orders.findIndex((row) => String(row['车次编号'] ?? '') === tripNo)

    if (existingIndex >= 0 && String(orders[existingIndex]['核定冻结'] ?? '') === '是') {
      // 仲裁规则③：监管员已核定冻结的车次，导入不得覆盖；来行另记缘由。
      const frozen = orders[existingIndex]
      rejects.push({
        id: nextId(rejects),
        status: '废行',
        pending: false,
        abnormal: true,
        批次号: batchId,
        文件名: filename,
        行号: lineNo,
        原始内容: raw,
        缘由: `车次 ${tripNo} 已由监管员核定冻结（作业单 ${frozen['作业单号']}），导入不覆盖；如需改判请到巡检侧撤销核定`,
        导入时间: createdAt,
      })
      rejectDetails.push({ lineNo, reasons: '该车次已核定冻结，导入不覆盖', raw })
      continue
    }

    const payload: Omit<CleaningOrder, 'id' | 'status' | 'pending' | 'abnormal' | '作业单号'> = {
      车次编号: tripNo,
      清运日期: date,
      完工日期: date,
      保洁区域: area,
      保洁班组: team,
      '清运量(车)': validQty,
      来源: '外部车单文件',
      口径版本: caliber,
      对账结论: judged.verdict,
      导入批次: batchId,
      导入时间: createdAt,
      核定冻结: '否',
    }

    if (existingIndex >= 0) {
      const old = orders[existingIndex]
      orders[existingIndex] = {
        ...old,
        ...payload,
        id: old.id,
        status: judged.pending ? ORDER_STATUS.pending : ORDER_STATUS.booked,
        pending: judged.pending,
        abnormal: judged.pending,
      }
      incomingIndex.set(tripNo, existingIndex)
      overwritten += 1
      if (judged.pending) pendingCount += 1
    } else {
      const orderNo = newOrderNo(orders, date)
      const inserted: CleaningOrder = {
        ...payload,
        id: nextId(orders),
        status: judged.pending ? ORDER_STATUS.pending : ORDER_STATUS.booked,
        pending: judged.pending,
        abnormal: judged.pending,
        作业单号: orderNo,
      }
      orders.push(inserted)
      incomingIndex.set(tripNo, orders.length - 1)
      created += 1
      if (judged.pending) pendingCount += 1
    }
  }

  // 按清运日期整批排序入账（同日按车次编号）。
  orders.sort((a, b) => {
    const da = String(a['清运日期'] ?? '')
    const db = String(b['清运日期'] ?? '')
    if (da !== db) return da < db ? -1 : 1
    return String(a['车次编号'] ?? '') < String(b['车次编号'] ?? '') ? -1 : 1
  })

  saveRows(CLEANING_KEY, orders)
  if (rejects.length > 0) saveRows(CLEANING_REJECT_KEY, rejects)

  appendHandover({
    类型: '导入批次结论',
    批次号: batchId,
    操作人: operator,
    内容:
      `车单文件「${filename}」按清运日期整批入账：新入 ${created} 笔、同车次覆盖 ${overwritten} 笔、` +
      `废行 ${rejectDetails.length} 行（缘由已另记废行簿）、挂待核 ${pendingCount} 笔。同车次不叠加，按车次编号覆盖旧版。`,
  })

  return {
    ok: true,
    rolledBack: false,
    filename,
    batchId,
    createdAt,
    created,
    overwritten,
    rejected: rejectDetails.length,
    pending: pendingCount,
    rejectDetails,
    message: `入账完成：新入 ${created} 笔、覆盖 ${overwritten} 笔、废行 ${rejectDetails.length} 行、待核 ${pendingCount} 笔。`,
  }
}

// ---------------------------------------------------------------------------
// 月底按保洁区域归总另存：保存成快照，页面列表与下载文件取同一份。
// ---------------------------------------------------------------------------

export type AreaAggregate = {
  area: string
  total: number
  booked: number
  pending: number
  qty: number
  pendingQty: number
}

export function computeMonthAggregate(month: string): { areas: AreaAggregate[]; total: AreaAggregate } {
  const rows = listRows(CLEANING_KEY).filter(
    (row) => String(row['清运日期'] ?? '').slice(0, 7) === month && String(row.status) !== ORDER_STATUS.rejected,
  )
  const map = new Map<string, AreaAggregate>(
    CLEANING_AREAS.map((area) => [area, { area, total: 0, booked: 0, pending: 0, qty: 0, pendingQty: 0 }]),
  )
  for (const row of rows) {
    const area = String(row['保洁区域'] ?? '')
    if (!map.has(area)) map.set(area, { area, total: 0, booked: 0, pending: 0, qty: 0, pendingQty: 0 })
    const agg = map.get(area) as AreaAggregate
    const qty = toNumber(row['清运量(车)']) ?? 0
    const isPending = String(row.status) === ORDER_STATUS.pending
    agg.total += 1
    agg.qty += qty
    if (isPending) {
      agg.pending += 1
      agg.pendingQty += qty
    } else {
      agg.booked += 1
    }
  }
  const areas = [...map.values()].filter((agg) => agg.total > 0)
  const total: AreaAggregate = areas.reduce(
    (sum, agg) => ({
      area: '合计',
      total: sum.total + agg.total,
      booked: sum.booked + agg.booked,
      pending: sum.pending + agg.pending,
      qty: sum.qty + agg.qty,
      pendingQty: sum.pendingQty + agg.pendingQty,
    }),
    { area: '合计', total: 0, booked: 0, pending: 0, qty: 0, pendingQty: 0 },
  )
  return { areas, total }
}

export const SUMMARY_FIELDS = ['月份', '保洁区域', '作业单数', '已入账单数', '待核单数', '清运量合计(车)', '待核清运量(车)', '保存时间'] as const

export function listSummaries(): SummaryRow[] {
  return listRows(CLEANING_SUMMARY_KEY) as SummaryRow[]
}

export function savedMonths(): string[] {
  const months = new Set(listSummaries().map((row) => String(row['月份'] ?? '')))
  return [...months].sort().reverse()
}

export function getSnapshot(month: string): SummaryRow[] | null {
  const rows = listSummaries().filter((row) => String(row['月份']) === month)
  return rows.length > 0 ? rows : null
}

/** 快照保存后台账又进了同月份单据时，页面提示可重新归总（不偷偷改已另存的那份）。 */
export function snapshotStale(month: string): boolean {
  const snapshot = getSnapshot(month)
  if (!snapshot) return false
  const totalRow = snapshot.find((row) => String(row['保洁区域']) === '合计')
  if (!totalRow) return false
  const { total } = computeMonthAggregate(month)
  return (
    Number(totalRow['作业单数']) !== total.total ||
    Number(totalRow['清运量合计(车)']) !== total.qty ||
    Number(totalRow['待核单数']) !== total.pending
  )
}

export function saveMonthSummary(month: string, operator = '值班管理员'): { ok: boolean; message: string; total: AreaAggregate } {
  if (!/^\d{4}-\d{2}$/.test(month)) {
    return { ok: false, message: '月份格式应为 YYYY-MM', total: computeMonthAggregate(month).total }
  }
  const { areas, total } = computeMonthAggregate(month)
  if (total.total === 0) {
    return { ok: false, message: `${month} 没有可归总的作业单`, total }
  }
  const savedAt = nowText()
  const rest = listSummaries().filter((row) => String(row['月份']) !== month)
  let seq = listRows(CLEANING_SUMMARY_KEY).reduce((max, row) => Math.max(max, Number(row.id) || 0), 0)
  const created: SummaryRow[] = []
  const orderedAreas = [...areas].sort((a, b) => {
    const ia = CLEANING_AREAS.indexOf(a.area as (typeof CLEANING_AREAS)[number])
    const ib = CLEANING_AREAS.indexOf(b.area as (typeof CLEANING_AREAS)[number])
    return (ia === -1 ? 99 : ia) - (ib === -1 ? 99 : ib)
  })
  for (const agg of [...orderedAreas, total]) {
    seq += 1
    created.push({
      id: seq,
      status: '归总',
      pending: false,
      abnormal: false,
      月份: month,
      保洁区域: agg.area,
      作业单数: agg.total,
      已入账单数: agg.booked,
      待核单数: agg.pending,
      '清运量合计(车)': agg.qty,
      '待核清运量(车)': agg.pendingQty,
      保存时间: savedAt,
    })
  }
  saveRows(CLEANING_SUMMARY_KEY, [...created, ...rest])
  appendHandover({
    类型: '月度归总结论',
    月份: month,
    操作人: operator,
    内容:
      `${month} 保洁作业按保洁区域归总另存：作业单 ${total.total} 笔（已入账 ${total.booked}、待核 ${total.pending}）、` +
      `清运量合计 ${total.qty} 车（其中待核 ${total.pendingQty} 车）。页面归总列表与下载文件取同一快照。`,
  })
  return { ok: true, message: `${month} 归总已另存，下载与页面列表是同一份快照`, total }
}

/** 下载口子：只认已另存的快照，绝不在下载时临时重算。 */
export function exportMonthSummary(month: string): { filename: string; content: string } | null {
  const snapshot = getSnapshot(month)
  if (!snapshot) return null
  const ordered = [...snapshot].sort((a, b) => {
    const ra = String(a['保洁区域'])
    const rb = String(b['保洁区域'])
    if (ra === '合计') return 1
    if (rb === '合计') return -1
    const ia = CLEANING_AREAS.indexOf(ra as (typeof CLEANING_AREAS)[number])
    const ib = CLEANING_AREAS.indexOf(rb as (typeof CLEANING_AREAS)[number])
    return (ia === -1 ? 99 : ia) - (ib === -1 ? 99 : ib)
  })
  return {
    filename: `保洁作业月度归总-${month}.csv`,
    content: toCsv([...SUMMARY_FIELDS], ordered, [...SUMMARY_FIELDS]),
  }
}

export function downloadMonthSummary(month: string): { ok: boolean; message: string } {
  const file = exportMonthSummary(month)
  if (!file) return { ok: false, message: '该月份尚未归总另存，请先另存再下载' }
  const blob = new Blob([file.content], { type: 'text/csv;charset=utf-8' })
  const url = URL.createObjectURL(blob)
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = file.filename
  document.body.appendChild(anchor)
  anchor.click()
  document.body.removeChild(anchor)
  URL.revokeObjectURL(url)
  return { ok: true, message: `已下载 ${file.filename}` }
}
