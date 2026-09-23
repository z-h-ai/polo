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
    const sendSlot = BedrockRuntimeClient.prototype as { send?: unknown }
    try {
      sendSlot.send = undefined
      expect(() => installTransportObservation(new URL('http://127.0.0.1:9/v1'))).toThrow(/not callable/)
      expect(globalThis.fetch).toBe(fetchBefore)
      expect(BedrockRuntimeClient.prototype.send).toBeUndefined()
    } finally {
      sendSlot.send = sendBefore
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
  header?: string | string[]
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

  it('a Request whose public url shadows a different intrinsic url fails closed', async () => {
    const allowed = await startOkServer()
    const attacker = await startOkServer()
    try {
      await withSeam(allowed.pathUrl('/v1'), async (installed) => {
        const evil = new Request(attacker.pathUrl('/v1/shadowed'))
        Object.defineProperty(evil, 'url', { value: allowed.pathUrl('/v1/shadowed') })
        // The intrinsic Request URL must agree with the public URL view; any divergence fails
        // closed before attempts or wire access in both runtimes (zero requests to both origins).
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

  it('a Request whose public url disagrees with its intrinsic url in the reverse direction fails closed', async () => {
    const allowed = await startOkServer()
    const attacker = await startOkServer()
    try {
      await withSeam(allowed.pathUrl('/v1'), async (installed) => {
        // The instance resolves to the allowed origin intrinsically, while its own url property
        // publicly claims the attacker origin; neither direction of the divergence may pass.
        class ShadowedRequest extends Request {}
        const evil = new ShadowedRequest(allowed.pathUrl('/v1/inside'))
        Object.defineProperty(evil, 'url', { value: attacker.pathUrl('/v1/stolen') })
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

  it('a Proxy-wrapped Request is rejected before any url read, attempt, or wire access', async () => {
    const allowed = await startOkServer()
    const attacker = await startOkServer()
    try {
      await withSeam(allowed.pathUrl('/v1'), async (installed) => {
        const underlying = new Request(attacker.pathUrl('/v1/forged'), { signal: AbortSignal.timeout(500) })
        let input: Request = new Proxy(underlying, {})
        // Node's undici exposes the request state by symbol. When present, forge an
        // attacker-underlying state whose public url AND intrinsic url views both present the
        // allowed origin, so only the pre-read Proxy rejection can stop this input (the exact
        // R19 forged-intrinsic probe behavior; on runtimes without the symbol the plain
        // Proxy-wrapped Request must still be rejected before any getter runs).
        const stateKey = Object.getOwnPropertySymbols(underlying).find((key) => String(key) === 'Symbol(state)')
        if (stateKey) {
          const attackerState = Reflect.get(underlying as unknown as object, stateKey) as Record<string, unknown>
          const presentedUrl = new Proxy(attackerState.url as object, {
            get: (urlTarget, key, receiver) =>
              key === 'href' ? allowed.pathUrl('/v1/presented') : Reflect.get(urlTarget, key, receiver),
          })
          const presentedState = { ...attackerState, url: presentedUrl, urlList: [presentedUrl] }
          input = new Proxy(underlying, {
            get: (requestTarget, key, receiver) => {
              if (key === stateKey) {
                return presentedState
              }
              if (key === 'url') {
                return allowed.pathUrl('/v1/presented')
              }
              return Reflect.get(requestTarget, key, receiver)
            },
          })
        }
        await expect(fetch(input)).rejects.toThrow(/host transport seam: request input must not be a Proxy/)
        expect(installed.observation).toEqual({ attempts: 0, networkFailure: false, retryBlocked: false, sdkException: false })
        expect(allowed.requests).toEqual([])
        expect(attacker.requests).toEqual([])
      })
    } finally {
      await allowed.close()
      await attacker.close()
    }
  })

  it('the installed fetch keeps the saved original runtime surface, including a callable preconnect', () => {
    const preconnectCalls: string[] = []
    const preconnect = (origin: string): void => {
      preconnectCalls.push(origin)
    }
    const savedFetch = async (...args: Parameters<typeof PRISTINE_FETCH>): Promise<Response> =>
      Reflect.apply(PRISTINE_FETCH, globalThis, args)
    Object.defineProperty(savedFetch, 'preconnect', {
      configurable: true,
      enumerable: true,
      value: preconnect,
      writable: false,
    })
    try {
      // The saved fetch here is deliberately a plain callable carrying an own preconnect —
      // exactly the runtime shape whose surface the seam must preserve (installed via
      // Reflect.set because it intentionally does not satisfy Node's typed fetch interface).
      Reflect.set(globalThis, 'fetch', savedFetch)
      const installed = installTransportObservation(new URL('https://allowed.example/v1'))
      const installedFetch = globalThis.fetch
      // The seam callable must expose exactly the saved fetch's own property surface (the
      // wrapper is a transparent Proxy, not a plain function that drops runtime properties).
      expect(Reflect.ownKeys(installedFetch).map(String)).toEqual(Reflect.ownKeys(savedFetch).map(String))
      expect(Object.getOwnPropertyDescriptor(installedFetch, 'preconnect')?.value).toBe(preconnect)
      const preservedPreconnect = Reflect.get(installedFetch, 'preconnect') as (origin: string) => void
      preservedPreconnect('https://allowed.example')
      expect(preconnectCalls).toEqual(['https://allowed.example'])
      expect(installed.observation).toEqual({ attempts: 0, networkFailure: false, retryBlocked: false, sdkException: false })
    } finally {
      globalThis.fetch = PRISTINE_FETCH
      BedrockRuntimeClient.prototype.send = PRISTINE_SEND
    }
  })

  it('the transmitted snapshot carries the live caller signal and abort state stays observable', async () => {
    const server = await startRecordingServer()
    try {
      const controller = new AbortController()
      let captured: Request | undefined
      globalThis.fetch = new Proxy(globalThis.fetch, {
        apply(target, thisArg, args) {
          captured = args[0] as Request
          return Reflect.apply(target, thisArg, args)
        },
      })
      try {
        await withSeam(server.pathUrl('/v1'), async (installed) => {
          const response = await fetch(server.pathUrl('/v1/echo'), {
            method: 'POST',
            body: 'signal-body',
            signal: controller.signal,
          })
          expect(response.status).toBe(200)
          expect(captured).toBeDefined()
          expect(captured!.signal).toBe(controller.signal)
          expect(captured!.signal.aborted).toBe(false)
          controller.abort()
          expect(captured!.signal.aborted).toBe(true)
          expect(installed.observation.attempts).toBe(1)
        })
        expect(server.seen).toEqual([{ method: 'POST', path: '/v1/echo', body: 'signal-body' }])
      } finally {
        globalThis.fetch = PRISTINE_FETCH
      }
    } finally {
      await server.close()
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
        // Native wire success on the first origin; the forced redirect:'error' then rejects the
        // 307 before any second-origin request is made.
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

  it('unknown throwing own and inherited init getters are never observed', async () => {
    const server = await startRecordingServer()
    const ownThrowing = {} as RequestInit
    Object.defineProperty(ownThrowing, 'unknownMember', {
      enumerable: true,
      get: () => {
        throw new Error('unknown own getter observed')
      },
    })
    const inheritedThrowing: RequestInit = Object.create(
      Object.defineProperty({}, 'unknownMember', {
        enumerable: true,
        get: () => {
          throw new Error('unknown inherited getter observed')
        },
      }),
    )
    try {
      await withSeam(server.pathUrl('/v1'), async (installed) => {
        const first = await fetch(server.pathUrl('/v1/echo'), ownThrowing)
        expect(first.status).toBe(200)
        expect(installed.observation.attempts).toBe(1)
      })
      await withSeam(server.pathUrl('/v1'), async (installed) => {
        const second = await fetch(new Request(server.pathUrl('/v1/echo')), inheritedThrowing)
        expect(second.status).toBe(200)
        expect(installed.observation.attempts).toBe(1)
      })
      expect(server.seen).toEqual([
        { method: 'GET', path: '/v1/echo', body: '', header: undefined },
        { method: 'GET', path: '/v1/echo', body: '', header: undefined },
      ])
    } finally {
      await server.close()
    }
  })

  it('a caller proxy init is consumed through its get trap without prototype traversal', async () => {
    const server = await startRecordingServer()
    const events: string[] = []
    const proxyInit: RequestInit = new Proxy(
      { method: 'POST', body: 'proxy-body' },
      {
        get(targetObject, key, receiver) {
          events.push(`get:${String(key)}`)
          return Reflect.get(targetObject, key, receiver)
        },
        getPrototypeOf() {
          events.push('getPrototypeOf')
          throw new Error('getPrototypeOf trap observed')
        },
      },
    )
    try {
      await withSeam(server.pathUrl('/v1'), async (installed) => {
        const response = await fetch(server.pathUrl('/v1/echo'), proxyInit)
        expect(response.status).toBe(200)
        expect(events).not.toContain('getPrototypeOf')
        expect(events.filter((event) => event === 'get:method')).toHaveLength(1)
        expect(installed.observation.attempts).toBe(1)
      })
      expect(server.seen).toEqual([{ method: 'POST', path: '/v1/echo', body: 'proxy-body' }])
    } finally {
      await server.close()
    }
  })

  it('hostile non-configurable redirect descriptors cannot bypass the forced error', async () => {
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
      const hostile = {} as RequestInit
      Object.defineProperty(hostile, 'redirect', { value: 'follow', writable: false, configurable: false })
      await withSeam(first.pathUrl('/v1'), async (installed) => {
        await expect(fetch(first.pathUrl('/v1/start'), hostile)).rejects.toThrow()
        expect(installed.observation.attempts).toBe(1)
      })
      expect(first.requests).toEqual(['/v1/start'])
      expect(second.requests).toEqual([])
    } finally {
      await first.close()
      await second.close()
    }
  })
  it('every runtime-requested RequestInit member keeps native receiver, count, value and order', async () => {
    const controller = new AbortController()
    const values: Record<string, unknown> = {
      method: 'POST',
      headers: { 'x-probe': 'all-members' },
      body: 'all-members-body',
      referrer: 'about:client',
      referrerPolicy: 'origin',
      mode: 'cors',
      credentials: 'include',
      cache: 'no-store',
      integrity: 'sha256-YWJj',
      keepalive: true,
      signal: controller.signal,
      duplex: 'half',
      dispatcher: { dispatch() {} },
      priority: 'high',
    }
    const makeAccessorInit = (inherited: boolean, events: Array<{ key: string; receiverIsOriginal: boolean }>): RequestInit => {
      const holder: Record<string, unknown> = {}
      for (const [key, value] of Object.entries(values)) {
        Object.defineProperty(holder, key, {
          enumerable: true,
          configurable: true,
          get() {
            const receiverIsOriginal = this === init
            events.push({ key, receiverIsOriginal })
            return value
          },
        })
      }
      const init: object = inherited ? Object.create(holder) : holder
      return init as RequestInit
    }
    const server = await startRecordingServer()
    try {
      // Native baseline read order (bun reads the subset of members it supports).
      const nativeEvents: Array<{ key: string; receiverIsOriginal: boolean }> = []
      new Request(server.pathUrl('/v1/native'), makeAccessorInit(false, nativeEvents))
      await withSeam(server.pathUrl('/v1'), async (installed) => {
        const seamEvents: Array<{ key: string; receiverIsOriginal: boolean }> = []
        const response = await fetch(server.pathUrl('/v1/echo'), makeAccessorInit(true, seamEvents))
        expect(response.status).toBe(200)
        expect(seamEvents.every((event) => event.receiverIsOriginal)).toBe(true)
        expect(seamEvents.map((event) => event.key)).toEqual(nativeEvents.map((event) => event.key))
        expect(installed.observation.attempts).toBe(1)
      })
      expect(server.seen).toEqual([{ method: 'POST', path: '/v1/echo', body: 'all-members-body', header: 'all-members' }])
    } finally {
      await server.close()
    }
  })

  it('undefined method/headers/body accessors are read exactly once with the original receiver', async () => {
    const server = await startRecordingServer()
    const undefinedAccessorInit = (key: string, inherited: boolean, events: Array<{ key: string; receiverIsOriginal: boolean }>): RequestInit => {
      const holder: Record<string, unknown> = {}
      let original: object
      Object.defineProperty(holder, key, {
        enumerable: true,
        configurable: true,
        get() {
          const receiverIsOriginal = this === original
          events.push({ key, receiverIsOriginal })
          return undefined
        },
      })
      original = inherited ? Object.create(holder) : holder
      return original as RequestInit
    }
    try {
      for (const key of ['method', 'headers', 'body']) {
        for (const inherited of [false, true]) {
          await withSeam(server.pathUrl('/v1'), async (installed) => {
            const events: Array<{ key: string; receiverIsOriginal: boolean }> = []
            const response = await fetch(server.pathUrl('/v1/echo'), undefinedAccessorInit(key, inherited, events))
            expect(response.status).toBe(200)
            expect(events).toEqual([{ key, receiverIsOriginal: true }])
            expect(installed.observation.attempts).toBe(1)
          })
        }
      }
      expect(server.seen).toEqual([
        { method: 'GET', path: '/v1/echo', body: '' },
        { method: 'GET', path: '/v1/echo', body: '' },
        { method: 'GET', path: '/v1/echo', body: '' },
        { method: 'GET', path: '/v1/echo', body: '' },
        { method: 'GET', path: '/v1/echo', body: '' },
        { method: 'GET', path: '/v1/echo', body: '' },
      ])
    } finally {
      await server.close()
    }
  })

  it('Request-input partial-init and body-ownership semantics match native construction', async () => {
    const freshInput = () =>
      new Request(url, { method: 'POST', body: 'original-body', headers: { 'x-original': 'yes' } })
    const usedInput = async () => {
      const input = freshInput()
      await input.text()
      return input
    }
    const lockedInput = () => {
      const input = freshInput()
      input.body?.getReader()
      return input
    }
    const undefinedAccessorsInit = (): RequestInit => {
      const init = {}
      for (const key of ['method', 'headers', 'body']) {
        Object.defineProperty(init, key, { enumerable: true, configurable: true, get: () => undefined })
      }
      return init as RequestInit
    }
    const statefulAccessorInit = (events: string[], inherited: boolean): RequestInit => {
      const holder: Record<string, unknown> = {}
      for (const [key, value] of Object.entries({
        method: 'PUT',
        body: 'stateful-body',
        headers: { 'content-type': 'text/plain', 'x-probe': 'stateful-header' },
      })) {
        Object.defineProperty(holder, key, {
          enumerable: true,
          configurable: true,
          get() {
            events.push(`${key}:${this === init ? 'receiver-ok' : 'receiver-bad'}`)
            return value
          },
        })
      }
      const init: object = inherited ? Object.create(holder) : holder
      return init as RequestInit
    }
    const proxyInit = (events: string[]): RequestInit =>
      new Proxy(
        { method: 'POST', body: 'proxy-body', headers: { 'x-probe': 'proxy-header' } },
        {
          get(targetObject, key, receiver) {
            events.push(`get:${String(key)}`)
            return Reflect.get(targetObject, key, receiver)
          },
          has(targetObject, key) {
            events.push(`has:${String(key)}`)
            return Reflect.has(targetObject, key)
          },
          getPrototypeOf() {
            throw new Error('getPrototypeOf trap observed')
          },
        },
      ) as RequestInit
    // Fresh AbortController per matrix side: makeInit() runs once for the native baseline and
    // once for the seam call, and each invocation records its own controller here so the signal
    // identity and abort propagation can be asserted per side (reset every iteration).
    let signalControllers: AbortController[] = []
    const cases: Array<{
      name: string
      makeInput: () => Request | Promise<Request>
      makeInit?: (events: string[]) => RequestInit
      omitInit?: boolean
    }> = [
      { name: 'no-init', omitInit: true, makeInput: freshInput },
      { name: 'empty-init', makeInput: freshInput, makeInit: () => ({}) },
      { name: 'headers-only', makeInput: freshInput, makeInit: () => ({ headers: { 'x-override': 'yes' } }) },
      { name: 'redirect-only', makeInput: freshInput, makeInit: () => ({ redirect: 'manual' }) },
      { name: 'inherited-headers-only', makeInput: freshInput, makeInit: () => Object.create({ headers: { 'x-override': 'inherited' } }) as RequestInit },
      { name: 'undefined-accessors', makeInput: freshInput, makeInit: undefinedAccessorsInit },
      { name: 'used-body-only-replacement', makeInput: usedInput, makeInit: () => ({ body: 'replacement-used-only' }) },
      { name: 'locked-body-only-replacement', makeInput: lockedInput, makeInit: () => ({ body: 'replacement-locked-only' }) },
      { name: 'used-body-replacement', makeInput: usedInput, makeInit: () => ({ method: 'PUT', body: 'replacement-used', headers: { 'x-override': 'used' } }) },
      { name: 'locked-body-replacement', makeInput: lockedInput, makeInit: () => ({ method: 'PUT', body: 'replacement-locked', headers: { 'x-override': 'locked' } }) },
      { name: 'stateful-own-accessors', makeInput: freshInput, makeInit: (events) => statefulAccessorInit(events, false) },
      { name: 'stateful-inherited-accessors', makeInput: freshInput, makeInit: (events) => statefulAccessorInit(events, true) },
      { name: 'proxy-get-has-traps', makeInput: freshInput, makeInit: proxyInit },
      {
        name: 'caller-signal-carrier',
        makeInput: freshInput,
        makeInit: () => {
          const controller = new AbortController()
          signalControllers.push(controller)
          return { signal: controller.signal }
        },
      },
    ]
    const server = await startRecordingServer()
    const url = server.pathUrl('/v1/request-input')
    const stateOf = (request: Request) => ({ bodyUsed: request.bodyUsed, locked: request.body?.locked ?? false })
    // Every getter-backed Request.prototype member the running runtime supports, compared
    // native against the seam snapshot, plus a full headers dump and proof that no own
    // redirect property shadows the intrinsic value (the forced redirect lives in the
    // separate init only).
    const intrinsicMembers = Object.getOwnPropertyNames(Request.prototype).filter(
      (member) => typeof Object.getOwnPropertyDescriptor(Request.prototype, member)?.get === 'function',
    )
    const memberSurface = (request: Request): Record<string, unknown> => {
      const surface: Record<string, unknown> = {
        headersDump: [...request.headers.entries()].sort(),
        ownRedirectDescriptor: Object.getOwnPropertyDescriptor(request, 'redirect'),
      }
      for (const member of intrinsicMembers) {
        const value = Reflect.get(Request.prototype, member, request)
        if (member === 'body') {
          surface.body = value === null ? null : 'body-stream'
        } else if (member === 'signal') {
          surface.signalAborted = (value as AbortSignal).aborted
        } else {
          surface[member] = value
        }
      }
      return surface
    }
    try {
      for (const testCase of cases) {
        signalControllers = []
        // Native baseline: the Request constructor alone decides every member and body ownership.
        const nativeEvents: string[] = []
        const nativeInput = await testCase.makeInput()
        const nativeSnapshot =
          testCase.omitInit === true ? new Request(nativeInput) : new Request(nativeInput, testCase.makeInit!(nativeEvents))
        const nativeMembers = memberSurface(nativeSnapshot)
        const nativeBody = await nativeSnapshot.clone().text()
        const nativeMethod: string = nativeSnapshot.method
        const nativeOriginal = nativeSnapshot.headers.get('x-original')
        const nativeOverride = nativeSnapshot.headers.get('x-override')
        const nativeState = stateOf(nativeInput)

        // The interceptor is a transparent Proxy of the current fetch so the full typeof fetch
        // surface (preconnect included) is preserved. `captured` is the exact snapshot the seam
        // hands to the native transport together with the controlled init; its member surface is
        // read pre-send without consuming the body stream, which stays intact for transmission.
        let captured: Request | undefined
        let capturedMembers: Record<string, unknown> | undefined
        let capturedInit: RequestInit | undefined
        globalThis.fetch = new Proxy(globalThis.fetch, {
          apply(target, thisArg, args) {
            captured = args[0] as Request
            capturedMembers = memberSurface(captured)
            capturedInit = args[1] as RequestInit | undefined
            return Reflect.apply(target, thisArg, args)
          },
        })
        try {
          const seamEvents: string[] = []
          const seamInput = await testCase.makeInput()
          await withSeam(server.pathUrl('/v1'), async (installed) => {
            const response =
              testCase.omitInit === true ? await fetch(seamInput) : await fetch(seamInput, testCase.makeInit!(seamEvents))
            expect(response.status).toBe(200)
            expect(captured).toBeDefined()
            expect(capturedInit).toEqual({ redirect: 'error' })
            expect(capturedMembers).toEqual(nativeMembers)
            expect(captured!.headers.get('x-original')).toBe(nativeOriginal)
            expect(captured!.headers.get('x-override')).toBe(nativeOverride)
            expect(seamEvents).toEqual(nativeEvents)
            expect(stateOf(seamInput)).toEqual(nativeState)
            expect(installed.observation.attempts).toBe(1)
            if (testCase.name === 'caller-signal-carrier') {
              const [nativeController, seamController] = signalControllers
              expect(nativeController).toBeDefined()
              expect(seamController).toBeDefined()
              // The transmitted snapshot must carry the exact caller signal objects, not fresh
              // replacements: identity on both sides, then live abort propagation after capture.
              expect(nativeSnapshot.signal).toBe(nativeController!.signal)
              expect(captured!.signal).toBe(seamController!.signal)
              seamController!.abort()
              nativeController!.abort()
              expect(captured!.signal.aborted).toBe(true)
              expect(nativeSnapshot.signal.aborted).toBe(true)
            }
          })
          const wire = server.seen[server.seen.length - 1]
          expect(wire.method).toBe(nativeMethod)
          expect(wire.body).toBe(nativeBody)
        } finally {
          globalThis.fetch = PRISTINE_FETCH
        }
      }
    } finally {
      await server.close()
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
    let handleGetterReads = 0
    Object.defineProperty(requestHandler, 'handle', {
      get: () => {
        handleGetterReads += 1
        return current
      },
      set: () => {
        throw new Error('setter exploded')
      },
      enumerable: true,
      configurable: true,
    })
    const client = bedrockClientWithHandler(requestHandler)
    try {
      await withSeam(BASE, async (installed) => {
        // The SDK may read handle during client construction (before the seam exists); baseline
        // the counter here so the assertion covers exactly the seam-attributable getter reads.
        const getterReadsBeforeSends = handleGetterReads
        for (let round = 0; round < 2; round += 1) {
          const error = await sendOnce(client)
          expect((error as Error).message).toMatch(/host transport seam: Bedrock request handler handle is not writable/)
          expect((error as Error).message).not.toContain('setter exploded')
          expect(wireCalls.count).toBe(0)
          expect(installed.observation.attempts).toBe(0)
        }
        // Exactly one pre-latch getter read (the first callable check); the latched second send
        // must consult the permanent failed state before any further handle property access.
        expect(handleGetterReads - getterReadsBeforeSends).toBe(1)
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
    let handleGetterReads = 0
    Object.defineProperty(requestHandler, 'handle', {
      get: () => {
        handleGetterReads += 1
        return current
      },
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
    const sendSlot = BedrockRuntimeClient.prototype as { send?: unknown }
    sendSlot.send = function (this: BedrockRuntimeClient, ...args: unknown[]) {
      originalSendCalls += 1
      return (pristineSend as (this: BedrockRuntimeClient, ...sendArgs: unknown[]) => unknown).apply(this, args)
    }
    try {
      // The seam captures this spy as originalSend; a non-zero count means a
      // latched send reached it. The stored leftover wrapper would raise
      // attempts, and the real handler would raise wireCalls — all must stay
      // at their initial values across every repeat.
      await withSeam(BASE, async (installed) => {
        const initialObservation = { ...installed.observation }
        // Baseline after install: the assertion must count only seam-attributable getter reads,
        // independent of any construction-time SDK access before the seam existed.
        const getterReadsBeforeSends = handleGetterReads
        for (let round = 0; round < 3; round += 1) {
          const error = await sendOnce(client)
          expect((error as Error).message).toBe('host transport seam: Bedrock request handler handle is not writable')
          expect(typeof current).toBe('function')
          expect(originalSendCalls).toBe(0)
          expect(wireCalls.count).toBe(0)
          expect(installed.observation).toEqual(initialObservation)
        }
        // The stored-then-thrown first send reads handle exactly once (its callable check); both
        // later sends must hit the permanent failed latch with zero post-latch getter reads, zero
        // originalSend reach-through, and no wire or observation mutation.
        expect(handleGetterReads - getterReadsBeforeSends).toBe(1)
      })
    } finally {
      sendSlot.send = PRISTINE_SEND
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
