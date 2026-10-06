import assert from 'node:assert/strict'
import {
  atomicCommit,
  arbitrate,
  buildPatrolIndex,
  businessDate,
  checkImportRow,
  CommitLock,
  monthOf,
  normalizeDate,
  parseCsv,
  policyForYear,
  reconcileQty,
  summarizeMonth,
  toCsv,
  CURRENT_POLICY,
  POLICY_2024,
} from '../src/data/cleaning.ts'

let pass = 0
const ok = (name, fn) => { fn(); pass += 1; console.log('  ✓', name) }

/* 1. CSV 解析：引号/逗号/BOM */
ok('parseCsv 处理 BOM、引号与字段内逗号', () => {
  const rows = parseCsv('﻿车次编号,清运日期\n"A,B",2026-10-01\nX,2026-10-02')
  assert.deepEqual(rows[0], ['车次编号', '清运日期'])
  assert.deepEqual(rows[1], ['A,B', '2026-10-01'])
  assert.equal(rows.length, 3)
})

/* 2. 日期归一化 */
ok('normalizeDate 支持 - / . 与非法日期退行', () => {
  assert.equal(normalizeDate('2026/10/6'), '2026-10-06')
  assert.equal(normalizeDate('2026-13-01'), '')
  assert.equal(normalizeDate('10-06-2026'), '')
})

/* 3. 逐行校验：坏行收集全部缘由 */
ok('checkImportRow 数量缺失/格式不对逐因列出', () => {
  const bad = checkImportRow(['', '2026-10-06', '', '', ''])
  assert.equal(bad.ok, false)
  assert.ok(bad.reasons.includes('车次编号缺失'))
  assert.ok(bad.reasons.includes('保洁区域缺失'))
  assert.ok(bad.reasons.includes('清运量缺失'))
  const good = checkImportRow(['CL-1', '2026-10-06', '东区舱', '甲班', '2'])
  assert.equal(good.ok, true)
  if (good.ok) assert.equal(good.data.清运量, 2)
  const neg = checkImportRow(['CL-2', '2026-10-06', '东区舱', '甲班', '-3'])
  assert.equal(neg.ok, false)
})

/* 4. 口径版本按年份 */
ok('policyForYear 分段', () => {
  assert.equal(policyForYear(2023).key, 'paper')
  assert.equal(policyForYear(2024).key, 'v2024')
  assert.equal(policyForYear(2026).key, 'v2026')
  assert.equal(CURRENT_POLICY.key, 'v2026')
})

/* 5. 巡检核对 */
const patrol = [
  { id: 1, 巡检路线: '东区舱 综合舱', 完成时间: '2026-10-01', 发现问题数: 2 },
  { id: 2, 巡检路线: '北区舱 综合舱', 完成时间: '2026-10-04', 发现问题数: 5 },
]
const idx = buildPatrolIndex(patrol, ['东区舱', '北区舱'])
ok('核对一致 -> 已入账', () => {
  const r = reconcileQty('东区舱', '2026-10-01', 2, POLICY_2024, idx)
  assert.equal(r.status, '已入账')
})
ok('明显不一致 -> 待核', () => {
  const r = reconcileQty('北区舱', '2026-10-04', 1, POLICY_2024, idx)
  assert.equal(r.status, '待核')
  assert.ok(r.reason.includes('明显不一致'))
})
ok('当日无巡检 -> 待核', () => {
  const r = reconcileQty('东区舱', '2026-10-20', 3, POLICY_2024, idx)
  assert.equal(r.status, '待核')
  assert.ok(r.reason.includes('无遗留问题上报'))
})
ok('纸质口径不核对', () => {
  const r = reconcileQty('东区舱', '2026-10-20', 9, policyForYear(2023), idx)
  assert.equal(r.status, '已入账')
})

