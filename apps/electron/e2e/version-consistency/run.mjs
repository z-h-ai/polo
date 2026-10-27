/**
 * Entry point: builds the harness (build.mjs) then spawns Electron against
 * the compiled main.cjs with an isolated profile/evidence dir. Exit code 0 =
 * every version-consistency check passed. Evidence lands in
 * $POO160_EVIDENCE_DIR (default <build>/evidence).
 */
import { createRequire } from 'node:module'
import { spawn, execSync } from 'node:child_process'
import { join, dirname } from 'node:path'
import { mkdirSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const repo = join(here, '..', '..', '..', '..')
const require = createRequire(join(repo, 'package.json'))
const build = process.env.POO160_BUILD_DIR || '/tmp/poo160-version'
const evidence = process.env.POO160_EVIDENCE_DIR || join(build, 'evidence')
mkdirSync(evidence, { recursive: true })

await import('./build.mjs')

let sourceRef = 'unknown'
try {
  sourceRef = execSync('git rev-parse HEAD', { cwd: repo, stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim()
} catch {}

const exe = require('electron')
// Launch against the build DIR (not main.cjs directly): defaultApp mode makes
// app.getVersion() report the Electron runtime, while an app dir carrying
// package.json gives the real app identity, like a packaged build.
const child = spawn(exe, [build], {
  cwd: build,
  stdio: 'inherit',
  env: {
    ...process.env,
    POO160_BUILD_DIR: build,
    POO160_EVIDENCE_DIR: evidence,
    POO160_SOURCE_REF: sourceRef,
    ELECTRON_ENABLE_LOGGING: '1',
  },
})
child.on('exit', (code, signal) => {
  console.log(`[poo160-version] electron exit code=${code} signal=${signal}`)
  process.exit(code ?? 1)
})
