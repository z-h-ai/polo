/**
 * Entry point: builds the harness (build.mjs) then spawns Electron against
 * the compiled main.cjs with an isolated profile/evidence dirs. Exit code 0
 * = every check passed. Evidence: $POO196_EVIDENCE_DIR
 * (default /tmp/poo196-experience/evidence).
 */
import { createRequire } from 'node:module'
import { spawn, execSync } from 'node:child_process'
import { join, dirname } from 'node:path'
import { mkdirSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const repo = join(here, '..', '..', '..', '..')
const require = createRequire(join(repo, 'package.json'))
const build = process.env.POO196_BUILD_DIR || '/tmp/poo196-experience/build'
const evidence = process.env.POO196_EVIDENCE_DIR || '/tmp/poo196-experience/evidence'
mkdirSync(evidence, { recursive: true })

await import('./build.mjs')

let sourceRef = 'unknown'
try {
  sourceRef = execSync('git rev-parse HEAD', { cwd: repo, stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim()
} catch {}

const exe = require('electron')
// POO196_CDP_PORT: expose the remote-debugging endpoint so an external
// Playwright driver can attach for credentialed evidence captures (A 级报告).
const cdpArgs = process.env.POO196_CDP_PORT ? [`--remote-debugging-port=${process.env.POO196_CDP_PORT}`] : []
const child = spawn(exe, [...cdpArgs, join(build, 'main.cjs')], {
  cwd: build,
  stdio: 'inherit',
  env: {
    ...process.env,
    POO196_BUILD_DIR: build,
    POO196_EVIDENCE_DIR: evidence,
    POO196_SOURCE_REF: sourceRef,
    ELECTRON_ENABLE_LOGGING: '1',
  },
})
child.on('exit', (code, signal) => {
  console.log(`[poo196-project-context] electron exit code=${code} signal=${signal}`)
  process.exit(code ?? 1)
})
