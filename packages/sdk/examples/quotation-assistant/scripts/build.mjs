import { build } from 'esbuild'
import { mkdir, writeFile, readFile, rm } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
// Local package identity for direct Enterprise import. Creator upload replaces
// it with the platform-assigned work/version identity; it grants no access.
const appId = process.env.POLO_APP_ID || randomUUID()
const version = process.env.POLO_APP_VERSION || '1.0.0'
if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(appId) || !/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(version)) throw new Error('POLO_APP_ID must be a local UUID and POLO_APP_VERSION must be SemVer')
// Creators deriving this example should update these declarations together.
const metadata = {
  enterpriseMetadataVersion: 1,
  name: 'Polo SDK 报价示例',
  description: '根据用户确认的 CSV 单价生成报价建议，核对数量后导出 CSV 和 JSON。',
  icon: '🧾',
  instructions: '在兼容 Polo 宿主中选择 UTF-8 CSV，检查预览后生成；核对项目、单价和数量并确认后导出。AI 建议需要人工复核。',
  author: 'Polo SDK example authors',
  source: 'Polo AI @polo-ai/sdk quotation-assistant example',
}
await rm('dist', { recursive: true, force: true }); await mkdir('dist', { recursive: true })
await build({ entryPoints: ['src/main.ts'], outfile: 'dist/app.js', bundle: true, platform: 'browser', format: 'esm', target: 'es2022', minify: true })
const html = (await readFile('index.html', 'utf8')).replace('</head>', '<link rel="stylesheet" href="./app.css"></head>')
await writeFile('dist/index.html', html)
await writeFile('dist/polo-app.json', JSON.stringify({ schemaVersion: 1, appId, version, ...metadata, runtime: 'static', entry: ['index.html'], healthcheck: '/', webPath: '/', permissions: [] }, null, 2))
console.log('Built dist/ upload payload; Creator assigns the final manifest and identity; Enterprise import keeps local declarations')
