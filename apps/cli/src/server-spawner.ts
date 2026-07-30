/**
 * Server spawner — start a headless Polo AI server as a child process.
 *
 * Spawns `bun run <serverEntry>`, reads stdout for the `POLO_AI_SERVER_URL=`
 * and `POLO_AI_SERVER_TOKEN=` lines, and returns a handle to stop the server.
 */

import { existsSync } from 'node:fs'
import { resolve, join } from 'node:path'
import type { Subprocess } from 'bun'
import { version as cliVersion } from '../package.json'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface SpawnedServer {
  url: string
  token: string
  stop: () => Promise<void>
}

export interface SpawnServerOptions {
  /** Path to the server entry file. Auto-detected from monorepo root if omitted. */
  serverEntry?: string
  /** Extra env vars to pass to the server process. */
  env?: Record<string, string>
  /** How long to wait for the server to print its URL (ms). Default: 30000. */
  startupTimeout?: number
  /** Suppress server stderr output (useful for validation where only test output matters). */
  quiet?: boolean
}

// ---------------------------------------------------------------------------
// Auto-detect server entry
// ---------------------------------------------------------------------------

export function findServerEntry(startDir = import.meta.dir): string {
  if (process.env.POLO_AI_SERVER_ENTRY) {
    if (!existsSync(process.env.POLO_AI_SERVER_ENTRY)) {
      throw new Error(`Packaged server artifact not found: ${process.env.POLO_AI_SERVER_ENTRY}`)
    }
    return process.env.POLO_AI_SERVER_ENTRY
  }

  const packagedCandidate = resolve(startDir, '..', 'server', 'polo-server.js')
  if (existsSync(packagedCandidate)) return packagedCandidate

  // Walk up from this file's directory to find the monorepo root.
  // Expected layout: apps/cli/src/server-spawner.ts → root/packages/server/src/index.ts
  let dir = startDir
  for (let i = 0; i < 10; i++) {
    const candidate = join(dir, 'packages', 'server', 'src', 'index.ts')
    if (existsSync(candidate)) return candidate
    dir = resolve(dir, '..')
  }
  throw new Error(
    'Packaged Polo server artifact is missing. Reinstall Polo or pass --server-entry for development.',
  )
}

export function resolveBunExecutable(): string {
  return process.env.POLO_AI_BUN || process.execPath
}

function inferPackagedEnvironment(serverEntry: string): Record<string, string> {
  if (!serverEntry.endsWith(join('dist', 'server', 'polo-server.js'))) return {}
  const appRoot = resolve(serverEntry, '..', '..', '..')
  return {
    POLO_AI_APP_ROOT: process.env.POLO_AI_APP_ROOT || appRoot,
    POLO_AI_RESOURCES_PATH: process.env.POLO_AI_RESOURCES_PATH || join(appRoot, 'resources'),
    POLO_AI_BUNDLED_ASSETS_ROOT: process.env.POLO_AI_BUNDLED_ASSETS_ROOT || appRoot,
    POLO_AI_IS_PACKAGED: 'true',
    POLO_AI_VERSION: process.env.POLO_AI_VERSION || cliVersion,
  }
}

// ---------------------------------------------------------------------------
// Spawn
// ---------------------------------------------------------------------------

export async function spawnServer(opts?: SpawnServerOptions): Promise<SpawnedServer> {
  const serverEntry = opts?.serverEntry ?? findServerEntry()
  const startupTimeout = opts?.startupTimeout ?? 30_000
  const token = crypto.randomUUID()
  const bunExecutable = resolveBunExecutable()

  // Strip CLAUDECODE to avoid the Claude Agent SDK's nesting guard rejecting
  // subprocess launches when the CLI is invoked from within a Claude Code session.
  const { CLAUDECODE: _, ...parentEnv } = process.env
  const proc: Subprocess = Bun.spawn([bunExecutable, 'run', serverEntry], {
    env: {
      ...parentEnv,
      ...inferPackagedEnvironment(serverEntry),
      ...opts?.env,
      POLO_AI_SERVER_TOKEN: token,
      POLO_AI_RPC_PORT: '0',
      POLO_AI_RPC_HOST: '127.0.0.1',
    },
    stdout: 'pipe',
    stderr: 'pipe',
  })

  // Pipe server stderr to our stderr so --debug logs are visible (unless quiet)
  if (proc.stderr && !opts?.quiet) {
    ;(async () => {
      // @ts-expect-error — Bun Subprocess types don't narrow stderr to ReadableStream when stderr: 'pipe'
      const reader = proc.stderr.getReader()
      try {
        while (true) {
          const { done, value } = await reader.read()
          if (done) break
          process.stderr.write(value)
        }
      } catch {
        // Server exited — normal
      }
    })()
  }

  // Read stdout line by line looking for POLO_AI_SERVER_URL=
  return new Promise<SpawnedServer>((resolve, reject) => {
    const timer = setTimeout(() => {
      proc.kill()
      reject(new Error(`Server did not start within ${startupTimeout}ms`))
    }, startupTimeout)

    let url = ''
    let buffer = ''

    const processLines = () => {
      const lines = buffer.split('\n')
      buffer = lines.pop() ?? '' // keep incomplete last line in buffer
      for (const line of lines) {
        if (line.startsWith('POLO_AI_SERVER_URL=')) {
          url = line.slice('POLO_AI_SERVER_URL='.length).trim()
        }
        if (line.startsWith('POLO_AI_SERVER_TOKEN=')) {
          // Server echoes the token — we already have it but this confirms ready
        }
        // Once we have the URL, the server is ready
        if (url) {
          clearTimeout(timer)
          resolve({
            url,
            token,
            stop: async () => {
              proc.kill('SIGTERM')
              await proc.exited
            },
          })
          return
        }
      }
    }

    ;(async () => {
      // @ts-expect-error — Bun Subprocess types don't narrow stdout to ReadableStream when stdout: 'pipe'
      const reader = proc.stdout.getReader()
      const decoder = new TextDecoder()
      try {
        while (true) {
          const { done, value } = await reader.read()
          if (done) break
          buffer += decoder.decode(value, { stream: true })
          processLines()
        }
      } catch {
        // Stream closed
      }
      // If we get here without resolving, the process exited before printing the URL
      clearTimeout(timer)
      if (!url) {
        reject(new Error('Server process exited before printing POLO_AI_SERVER_URL'))
      }
    })()
  })
}
