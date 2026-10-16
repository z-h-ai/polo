import { build } from 'esbuild'
import { mkdir, writeFile, readFile, rm } from 'node:fs/promises'
const appId = process.env.POLO_APP_ID
const version = process.env.POLO_APP_VERSION
if (!appId || !/^[A-Za-z0-9][A-Za-z0-9._:@|+-]{0,127}$/.test(appId) || !version || !/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(version)) throw new Error('Set POLO_APP_ID to the published package ID and POLO_APP_VERSION to its version')
await rm('dist', { recursive: true, force: true }); await mkdir('dist/web', { recursive: true })
await build({ entryPoints: ['src/main.ts'], outfile: 'dist/web/app.js', bundle: true, platform: 'browser', format: 'esm', target: 'es2022', minify: true })
const html = (await readFile('index.html', 'utf8')).replace('</head>', '<link rel="stylesheet" href="./app.css"></head>')
await writeFile('dist/web/index.html', html)
await writeFile('dist/polo-app.json', JSON.stringify({ schemaVersion: 1, appId, version, runtime: 'static', entry: ['web'], healthcheck: '/healthz', webPath: '/', permissions: [] }, null, 2))
console.log('Built dist/ for the normal Polo Catalog delivery path')
