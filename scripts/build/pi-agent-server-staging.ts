/**
 * Pi agent server bundle build + staging — testable core.
 *
 * Extracted from scripts/electron-build-main.ts so the REAL build+stage path
 * can be driven by automated tests (temp layouts) instead of only shipping in
 * the packaging entry. The production build arguments come from the single
 * source `piAgentServerBuildArgs` (node-target ESM — the production host is a
 * Node 22 subprocess spawned with ELECTRON_RUN_AS_NODE=1).
 *
 * Failure semantics: these entries THROW on failure (testable); the
 * packaging entry translates throws into process.exit.
 */

import { cpSync, existsSync, mkdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { spawn } from 'bun'
import { piAgentServerBuildArgs } from './pi-build-args.ts'

export interface PiAgentServerStagingLayout {
  /** The package's TypeScript entry (e.g. <pkg>/src/index.ts). */
  sourceEntry: string
  /** The package dist directory the bundle is emitted into. */
  distDir: string
  /** Where the staged bundle is copied to (e.g. electron resources).
   *  Required for staging; build-only callers may omit it. */
  resourceDir?: string
  /**
   * The koffi native module copied next to the staged bundle. Optional only
   * for layouts that do not stage the runtime copy.
   */
  koffiSource?: string
}

/** The staged bundle path inside a layout. */
export function stagedBundlePath(layout: PiAgentServerStagingLayout): string {
  return join(layout.distDir, 'index.js')
}

/**
 * Build the bundle through the SHARED production args
 * (`piAgentServerBuildArgs`, node-target ESM). Throws when the bundler
 * fails or the output does not exist.
 */
export async function buildPiAgentServerBundle(
  layout: PiAgentServerStagingLayout,
  cwd: string,
): Promise<void> {
  mkdirSync(layout.distDir, { recursive: true })
  const proc = spawn({
    cmd: [process.execPath, ...piAgentServerBuildArgs(layout.sourceEntry, layout.distDir)],
    cwd,
    stdout: 'inherit',
    stderr: 'inherit',
  })
  const exitCode = await proc.exited
  if (exitCode !== 0) {
    throw new Error(`pi-agent-server bundle build failed with exit code ${exitCode}`)
  }
  if (!existsSync(stagedBundlePath(layout))) {
    throw new Error(`pi-agent-server bundle output not found at ${stagedBundlePath(layout)}`)
  }
}

/**
 * Stage the built bundle (+ koffi runtime copy when configured): resource
 * dir is RECREATED (never accumulate stale files), then the fresh bundle is
 * copied in.
 */
export function stagePiAgentServerBundleResource(layout: PiAgentServerStagingLayout): void {
  if (!layout.resourceDir) {
    throw new Error('staging requires a resourceDir in the layout')
  }
  if (!existsSync(stagedBundlePath(layout))) {
    throw new Error(`pi-agent-server bundle output not found at ${stagedBundlePath(layout)}`)
  }
  if (layout.koffiSource && !existsSync(layout.koffiSource)) {
    throw new Error(`koffi dependency not found at ${layout.koffiSource}`)
  }

  rmSync(layout.resourceDir, { recursive: true, force: true })
  mkdirSync(layout.resourceDir, { recursive: true })
  cpSync(stagedBundlePath(layout), join(layout.resourceDir, 'index.js'))
  if (layout.koffiSource) {
    cpSync(layout.koffiSource, join(layout.resourceDir, 'node_modules/koffi'), {
      recursive: true,
      force: true,
    })
  }
}
