/**
 * Shared build entry for the pi-agent-server production bundle.
 *
 * Single runnable consumer of `piAgentServerBuildArgs` (the single source of
 * the build arguments): the package build script
 * (packages/pi-agent-server `bun run build`), the Docker server image and
 * any other non-TS caller route through here so no target/format definition
 * is ever duplicated.
 */

import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { piAgentServerBuildArgs } from './pi-build-args.ts'

const REPO_ROOT = join(import.meta.dir, '..', '..')
const SRC = join(REPO_ROOT, 'packages', 'pi-agent-server', 'src', 'index.ts')
const OUTDIR = join(REPO_ROOT, 'packages', 'pi-agent-server', 'dist')

mkdirSync(OUTDIR, { recursive: true })
const proc = Bun.spawnSync({
  cmd: [process.execPath, ...piAgentServerBuildArgs(SRC, OUTDIR)],
  cwd: REPO_ROOT,
  stdout: 'inherit',
  stderr: 'inherit',
})
process.exit(proc.exitCode ?? 1)
