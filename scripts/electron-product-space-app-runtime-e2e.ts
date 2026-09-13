/**
 * POO-54 acceptance entry: builds and drives a REAL Electron main harness
 * that starts a fixture process App through the real local-app manager and
 * verifies the real loopback local-app-api.v1 boundary end-to-end.
 *
 * Usage: bun run scripts/electron-product-space-app-runtime-e2e.ts
 */
import { mkdtempSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { build } from 'esbuild'

const rootDirectory = join(import.meta.dir, '..')
const temporaryDirectory = mkdtempSync(join(tmpdir(), 'polo-app-runtime-e2e-'))
const mainOutput = join(temporaryDirectory, 'main.cjs')
const fixtureOutput = join(temporaryDirectory, 'fixture-server.js')
const electronExecutable = require('electron') as string

async function main(): Promise<void> {
  symlinkSync(
    join(rootDirectory, 'node_modules'),
    join(temporaryDirectory, 'node_modules'),
    'dir',
  )

  await Promise.all([
    build({
      absWorkingDir: rootDirectory,
      bundle: true,
      entryPoints: ['apps/electron/e2e/product-space-app-runtime/main.ts'],
      external: ['electron', 'koffi'],
      format: 'cjs',
      outfile: mainOutput,
      platform: 'node',
    }),
    build({
      absWorkingDir: rootDirectory,
      bundle: true,
      entryPoints: ['apps/electron/e2e/product-space-app-runtime/fixture-app.ts'],
      format: 'esm',
      outfile: fixtureOutput,
      platform: 'node',
    }),
  ])

  const electron = Bun.spawn([
    electronExecutable,
    mainOutput,
  ], {
    cwd: rootDirectory,
    env: {
      ...process.env,
      // The harness runs the fixture App with the same Bun binary that runs
      // this script (process.execPath is the bun binary under `bun run`).
      POLO_AI_BUN: process.env.POLO_AI_BUN || process.execPath,
      POLO_AI_DISABLE_AUTO_OPEN: '1',
      ELECTRON_ENABLE_LOGGING: '1',
    },
    stderr: 'inherit',
    stdout: 'inherit',
  })

  const exitCode = await electron.exited
  if (exitCode !== 0) {
    throw new Error(`ProductSpace App runtime E2E exited with code ${exitCode}`)
  }
}

main().catch(error => {
  console.error(error)
  process.exit(1)
})
