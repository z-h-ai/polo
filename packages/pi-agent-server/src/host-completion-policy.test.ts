/**
 * POO-69 host transport seam regression.
 *
 * Covers the fetch URL policy (string/URL/Request inputs, exact base +
 * descendant paths, userinfo/fragment/origin/path/encoding rejections,
 * redirect:'error' with a real second-origin server) and the pure failure
 * classification priority. The Bedrock seam scenarios (single wire attempt via
 * the real request-handler seam, numeric status retention, exact constructor
 * identity with the real pi-ai Bedrock provider under AWS_MAX_ATTEMPTS=3) run
 * through `host-transport-bedrock-fixture.ts` under Node — the production host
 * runtime — because bun's http2 is not deterministic enough for the real
 * NodeHttp2Handler (h2c) path.
 */
import { describe, expect, it } from 'bun:test'
import { BedrockRuntimeClient, ConverseCommand } from '@aws-sdk/client-bedrock-runtime'
import http from 'node:http'
import { join } from 'node:path'
import type { AddressInfo, Server, Socket } from 'node:net'
import {
  classifyTransportFailure,
  installTransportObservation,
  type InstalledTransportObservation,
  type TransportObservation,
} from './host-completion-policy.ts'

const PRISTINE_FETCH = globalThis.fetch
const PRISTINE_SEND = BedrockRuntimeClient.prototype.send

interface HttpFixture {
  port: number
  pathUrl(path: string): string
  requests: string[]
  close(): Promise<void>
}

function trackClose(server: Server, fixture: HttpFixture): void {
  const sockets = new Set<Socket>([])
  server.on('connection', (socket) => {
    sockets.add(socket)
    socket.on('close', () => sockets.delete(socket))
  })
  fixture.close = async () => {
    for (const socket of sockets) socket.destroy()
    await new Promise<void>((resolve) => server.close(() => resolve()))
  }
}

async function startHttpServer(handler: (req: http.IncomingMessage, res: http.ServerResponse, path: string) => void): Promise<HttpFixture> {
  const requests: string[] = []
  const server = http.createServer((req, res) => {
    requests.push(req.url ?? '')
    handler(req, res, req.url ?? '')
  })
  const fixture = {
    requests,
    port: 0,
    pathUrl(path: string): string {
      return `http://127.0.0.1:${fixture.port}${path}`
    },
    close: async () => {},
  } satisfies HttpFixture
  trackClose(server, fixture)
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  fixture.port = (server.address() as AddressInfo).port
  return fixture
}

function respond(res: http.ServerResponse, status: number, body: string): void {
  res.writeHead(status, { 'content-type': 'application/json' })
  res.end(body)
}

const OK_BODY = JSON.stringify({ ok: true })

async function startOkServer(): Promise<HttpFixture> {
  return startHttpServer((_req, res) => respond(res, 200, OK_BODY))
}

async function withSeam<T>(base: string, run: (installed: InstalledTransportObservation) => Promise<T>): Promise<T> {
  const installed = installTransportObservation(new URL(base))
  try {
    return await run(installed)
  } finally {
    globalThis.fetch = PRISTINE_FETCH
    BedrockRuntimeClient.prototype.send = PRISTINE_SEND
  }
}

// ---------------------------------------------------------------------------
// fetch URL policy
// ---------------------------------------------------------------------------