/* 6. 月底归总：待核/作废不计入 */
const orders = [
  { id: 1, status: '已入账', 保洁区域: '东区舱', 清运量: 2, 作业日期: '2026-10-01' },
  { id: 2, status: '已核定', 保洁区域: '东区舱', 清运量: 1, 清运日期: '2026-10-02' },
  { id: 3, status: '待核', 保洁区域: '北区舱', 清运量: 1, 作业日期: '2026-10-04' },
  { id: 4, status: '已作废', 保洁区域: '南区舱', 清运量: 9, 完工日期: '2026-10-05' },
  { id: 5, status: '已入账', 保洁区域: '西区舱', 清运量: 3, 作业日期: '2026-09-30' },
]
ok('summarizeMonth 按区域合计、待核单列不进量、作废与跨月剔除', () => {
  const s = summarizeMonth(orders, '2026-10', 'now')
  assert.equal(s.totalQty, 3)                 // 仅东区舱两笔已入账 2+1
  assert.equal(s.totalOrders, 2)              // 只数已入账/已核定
  assert.equal(s.pendingCount, 1)             // 北区舱待核单列
  const east = s.areas.find((a) => a.area === '东区舱')
  assert.equal(east.totalQty, 3)
  assert.equal(east.bookedCount, 2)
  const north = s.areas.find((a) => a.area === '北区舱')
  assert.equal(north.pendingCount, 1)
  assert.equal(north.pendingQty, 1)
  assert.equal(north.totalQty, 0)             // 待核的量不进正式合计
  assert.ok(!s.areas.some((a) => a.area === '南区舱')) // 已作废剔除
  assert.ok(!s.areas.some((a) => a.area === '西区舱')) // 跨月剔除
})

/* 7. 仲裁：监管核定 > 车单 > 纸质；同源新批次胜 */
ok('arbitrate 权威等级与新批次覆盖', () => {
  const fixed = { 数据来源: '监管核定', 导入批次: 'b1' }
  const sheet = { 数据来源: '车单导入', 导入批次: 'b2' }
  assert.equal(arbitrate(fixed, sheet).winner, 'existing')
  assert.equal(arbitrate(sheet, fixed).winner, 'incoming')
  const oldSheet = { 数据来源: '车单导入', 导入批次: '2026-10-01 09:00:00' }
  const newSheet = { 数据来源: '车单导入', 导入批次: '2026-10-02 09:00:00' }
  assert.equal(arbitrate(oldSheet, newSheet).winner, 'incoming')
  const dup = { 数据来源: '车单导入', 导入批次: 'b2' }
  assert.equal(arbitrate(dup, { ...dup }).winner, 'existing')
})

/* 8. 并发互斥：同刻第二笔整笔回退 */
ok('CommitLock 先到入账、后到回退（零写入）', () => {
  const lock = new CommitLock()
  let writes = 0
  let nested
  // 第一笔提交“在途”（fn 尚未返回）时，第二笔同刻进来 → 必须整笔回退。
  const r1 = atomicCommit(lock, () => {
    writes += 1
    nested = atomicCommit(lock, () => { writes += 1; return 'second' })
    return 'first'
  })
  assert.equal(r1, 'first')
  assert.deepEqual(nested, { rolledBack: true })
  assert.equal(writes, 1)
  // 第一笔放行后，锁已释放，下一笔可正常入账。
  const r3 = atomicCommit(lock, () => { writes += 1; return 'third' })
  assert.equal(r3, 'third')
  assert.equal(writes, 2)
})

/* 9. toCsv 往返 */
ok('toCsv/parseCsv 往返一致', () => {
  const csv = toCsv([['a', 'x,y'], ['b', 1]])
  const back = parseCsv(csv)
  assert.deepEqual(back[0], ['a', 'x,y'])
  assert.deepEqual(back[1], ['b', '1'])
})

/* 10. businessDate / monthOf 取值轴 */
ok('businessDate 优先作业日期，monthOf 取年月', () => {
  assert.equal(businessDate({ 清运日期: '2026-10-02' }), '2026-10-02')
  assert.equal(businessDate({ 完工日期: '2023-05-12' }), '2023-05-12')
  assert.equal(monthOf('2026-10-02'), '2026-10')
})

console.log(`\n通过 ${pass} 项`)
