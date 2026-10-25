/** Historical P1 reproduction: pre-P2 runtime + production managed decider.
 * Current Host authorization is verified by electron-browser-authorization-e2e.ts.
 * Default: controlled HTTP model/billing fixtures (NOT a live-model P2 gate).
 * POO113_MANAGED_INPUT: private JSON {connection,apiKey,adminUrl,accessToken,accountId,productSpaceId}
 * obtained from an authenticated Admin client. Live mode never skips billing.
 * POO113_EVIDENCE_DIR: retained evidence destination (no secrets are written).
 */
import { build } from 'esbuild'
import { build as buildRenderer } from 'vite'
import { mkdtempSync, mkdirSync, cpSync, existsSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'

const root = join(import.meta.dir, '..')
const temp = mkdtempSync(join(tmpdir(), 'polo-managed-browser-'))
const evidence = process.env.POO113_EVIDENCE_DIR ?? join(temp, 'evidence')
mkdirSync(evidence, { recursive: true })
symlinkSync(join(root, 'node_modules'), join(temp, 'node_modules'), 'dir')
// Exact pre-fix implementation, compiled against this branch's unchanged dependencies.
const baseline = execFileSync('git', ['show', '253781a3:packages/shared/src/agent/browser-fast-decider.ts'], { cwd: root, encoding: 'utf8' })
  .replace(/from '([.][^']+)'/g, (_, path: string) => `from '${join(root, 'packages/shared/src/agent', path)}'`)
writeFileSync(join(temp, 'baseline.ts'), baseline)
const baselineCdp = execFileSync('git', ['show', '253781a3:apps/electron/src/main/browser-cdp.ts'], { cwd: root, encoding: 'utf8' })
  .replace(/from '([.][^']+)'/g, (_, path: string) => `from '${join(root, 'apps/electron/src/main', path)}'`)
writeFileSync(join(temp, 'baseline-cdp.ts'), baselineCdp)
// Preserve the P1 experiment without bypassing current product authorization.
const p1Runtime = execFileSync('git', ['show', '253781a3:packages/shared/src/agent/browser-tool-runtime.ts'], { cwd: root, encoding: 'utf8' })
  .replace(/from '([.][^']+)'/g, (_, path: string) => `from '${join(root, 'packages/shared/src/agent', path)}'`)
writeFileSync(join(temp, 'p1-runtime.ts'), p1Runtime)
await build({ absWorkingDir: root, bundle: true, entryPoints: ['apps/electron/e2e/browser-managed/main.ts'],
  external: ['electron', 'koffi'], platform: 'node', format: 'cjs', outfile: join(temp, 'main.cjs'),
  alias: { '__poo113_p1_runtime__': join(temp, 'p1-runtime.ts'), '__poo113_baseline__': join(temp, 'baseline.ts'), '__poo113_baseline_cdp__': join(temp, 'baseline-cdp.ts') },
})
const rendererCache = process.env.POO113_RENDERER_DIR
if (rendererCache && existsSync(join(rendererCache, 'browser-toolbar.html'))) cpSync(rendererCache, join(temp, 'renderer'), { recursive: true })
else {
  await buildRenderer({ configFile: join(root, 'apps/electron/vite.config.ts'), build: { outDir: join(temp, 'renderer'), sourcemap: false, rollupOptions: { input: { 'browser-toolbar': join(root, 'apps/electron/src/renderer/browser-toolbar.html'), 'browser-empty-state': join(root, 'apps/electron/src/renderer/browser-empty-state.html') } } } })
  if (rendererCache) cpSync(join(temp, 'renderer'), rendererCache, { recursive: true })
}
await build({ bundle: true, entryPoints: [join(root, 'apps/electron/src/preload/browser-toolbar.ts')], external: ['electron'], platform: 'node', format: 'cjs', outfile: join(temp, 'browser-toolbar-preload.cjs') })
const sourceRef = 'historical-p1-runtime-253781a3/current-decider-cdp-sha256:' + createHash('sha256').update(readFileSync(join(root, 'packages/shared/src/agent/browser-fast-decider.ts'))).update(readFileSync(join(root, 'packages/server-core/src/sessions/SessionManager.ts'))).update(readFileSync(join(root, 'apps/electron/src/main/browser-cdp.ts'))).digest('hex')
const child = Bun.spawn([require('electron'), join(temp, 'main.cjs')], {
  cwd: root, env: { ...process.env, POO113_EVIDENCE_DIR: evidence, POO113_PROFILE_DIR: join(temp, 'profile'), POO113_SOURCE_REF: sourceRef }, stdout: 'inherit', stderr: 'inherit',
})
const code = await child.exited
console.log(JSON.stringify({ evidence, exitCode: code }))
process.exit(code)
