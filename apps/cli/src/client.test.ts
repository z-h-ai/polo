import { describe, it, expect, afterEach } from 'bun:test'
import { accessSync, constants, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { delimiter, join } from 'node:path'
import { createPrivateKey, X509Certificate } from 'node:crypto'
import { CliRpcClient } from './client.ts'
import {
  serializeEnvelope,
  deserializeEnvelope,
} from '@polo-ai/server-core/transport'
import type { MessageEnvelope } from '@polo-ai/shared/protocol'

// ---------------------------------------------------------------------------
// Mock WS server helpers
// ---------------------------------------------------------------------------

interface MockServer {
  url: string
  port: number
  close: () => void
  lastMessage: () => MessageEnvelope | null
  sendToAll: (envelope: MessageEnvelope) => void
}

function createMockServer(opts?: {
  rejectAuth?: boolean
  noAck?: boolean
  tls?: { cert: string; key: string }
  serverVersion?: string
}): MockServer {
  let lastMsg: MessageEnvelope | null = null
  const clients = new Set<any>()

  const server = Bun.serve({
    port: 0,
    tls: opts?.tls,
    fetch(req, server) {
      if (server.upgrade(req)) return undefined
      return new Response('Not found', { status: 404 })
    },
    websocket: {
      message(ws, message) {
        const raw = typeof message === 'string' ? message : new TextDecoder().decode(message)
        const envelope = deserializeEnvelope(raw)
        lastMsg = envelope

        if (envelope.type === 'handshake') {
          if (opts?.rejectAuth) {
            const error: MessageEnvelope = {
              id: envelope.id,
              type: 'error',
              error: { code: 'AUTH_FAILED', message: 'Invalid token' },
            }
            ws.send(serializeEnvelope(error))
            ws.close()
            return
          }

          if (opts?.noAck) return // Simulate timeout

          const ack: MessageEnvelope = {
            id: crypto.randomUUID(),
            type: 'handshake_ack',
            clientId: 'test-client-001',
            protocolVersion: '1.0',
            serverVersion: opts?.serverVersion,
          }
          ws.send(serializeEnvelope(ack))
          return
        }

        if (envelope.type === 'request') {
          // Default: echo args back as result
          const response: MessageEnvelope = {
            id: envelope.id,
            type: 'response',
            channel: envelope.channel,
            result: envelope.args,
          }
          ws.send(serializeEnvelope(response))
        }
      },
      open(ws) {
        clients.add(ws)
      },
      close(ws) {
        clients.delete(ws)
      },
    },
  })

  const protocol = opts?.tls ? 'wss' : 'ws'
  const port = server.port!
  return {
    url: `${protocol}://127.0.0.1:${port}`,
    port,
    close: () => server.stop(true),
    lastMessage: () => lastMsg,
    sendToAll: (envelope: MessageEnvelope) => {
      const data = serializeEnvelope(envelope)
      for (const ws of clients) ws.send(data)
    },
  }
}

function createErrorServer(): MockServer {
  let lastMsg: MessageEnvelope | null = null
  const clients = new Set<any>()

  const server = Bun.serve({
    port: 0,
    fetch(req, server) {
      if (server.upgrade(req)) return undefined
      return new Response('Not found', { status: 404 })
    },
    websocket: {
      message(ws, message) {
        const raw = typeof message === 'string' ? message : new TextDecoder().decode(message)
        const envelope = deserializeEnvelope(raw)
        lastMsg = envelope

        if (envelope.type === 'handshake') {
          const ack: MessageEnvelope = {
            id: crypto.randomUUID(),
            type: 'handshake_ack',
            clientId: 'test-client-err',
            protocolVersion: '1.0',
          }
          ws.send(serializeEnvelope(ack))
          return
        }

        if (envelope.type === 'request') {
          // Respond with error
          const response: MessageEnvelope = {
            id: envelope.id,
            type: 'response',
            channel: envelope.channel,
            error: { code: 'HANDLER_ERROR', message: 'test error' },
          }
          ws.send(serializeEnvelope(response))
        }
      },
      open(ws) {
        clients.add(ws)
      },
      close(ws) {
        clients.delete(ws)
      },
    },
  })

  const port = server.port!
  return {
    url: `ws://127.0.0.1:${port}`,
    port,
    close: () => server.stop(true),
    lastMessage: () => lastMsg,
    sendToAll: (envelope: MessageEnvelope) => {
      const data = serializeEnvelope(envelope)
      for (const ws of clients) ws.send(data)
    },
  }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

let server: MockServer | null = null

afterEach(() => {
  server?.close()
  server = null
})

describe('CliRpcClient', () => {
  it('connects and completes handshake', async () => {
    server = createMockServer()
    const client = new CliRpcClient(server.url, { token: 'test-token' })
    const clientId = await client.connect()
    expect(clientId).toBe('test-client-001')
    expect(client.isConnected).toBe(true)
    expect(client.clientId).toBe('test-client-001')
    client.destroy()
  })

  it('sends token in handshake', async () => {
    server = createMockServer()
    const client = new CliRpcClient(server.url, { token: 'my-secret' })
    await client.connect()
    const hs = server.lastMessage()
    expect(hs?.type).toBe('handshake')
    expect(hs?.token).toBe('my-secret')
    client.destroy()
  })

  it('rejects on auth failure', async () => {
    server = createMockServer({ rejectAuth: true })
    const client = new CliRpcClient(server.url, { token: 'bad-token' })
    await expect(client.connect()).rejects.toThrow('Invalid token')
    client.destroy()
  })

  it('accepts a compatible server major version', async () => {
    server = createMockServer({ serverVersion: '1.8.0' })
    const client = new CliRpcClient(server.url, { expectedServerVersion: '1.2.0' })
    await client.connect()
    expect(client.serverVersion).toBe('1.8.0')
    client.destroy()
  })

  it('rejects an incompatible server major version', async () => {
    server = createMockServer({ serverVersion: '2.0.0' })
    const client = new CliRpcClient(server.url, { expectedServerVersion: '1.9.0' })
    try {
      await client.connect()
      throw new Error('Expected an incompatible version error')
    } catch (error) {
      expect((error as Error).message).toContain('not compatible')
      expect((error as Error & { code?: string }).code).toBe('VERSION_INCOMPATIBLE')
    }
    client.destroy()
  })

  it('rejects a server that omits its version during validation', async () => {
    server = createMockServer()
    const client = new CliRpcClient(server.url, { expectedServerVersion: '1.9.0' })
    await expect(client.connect()).rejects.toThrow('did not report a version')
    client.destroy()
  })

  it('rejects on connect timeout', async () => {
    server = createMockServer({ noAck: true })
    const client = new CliRpcClient(server.url, { connectTimeout: 200 })
    await expect(client.connect()).rejects.toThrow('Connection timeout')
    client.destroy()
  })

  it('invoke sends request and receives response', async () => {
    server = createMockServer()
    const client = new CliRpcClient(server.url)
    await client.connect()
    const result = await client.invoke('system:homeDir')
    // Mock server echoes args — no args means empty array
    expect(result).toEqual([])
    client.destroy()
  })

  it('invoke passes args correctly', async () => {
    server = createMockServer()
    const client = new CliRpcClient(server.url)
    await client.connect()
    const result = await client.invoke('sessions:get', 'workspace-1')
    expect(result).toEqual(['workspace-1'])
    client.destroy()
  })

  it('invoke rejects on server error', async () => {
    server = createErrorServer()
    const client = new CliRpcClient(server.url)
    await client.connect()
    await expect(client.invoke('system:versions')).rejects.toThrow('test error')
    client.destroy()
  })

  it('invoke rejects on timeout', async () => {
    server = createMockServer({ noAck: false })
    // Create a server that acks handshake but never responds to requests
    server.close()

    const silentServer = Bun.serve({
      port: 0,
      fetch(req, svr) {
        if (svr.upgrade(req)) return undefined
        return new Response('Not found', { status: 404 })
      },
      websocket: {
        message(ws, message) {
          const raw = typeof message === 'string' ? message : new TextDecoder().decode(message)
          const envelope = deserializeEnvelope(raw)
          if (envelope.type === 'handshake') {
            const ack: MessageEnvelope = {
              id: crypto.randomUUID(),
              type: 'handshake_ack',
              clientId: 'silent-client',
              protocolVersion: '1.0',
            }
            ws.send(serializeEnvelope(ack))
          }
          // Never respond to requests
        },
      },
    })

    const client = new CliRpcClient(`ws://127.0.0.1:${silentServer.port}`, { requestTimeout: 200 })
    await client.connect()
    await expect(client.invoke('system:homeDir')).rejects.toThrow('Request timeout')
    client.destroy()
    silentServer.stop(true)
  })

  it('invoke throws when not connected', async () => {
    const client = new CliRpcClient('ws://127.0.0.1:1')
    await expect(client.invoke('system:homeDir')).rejects.toThrow('Not connected')
    client.destroy()
  })

  it('receives push events via on()', async () => {
    server = createMockServer()
    const client = new CliRpcClient(server.url)
    await client.connect()

    const events: unknown[][] = []
    const unsub = client.on('session:event', (...args) => {
      events.push(args)
    })

    // Push an event from server
    server.sendToAll({
      id: crypto.randomUUID(),
      type: 'event',
      channel: 'session:event',
      args: [{ type: 'text_delta', sessionId: 's1', delta: 'hello' }],
    })

    // Give it a tick
    await new Promise((r) => setTimeout(r, 50))

    expect(events.length).toBe(1)
    expect((events[0][0] as any).delta).toBe('hello')

    // Unsubscribe stops delivery
    unsub()
    server.sendToAll({
      id: crypto.randomUUID(),
      type: 'event',
      channel: 'session:event',
      args: [{ type: 'text_delta', sessionId: 's1', delta: 'world' }],
    })

    await new Promise((r) => setTimeout(r, 50))
    expect(events.length).toBe(1) // Still 1
    client.destroy()
  })

  it('destroy closes connection and rejects pending', async () => {
    server = createMockServer({ noAck: false })
    // Use a server that acks but never responds
    server.close()

    const silentServer = Bun.serve({
      port: 0,
      fetch(req, svr) {
        if (svr.upgrade(req)) return undefined
        return new Response('Not found', { status: 404 })
      },
      websocket: {
        message(ws, message) {
          const raw = typeof message === 'string' ? message : new TextDecoder().decode(message)
          const envelope = deserializeEnvelope(raw)
          if (envelope.type === 'handshake') {
            ws.send(serializeEnvelope({
              id: crypto.randomUUID(),
              type: 'handshake_ack',
              clientId: 'destroy-test',
              protocolVersion: '1.0',
            }))
          }
        },
      },
    })

    const client = new CliRpcClient(`ws://127.0.0.1:${silentServer.port}`, { requestTimeout: 5000 })
    await client.connect()

    const pending = client.invoke('system:homeDir')
    client.destroy()

    await expect(pending).rejects.toThrow('Client destroyed')
    expect(client.isConnected).toBe(false)
    silentServer.stop(true)
  })

  it('throws on invoke after destroy', async () => {
    server = createMockServer()
    const client = new CliRpcClient(server.url)
    await client.connect()
    client.destroy()
    await expect(client.invoke('system:homeDir')).rejects.toThrow('Not connected')
  })

  it('connects over wss:// with TLS', async () => {
    await connectOverWssWithGeneratedTls()
  })
})

// ---------------------------------------------------------------------------
// TLS fixture oracle
//
// The fixture DISTINGUISHES "openssl genuinely absent" (the only legitimate
// environmental skip) from "openssl present but broken / fixture invalid"
// (which MUST fail the WSS test — a pass-looking skip would mask real
// regressions in the fixture path).
// ---------------------------------------------------------------------------

/**
 * The WSS handshake regression body. Shared verbatim by the happy-path test
 * and the shadowed-openssl regression so the failure mapping (fixture
 * failure ⇒ thrown error, never a skip) is exercised by both.
 */
async function connectOverWssWithGeneratedTls(): Promise<void> {
  const fixture = generateSelfSignedCert()
  if (fixture.status === 'unavailable') {
    // ONLY legitimate skip: the openssl executable is genuinely absent.
    console.log(`  (skipped: ${fixture.reason})`)
    return
  }
  if (fixture.status === 'failure') {
    throw new Error(`TLS fixture failed: ${fixture.reason}`)
  }
  server = createMockServer({ tls: { cert: fixture.cert, key: fixture.key } })

  const prev = process.env.NODE_TLS_REJECT_UNAUTHORIZED
  process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0'
  try {
    const client = new CliRpcClient(server.url)
    const clientId = await client.connect()
    expect(clientId).toBe('test-client-001')
    expect(server.url.startsWith('wss://')).toBe(true)
    client.destroy()
  } finally {
    if (prev === undefined) {
      delete process.env.NODE_TLS_REJECT_UNAUTHORIZED
    } else {
      process.env.NODE_TLS_REJECT_UNAUTHORIZED = prev
    }
  }
}

describe('TLS fixture oracle', () => {
  it('reports unavailable only when openssl is genuinely absent from PATH', () => {
    const prevPath = process.env.PATH
    try {
      process.env.PATH = join(tmpdir(), `polo-cli-absent-path-${Date.now()}`)
      expect(generateSelfSignedCert().status).toBe('unavailable')
    } finally {
      if (prevPath === undefined) delete process.env.PATH
      else process.env.PATH = prevPath
    }
  })

  it('fails instead of skipping when a broken openssl shadows the real one', () => {
    if (process.platform === 'win32') {
      console.log('  (skipped: POSIX-only stub simulation)')
      return
    }
    let dir: string | null = null
    const prevPath = process.env.PATH
    try {
      dir = mkdtempSync(join(tmpdir(), 'polo-cli-openssl-stub-'))
      const stub = join(dir, 'openssl')
      writeFileSync(stub, '#!/bin/sh\nexit 3\n', { mode: 0o755 })
      // Sanity: the stub must truly be executable, else the simulation
      // below would silently prove nothing.
      accessSync(stub, constants.X_OK)
      process.env.PATH = `${dir}${delimiter}${prevPath ?? ''}`

      const fixture = generateSelfSignedCert()
      expect(fixture.status).toBe('failure')
      expect(fixture.status).not.toBe('unavailable')
      if (fixture.status === 'failure') {
        expect(fixture.reason.length).toBeGreaterThan(0)
      }
    } finally {
      if (prevPath === undefined) delete process.env.PATH
      else process.env.PATH = prevPath
      if (dir !== null) {
        try {
          rmSync(dir, { recursive: true, force: true })
        } catch {
          // best-effort cleanup
        }
      }
    }
  })

  it('wss handshake body rejects (never skips) under a shadowed broken openssl', async () => {
    if (process.platform === 'win32') {
      console.log('  (skipped: POSIX-only stub simulation)')
      return
    }
    let dir: string | null = null
    const prevPath = process.env.PATH
    try {
      dir = mkdtempSync(join(tmpdir(), 'polo-cli-openssl-stub-'))
      const stub = join(dir, 'openssl')
      writeFileSync(stub, '#!/bin/sh\nexit 3\n', { mode: 0o755 })
      accessSync(stub, constants.X_OK)
      process.env.PATH = `${dir}${delimiter}${prevPath ?? ''}`
      await expect(connectOverWssWithGeneratedTls()).rejects.toThrow('TLS fixture failed')
    } finally {
      if (prevPath === undefined) delete process.env.PATH
      else process.env.PATH = prevPath
      if (dir !== null) {
        try {
          rmSync(dir, { recursive: true, force: true })
        } catch {
          // best-effort cleanup
        }
      }
    }
  })
})

// ---------------------------------------------------------------------------
// TLS cert helper — hermetic self-signed fixture.
//
// The key and the cert are each written to their OWN file inside a private
// temp directory, then read back and independently parse-validated
// (createPrivateKey / X509Certificate). Never merge both PEMs through one
// shared stream: under parallel test load a merged /dev/stdout stream
// interleaves or truncates, and Bun.serve then rejects the corrupted key
// with ERR_BORINGSSL DECODE_ERROR. The temp directory is removed in
// `finally` on every path.
//
// The result is a TAGGED union — never a bare null — so the caller can tell
// an environmental skip apart from a real failure:
// - 'unavailable': openssl is genuinely absent from PATH (skip);
// - 'failure': openssl exists but key/cert generation, file read or parse
//   validation failed (the WSS test must FAIL on this);
// - 'ready': usable cert/key pair.
// The availability probe and the openssl spawns both receive the SAME PATH
// snapshot so a test mutating process.env mid-flight can never make the
// probe and the spawn resolve different binaries.
// ---------------------------------------------------------------------------

type TlsFixture =
  | { status: 'ready'; cert: string; key: string }
  | { status: 'unavailable'; reason: string }
  | { status: 'failure'; reason: string }

function generateSelfSignedCert(): TlsFixture {
  const pathEnv = process.env.PATH ?? ''
  if (Bun.which('openssl', { PATH: pathEnv }) === null) {
    return { status: 'unavailable', reason: 'openssl executable not found in PATH' }
  }
  const spawnEnv = { ...process.env, PATH: pathEnv }
  let dir: string | null = null
  try {
    dir = mkdtempSync(join(tmpdir(), 'polo-cli-tls-'))
    const keyPath = join(dir, 'key.pem')
    const certPath = join(dir, 'cert.pem')

    // 1) The EC private key is generated straight into its own file.
    const keyResult = Bun.spawnSync({
      cmd: ['openssl', 'genpkey', '-algorithm', 'EC',
        '-pkeyopt', 'ec_paramgen_curve:prime256v1', '-out', keyPath],
      stdout: 'pipe',
      stderr: 'pipe',
      env: spawnEnv,
    })
    if (keyResult.exitCode !== 0) {
      return { status: 'failure', reason: `openssl key generation failed (exit ${keyResult.exitCode})` }
    }

    // 2) The 1-day self-signed cert is signed FROM that key file into its
    //    own file — no output ever shares a stream with the key.
    const certResult = Bun.spawnSync({
      cmd: ['openssl', 'req', '-x509', '-key', keyPath, '-out', certPath,
        '-days', '1', '-subj', '/CN=localhost', '-batch'],
      stdout: 'pipe',
      stderr: 'pipe',
      env: spawnEnv,
    })
    if (certResult.exitCode !== 0) {
      return { status: 'failure', reason: `openssl certificate signing failed (exit ${certResult.exitCode})` }
    }

    // 3) Read each PEM independently and reject anything that fails to parse
    //    so Bun.serve never sees a structurally broken fixture.
    let key: string
    let cert: string
    try {
      key = readFileSync(keyPath, 'utf8')
      cert = readFileSync(certPath, 'utf8')
    } catch (error) {
      return { status: 'failure', reason: `generated PEM files unreadable: ${String(error)}` }
    }
    try {
      createPrivateKey(key)
      new X509Certificate(cert)
    } catch (error) {
      return { status: 'failure', reason: `generated PEM failed parse validation: ${String(error)}` }
    }
    return { status: 'ready', cert, key }
  } catch (error) {
    // The availability probe already passed, so anything throwing here is a
    // broken fixture — it must FAIL the WSS test, never masquerade as an
    // environmental skip.
    return { status: 'failure', reason: `unexpected fixture error: ${String(error)}` }
  } finally {
    if (dir !== null) {
      try {
        rmSync(dir, { recursive: true, force: true })
      } catch {
        // best-effort cleanup of a private temp directory
      }
    }
  }
}
