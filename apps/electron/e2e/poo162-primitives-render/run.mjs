/**
 * Entry: build then spawn Electron. Exit 0 = menu/submenu/WorkbenchSelect all
 * render for real and the submenu stays inside the viewport.
 */
import { createRequire } from 'node:module'
import { spawn } from 'node:child_process'
import { join, dirname } from 'node:path'
import { mkdirSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const repo = join(here, '..', '..', '..', '..')
const require = createRequire(join(repo, 'package.json'))
const build = process.env.POO162_BUILD_DIR || '/tmp/poo162-primitives-render'
const evidence = process.env.POO162_EVIDENCE_DIR || join(build, 'evidence')
mkdirSync(evidence, { recursive: true })

await import('./build.mjs')

// This worktree's electron dist may be unbuilt; inject an explicit binary
// via POO162_ELECTRON_BIN in that case (never reference another worktree).
function resolveElectron() {
  if (process.env.POO162_ELECTRON_BIN) return process.env.POO162_ELECTRON_BIN
  try {
    const local = require('electron')
    require('node:fs').accessSync(join(local, 'Contents', 'MacOS', 'Electron'))
    return local
  } catch {
    console.error('[poo162-primitives-render] local electron dist is missing; run `bun install` in this worktree or set POO162_ELECTRON_BIN')
    process.exit(1)
  }
}
const exe = resolveElectron()
const child = spawn(exe, [join(build, 'main.cjs')], {
  cwd: build,
  stdio: 'inherit',
  env: { ...process.env, POO162_BUILD_DIR: build, POO162_EVIDENCE_DIR: evidence, ELECTRON_ENABLE_LOGGING: '1' },
})
child.on('exit', (code, signal) => {
  console.log(`[poo162-primitives-render] electron exit code=${code} signal=${signal}`)
  process.exit(code ?? 1)
})
