/**
 * Entry point: builds the harness, then spawns Electron TWICE against the
 * compiled main.cjs — phase "create" (generate + persist + render all
 * entries) and phase "recover" (fresh process re-reads the legacy-corrupted
 * session and renders it). BOTH runs use cwd=/ (the Finder-launch condition).
 * Exit code 0 = every check passed in both phases. Evidence (runtime JSON +
 * screenshots) lands in $POO161_EVIDENCE_DIR (default <build>/evidence).
 */
import { createRequire } from 'node:module'
import { spawn, execSync } from 'node:child_process'
import { join, dirname } from 'node:path'
import { mkdirSync, rmSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const repo = join(here, '..', '..', '..', '..')
const require = createRequire(join(repo, 'package.json'))
const build = process.env.POO161_BUILD_DIR || '/tmp/poo161-canvas-recovery'
const evidence = process.env.POO161_EVIDENCE_DIR || join(build, 'evidence')
mkdirSync(evidence, { recursive: true })

await import('./build.mjs')

// Fresh evidence/workspace per full run (phase pairs always run together).
rmSync(join(build, 'workspace'), { recursive: true, force: true })

let sourceRef = 'unknown'
try {
  sourceRef = execSync('git rev-parse HEAD', { cwd: repo, stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim()
} catch {}

const exe = require('electron')

function runPhase(phase) {
  return new Promise((resolve, reject) => {
    const child = spawn(exe, [join(build, 'main.cjs')], {
      cwd: '/', // THE POO-161 bug condition: Finder launch runs with cwd=/
      stdio: 'inherit',
      env: {
        ...process.env,
        POO161_BUILD_DIR: build,
        POO161_EVIDENCE_DIR: evidence,
        POO161_PHASE: phase,
        POO161_SOURCE_REF: sourceRef,
        POO161_CONFIG_DIR: join(build, 'config'),
        POLO_AI_CONFIG_DIR: join(build, 'config'),
        ELECTRON_ENABLE_LOGGING: '1',
      },
    })
    child.on('exit', (code, signal) => {
      if (code === 0) resolve()
      else reject(new Error(`phase ${phase} exit code=${code} signal=${signal}`))
    })
    child.on('error', reject)
  })
}

try {
  await runPhase('create')
  console.log('[poo161-canvas-recovery] phase create: PASS')
  await runPhase('recover')
  console.log('[poo161-canvas-recovery] phase recover: PASS')
  console.log('[poo161-canvas-recovery] ALL PASS (write-end integrity, read-end recovery, three entries, restart recovery)')
  process.exit(0)
} catch (err) {
  console.error(`[poo161-canvas-recovery] FAIL: ${err.message}`)
  process.exit(1)
}
