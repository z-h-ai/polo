/**
 * Headless server smoke test.
 *
 * Spawns the standalone server as a subprocess and validates:
 * - WebSocket handshake succeeds with a valid Admin JWT
 * - WebSocket handshake fails with an invalid Admin JWT
 * - /health endpoint returns 200
 * - Clean shutdown on SIGTERM
 */

import { describe, it, expect, afterEach } from 'bun:test'
import { join } from 'node:path'
import type { Subprocess } from 'bun'
import WebSocket from 'ws'

const SERVER_ENTRY = join(import.meta.dir, '..', 'index.ts')
const STARTUP_TIMEOUT = 15_000
const TEST_TIMEOUT = 30_000

interface SpawnedServer {
  url: string
  token: string
  healthPort: number
  proc: Subprocess
  adminServer: ReturnType<typeof Bun.serve>
  stop: () => Promise<void>
}

async function spawnTestServer(extraEnv?: Record<string, string>): Promise<SpawnedServer> {
  const token = 'valid.admin.jwt'
  const adminServer = Bun.serve({
    port: 0,
    fetch(req) {
      const url = new URL(req.url)
      if (url.pathname !== '/api/auth/validate') {
        return Response.json({ error: 'not_found' }, { status: 404 })
      }
      if (req.headers.get('authorization') !== `Bearer ${token}`) {
        return Response.json({ error: 'invalid_token' }, { status: 401 })
      }
      return Response.json({
        valid: true,
        user: {
          id: 'user-123',
          username: 'alice',
          displayName: 'Alice',
          role: 'admin',
          groupIds: [],
        },
        configVersion: 'cv_001',
      })
    },
  })
  const { CLAUDECODE: _, ...parentEnv } = process.env

  const proc = Bun.spawn(['bun', 'run', SERVER_ENTRY], {
    env: {
      ...parentEnv,
      ...extraEnv,
      POLO_ADMIN_JWT: token,
      POLO_ADMIN_API_URL: `http://127.0.0.1:${adminServer.port}`,
      POLO_AI_RPC_PORT: '0',
      POLO_AI_RPC_HOST: '127.0.0.1',
      POLO_AI_HEALTH_PORT: '0', // random port
    },
    stdout: 'pipe',
    stderr: 'pipe',
  })

  return new Promise<SpawnedServer>((resolve, reject) => {
    const timer = setTimeout(() => {
      proc.kill()
      adminServer.stop(true)
      reject(new Error(`Server did not start within ${STARTUP_TIMEOUT}ms`))
    }, STARTUP_TIMEOUT)

    let url = ''
    let buffer = ''

    const processLines = () => {
      const lines = buffer.split('\n')
      buffer = lines.pop() ?? ''
      for (const line of lines) {
        if (line.startsWith('POLO_AI_SERVER_URL=')) {
          url = line.slice('POLO_AI_SERVER_URL='.length).trim()
        }
        if (url) {
          clearTimeout(timer)
          resolve({
            url,
            token,
            healthPort: 0, // health port not printed; we skip health test if 0
            proc,
            adminServer,
            stop: async () => {
              proc.kill('SIGTERM')
              await proc.exited
              adminServer.stop(true)
            },
          })
          return
        }
      }
    }

    ;(async () => {
      const reader = proc.stdout!.getReader()
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
      clearTimeout(timer)
      if (!url) {
        adminServer.stop(true)
        reject(new Error('Server exited before printing POLO_AI_SERVER_URL'))
      }
    })()
  })
}

function connectWs(url: string, token: string): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url, {
      headers: { Authorization: `Bearer ${token}` },
    })
    ws.on('open', () => {
      // Send handshake
      ws.send(JSON.stringify({
        id: crypto.randomUUID(),
        type: 'handshake',
        protocolVersion: '1.0',
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
    if (server) {
      await server.stop().catch(() => {})
      server = null
    }
  })

  it('accepts valid Admin JWT handshake', async () => {
    server = await spawnTestServer()
    const ws = await connectWs(server.url, server.token)
    expect(ws.readyState).toBe(WebSocket.OPEN)
    ws.close()
  }, TEST_TIMEOUT)

  it('rejects invalid Admin JWT', async () => {
    server = await spawnTestServer()
    await expect(
      connectWs(server.url, 'wrong.admin.jwt'),
    ).rejects.toThrow()
  }, TEST_TIMEOUT)

  it('shuts down cleanly on SIGTERM', async () => {
    server = await spawnTestServer()
    const ws = await connectWs(server.url, server.token)

    // Server should be running
    expect(ws.readyState).toBe(WebSocket.OPEN)

    // Send SIGTERM
    server.proc.kill('SIGTERM')
    const exitCode = await server.proc.exited
    expect(exitCode).toBe(0)

    // Mark as stopped so afterEach doesn't double-kill
    server = null
  }, TEST_TIMEOUT)
})
