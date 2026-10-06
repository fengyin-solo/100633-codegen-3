import { SEED_ROWS } from './seed'
import type { EntryRow } from './types'

// 本地持久化：数据放在 localStorage 里，刷新、关掉再打开都还在。
const STORAGE_KEY = 'urban-utility-tunnel:entries'
// 保洁存量回填标记：回填只做一次；重置保洁模块时一并清掉，好让种子重新走一遍。
export const CLEANING_BACKFILL_FLAG = 'urban-utility-tunnel:cleaning-backfill-v1'

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T
}

/* ------------------------------------------------------------------ *
 * 存量保洁作业单回填（一次性、幂等）
 * 以完工日期为轴选当年口径；取值残缺按当年那版补齐；已有终局结论的保留原判。
 * 放在存储层是为了让“读出来即已回填”，避免循环依赖 service。
 * ------------------------------------------------------------------ */

type BackfillPolicy = { label: string; fallbackQty: number | null; reconcile: boolean; note: string }

const POLICY_PAPER: BackfillPolicy = {
  label: '纸质版(2023年以前)',
  fallbackQty: 1,
  reconcile: false,
  note: '纸质车单一车一记，无电子巡检可比对，残缺车次按1车补录，保留原判不重新核对。',
}
const POLICY_2024: BackfillPolicy = { label: '2024版(2024-2025)', fallbackQty: 1, reconcile: true, note: '清运量按车计，容差1车。' }
const POLICY_2026: BackfillPolicy = { label: '2026版(现行)', fallbackQty: null, reconcile: true, note: '现行口径，残缺不估算。' }

function policyForYear(year: number): BackfillPolicy {
  if (year <= 2023) return POLICY_PAPER
  if (year <= 2025) return POLICY_2024
  return POLICY_2026
}

function backfillCleaning(orders: EntryRow[]): { rows: EntryRow[]; ran: boolean; filled: number; kept: number } {
  let filled = 0
  let kept = 0
  const rows = orders.map((row) => {
    const updated: EntryRow = { ...row }
    const date = String(updated['作业日期'] || updated['清运日期'] || updated['完工日期'] || '')
    const year = Number(date.slice(0, 4))
    const policy = Number.isFinite(year) ? policyForYear(year) : POLICY_PAPER
    updated['口径版本'] = policy.label

    if (!updated['作业日期'] && date) {
      updated['作业日期'] = date
      filled += 1
    }
    const qty = Number(updated['清运量'])
    if (!Number.isFinite(qty) || qty <= 0) {
      if (policy.fallbackQty !== null) {
        updated['清运量'] = policy.fallbackQty
        updated['补录口径'] = `按${policy.label}残缺车次补${policy.fallbackQty}车`
        filled += 1
      } else {
        updated['补录口径'] = `${policy.label}不允许估算，残缺清运量留待监管核定`
      }
    }
    if (!updated['数据来源']) updated['数据来源'] = '纸质补录'
    if (!updated['导入批次']) updated['导入批次'] = `backfill-${date || 'unknown'}`

    const hasVerdict = ['已入账', '已核定', '待核', '已作废'].includes(String(updated.status))
    if (hasVerdict) {
      kept += 1
    } else if (!policy.reconcile) {
      updated.status = '已入账'
      updated.pending = false
      updated['核对说明'] = policy.note
    } else if (!Number(updated['清运量'])) {
      updated.status = '待核'
      updated.pending = true
      updated['核对说明'] = '回填后清运量仍残缺，按现行口径不估算，挂待核'
    } else {
      updated.status = '已入账'
      updated['核对说明'] = `回填按${policy.label}入账，保留当时口径`
    }
    return updated
  })
  return { rows, ran: true, filled, kept }
}

function readStorage(): Record<string, EntryRow[]> {
  const fallback = clone(SEED_ROWS)
  if (typeof window === 'undefined' || !window.localStorage) {
    return fallback
  }
  const raw = window.localStorage.getItem(STORAGE_KEY)
  let data: Record<string, EntryRow[]>
  if (!raw) {
    data = fallback
  } else {
    try {
      data = { ...fallback, ...(JSON.parse(raw) as Record<string, EntryRow[]>) }
    } catch {
      data = fallback
    }
  }

  // 保洁存量只回填一次：首次读到且未打过标记时执行。
  if (data['cleaning'] && !window.localStorage.getItem(CLEANING_BACKFILL_FLAG)) {
    const result = backfillCleaning(data['cleaning'])
    data = { ...data, cleaning: result.rows }
    const handover = data['cleaningHandover'] ? [...data['cleaningHandover']] : []
    handover.push({
      id: handover.reduce((m, r) => Math.max(m, Number(r.id) || 0), 0) + 1,
      status: '已交接',
      pending: false,
      abnormal: false,
      时间: new Date().toISOString().replace('T', ' ').slice(0, 19),
      类别: '存量回填',
      事项: `存量保洁作业单按完工日期回填一次：共${result.rows.length}单，补齐残缺值${result.filled}项，保留原判${result.kept}单。`,
    })
    data = { ...data, cleaningHandover: handover }
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(data))
    window.localStorage.setItem(CLEANING_BACKFILL_FLAG, new Date().toISOString())
  }

  if (!raw) {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(data))
  }
  return data
}

let cache: Record<string, EntryRow[]> | null = null

export function allRows(): Record<string, EntryRow[]> {
  if (cache === null) {
    cache = readStorage()
  }
  return cache
}

export function listRows(key: string): EntryRow[] {
  return allRows()[key] ?? []
}

export function saveRows(key: string, rows: EntryRow[]): void {
  const next = { ...allRows(), [key]: rows }
  cache = next
  if (typeof window !== 'undefined' && window.localStorage) {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(next))
  }
}

export function resetRows(key: string): EntryRow[] {
  const rows = clone(SEED_ROWS[key] ?? [])
  saveRows(key, rows)
  // 重置保洁模块时清掉回填标记，让历史种子按当年口径再回填一次。
  if (key === 'cleaning' && typeof window !== 'undefined' && window.localStorage) {
    window.localStorage.removeItem(CLEANING_BACKFILL_FLAG)
    cache = null
    allRows()
  }
  return rows
}

export function storageKey(): string {
  return STORAGE_KEY
}