describe('fetch seam reaches the original fetch once for allowed targets', () => {
  for (const kind of ['string', 'URL', 'Request'] as const) {
    for (const target of ['exact', 'descendant'] as const) {
      it(`${kind} input → ${target} base path`, async () => {
        const server = await startOkServer()
        try {
          const path = target === 'exact' ? '/v1' : '/v1/chat/completions'
          await withSeam(server.pathUrl('/v1'), async (installed) => {
            const input =
              kind === 'string'
                ? server.pathUrl(path)
                : kind === 'URL'
                  ? new URL(server.pathUrl(path))
                  : new Request(server.pathUrl(path))
            const response = await fetch(input)
            expect(response.status).toBe(200)
            expect(await response.text()).toBe(OK_BODY)
            expect(installed.observation).toEqual({
              attempts: 1,
              status: 200,
              networkFailure: false,
              retryBlocked: false,
              sdkException: false,
            })
          })
          expect(server.requests).toEqual([path])
        } finally {
          await server.close()
        }
      })
    }
  }

  it('IPv6 origin keys strip brackets and match', async () => {
    const server = http.createServer((_req, res) => respond(res, 200, OK_BODY))
    await new Promise<void>((resolve) => server.listen(0, '::1', resolve))
    const port = (server.address() as AddressInfo).port
    const fixture: HttpFixture = {
      port,
      requests: [],
      pathUrl(path: string): string {
        return `http://[::1]:${port}${path}`
      },
      close: async () => {
        server.closeAllConnections?.()
        await new Promise<void>((resolve) => server.close(() => resolve()))
      },
    }
    try {
      await withSeam(fixture.pathUrl('/v1'), async (installed) => {
        const response = await fetch(fixture.pathUrl('/v1/segments'))
        expect(response.status).toBe(200)
        expect(installed.observation.attempts).toBe(1)
      })
    } finally {
      await fixture.close()
    }
  })

  it('hostname case difference still matches the same origin exactly once', async () => {
    const server = http.createServer((_req, res) => respond(res, 200, OK_BODY))
    const requests: string[] = []
    server.on('request', (req) => requests.push(req.url ?? ''))
    await new Promise<void>((resolve) => server.listen(0, 'localhost', resolve))
    const port = (server.address() as AddressInfo).port
    const close = async (): Promise<void> => {
      server.closeAllConnections?.()
      await new Promise<void>((resolve) => server.close(() => resolve()))
    }
    try {
      await withSeam(`http://localhost:${port}/v1`, async (installed) => {
        const response = await fetch(`http://LOCALHOST:${port}/v1/one`)
        expect(response.status).toBe(200)
        expect(installed.observation.attempts).toBe(1)
      })
      expect(requests).toEqual(['/v1/one'])
    } finally {
      await close()
    }
  })

  it('failed bedrock validation leaves both global identities untouched', () => {
    const fetchBefore = globalThis.fetch
    const sendBefore = BedrockRuntimeClient.prototype.send
    try {
      BedrockRuntimeClient.prototype.send = undefined
      expect(() => installTransportObservation(new URL('http://127.0.0.1:9/v1'))).toThrow(/not callable/)
      expect(globalThis.fetch).toBe(fetchBefore)
      expect(BedrockRuntimeClient.prototype.send).toBeUndefined()
    } finally {
      BedrockRuntimeClient.prototype.send = sendBefore
    }
    expect(BedrockRuntimeClient.prototype.send).toBe(sendBefore)
  })

  it('effective default ports normalize for origin comparison', async () => {
    // Positive: :443 spelled on an https base without a port — same origin, so the
    // attempt goes through (and fails on the reserved .invalid host = networkFailure).
    await withSeam('https://seam-invalid.invalid/v1', async (installed) => {
      await expect(fetch('https://seam-invalid.invalid:443/v1/segments')).rejects.toThrow()
      expect(installed.observation.attempts).toBe(1)
      expect(installed.observation.networkFailure).toBe(true)
    })
    // Negative: a different explicit port is an origin mismatch — blocked pre-wire.
    await withSeam('https://seam-invalid.invalid/v1', async (installed) => {
      await expect(fetch('https://seam-invalid.invalid:8443/v1/segments')).rejects.toThrow(/host transport seam:/)
      expect(installed.observation.attempts).toBe(0)
    })
  })
})

