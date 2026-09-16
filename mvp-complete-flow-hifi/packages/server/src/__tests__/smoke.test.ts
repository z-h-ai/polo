/**
 * Headless server smoke test.
 *
 * Spawns the standalone server as a subprocess and validates:
 * - WebSocket handshake succeeds with valid token
 * - WebSocket handshake fails with invalid token
 * - Every server has isolated config and runtime/lock directories
 * - Startup failures include child diagnostics and clean all resources
 * - Clean shutdown on SIGTERM
 */

import { afterEach, describe, expect, it } from 'bun:test'
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Subprocess } from 'bun'
import WebSocket from 'ws'

const SERVER_ENTRY = join(import.meta.dir, '..', 'index.ts')
const STARTUP_TIMEOUT = 15_000
const SHUTDOWN_TIMEOUT = 5_000
const TEST_TIMEOUT = 30_000

interface SpawnTestServerOptions {
  token?: string
  extraEnv?: Record<string, string>
  command?: string[]
  startupTimeoutMs?: number
  startupReadyStderr?: string
  traceFile?: string
}

interface SpawnedServer {
  url: string
  token: string
  proc: Subprocess
  tempRoot: string
  configDir: string
  runtimeDir: string
  stop: () => Promise<number>
}

interface SmokeTraceEvent {
  event: 'allocated' | 'started' | 'cleaned' | 'spawn-error'
  instanceId: string
  pid?: number
  url?: string
  tempRoot: string
  configDir: string
  runtimeDir: string
  exitCode?: number
  error?: string
}

function writeTrace(traceFile: string | undefined, event: SmokeTraceEvent): void {
  if (!traceFile) return
  appendFileSync(traceFile, `${JSON.stringify(event)}\n`, 'utf8')
}

function formatStderr(stderr: string): string {
  const trimmed = stderr.trim()
  return trimmed.length > 0 ? trimmed : '<empty>'
}

