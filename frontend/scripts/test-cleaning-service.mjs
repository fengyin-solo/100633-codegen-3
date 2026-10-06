import assert from 'node:assert/strict'

/* ---- 内存版 localStorage / window，必须在 import 服务前就位 ---- */
const mem = new Map()
globalThis.localStorage = {
  getItem: (k) => (mem.has(k) ? mem.get(k) : null),
  setItem: (k, v) => mem.set(k, String(v)),
  removeItem: (k) => mem.delete(k),
}
globalThis.window = globalThis

const {
  listCleaning,
  listRejects,
  listHandover,
  pendingReviews,
  importVehicleSheet,
  reviewOrder,
  archiveMonth,
  monthSummary,
  cleaningStats,
} = await import('../src/api/cleaning-service.ts')

let pass = 0
const ok = (name, fn) => { fn(); pass += 1; console.log('  ✓', name) }

/* 0. 首次读取即已回填：纸质历史单补 1 车、口径版本落好，既有 2024/已核定保留原判 */
ok('存量按完工日期回填一次：纸质补1车、既有保留原判', () => {
  const all = listCleaning()
  const paper = all.filter((r) => String(r['口径版本']).startsWith('纸质版'))
  assert.ok(paper.length >= 3)
  for (const p of paper) {
    assert.equal(Number(p['清运量']), 1)
    assert.equal(String(p.status), '已入账')
  }
  const confirmed2025 = all.find((r) => String(r['车次编号']) === 'CL-20250315-02')
  assert.equal(String(confirmed2025.status), '已核定')
  assert.equal(String(confirmed2025['口径版本']), '2024版(2024-2025)')
  // 回填结论已进交接清单
  assert.ok(listHandover().some((h) => String(h['类别']) === '存量回填'))
})

/* 1. 整批导入：好行入账、坏行另立、与巡检核对挂待核 */
const sheet = [
  '车次编号,清运日期,保洁区域,保洁班组,清运量',
  'CL-20261006-01,2026-10-06,东区舱,甲班,2',      // 当日无巡检 -> 待核
  'CL-20261001-09,2026-10-01,东区舱,甲班,2',      // 当日巡检2 -> 已入账（新车次）
  'CL-BAD-01,2026-10-06,西区舱,乙班,',             // 清运量缺失 -> 退行
  'CL-BAD-02,2026/13/01,西区舱,乙班,1',            // 日期非法 -> 退行
  'CL-BAD-03,2026-10-06,,乙班,1',                  // 区域缺失 -> 退行
  'CL-20261004-02,2026-10-04,北区舱,丙班,1',       // 巡检5，1车明显不一致 -> 待核
].join('\n')

let report
ok('整批导入：入账/退行/待核分类正确', () => {
  report = importVehicleSheet(sheet)
  assert.equal(report.rolledBack, undefined)
  assert.equal(report.accepted, 3)
  assert.equal(report.rejected, 3)
  assert.equal(report.overwritten, 0)
  const rejects = listRejects().filter((r) => r['批次'] === report.batch)
  assert.equal(rejects.length, 3)
  assert.ok(rejects.every((r) => String(r['缘由']).length > 0))
  const pending = pendingReviews().map((r) => String(r['车次编号']))
  assert.ok(pending.includes('CL-20261006-01'))
  assert.ok(pending.includes('CL-20261004-02'))
  const booked = listCleaning({ status: '已入账' }).find((r) => r['车次编号'] === 'CL-20261001-09')
  assert.ok(booked)
  // 交接清单同步
  assert.ok(listHandover().some((h) => String(h['事项']).includes('批次 ' + report.batch)))
})

/* 2. 同车次重复导入：覆盖不叠加 */
ok('同车次重复导入整笔覆盖、不叠加', () => {
  const before = listCleaning().filter((r) => r['车次编号'] === 'CL-20261001-09').length
  assert.equal(before, 1)
  const r = importVehicleSheet('车次编号,清运日期,保洁区域,保洁班组,清运量\nCL-20261001-09,2026-10-01,东区舱,丁班,3')
  assert.equal(r.overwritten, 1)
  assert.equal(r.accepted, 0)
  const rows = listCleaning().filter((x) => x['车次编号'] === 'CL-20261001-09')
  assert.equal(rows.length, 1)
  assert.equal(String(rows[0]['保洁班组']), '丁班')
  assert.equal(Number(rows[0]['清运量']), 3)
  assert.ok(String(rows[0]['仲裁说明']).includes('覆盖'))
})

