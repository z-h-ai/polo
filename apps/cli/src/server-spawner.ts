/**
 * Server spawner — start a headless Polo AI server as a child process.
 *
 * Spawns `bun run <serverEntry>`, reads stdout for the `POLO_AI_SERVER_URL=`
 * and `POLO_AI_SERVER_TOKEN=` lines, and returns a handle to stop the server.
 */

import { existsSync } from 'node:fs'
import { resolve, join } from 'node:path'
import type { Subprocess } from 'bun'
import { createSafeRuntimeEnvironment } from '@polo-ai/shared/utils'
import { getProcessBirthIdentity } from './cli-thread-store.ts'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface SpawnedServer {
  url: string
  token: string
  pid: number
  startedAt: number
  processIdentity: string
  diagnostics: () => string
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
  /** First framed message on the inherited parent-death pipe. */
  bootstrapPayload?: unknown
  /** Values removed from the child environment and redacted from diagnostics. */
  secrets?: Array<string | undefined>
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
  }
}

// ---------------------------------------------------------------------------
// Spawn
// ---------------------------------------------------------------------------

export async function spawnServer(opts?: SpawnServerOptions): Promise<SpawnedServer> {
  const serverEntry = opts?.serverEntry ?? findServerEntry()
  const startupTimeout = opts?.startupTimeout ?? 30_000
  const token = crypto.randomUUID()
  const startedAt = Date.now()
  const bunExecutable = resolveBunExecutable()

  const secrets = (opts?.secrets ?? []).filter((value): value is string => !!value)
  const proc: Subprocess = Bun.spawn([bunExecutable, 'run', serverEntry], {
    env: createSafeRuntimeEnvironment(process.env, {
      ...inferPackagedEnvironment(serverEntry),
      ...opts?.env,
      POLO_AI_BUN: bunExecutable,
      POLO_AI_SERVER_TOKEN: token,
      POLO_AI_RPC_PORT: '0',
      POLO_AI_RPC_HOST: '127.0.0.1',
    }),
    stdout: 'pipe',
    stderr: 'pipe',
    stdin: 'pipe',
  })

  if (opts?.bootstrapPayload !== undefined && proc.stdin) {
    const sink = proc.stdin as unknown as { write(value: string): number; flush(): Promise<number> }
    sink.write(`${JSON.stringify(opts.bootstrapPayload)}\n`)
    await sink.flush()
  }

  const redact = (value: string): string => {
    let output = value
    for (const secret of secrets) output = output.split(secret).join('[REDACTED]')
    return output
      .replace(/Authorization\s*:\s*(?:Bearer|Basic)\s+\S+/gi, 'Authorization: [REDACTED]')
      .replace(/\b(?:sk|pk)-[A-Za-z0-9_-]{12,}\b/g, '[REDACTED]')
  }
  const MAX_DIAGNOSTIC_BYTES = 16 * 1024
  let diagnosticBuffer = ''
  let stderrCarry = ''
  const carryLength = Math.max(256, ...secrets.map(secret => secret.length + 64))

  const appendDiagnostics = (value: string): void => {
    diagnosticBuffer = (diagnosticBuffer + value).slice(-MAX_DIAGNOSTIC_BYTES)
  }
  const flushSafeStderr = (final = false): void => {
    const safeLength = final ? stderrCarry.length : Math.max(0, stderrCarry.length - carryLength)
    if (safeLength === 0) return
    const safe = redact(stderrCarry.slice(0, safeLength))
    stderrCarry = stderrCarry.slice(safeLength)
    appendDiagnostics(safe)
    if (!opts?.quiet) process.stderr.write(safe)
  }

  // Always drain stderr. Quiet mode retains only a bounded, redacted tail so a
  // verbose child can never fill the pipe and deadlock the runtime.
  if (proc.stderr) {
    ;(async () => {
      // @ts-expect-error — Bun Subprocess types don't narrow stderr to ReadableStream when stderr: 'pipe'
      const reader = proc.stderr.getReader()
      const decoder = new TextDecoder()
      try {
        while (true) {
          const { done, value } = await reader.read()
          if (done) break
          stderrCarry += decoder.decode(value, { stream: true })
          flushSafeStderr()
        }
        stderrCarry += decoder.decode()
        flushSafeStderr(true)
      } catch {
        // Server exited — normal
        flushSafeStderr(true)
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
          const processIdentity = getProcessBirthIdentity(proc.pid)
          if (!processIdentity) {
            proc.kill()
            reject(new Error(`Could not verify CLI runtime process identity for pid ${proc.pid}`))
            return
          }
          let stopPromise: Promise<void> | null = null
          resolve({
            url,
            token,
            pid: proc.pid,
            startedAt,
            processIdentity,
            diagnostics: () => redact(diagnosticBuffer + stderrCarry).slice(-MAX_DIAGNOSTIC_BYTES),
            stop: async () => {
              if (!stopPromise) {
                stopPromise = (async () => {
                  if (proc.exitCode === null) proc.kill('SIGTERM')
                  const exitCode = await proc.exited
                  if (exitCode !== 0) {
                    throw new Error(`CLI runtime cleanup failed (exit ${exitCode})`)
                  }
                })()
              }
              await stopPromise
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
        const diagnostics = redact(diagnosticBuffer + stderrCarry).slice(-MAX_DIAGNOSTIC_BYTES).trim()
        reject(new Error(
          `Server process exited before printing POLO_AI_SERVER_URL${diagnostics ? `\n${diagnostics}` : ''}`,
        ))
      }
    })()
  })
}
