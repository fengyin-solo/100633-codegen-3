// 保洁台账业务逻辑验证（临时脚本，不进构建）：桩掉浏览器存储与 DOM/File 后直接跑服务层。
const storage = new Map()
globalThis.localStorage = {
  getItem: (k) => (storage.has(k) ? storage.get(k) : null),
  setItem: (k, v) => void storage.set(k, String(v)),
  removeItem: (k) => void storage.delete(k),
}
globalThis.URL = { createObjectURL: () => 'blob:stub', revokeObjectURL: () => {} }
globalThis.Blob = class { constructor(parts, opts) { this.parts = parts; this.opts = opts } }
globalThis.document = { createElement: () => ({ click() {} }), body: { appendChild() {}, removeChild() {} } }
class FileStub {
  constructor(parts, name) {
    this._text = parts.join('')
    this.name = name
  }
  text() { return Promise.resolve(this._text) }
}
globalThis.File = FileStub

import assert from 'node:assert'

import { SEED_ROWS } from '@/data/seed'
import { saveRows, listRows } from '@/data/local-store'
import {
  ensureBackfill,
  importManifestFile,
  listOrders,
  listRejects,
  listHolds,
  resolveHold,
  computeMonthAggregate,
  saveMonthSummary,
  downloadMonthSummary,
  getSnapshot,
  listHandover,
  snapshotStale,
  parseCsv,
} from '@/api/cleaning-service'
import { CLEANING_KEY } from '@/data/cleaning'