describe('fetch seam blocks policy violations before the original fetch', () => {
  async function rejectsBeforeWire(server: HttpFixture, target: string): Promise<Error> {
    let thrown: Error | undefined
    await withSeam(server.pathUrl('/v1'), async () => {
      thrown = await fetch(target).then(
        () => undefined,
        (error: unknown) => error as Error,
      )
    })
    expect(thrown).toBeInstanceOf(Error)
    expect(thrown!.message).toContain('host transport seam:')
    expect(server.requests).toEqual([])
    return thrown!
  }

  it('userinfo is rejected', async () => {
    const server = await startOkServer()
    try {
      await rejectsBeforeWire(server, `http://user:pass@127.0.0.1:${server.port}/v1/chat`)
    } finally {
      await server.close()
    }
  })

  it('fragment is rejected', async () => {
    const server = await startOkServer()
    try {
      await rejectsBeforeWire(server, `${server.pathUrl('/v1')}#fragment`)
    } finally {
      await server.close()
    }
  })

  it('origin mismatch (port) is rejected', async () => {
    const server = await startOkServer()
    const other = await startOkServer()
    try {
      await rejectsBeforeWire(server, other.pathUrl('/v1/chat'))
    } finally {
      await server.close()
      await other.close()
    }
  })

  it('origin mismatch (hostname) is rejected', async () => {
    const server = await startOkServer()
    try {
      await rejectsBeforeWire(server, `http://localhost:${server.port}/v1/chat`)
    } finally {
      await server.close()
    }
  })

  it('/v1evil is not a /v1 descendant', async () => {
    const server = await startOkServer()
    try {
      await rejectsBeforeWire(server, server.pathUrl('/v1evil'))
    } finally {
      await server.close()
    }
  })

  it('canonical dot traversal escapes are rejected', async () => {
    const server = await startOkServer()
    try {
      await rejectsBeforeWire(server, server.pathUrl('/v1/../secret'))
      await rejectsBeforeWire(server, `${server.pathUrl('/v1')}/%2e%2e/secret`)
    } finally {
      await server.close()
    }
  })

  it('encoded slash, encoded backslash and decode failures are rejected', async () => {
    const server = await startOkServer()
    try {
      await rejectsBeforeWire(server, `${server.pathUrl('/v1')}/%2Fsecret`)
      await rejectsBeforeWire(server, `${server.pathUrl('/v1')}/%5Cback`)
      await rejectsBeforeWire(server, `${server.pathUrl('/v1')}/%zz-bad`)
    } finally {
      await server.close()
    }
  })

  it('non-http schemes are rejected', async () => {
    const server = await startOkServer()
    try {
      await rejectsBeforeWire(server, `ftp://127.0.0.1:${server.port}/v1/file`)
    } finally {
      await server.close()
    }
  })

  it('unsupported fetch input is rejected', async () => {
    const server = await startOkServer()
    try {
      await rejectsBeforeWire(server, undefined as unknown as string)
    } finally {
      await server.close()
    }
  })

  it('install fails closed for a base url carrying userinfo or fragment', () => {
    expect(() => installTransportObservation(new URL('http://user@127.0.0.1:9/v1'))).toThrow(/host transport seam:/)
    expect(() => installTransportObservation(new URL('http://127.0.0.1:9/v1#frag'))).toThrow(/host transport seam:/)
  })

  it('encoded dot segment that survives canonicalization stays decodable-once', async () => {
    const server = await startOkServer()
    try {
      await withSeam(server.pathUrl('/v1'), async () => {
        // %252e%252e decodes once to the literal segment "%2e%2e" — inside /v1.
        const response = await fetch(`${server.pathUrl('/v1')}/%252e%252e`)
        expect(response.status).toBe(200)
      })
      expect(server.requests).toEqual(['/v1/%252e%252e'])
    } finally {
      await server.close()
    }
  })

  it('base path with trailing slash allows its subtree but not the bare parent path', async () => {
    const server = await startOkServer()
    try {
      await withSeam(server.pathUrl('/v1/'), async () => {
        const ok = await fetch(server.pathUrl('/v1/deep'))
        expect(ok.status).toBe(200)
      })
      await withSeam(server.pathUrl('/v1/'), async () => {
        await expect(fetch(server.pathUrl('/v1'))).rejects.toThrow(/host transport seam:/)
      })
      expect(server.requests).toEqual(['/v1/deep'])
    } finally {
      await server.close()
    }
  })
})

describe('fetch seam redirect and single-attempt behavior', () => {
  for (const status of [307, 308] as const) {
    it(`${status} redirect to a second origin performs zero second-origin requests`, async () => {
      const second = await startOkServer()
      const first = await startHttpServer((_req, res, path) => {
        if (path === '/v1/start') {
          res.writeHead(status, { location: second.pathUrl('/elsewhere') })
          res.end()
        } else {
          respond(res, 200, OK_BODY)
        }
      })
      try {
        await withSeam(first.pathUrl('/v1'), async () => {
          await expect(fetch(first.pathUrl('/v1/start'))).rejects.toThrow()
        })
        expect(first.requests).toEqual(['/v1/start'])
        expect(second.requests).toEqual([])
      } finally {
        await first.close()
        await second.close()
      }
    })
  }

  it('second attempt throws before the original fetch and marks retryBlocked', async () => {
    const server = await startOkServer()
    try {
      await withSeam(server.pathUrl('/v1'), async (installed) => {
        const first = await fetch(server.pathUrl('/v1/one'))
        expect(first.status).toBe(200)
        const error = await fetch(server.pathUrl('/v1/two')).then(
          () => undefined,
          (e: unknown) => e as Error,
        )
        expect(error).toBeInstanceOf(Error)
        expect(error!.name).toBe('RetryBlockedError')
        expect(installed.observation.attempts).toBe(2)
        expect(installed.observation.retryBlocked).toBe(true)
        expect(installed.observation.status).toBe(200)
      })
      expect(server.requests).toEqual(['/v1/one'])
    } finally {
      await server.close()
    }
  })

  it('transport throw marks networkFailure and propagates the original error', async () => {
    const server = await startHttpServer((req, res) => {
      req.destroy()
      res.destroy()
    })
    try {
      await withSeam(server.pathUrl('/v1'), async (installed) => {
        await expect(fetch(server.pathUrl('/v1/drop'))).rejects.toThrow()
        expect(installed.observation.networkFailure).toBe(true)
        expect(installed.observation.attempts).toBe(1)
        expect(installed.observation.status).toBeUndefined()
      })
    } finally {
      await server.close()
    }
  })

  it('other numeric statuses are observed and the response is returned as-is', async () => {
    const server = await startHttpServer((_req, res) => respond(res, 404, JSON.stringify({ nope: true })))
    try {
      await withSeam(server.pathUrl('/v1'), async (installed) => {
        const response = await fetch(server.pathUrl('/v1/missing'))
        expect(response.status).toBe(404)
        expect(await response.json()).toEqual({ nope: true })
        expect(installed.observation.status).toBe(404)
      })
    } finally {
      await server.close()
    }
  })
})

