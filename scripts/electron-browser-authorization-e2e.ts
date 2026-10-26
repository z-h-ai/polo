/** Real Electron action authorization + production managed decider.
 * Default: controlled HTTP model/billing fixtures (NOT a live-model P2 gate).
 * POO113_MANAGED_INPUT: private JSON {connection,apiKey,adminUrl,accessToken,accountId,productSpaceId}
 * obtained from an authenticated Admin client. Live mode never skips billing.
 * POO113_EVIDENCE_DIR: retained evidence destination (no secrets are written).
 */
import { build } from 'esbuild'
import { build as buildRenderer } from 'vite'
import { mkdtempSync, mkdirSync, cpSync, existsSync, readFileSync, symlinkSync, writeFileSync,rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'

const root = join(import.meta.dir, '..')
const temp = mkdtempSync(join(tmpdir(), 'polo-browser-authorization-'))
const evidence = process.env.POO113_EVIDENCE_DIR ?? join(temp, 'evidence')
mkdirSync(evidence, { recursive: true })
symlinkSync(join(root, 'node_modules'), join(temp, 'node_modules'), 'dir')
await build({ absWorkingDir: root, bundle: true, entryPoints: ['apps/electron/e2e/browser-authorization/main.ts'],
  external: ['electron', 'koffi'], platform: 'node', format: 'cjs', outfile: join(temp, 'main.cjs') })
await build({absWorkingDir:root,bundle:true,entryPoints:['apps/electron/e2e/browser-authorization/permission-renderer.ts'],outfile:join(temp,'permission-renderer.js'),platform:'browser',format:'iife',alias:{'@':join(root,'apps/electron/src/renderer')},define:{'process.env.NODE_ENV':'"production"'}})
const rendererCache = process.env.POO113_RENDERER_DIR
if (rendererCache && existsSync(join(rendererCache, 'browser-toolbar.html'))) cpSync(rendererCache, join(temp, 'renderer'), { recursive: true })
else {
  await buildRenderer({ configFile: join(root, 'apps/electron/vite.config.ts'), build: { outDir: join(temp, 'renderer'), sourcemap: false, rollupOptions: { input: { 'browser-toolbar': join(root, 'apps/electron/src/renderer/browser-toolbar.html'), 'browser-empty-state': join(root, 'apps/electron/src/renderer/browser-empty-state.html') } } } })
  if (rendererCache) cpSync(join(temp, 'renderer'), rendererCache, { recursive: true })
}
await build({ bundle: true, entryPoints: [join(root, 'apps/electron/src/preload/browser-toolbar.ts')], external: ['electron'], platform: 'node', format: 'cjs', outfile: join(temp, 'browser-toolbar-preload.cjs') })
const sourceInputs=['packages/shared/src/agent/browser-fast-decider.ts','packages/shared/src/agent/browser-action-authorization.ts','packages/shared/src/agent/browser-tool-runtime.ts','packages/server-core/src/sessions/SessionManager.ts','apps/electron/src/main/browser-cdp.ts','apps/electron/src/main/browser-pane-manager.ts','apps/electron/src/renderer/components/app-shell/input/structured/BrowserActionPermissionRequest.tsx'];
const sourceHash=createHash('sha256');for(const file of sourceInputs)sourceHash.update(file+'\0').update(readFileSync(join(root,file)));
const sourceRef='runtime-sha256:'+sourceHash.digest('hex');
const child = Bun.spawn([require('electron'), join(temp, 'main.cjs')], {
  cwd: root, env: { ...process.env, POO113_EVIDENCE_DIR: evidence, POO113_PROFILE_DIR: join(temp, 'profile'), POO113_SOURCE_REF: sourceRef, POO113_PERMISSION_RENDERER:join(temp,'permission-renderer.js'),POO113_RENDERER_CSS_DIR:join(temp,'renderer/assets') }, stdout: 'inherit', stderr: 'inherit',
})
const code = await child.exited
if(process.env.POO113_EVIDENCE_DIR)rmSync(temp,{recursive:true,force:true})
else for(const name of ['profile','renderer','main.cjs','permission-renderer.js','browser-toolbar-preload.cjs','node_modules'])rmSync(join(temp,name),{recursive:true,force:true})
console.log(JSON.stringify({ evidence, exitCode: code, temporaryRuntimeCleaned:true }))
process.exit(code)