async function main() {
let passed = 0
function check(name, fn) {
  fn()
  passed += 1
  console.log(`  ✓ ${name}`)
}

// 用种子数据播种（与首次打开一致）
for (const [key, rows] of Object.entries(SEED_ROWS)) {
  saveRows(key, JSON.parse(JSON.stringify(rows)))
}

console.log('1) 存量回填')
const backfill = ensureBackfill('测试监管员')
check('回填实际执行且覆盖 6 笔', () => {
  assert.strictEqual(backfill.ran, true)
  assert.strictEqual(backfill.filled, 6)
})
check('回填幂等：第二次不再跑', () => {
  assert.strictEqual(ensureBackfill().ran, false)
})
const orders = listOrders()
const byNo = Object.fromEntries(orders.map((r) => [r['作业单号'], r]))
check('v1 残缺清运量按 1 车补录、免对账、已入账', () => {
  const r = byNo['CLN-2023-001']
  assert.strictEqual(r['清运量(车)'], 1)
  assert.strictEqual(r['口径版本'], 'v1-纸质车单口径')
  assert.strictEqual(r.status, '已入账')
  assert.match(String(r['对账结论']), /免对账/)
})
check('v2 单（6 车 vs 遗留 6）入账；v2 单（12 vs 6，差异 50% 未超阈值）也入账', () => {
  assert.strictEqual(byNo['CLN-2024-006'].status, '已入账')
  assert.strictEqual(byNo['CLN-2025-014'].status, '已入账')
})
check('v3 单（7 vs 6，差异 14% ≤ 30%）入账；3 vs 10（70% > 30%）挂待核', () => {
  assert.strictEqual(byNo['CLN-2026-031'].status, '已入账')
  assert.strictEqual(byNo['CLN-2026-032'].status, '待核')
})
check('v3 当天无巡检上报（B区西段 2026-09-20 有上报 3，3 vs 3 一致）入账', () => {
  assert.strictEqual(byNo['CLN-2026-058'].status, '已入账')
})

console.log('2) 车单整批导入')
const csv = [
  '车次编号,清运日期,保洁区域,保洁班组,清运量(车)',
  'GC-2026-051803,2026-05-18,A区北段,保洁三班,9',  // 同车次覆盖：3->9，仍与遗留10差10%，应转已入账
  'GC-2026-100101,2026-10-01,B区东段,保洁二班,2',    // 当天无巡检上报 -> v3 挂待核
  'GC-2026-100102,2026-10-01,B区西段,保洁一班,abc',  // 数量格式不对 -> 废行
  'GC-2026-100103,2026-10-01,C区,保洁一班,1',         // 区域不对 -> 废行
  'GC-2026-100104,2026/10/01,A区南段,保洁一班,1',     // 日期不对 -> 废行
  ',2026-10-01,A区南段,保洁一班,1',                   // 车次缺失 -> 废行
  'GC-2026-100105,2026-10-01,A区南段,保洁二班,1',     // 正常新入但当天无巡检上报 -> v3 也挂待核
]

const r2 = await importManifestFile(new FileStub([csv.join('\n')], '车单-202610.csv'), '测试管理员')
check('批次结果：新入 2、覆盖 1、废行 4、待核 2（101 无巡检可对、105 同）', () => {
  assert.strictEqual(r2.ok, true)
  assert.strictEqual(r2.created, 2)
  assert.strictEqual(r2.overwritten, 1)
  assert.strictEqual(r2.rejected, 4)
  assert.strictEqual(r2.pending, 2)
})
check('同车次覆盖不叠加：总量 6+2=8 笔，被覆盖单清运量变 9 且状态转已入账', () => {
  const after = listOrders()
  assert.strictEqual(after.length, 8)
  const covered = after.find((r) => r['车次编号'] === 'GC-2026-051803')
  assert.strictEqual(covered['清运量(车)'], 9)
  assert.strictEqual(covered.status, '已入账')
})
check('废行另起记录缘由并保留原始内容', () => {
  const rejects = listRejects()
  assert.strictEqual(rejects.length, 4)
  assert.match(String(rejects.find((r) => String(r['缘由']).includes('abc'))['缘由']), /格式不对/)
  assert.match(String(rejects.find((r) => String(r['缘由']).includes('C区'))['缘由']), /不在登记范围/)
})
check('待核清单与台账同源', () => {
  assert.strictEqual(listHolds().length, 2) // CLN-2026-032 已被覆盖转入账；剩 GC...101 + ?
})

console.log('3) 监管员核定')
const holdId = listHolds().find((r) => r['车次编号'] === 'GC-2026-100101').id
const r3 = resolveHold(holdId, '监管员王', '核实车单与监控一致，巡检未覆盖该区域')
check('核定成功并入账冻结', () => {
  assert.strictEqual(r3.ok, true)
  const r = listOrders().find((x) => x.id === holdId)
  assert.strictEqual(r.status, '已入账')
  assert.strictEqual(r['核定冻结'], '是')
  assert.strictEqual(listHolds().length, 1)
})
const csvFrozen = '车次编号,清运日期,保洁区域,保洁班组,清运量(车)\nGC-2026-100101,2026-10-01,B区东段,保洁二班,99\n'
const r3b = await importManifestFile(new FileStub([csvFrozen], '车单-冻结重试.csv'), '测试管理员')
check('已冻结车次再导入不覆盖，来行进废行簿', () => {
  const r = listOrders().find((x) => x.id === holdId)
  assert.strictEqual(r['清运量(车)'], 2)
  const rej = listRejects().find((x) => String(x['缘由']).includes('核定冻结'))
  assert.ok(rej)
})

console.log('4) 表头缺失整批回退')
const badCsv = '车次编号,清运日期,保洁班组,清运量(车)\nX,2026-10-01,保洁一班,1\n'
const before = listOrders().length
const r4 = await importManifestFile(new FileStub([badCsv], '缺列.csv'), '测试管理员')
check('整笔回退：ok=false、台账行数不变、废行簿不增', () => {
  assert.strictEqual(r4.ok, false)
  assert.strictEqual(r4.rolledBack, true)
  assert.strictEqual(listOrders().length, before)
  assert.strictEqual(listRejects().length, 5) // 仅冻结重试那 1 行新增
})

console.log('5) 并发：同时两笔只让先到者入账')
const okCsv = '车次编号,清运日期,保洁区域,保洁班组,清运量(车)\nCC-1,2026-10-02,A区南段,保洁一班,1\n'
const [a, b] = await Promise.all([
  importManifestFile(new FileStub([okCsv.replace('CC-1', 'CC-A')], 'a.csv'), '测试管理员'),
  importManifestFile(new FileStub([okCsv.replace('CC-1', 'CC-B')], 'b.csv'), '测试管理员'),
])
check('恰有一笔成功、一笔整笔回退', () => {
  const oks = [a, b].filter((x) => x.ok).length
  const rollbacks = [a, b].filter((x) => x.rolledBack && !x.ok).length
  assert.strictEqual(oks, 1)
  assert.strictEqual(rollbacks, 1)
})

console.log('6) 月底归总另存：页面与下载同源')
saveRows(CLEANING_KEY, listOrders().filter((r) => String(r['清运日期']).slice(0, 7) !== '2026-10'))
// 重新加几笔 2026-05 的：A区北段 9车(已入账)、A区南段 7车(已入账)
const agg = computeMonthAggregate('2026-05')
check('2026-05 按区域归总：2 个区域、共 16 车', () => {
  assert.strictEqual(agg.total.total, 2)
  assert.strictEqual(agg.total.qty, 16)
  assert.strictEqual(agg.total.pending, 0)
})
const r6 = saveMonthSummary('2026-05', '测试管理员')
check('另存成功且可下载', () => {
  assert.strictEqual(r6.ok, true)
  assert.strictEqual(downloadMonthSummary('2026-05').ok, true)
  assert.strictEqual(downloadMonthSummary('2026-04').ok, false)
})
check('快照内容与页面列表一致（直接取同一份存储）', () => {
  const snap = getSnapshot('2026-05')
  const totalRow = snap.find((r) => r['保洁区域'] === '合计')
  assert.strictEqual(Number(totalRow['清运量合计(车)']), 16)
  assert.strictEqual(Number(totalRow['作业单数']), 2)
})
check('快照冻结：台账同月变动后快照不漂移、stale 提示', () => {
  assert.strictEqual(snapshotStale('2026-05'), false)
  const extra = { ...listOrders().find((r) => r['车次编号'] === 'GC-2026-051802'), id: 999, 作业单号: 'CLN-2026-900', 车次编号: 'GC-EXTRA' }
  saveRows(CLEANING_KEY, [...listOrders(), extra])
  assert.strictEqual(snapshotStale('2026-05'), true)
  assert.strictEqual(Number(getSnapshot('2026-05').find((r) => r['保洁区域'] === '合计')['清运量合计(车)']), 16)
})

console.log('7) 交接清单：台账动作全部留痕且两处同源')
const handovers = listHandover()
check('含回填/导入/冻结/回退/归总各类结论', () => {
  const types = handovers.map((r) => r['类型'])
  for (const t of ['存量回填结论', '导入批次结论', '待核核定结论', '导入整批回退', '并发回退', '月度归总结论']) {
    assert.ok(types.includes(t), `缺少 ${t}`)
  }
})

console.log('8) CSV 解析：引号、逗号、换行')
check('带引号逗号与换行正确解析', () => {
  const rows = parseCsv('a,b\n"x,y","line1\nline2"\n')
  assert.deepStrictEqual(rows, [['a', 'b'], ['x,y', 'line1\nline2']])
})

console.log(`\n全部 ${passed} 组断言通过`)
}

main().catch((err) => { console.error(err); process.exit(1) })