async function spawnTestServer(options: SpawnTestServerOptions = {}): Promise<SpawnedServer> {
  const token = options.token
    ?? crypto.randomUUID() + crypto.randomUUID() // 72 chars, well above 16 minimum
  const instanceId = crypto.randomUUID()
  const tempParent = process.env.POLO_AI_SMOKE_TEMP_PARENT ?? tmpdir()
  mkdirSync(tempParent, { recursive: true, mode: 0o700 })
  const tempRoot = mkdtempSync(join(tempParent, 'polo-server-smoke-'))
  const configDir = join(tempRoot, 'config')
  const runtimeDir = join(tempRoot, 'runtime')
  mkdirSync(configDir, { recursive: true, mode: 0o700 })
  mkdirSync(runtimeDir, { recursive: true, mode: 0o700 })

  const traceFile = options.traceFile ?? process.env.POLO_AI_SMOKE_TRACE_FILE
  const traceBase = { instanceId, tempRoot, configDir, runtimeDir }
  const { CLAUDECODE: _, ...parentEnv } = process.env
  let proc: Subprocess

  try {
    proc = Bun.spawn(options.command ?? [process.execPath, 'run', SERVER_ENTRY], {
      env: {
        ...parentEnv,
        ...options.extraEnv,
        POLO_AI_SERVER_TOKEN: token,
        POLO_AI_RPC_PORT: '0',
        POLO_AI_RPC_HOST: '127.0.0.1',
        POLO_AI_HEALTH_PORT: '0',
        // These must come after parent/extra env so every smoke child owns its
        // config and .server.lock namespaces even when runners share a parent env.
        POLO_AI_CONFIG_DIR: configDir,
        POLO_AI_SERVER_RUNTIME_DIR: runtimeDir,
      },
      stdout: 'pipe',
      stderr: 'pipe',
    })
  } catch (error) {
    rmSync(tempRoot, { recursive: true, force: true })
    const message = error instanceof Error ? error.message : String(error)
    writeTrace(traceFile, {
      event: 'spawn-error',
      ...traceBase,
      error: message,
    })
    throw new Error(`Failed to spawn smoke server: ${message}`)
  }

  writeTrace(traceFile, {
    event: 'allocated',
    ...traceBase,
    pid: proc.pid,
  })

  let stderr = ''
  let url = ''
  let cleaned = false
  let cleanupPromise: Promise<number> | null = null
  let resolveStartupReady!: () => void
  const startupReadyPromise = new Promise<void>((resolve) => {
    resolveStartupReady = resolve
  })

  const stderrPump = (async () => {
    const reader = (proc.stderr as ReadableStream<Uint8Array>).getReader()
    const decoder = new TextDecoder()
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      stderr += decoder.decode(value, { stream: true })
      if (
        options.startupReadyStderr
        && stderr.includes(options.startupReadyStderr)
      ) {
        resolveStartupReady()
      }
    }
    stderr += decoder.decode()
  })()

  let resolveUrl!: (value: string) => void
  const urlPromise = new Promise<string>((resolve) => {
    resolveUrl = resolve
  })

  const stdoutPump = (async () => {
    const reader = (proc.stdout as ReadableStream<Uint8Array>).getReader()
    const decoder = new TextDecoder()
    let buffer = ''

    const processLines = (flush = false) => {
      const lines = buffer.split('\n')
      buffer = flush ? '' : (lines.pop() ?? '')
      for (const line of lines) {
        if (!url && line.startsWith('POLO_AI_SERVER_URL=')) {
          url = line.slice('POLO_AI_SERVER_URL='.length).trim()
          writeTrace(traceFile, {
            event: 'started',
            ...traceBase,
            pid: proc.pid,
            url,
          })
          resolveUrl(url)
        }
      }
    }

    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      buffer += decoder.decode(value, { stream: true })
      processLines()
    }
    buffer += decoder.decode()
    processLines(true)
  })()

  const removeTempRoot = (exitCode: number) => {
    if (cleaned) return
    cleaned = true
    rmSync(tempRoot, { recursive: true, force: true })
    writeTrace(traceFile, {
      event: 'cleaned',
      ...traceBase,
      pid: proc.pid,
      exitCode,
    })
  }

  const terminateAndClean = (signal: NodeJS.Signals = 'SIGTERM'): Promise<number> => {
    if (cleanupPromise) return cleanupPromise

    cleanupPromise = (async () => {
      if (proc.exitCode === null) {
        proc.kill(signal)
      }

      const exitedBeforeDeadline = await Promise.race([
        proc.exited.then((exitCode) => ({ exitCode })),
        Bun.sleep(SHUTDOWN_TIMEOUT).then(() => null),
      ])

      let exitCode: number
      if (exitedBeforeDeadline) {
        exitCode = exitedBeforeDeadline.exitCode
      } else {
        if (proc.exitCode === null) {
          proc.kill('SIGKILL')
        }
        exitCode = await proc.exited
      }

      await Promise.allSettled([stdoutPump, stderrPump])
      removeTempRoot(exitCode)
      return exitCode
    })()

    return cleanupPromise
  }

  const startupTimeoutMs = options.startupTimeoutMs ?? STARTUP_TIMEOUT
  let timer: ReturnType<typeof setTimeout> | undefined
  const earlyExitPromise = proc.exited.then((exitCode) => {
    if (!url) {
      throw new Error(`Server exited before printing POLO_AI_SERVER_URL (exit=${exitCode})`)
    }
    return url
  })

  try {
    if (options.startupReadyStderr) {
      await Promise.race([
        startupReadyPromise,
        earlyExitPromise,
        Bun.sleep(STARTUP_TIMEOUT).then(() => {
          throw new Error(
            `Server did not publish startup marker within ${STARTUP_TIMEOUT}ms`,
          )
        }),
      ])
    }
    const timeoutPromise = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        reject(new Error(`Server did not start within ${startupTimeoutMs}ms`))
      }, startupTimeoutMs)
    })
    await Promise.race([urlPromise, timeoutPromise, earlyExitPromise])
    if (timer) clearTimeout(timer)
  } catch (error) {
    if (timer) clearTimeout(timer)
    const exitCode = await terminateAndClean()
    await stderrPump
    const message = error instanceof Error ? error.message : String(error)
    throw new Error(
      `${message}; finalExit=${exitCode}; stderr=${formatStderr(stderr)}`,
    )
  }

  return {
    url,
    token,
    proc,
    tempRoot,
    configDir,
    runtimeDir,
    stop: () => terminateAndClean(),
  }
}