// ---------------------------------------------------------------------------
// Base immutability and intrinsic object-input binding (two-server evidence)
// ---------------------------------------------------------------------------

interface WireRecord {
  method?: string
  path: string
  body: string
  header?: string
}

async function startRecordingServer(): Promise<HttpFixture & { seen: WireRecord[] }> {
  const seen: WireRecord[] = []
  const server = await startHttpServer((req, res, path) => {
    let body = ''
    req.on('data', (chunk) => {
      body += chunk
    })
    req.on('end', () => {
      seen.push({ method: req.method, path, body, header: req.headers['x-probe'] })
      respond(res, 200, OK_BODY)
    })
  })
  return Object.assign(server, { seen })
}

describe('fetch policy binds validation to immutable and intrinsic state', () => {
  it('mutating the caller-owned base URL after install does not move the allow-list', async () => {
    const allowed = await startOkServer()
    const attacker = await startOkServer()
    try {
      const callerOwnedBase = new URL(allowed.pathUrl('/v1'))
      const installed = installTransportObservation(callerOwnedBase)
      try {
        // Mutate the caller's URL to the attacker origin after installation,
        // exactly like a post-install allow-list move attempt.
        callerOwnedBase.href = attacker.pathUrl('/escape')
        await expect(fetch(attacker.pathUrl('/escape/child'))).rejects.toThrow(/host transport seam:/)
        expect(installed.observation).toEqual({ attempts: 0, networkFailure: false, retryBlocked: false, sdkException: false })
        expect(allowed.requests).toEqual([])
        expect(attacker.requests).toEqual([])
      } finally {
        globalThis.fetch = PRISTINE_FETCH
        BedrockRuntimeClient.prototype.send = PRISTINE_SEND
      }
    } finally {
      await allowed.close()
      await attacker.close()
    }
  })

  it('a URL with shadowed safe-looking properties is blocked at its intrinsic target', async () => {
    const allowed = await startOkServer()
    const attacker = await startOkServer()
    try {
      await withSeam(allowed.pathUrl('/v1'), async (installed) => {
        const evil = new URL(attacker.pathUrl('/v1/shadowed'))
        Object.defineProperties(evil, {
          protocol: { value: 'http:' },
          hostname: { value: '127.0.0.1' },
          port: { value: String(allowed.port) },
          pathname: { value: '/v1/shadowed' },
        })
        await expect(fetch(evil)).rejects.toThrow(/host transport seam:/)
        expect(installed.observation).toEqual({ attempts: 0, networkFailure: false, retryBlocked: false, sdkException: false })
        expect(allowed.requests).toEqual([])
        expect(attacker.requests).toEqual([])
      })
    } finally {
      await allowed.close()
      await attacker.close()
    }
  })

  it('a Request with a shadowed url property fails closed on the internal-consistency check', async () => {
    const allowed = await startOkServer()
    const attacker = await startOkServer()
    try {
      await withSeam(allowed.pathUrl('/v1'), async (installed) => {
        const evil = new Request(attacker.pathUrl('/v1/shadowed'))
        Object.defineProperty(evil, 'url', { value: allowed.pathUrl('/v1/shadowed') })
        await expect(fetch(evil)).rejects.toThrow(/host transport seam:/)
        expect(installed.observation).toEqual({ attempts: 0, networkFailure: false, retryBlocked: false, sdkException: false })
        expect(allowed.requests).toEqual([])
        expect(attacker.requests).toEqual([])
      })
    } finally {
      await allowed.close()
      await attacker.close()
    }
  })

  it('normal URL and Request calls still reach the permitted transport once with init/body intact', async () => {
    const server = await startRecordingServer()
    try {
      await withSeam(server.pathUrl('/v1'), async (installed) => {
        const response = await fetch(new URL(server.pathUrl('/v1/echo')), {
          method: 'POST',
          body: 'url-body',
          headers: { 'content-type': 'text/plain', 'x-probe': 'own-header' },
        })
        expect(response.status).toBe(200)
        expect(await response.text()).toBe(OK_BODY)
        expect(installed.observation.attempts).toBe(1)
        expect(installed.observation.status).toBe(200)
      })
      await withSeam(server.pathUrl('/v1'), async (installed) => {
        const request = new Request(server.pathUrl('/v1/echo'), {
          method: 'POST',
          body: 'original-body',
          headers: { 'content-type': 'text/plain', 'x-probe': 'request-header' },
        })
        const second = await fetch(request, {
          method: 'PUT',
          body: 'override-body',
          headers: { 'x-probe': 'init-header' },
        })
        expect(second.status).toBe(200)
        expect(await second.text()).toBe(OK_BODY)
        expect(installed.observation.attempts).toBe(1)
        expect(installed.observation.status).toBe(200)
      })
      expect(server.seen).toEqual([
        { method: 'POST', path: '/v1/echo', body: 'url-body', header: 'own-header' },
        { method: 'PUT', path: '/v1/echo', body: 'override-body', header: 'init-header' },
      ])
    } finally {
      await server.close()
    }
  })

  it('consumed and locked Request bodies succeed when init.body replaces them', async () => {
    const server = await startRecordingServer()
    const consumed = async () => {
      const request = new Request(server.pathUrl('/v1/echo'), { method: 'POST', body: 'old' })
      await request.text()
      return request
    }
    const locked = () => {
      const request = new Request(server.pathUrl('/v1/echo'), { method: 'POST', body: 'old' })
      request.body?.getReader()
      return request
    }
    try {
      await withSeam(server.pathUrl('/v1'), async (installed) => {
        const consumedResponse = await fetch(await consumed(), { method: 'PUT', body: 'replacement-consumed' })
        expect(consumedResponse.status).toBe(200)
        expect(installed.observation.attempts).toBe(1)
      })
      await withSeam(server.pathUrl('/v1'), async (installed) => {
        const lockedResponse = await fetch(locked(), { method: 'PUT', body: 'replacement-locked' })
        expect(lockedResponse.status).toBe(200)
        expect(installed.observation.attempts).toBe(1)
      })
      expect(server.seen).toEqual([
        { method: 'PUT', path: '/v1/echo', body: 'replacement-consumed' },
        { method: 'PUT', path: '/v1/echo', body: 'replacement-locked' },
      ])
    } finally {
      await server.close()
    }
  })

  it('unusable Request bodies without an init.body replacement still fail before the wire', async () => {
    const server = await startRecordingServer()
    const consumed = async () => {
      const request = new Request(server.pathUrl('/v1/echo'), { method: 'POST', body: 'old' })
      await request.text()
      return request
    }
    const locked = () => {
      const request = new Request(server.pathUrl('/v1/echo'), { method: 'POST', body: 'old' })
      request.body?.getReader()
      return request
    }
    try {
      // Native baseline: the same calls reject (or throw) without a replacement body.
      const rejectionOf = (run: () => Promise<Response>): Promise<unknown> =>
        Promise.resolve()
          .then(run)
          .then(
            () => undefined,
            (error: unknown) => error,
          )
      expect(await rejectionOf(async () => fetch(await consumed(), { method: 'PUT' }))).toBeInstanceOf(Error)
      expect(await rejectionOf(() => fetch(locked(), { method: 'PUT' }))).toBeInstanceOf(Error)
      await withSeam(server.pathUrl('/v1'), async (installed) => {
        expect(await rejectionOf(async () => fetch(await consumed(), { method: 'PUT' }))).toBeInstanceOf(Error)
        expect(await rejectionOf(() => fetch(locked(), { method: 'PUT' }))).toBeInstanceOf(Error)
        // Either the seam construction or the native-equivalent fetch of the
        // snapshot fails; either way the wire target is never reached.
        expect(installed.observation.attempts).toBeLessThanOrEqual(2)
        expect(installed.observation.sdkException).toBe(false)
      })
      expect(server.seen).toEqual([])
    } finally {
      await server.close()
    }
  })

  it('inherited RequestInit fields are applied exactly like native fetch', async () => {
    const server = await startRecordingServer()
    const inheritedInit = () =>
      Object.create({
        method: 'PUT',
        body: 'init-body',
        headers: { 'content-type': 'text/plain', 'x-probe': 'init-header' },
      })
    try {
      // Native baseline: inherited dictionary fields override the Request.
      await fetch(
        new Request(server.pathUrl('/v1/echo'), { method: 'POST', body: 'request-body', headers: { 'x-probe': 'request-header' } }),
        inheritedInit(),
      )
      await withSeam(server.pathUrl('/v1'), async (installed) => {
        const response = await fetch(
          new Request(server.pathUrl('/v1/echo'), { method: 'POST', body: 'request-body', headers: { 'x-probe': 'request-header' } }),
          inheritedInit(),
        )
        expect(response.status).toBe(200)
        expect(installed.observation.attempts).toBe(1)
      })
      expect(server.seen).toEqual([
        { method: 'PUT', path: '/v1/echo', body: 'init-body', header: 'init-header' },
        { method: 'PUT', path: '/v1/echo', body: 'init-body', header: 'init-header' },
      ])
    } finally {
      await server.close()
    }
  })

  it('own-property init and forced redirect behavior remain correct', async () => {
    const second = await startOkServer()
    const first = await startHttpServer((req, res, path) => {
      if (path === '/v1/start') {
        res.writeHead(307, { location: second.pathUrl('/elsewhere') })
        res.end()
      } else {
        respond(res, 200, OK_BODY)
      }
    })
    try {
      await withSeam(first.pathUrl('/v1'), async (installed) => {
        const request = new Request(first.pathUrl('/v1/start'), { method: 'POST', body: 'own-body' })
        await expect(fetch(request, { redirect: 'follow', headers: { 'content-type': 'text/plain' } })).rejects.toThrow()
        expect(installed.observation.attempts).toBe(1)
      })
      expect(first.requests).toEqual(['/v1/start'])
      expect(second.requests).toEqual([])
    } finally {
      await first.close()
      await second.close()
    }
  })

  it('receiver-sensitive own accessor init fields are accepted with the same values as native', async () => {
    const server = await startRecordingServer()
    const accessorInit = (): RequestInit => {
      const init = {}
      for (const [key, value] of Object.entries({
        method: 'POST',
        body: 'accessor-body',
        headers: { 'content-type': 'text/plain', 'x-probe': 'accessor-header' },
      })) {
        Object.defineProperty(init, key, {
          enumerable: true,
          get() {
            if (this !== init) throw new Error(`wrong receiver for ${key}`)
            return value
          },
        })
      }
      return init as RequestInit
    }
    try {
      // Native baseline: same values reach the permitted transport.
      await fetch(server.pathUrl('/v1/echo'), accessorInit())
      await withSeam(server.pathUrl('/v1'), async (installed) => {
        const response = await fetch(server.pathUrl('/v1/echo'), accessorInit())
        expect(response.status).toBe(200)
        expect(installed.observation.attempts).toBe(1)
      })
      expect(server.seen).toEqual([
        { method: 'POST', path: '/v1/echo', body: 'accessor-body', header: 'accessor-header' },
        { method: 'POST', path: '/v1/echo', body: 'accessor-body', header: 'accessor-header' },
      ])
    } finally {
      await server.close()
    }
  })

  it('receiver-sensitive inherited accessor init fields keep the original init as receiver', async () => {
    const server = await startRecordingServer()
    const inheritedAccessorInit = (): RequestInit => {
      const init: object = Object.create({
        get method(): string {
          if (this !== init) throw new Error('wrong receiver for method')
          return 'PUT'
        },
        get body(): string {
          if (this !== init) throw new Error('wrong receiver for body')
          return 'inherited-accessor-body'
        },
      })
      return init as RequestInit
    }
    try {
      await withSeam(server.pathUrl('/v1'), async (installed) => {
        const response = await fetch(server.pathUrl('/v1/echo'), inheritedAccessorInit())
        expect(response.status).toBe(200)
        expect(installed.observation.attempts).toBe(1)
      })
      expect(server.seen).toEqual([{ method: 'PUT', path: '/v1/echo', body: 'inherited-accessor-body' }])
    } finally {
      await server.close()
    }
  })

  it('a redirect accessor that swallows forced values cannot re-enable following', async () => {
    const second = await startOkServer()
    const first = await startHttpServer((req, res, path) => {
      if (path === '/v1/start') {
        res.writeHead(307, { location: second.pathUrl('/outside') })
        res.end()
      } else {
        respond(res, 200, OK_BODY)
      }
    })
    try {
      const writes: Array<{ receiverIsOriginal: boolean; value: unknown }> = []
      const swallowInit: RequestInit = Object.defineProperties({} as RequestInit, {
        redirect: {
          enumerable: true,
          get: () => 'follow',
          set: (value) => {
            writes.push({ receiverIsOriginal: false, value })
          },
        },
      })
      await withSeam(first.pathUrl('/v1'), async (installed) => {
        await expect(fetch(first.pathUrl('/v1/start'), swallowInit)).rejects.toThrow()
        expect(installed.observation.attempts).toBe(1)
      })
      expect(first.requests).toEqual(['/v1/start'])
      expect(second.requests).toEqual([])
      expect(writes).toEqual([])
    } finally {
      await first.close()
      await second.close()
    }
  })
})

