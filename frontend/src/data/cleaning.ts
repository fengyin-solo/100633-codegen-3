/**
 * 保洁作业单台账的数据约定：字段、口径版本、班组/区域字典都集中在这里，
 * 服务层（api/cleaning-service.ts）与页面都只认这一份。
 */
import type { EntryRow } from './types'

/** 存储键：作业单台账、废行簿、待核单、月底归总快照、交接清单结论，全部沿用通用行存储。 */
export const CLEANING_KEY = 'cleaning'
export const CLEANING_REJECT_KEY = 'cleaningReject'
export const CLEANING_SUMMARY_KEY = 'cleaningSummary'
export const CLEANING_HANDOVER_KEY = 'cleaningHandover'

export const CLEANING_FIELDS = [
  '作业单号',
  '车次编号',
  '清运日期',
  '完工日期',
  '保洁区域',
  '保洁班组',
  '清运量(车)',
  '来源',
  '口径版本',
  '对账结论',
] as const

/** 保洁区域字典：巡检路线以区域命名，对账时按「同区域 + 同一天」匹配。 */
export const CLEANING_AREAS = ['A区北段', 'A区南段', 'B区东段', 'B区西段', '中控支线'] as const

export const CLEANING_TEAMS = ['保洁一班', '保洁二班', '保洁三班'] as const

/**
 * 口径版本（改版后的口径只对新记录生效，既有记录按当时口径保留原判）：
 * - v1 纸质车单口径：2023 年及以前。早年只有纸质记录，清运量残缺的统一按「1 车/单」补录，
 *   当时巡检不留电子化问题数，不做事后对账，原判一律保留。
 * - v2 联单口径：2024-01-01 至 2025-12-31。纸质联单与巡检日报并行，
 *   清运量与当天巡检遗留问题数差异超过 50% 才判异常。
 * - v3 车单电子化口径：2026-01-01 起的现行口径。差异超过 30% 即判异常；
 *   当天该区域没有巡检上报、无法对账的，同样先挂待核。
 */
export type CaliberVersion = 'v1-纸质车单口径' | 'v2-联单口径' | 'v3-车单电子化口径'

export const CALIBER_V1: CaliberVersion = 'v1-纸质车单口径'
export const CALIBER_V2: CaliberVersion = 'v2-联单口径'
export const CALIBER_V3: CaliberVersion = 'v3-车单电子化口径'

export const CALIBER_DESC: Record<CaliberVersion, { period: string; tolerance: string; rule: string }> = {
  [CALIBER_V1]: {
    period: '2023-12-31 及以前',
    tolerance: '不对账',
    rule: '只有纸质车单，清运量残缺按 1 车/单补录，按当时口径保留原判，不做事后对账。',
  },
  [CALIBER_V2]: {
    period: '2024-01-01 至 2025-12-31',
    tolerance: '差异 > 50%',
    rule: '联单口径，清运量与当天同区域巡检遗留问题数差异超过 50% 才挂待核。',
  },
  [CALIBER_V3]: {
    period: '2026-01-01 起（现行）',
    tolerance: '差异 > 30%',
    rule: '车单电子化口径，差异超过 30%、或当天该区域无巡检上报可对的，挂待核。',
  },
}

export function caliberOf(dateText: string): CaliberVersion {
  const date = new Date(`${dateText}T00:00:00`)
  if (Number.isNaN(date.getTime())) {
    return CALIBER_V3
  }
  if (date < new Date('2024-01-01T00:00:00')) {
    return CALIBER_V1
  }
  if (date < new Date('2026-01-01T00:00:00')) {
    return CALIBER_V2
  }
  return CALIBER_V3
}

/** 仲裁规则（冲突时以哪一份为准）及依据。 */
export const ARBITRATION_RULES = [
  '① 外部车单文件优先于群消息与手工登记：车单是清运现场的原始凭证，有车次编号可追溯。',
  '② 同一车次编号以后到的导入批次为准并覆盖旧版，不叠加：车次编号唯一，重复拉运不另计。',
  '③ 监管员核定结论优先于系统自动判定：待核单经人工核实后，以核定结论冻结，后续同车次导入不得翻案（除非监管员在巡检侧撤销核定）。',
  '④ 同刻并发提交只让先到者拿锁入账，后到者整笔回退，连一条都不进账：避免同一车单被拆成两笔。',
  '⑤ 月底归总以已入账且未冻结改判的作业单为准，归总快照保存后页面与导出取同一份快照，不再随台账漂移。',
] as const

/** 行状态 */
export const ORDER_STATUS = {
  booked: '已入账',
  pending: '待核',
  rejected: '废行',
} as const

export type CleaningOrder = EntryRow
export type RejectRow = EntryRow
export type HoldRow = EntryRow
export type HandoverRow = EntryRow
export type SummaryRow = EntryRow