/* 3. 已核定单据不被车单反向推翻 */
ok('监管核定权威高于车单：重导不覆盖，写入坏行注明', () => {
  const targetId = listCleaning().find((r) => r['车次编号'] === 'CL-20261004-02').id
  const review = reviewOrder(targetId, '一致入账', '现场核实为分两车运抵')
  assert.equal(review.ok, true)
  const r = importVehicleSheet('车次编号,清运日期,保洁区域,保洁班组,清运量\nCL-20261004-02,2026-10-04,北区舱,丙班,9')
  assert.equal(r.accepted, 0)
  assert.equal(r.rejected, 1)
  const row = listCleaning().find((x) => x['车次编号'] === 'CL-20261004-02')
  assert.equal(String(row.status), '已核定')
  assert.equal(Number(row['清运量']), 1) // 仍是核定值，未被 9 覆盖
  assert.ok(listHandover().some((h) => String(h['事项']).includes('核定为')))
})

/* 4. 待核不符作废 -> 退出归总 */
ok('不符作废退出月底归总', () => {
  const id = listCleaning().find((r) => r['车次编号'] === 'CL-20261006-01').id
  const r = reviewOrder(id, '不符作废', '车次与作业区域不符')
  assert.equal(r.ok, true)
  assert.equal(String(listCleaning().find((x) => Number(x.id) === id).status), '已作废')
})

/* 5. 月底归总：页面函数与另存口径一致（先导入两笔无巡检的待核单，验证待核单列不进量） */
ok('同批不同车次各自唯一入账（为归总准备中控舱待核单）', () => {
  const r = importVehicleSheet('车次编号,清运日期,保洁区域,保洁班组,清运量\nCL-CONC-01,2026-10-07,中控舱,甲班,1\nCL-CONC-02,2026-10-07,中控舱,甲班,1')
  assert.equal(r.accepted, 2)
  assert.equal(listCleaning().filter((x) => String(x['车次编号']).startsWith('CL-CONC')).length, 2)
})

ok('月底按区域归总，待核单列但量不进合计、作废剔除', () => {
  const s = monthSummary('2026-10')
  const east = s.areas.find((a) => a.area === '东区舱')
  // 东区舱：种子 CL-...1001-01=2 + 导入并覆盖后的 CL-...1001-09=3（1006-01 已作废）= 5
  assert.equal(east.totalQty, 5)
  const north = s.areas.find((a) => a.area === '北区舱')
  assert.equal(north.totalQty, 1)
  // 中控舱两笔无巡检挂待核：单列计数，但其量不进正式合计
  const central = s.areas.find((a) => a.area === '中控舱')
  assert.equal(central.pendingCount, 2)
  assert.equal(central.totalQty, 0)
  // 全局待核 = 中控舱2笔 + 种子北区舱 CL-20261004-01 1笔（导入那张已核定）
  assert.equal(s.pendingCount, 3)
  const ar = archiveMonth('2026-10')
  assert.equal(ar.ok, true)
  assert.ok(listHandover().some((h) => String(h['类别']) === '月底另存'))
})

/* 6. 提交串行化：导入与核定共用一把互斥锁，不产生脏写（同刻在途第二笔回退由领域锁单测保证） */
ok('连续提交不产生脏写、各自唯一', () => {
  const r = importVehicleSheet('车次编号,清运日期,保洁区域,保洁班组,清运量\nCL-CONC-01,2026-10-07,中控舱,甲班,1')
  assert.equal(r.accepted, 0) // 已存在 -> 覆盖而非新增
  assert.equal(r.overwritten, 1)
  assert.equal(listCleaning().filter((x) => String(x['车次编号']) === 'CL-CONC-01').length, 1)
})

/* 7. 统计 */
ok('cleaningStats 口径', () => {
  const st = cleaningStats()
  assert.ok(st.booked > 0)
  assert.ok(st.rejected >= 4) // 3 坏行 + 1 核定被车单冲击
})

console.log(`\n通过 ${pass} 项服务层用例`)