// ---------------------------------------------------------------------------
// Bedrock send-seam install atomicity (stub wire — no real h2 transport)
// ---------------------------------------------------------------------------

function bedrockClientWithHandler(requestHandler: object): BedrockRuntimeClient {
  return new BedrockRuntimeClient({
    region: 'us-east-1',
    credentials: { accessKeyId: 'fixture', secretAccessKey: 'fixture' },
    maxAttempts: 1,
    requestHandler: requestHandler as never,
  })
}

describe('bedrock send-seam install atomicity fails closed on unusable handles', () => {
  const BASE = 'https://bedrock-runtime.us-east-1.amazonaws.com'

  async function sendOnce(client: BedrockRuntimeClient): Promise<unknown> {
    try {
      await client.send(new ConverseCommand({ modelId: 'fixture', messages: [] }))
      return undefined
    } catch (error) {
      return error
    }
  }

  function wireStub(wireCalls: { count: number }): (request: unknown, options?: unknown) => Promise<never> {
    return async () => {
      wireCalls.count += 1
      throw new Error('WIRE_REACHED')
    }
  }

  it('unwritable callable handle fails closed on every send with zero wire attempts', async () => {
    const wireCalls = { count: 0 }
    const handle = wireStub(wireCalls)
    const requestHandler = { handle }
    Object.defineProperty(requestHandler, 'handle', {
      value: handle,
      enumerable: true,
      configurable: false,
      writable: false,
    })
    const client = bedrockClientWithHandler(requestHandler)
    try {
      await withSeam(BASE, async (installed) => {
        const first = await sendOnce(client)
        expect((first as Error).message).toMatch(/host transport seam: Bedrock request handler handle is not writable/)
        expect(wireCalls.count).toBe(0)
        expect(installed.observation).toEqual({ attempts: 0, networkFailure: false, retryBlocked: false, sdkException: false })
        // The failed install left the handler unmarked: the second send must
        // fail closed again instead of skipping the guard.
        const second = await sendOnce(client)
        expect((second as Error).message).toMatch(/host transport seam: Bedrock request handler handle is not writable/)
        expect(wireCalls.count).toBe(0)
        expect(installed.observation).toEqual({ attempts: 0, networkFailure: false, retryBlocked: false, sdkException: false })
      })
    } finally {
      client.destroy()
    }
  })

  it('a throwing handle setter converts to the stable seam error on every send', async () => {
    const wireCalls = { count: 0 }
    let current = wireStub(wireCalls)
    const requestHandler: { handle: unknown } = { handle: current }
    Object.defineProperty(requestHandler, 'handle', {
      get: () => current,
      set: () => {
        throw new Error('setter exploded')
      },
      enumerable: true,
      configurable: true,
    })
    const client = bedrockClientWithHandler(requestHandler)
    try {
      await withSeam(BASE, async (installed) => {
        for (let round = 0; round < 2; round += 1) {
          const error = await sendOnce(client)
          expect((error as Error).message).toMatch(/host transport seam: Bedrock request handler handle is not writable/)
          expect((error as Error).message).not.toContain('setter exploded')
          expect(wireCalls.count).toBe(0)
          expect(installed.observation.attempts).toBe(0)
        }
      })
    } finally {
      client.destroy()
    }
  })

  it('a silently swallowing handle setter is caught by the install verification', async () => {
    const wireCalls = { count: 0 }
    let current = wireStub(wireCalls)
    const requestHandler: { handle: unknown } = { handle: current }
    Object.defineProperty(requestHandler, 'handle', {
      get: () => current,
      set: () => {},
      enumerable: true,
      configurable: true,
    })
    const client = bedrockClientWithHandler(requestHandler)
    try {
      await withSeam(BASE, async (installed) => {
        const error = await sendOnce(client)
        expect((error as Error).message).toMatch(/host transport seam: Bedrock request handler handle is not writable/)
        expect(wireCalls.count).toBe(0)
        expect(installed.observation.attempts).toBe(0)
      })
    } finally {
      client.destroy()
    }
  })

  it('a store-then-throw setter latches failed installs across repeated sends', async () => {
    const wireCalls = { count: 0 }
    let current: unknown = wireStub(wireCalls)
    const requestHandler: { handle: unknown } = { handle: current }
    let firstWrite = true
    Object.defineProperty(requestHandler, 'handle', {
      get: () => current,
      set: (value) => {
        current = value
        if (firstWrite) {
          firstWrite = false
          throw new Error('persisted then exploded')
        }
      },
      enumerable: true,
      configurable: true,
    })
    const client = bedrockClientWithHandler(requestHandler)
    let originalSendCalls = 0
    const pristineSend = BedrockRuntimeClient.prototype.send
    BedrockRuntimeClient.prototype.send = function (this: BedrockRuntimeClient, ...args: unknown[]) {
      originalSendCalls += 1
      return pristineSend.apply(this, args)
    }
    try {
      // The seam captures this spy as originalSend; a non-zero count means a
      // latched send reached it. The stored leftover wrapper would raise
      // attempts, and the real handler would raise wireCalls — all must stay
      // at their initial values across every repeat.
      await withSeam(BASE, async (installed) => {
        const initialObservation = { ...installed.observation }
        for (let round = 0; round < 3; round += 1) {
          const error = await sendOnce(client)
          expect((error as Error).message).toBe('host transport seam: Bedrock request handler handle is not writable')
          expect(typeof current).toBe('function')
          expect(originalSendCalls).toBe(0)
          expect(wireCalls.count).toBe(0)
          expect(installed.observation).toEqual(initialObservation)
        }
      })
    } finally {
      BedrockRuntimeClient.prototype.send = PRISTINE_SEND
      client.destroy()
    }
  })

  it('writable custom handlers keep per-attempt gating before the original wire', async () => {
    const seen: unknown[] = []
    const requestHandler = {
      handle: async (request: unknown) => {
        seen.push(request)
        throw new Error('WIRE_REACHED')
      },
    }
    const client = bedrockClientWithHandler(requestHandler)
    try {
      await withSeam(BASE, async (installed) => {
        const first = await sendOnce(client)
        expect((first as Error).message).toBe('WIRE_REACHED')
        expect(seen).toHaveLength(1)
        expect(installed.observation).toEqual({
          attempts: 1,
          networkFailure: true,
          retryBlocked: false,
          sdkException: true,
        })
        const second = await sendOnce(client)
        expect((second as Error).message).toMatch(/host transport seam: second wire attempt blocked/)
        expect(seen).toHaveLength(1)
        expect(installed.observation.attempts).toBe(2)
        expect(installed.observation.retryBlocked).toBe(true)
      })
    } finally {
      client.destroy()
    }
  })
})

