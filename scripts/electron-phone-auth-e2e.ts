import { build } from 'esbuild'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const rootDirectory = join(import.meta.dir, '..')
const temporaryDirectory = mkdtempSync(join(tmpdir(), 'polo-phone-auth-e2e-'))
const mainOutput = join(temporaryDirectory, 'main.cjs')
const preloadOutput = join(temporaryDirectory, 'preload.cjs')
const electronExecutable = require('electron') as string

try {
  await Promise.all([
    build({
      absWorkingDir: rootDirectory,
      bundle: true,
      entryPoints: ['apps/electron/e2e/phone-auth/main.ts'],
      external: ['electron'],
      format: 'cjs',
      outfile: mainOutput,
      platform: 'node',
    }),
    build({
      absWorkingDir: rootDirectory,
      bundle: true,
      entryPoints: ['apps/electron/e2e/phone-auth/preload.ts'],
      external: ['electron'],
      format: 'cjs',
      outfile: preloadOutput,
      platform: 'node',
    }),
  ])

  const processHandle = Bun.spawn(
    [electronExecutable, mainOutput, preloadOutput, rootDirectory],
    {
      cwd: rootDirectory,
      stderr: 'inherit',
      stdout: 'inherit',
    },
  )
  const exitCode = await processHandle.exited
  if (exitCode !== 0) {
    process.exitCode = exitCode
  }
} finally {
  rmSync(temporaryDirectory, { force: true, recursive: true })
}