function connectWs(url: string, token: string): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url)
    ws.on('open', () => {
      ws.send(JSON.stringify({
        id: crypto.randomUUID(),
        type: 'handshake',
        protocolVersion: '1.0',
        token,
      }))
    })
    ws.on('message', (data) => {
      const msg = JSON.parse(data.toString())
      if (msg.type === 'handshake_ack') {
        resolve(ws)
      } else if (msg.type === 'error') {
        reject(new Error(`Handshake error: ${msg.error?.message}`))
        ws.close()
      }
    })
    ws.on('error', reject)
    ws.on('close', (code, reason) => {
      reject(new Error(`WS closed: ${code} ${reason}`))
    })
  })
}

describe('headless server smoke test', () => {
  let server: SpawnedServer | null = null

  afterEach(async () => {
    if (!server) return
    const stoppedServer = server
    server = null
    await stoppedServer.stop()
    expect(existsSync(stoppedServer.tempRoot)).toBe(false)
    expect(existsSync(stoppedServer.configDir)).toBe(false)
    expect(existsSync(stoppedServer.runtimeDir)).toBe(false)
  })

  it('accepts valid token handshake', async () => {
    server = await spawnTestServer()
    const ws = await connectWs(server.url, server.token)
    expect(ws.readyState).toBe(WebSocket.OPEN)
    ws.close()
  }, TEST_TIMEOUT)

  it('rejects invalid token', async () => {
    server = await spawnTestServer()
    await expect(
      connectWs(server.url, 'wrong-token-that-is-long-enough'),
    ).rejects.toThrow()
  }, TEST_TIMEOUT)

  it('rejects short token at startup with child diagnostics', async () => {
    await expect(
      spawnTestServer({ token: 'short' }),
    ).rejects.toThrow(/exit=.*stderr=.*token|exit=.*stderr=.*Token/i)
  }, TEST_TIMEOUT)

  it('cleans a server that times out before publishing its URL', async () => {
    const stallScript = [
      'process.on("SIGTERM", () => process.exit(0))',
      'console.error("smoke-stall-marker")',
      'setInterval(() => {}, 1000)',
    ].join(';')

    await expect(
      spawnTestServer({
        command: [process.execPath, '-e', stallScript],
        startupTimeoutMs: 100,
        // Start the intentionally short timeout only after the child confirms
        // its signal handler is installed. A busy full-suite runner can take
        // longer than 100 ms merely to schedule a freshly spawned process.
        startupReadyStderr: 'smoke-stall-marker',
      }),
    ).rejects.toThrow(/did not start.*finalExit=0.*smoke-stall-marker/i)
  }, TEST_TIMEOUT)

  it('shuts down cleanly on SIGTERM', async () => {
    server = await spawnTestServer()
    const ws = await connectWs(server.url, server.token)
    expect(ws.readyState).toBe(WebSocket.OPEN)
    ws.close()

    const stoppedServer = server
    server = null
    const exitCode = await stoppedServer.stop()
    expect(exitCode).toBe(0)
    expect(existsSync(stoppedServer.tempRoot)).toBe(false)
  }, TEST_TIMEOUT)
})