// ---------------------------------------------------------------------------
// Bedrock seam under the Node production runtime
// ---------------------------------------------------------------------------

describe('bedrock seam fixtures under the Node production runtime', () => {
  it('single wire attempt, numeric status retention and exact constructor identity hold under real h2c', async () => {
    const nodeBin = process.env.POLO_PI_HOST_NODE ?? 'node'
    const fixture = Bun.spawn({
      cmd: [nodeBin, '--experimental-strip-types', join(import.meta.dir, 'host-transport-bedrock-fixture.ts')],
      cwd: join(import.meta.dir, '..', '..', '..'),
      stdout: 'pipe',
      stderr: 'pipe',
      env: { ...process.env },
    })
    const stderrText = await new Response(fixture.stderr).text()
    const exitCode = await fixture.exited
    if (exitCode !== 0) {
      throw new Error(`bedrock seam fixture failed (exit ${exitCode})\n${stderrText}`)
    }
    const stdoutText = await new Response(fixture.stdout).text()
    const results = stdoutText
      .split('\n')
      .filter((line) => line.startsWith('RESULT:'))
      .map((line) => JSON.parse(line.slice('RESULT:'.length)) as { name: string; pass: boolean; detail?: string })
    expect(results.length).toBe(7)
    expect(results.every((result) => result.pass)).toBe(true)
    expect(results.map((result) => result.name)).toEqual([
      'constructor identity is exact',
      '401 keeps its numeric status and marks sdkException',
      '403 keeps its numeric status',
      '503 retried by the SDK is blocked before the second wire attempt',
      'destroyed first wire attempt surfaces as a terminal network failure',
      'non-callable request handler is refused before the original send',
      'pi-ai Bedrock provider shares the seam constructor and wire gate',
    ])
  }, 120000)
})

