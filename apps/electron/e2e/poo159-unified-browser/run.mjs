/**
 * Entry point: builds the harness (build.mjs) then spawns Electron against
 * the compiled main.cjs with isolated profile/evidence dirs. Exit code 0 =
 * every loop check passed. Evidence JSON + screenshots land in
 * $POO159_EVIDENCE_DIR (default <build>/evidence).
 */
import { createRequire } from 'node:module'
import { spawn, execSync } from 'node:child_process'
import { join, dirname } from 'node:path'
import { mkdirSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const repo = join(here, '..', '..', '..', '..')
const require = createRequire(join(repo, 'package.json'))
const build = process.env.POO159_BUILD_DIR || '/tmp/poo159-unified-browser'
const evidence = process.env.POO159_EVIDENCE_DIR || join(build, 'evidence')
mkdirSync(evidence, { recursive: true })

await import('./build.mjs')

let sourceRef = process.env.POO159_SOURCE_REF || 'unknown'
try {
  if (!process.env.POO159_SOURCE_REF) sourceRef = execSync('git rev-parse HEAD', { cwd: repo, stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim()
} catch {}

const exe = require('electron')
const child = spawn(exe, [join(build, 'main.cjs')], {
  cwd: build,
  stdio: 'inherit',
  env: {
    ...process.env,
    POO159_BUILD_DIR: build,
    POO159_EVIDENCE_DIR: evidence,
    POO159_SOURCE_REF: sourceRef,
    ELECTRON_ENABLE_LOGGING: '1',
  },
})
child.on('exit', (code, signal) => {
  console.log(`[poo159-unified-browser] electron exit code=${code} signal=${signal}`)
  process.exit(code ?? 1)
})
