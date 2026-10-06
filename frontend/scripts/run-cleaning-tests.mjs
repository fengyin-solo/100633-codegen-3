// 保洁台账领域规则 + 服务层端到端测试入口（不依赖浏览器）。
// 用 esbuild 把 TS 即时打包到临时文件后用 node 跑，规避直接执行 TS 与平台二进制占位问题。
import { build } from 'esbuild'
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import path from 'node:path'

const root = path.dirname(fileURLToPath(import.meta.url))
const cases = ['scripts/test-cleaning.mjs', 'scripts/test-cleaning-service.mjs']

for (const entry of cases) {
  const out = path.join(root, '..', 'node_modules', '.tmp', path.basename(entry).replace('.mjs', '.bundle.mjs'))
  await build({ entryPoints: [path.join(root, '..', entry)], bundle: true, platform: 'node', format: 'esm', outfile: out })
  console.log(`\n=== ${entry} ===`)
  execFileSync(process.execPath, [out], { stdio: 'inherit' })
}