// ---------------------------------------------------------------------------
// Pure classification
// ---------------------------------------------------------------------------

describe('classifyTransportFailure fixed priority', () => {
  const base: TransportObservation = {
    attempts: 0,
    networkFailure: false,
    retryBlocked: false,
    sdkException: false,
  }

  it('deadline wins over retry blocking', () => {
    expect(
      classifyTransportFailure({ ...base, attempts: 2, retryBlocked: true }, { deadlineExpired: true, providerFailed: true }),
    ).toBe('deadline_exceeded')
  })

  it('retry blocked wins over 401', () => {
    expect(
      classifyTransportFailure({ ...base, attempts: 2, retryBlocked: true, status: 401 }, { deadlineExpired: false, providerFailed: true }),
    ).toBe('retry_blocked')
  })

  it('attempts > 1 alone means retry blocked', () => {
    expect(classifyTransportFailure({ ...base, attempts: 2 }, { deadlineExpired: false, providerFailed: true })).toBe('retry_blocked')
  })

  it('401 wins over network failure', () => {
    expect(
      classifyTransportFailure(
        { ...base, attempts: 1, status: 401, networkFailure: true },
        { deadlineExpired: false, providerFailed: true },
      ),
    ).toBe('provider_rejected_credentials')
  })

  it('other numeric status with provider failure is a request failure (503 + SDK)', () => {
    expect(
      classifyTransportFailure(
        { ...base, attempts: 2, status: 503, retryBlocked: true, sdkException: true },
        { deadlineExpired: false, providerFailed: true },
      ),
    ).toBe('retry_blocked')
    expect(
      classifyTransportFailure({ ...base, attempts: 1, status: 503, sdkException: true }, { deadlineExpired: false, providerFailed: true }),
    ).toBe('provider_request_failed')
  })

  it('network failure alone is a request failure', () => {
    expect(
      classifyTransportFailure({ ...base, attempts: 1, networkFailure: true }, { deadlineExpired: false, providerFailed: true }),
    ).toBe('provider_request_failed')
  })

  it('200 without provider failure classifies to undefined', () => {
    expect(
      classifyTransportFailure({ ...base, attempts: 1, status: 200 }, { deadlineExpired: false, providerFailed: false }),
    ).toBeUndefined()
  })

  it('zero-attempt provider terminal failure stays terminal', () => {
    expect(classifyTransportFailure(base, { deadlineExpired: false, providerFailed: true })).toBe('provider_error_terminal')
    expect(
      classifyTransportFailure({ ...base, sdkException: true }, { deadlineExpired: false, providerFailed: true }),
    ).toBe('provider_error_terminal')
  })
})
