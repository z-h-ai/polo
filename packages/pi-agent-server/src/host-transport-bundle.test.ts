/**
 * POO-69 production-bundle seam smoke.
 *
 * Builds a REAL production-mode bundle through the shared SOT
 * (`buildPiAgentServerBundle` → `piAgentServerBuildArgs`, Node-target ESM,
 * only koffi external) with a temporary entry that installs the transport
 * seam, registers the pi-ai Bedrock provider module and triggers a real
 * model call. The artifact is copied to a node_modules-free directory and
 * executed under the Node host. A `--import` preload intercepts ONLY the
 * builtin HTTPS/HTTP2 transports whose normalized hostname equals the exact
 * Bedrock runtime hostname (strict `===`, never substring) and redirects them
 * to a local TLS 503 server — the AWS constructor, request
 * handler and send are never replaced or mocked and AWS_ENDPOINT_URL* stays
 * unset. Proves: the exact-hostname server sees exactly one request, the
 * SDK-internal retry (AWS_MAX_ATTEMPTS=3) is blocked by the seam before the
 * second wire attempt, the structured 503 is observed, a suffixed lookalike
 * hostname is NOT redirected (direct connection, zero fixture hits), and the
 * bundle has no external AWS runtime imports.
 */
import { describe, expect, it } from 'bun:test'
import { copyFileSync, existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { buildPiAgentServerBundle } from '../../../scripts/build/pi-agent-server-staging.ts'

const HOST_NODE = process.env.POLO_PI_HOST_NODE ?? 'node'

const PRELOAD_MJS = `
import https from 'node:https'
import http2 from 'node:http2'
const BEDROCK_HOST = 'bedrock-runtime.us-east-1.amazonaws.com'
const targetHost = process.env.SEAM_FIXTURE_HOST || '127.0.0.1'
const targetPort = Number(process.env.SEAM_FIXTURE_PORT)
if (!targetPort) throw new Error('SEAM_FIXTURE_PORT missing')
function exactHostname(candidate) {
  let hostname = String(candidate).toLowerCase()
  if (hostname.startsWith('[') && hostname.endsWith(']')) hostname = hostname.slice(1, -1)
  return hostname
}
function hostnameFromAuthority(authority) {
  if (typeof authority === 'string') {
    try { return new URL(authority).hostname } catch { return null }
  }
  if (authority instanceof URL) return authority.hostname
  if (authority && typeof authority === 'object') {
    const host = authority.hostname ?? authority.host
    if (typeof host === 'string') {
      try { return new URL('https://' + host).hostname } catch { return host }
    }
  }
  return null
}
const originalConnect = http2.connect
http2.connect = function (authority, options, listener) {
  let rewritten = authority
  const hostname = hostnameFromAuthority(authority)
  if (hostname !== null && exactHostname(hostname) === BEDROCK_HOST) {
    rewritten = 'https://' + targetHost + ':' + targetPort
    options = { ...options, rejectUnauthorized: false }
  }
  return originalConnect.call(this, rewritten, options, listener)
}
const originalRequest = https.request
https.request = function (...args) {
  const urlArg = args.find((a) => typeof a === 'string' || a instanceof URL)
  const optionsArg = args.find((a) => a && typeof a === 'object' && !Array.isArray(a) && !(a instanceof URL))
  let hostname = null
  if (typeof urlArg === 'string') {
    try { hostname = new URL(urlArg).hostname } catch { hostname = null }
  } else if (urlArg instanceof URL) {
    hostname = urlArg.hostname
  }
  if (hostname === null && optionsArg) {
    const host = optionsArg.hostname ?? optionsArg.host
    if (typeof host === 'string') {
      try { hostname = new URL('https://' + host).hostname } catch { hostname = host }
    }
  }
  if (hostname !== null && optionsArg && exactHostname(hostname) === BEDROCK_HOST) {
    args[args.indexOf(optionsArg)] = { ...optionsArg, hostname: targetHost, host: targetHost, port: targetPort, rejectUnauthorized: false }
  }
  return originalRequest.apply(this, args)
}
`

const TLS_SERVER_MJS = `
import http2 from 'node:http2'
import { readFileSync } from 'node:fs'
const [key, cert] = [process.argv[2], process.argv[3]].map((p) => readFileSync(p))
const server = http2.createSecureServer({ key, cert, allowHTTP1: true })
server.on('stream', (stream, headers) => {
  console.log('REQUEST:' + String(headers[':path'] ?? ''))
  stream.respond({ ':status': '503', 'content-type': 'application/json' })
  stream.end(JSON.stringify({ __type: 'ServiceUnavailableException' }))
})
server.listen(0, '127.0.0.1', () => {
  console.log('READY:' + server.address().port)
})
setInterval(() => {}, 1000)
process.on('SIGTERM', () => process.exit(0))
`

const ENTRY_TEMPLATE = (policyImport: string): string => `
import { installTransportObservation, classifyTransportFailure } from '${policyImport}'

const installed = installTransportObservation(new URL('https://bedrock-runtime.us-east-1.amazonaws.com'))

async function main() {
  const [{ getModel, setBedrockProviderModule, streamSimple }, { bedrockProviderModule }] = await Promise.all([
    import('@mariozechner/pi-ai'),
    import('@mariozechner/pi-ai/bedrock-provider'),
  ])
  setBedrockProviderModule(bedrockProviderModule)
  const model = getModel('amazon-bedrock', 'amazon.nova-lite-v1:0')
  if (process.env.SEAM_FIXTURE_MODEL_BASE_URL) model.baseUrl = process.env.SEAM_FIXTURE_MODEL_BASE_URL
  const events = streamSimple(model, { systemPrompt: '', messages: [{ role: 'user', content: 'bundle seam smoke' }] }, {})
  for await (const event of events) {
    if (event.type === 'error') break
  }
  const classification = classifyTransportFailure(installed.observation, { deadlineExpired: false, providerFailed: true })
  console.log('RESULT:' + JSON.stringify({ observation: installed.observation, classification }))
}

main().then(
  () => process.exit(0),
  (error) => {
    console.error('ENTRY-FAILED', error)
    process.exit(1)
  },
)
`

async function readLines(stream: ReadableStream<Uint8Array>, onLine: (line: string) => void): Promise<void> {
  const reader = stream.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  for (;;) {
    const newline = buffer.indexOf('\n')
    if (newline >= 0) {
      const line = buffer.slice(0, newline).trim()
      buffer = buffer.slice(newline + 1)
      if (line) onLine(line)
      continue
    }
    const { value, done } = await reader.read()
    if (done) {
      if (buffer.trim()) onLine(buffer.trim())
      return
    }
    buffer += decoder.decode(value, { stream: true })
  }
}

function collectLines(stream: ReadableStream<Uint8Array>): {
  lines: string[]
  settled: Promise<void>
  waitForLine(prefix: string, timeoutMs: number): Promise<string>
} {
  const lines: string[] = []
  const waiters: Array<{ prefix: string; resolve: (line: string) => void; reject: (error: Error) => void; timer: ReturnType<typeof setTimeout> }> = []
  const settled = readLines(stream, (line) => {
    lines.push(line)
    const waiterIndex = waiters.findIndex((waiter) => line.startsWith(waiter.prefix))
    if (waiterIndex >= 0) {
      const [waiter] = waiters.splice(waiterIndex, 1)
      clearTimeout(waiter.timer)
      waiter.resolve(line)
    }
  })
  return {
    lines,
    settled,
    waitForLine(prefix: string, timeoutMs: number): Promise<string> {
      const existing = lines.find((line) => line.startsWith(prefix))
      if (existing) return Promise.resolve(existing)
      return new Promise<string>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error(`timed out waiting for line ${prefix}`)), timeoutMs)
        waiters.push({ prefix, resolve, reject, timer })
      })
    },
  }
}

interface BundleScenarioResult {
  observation: { attempts: number; status?: number; networkFailure: boolean; retryBlocked: boolean; sdkException: boolean }
  classification: string
}

describe('host transport seam in the production bundle', () => {
  it('redirects only the exact bedrock runtime hostname; lookalike hosts stay direct', async () => {
    // 1. Temporary entry INSIDE the package so the bun build resolves the
    //    workspace deps; only sourceEntry and distDir differ from production.
    const fixtureDir = mkdtempSync(join(import.meta.dir, 'host-transport-bundle-'))
    const entryPath = join(fixtureDir, 'index.ts')
    const distDir = join(fixtureDir, 'dist')
    try {
      writeFileSync(entryPath, ENTRY_TEMPLATE('../host-completion-policy.ts'))
      writeFileSync(join(fixtureDir, 'preload.mjs'), PRELOAD_MJS)
      writeFileSync(join(fixtureDir, 'server.mjs'), TLS_SERVER_MJS)
      await buildPiAgentServerBundle({ sourceEntry: entryPath, distDir }, join(import.meta.dir, '..', '..', '..'))
      const bundlePath = join(distDir, 'index.js')
      expect(existsSync(bundlePath)).toBe(true)

      // 2. Bundle shape: production args are Node-target ESM single-file.
      //    Scan the emitted import statements: every external must be a Node
      //    builtin — zero external AWS runtime imports (inlined, not required).
      const bundle = readFileSync(bundlePath, 'utf-8')
      expect(bundle).toContain('createRequire')
      const importSpecifiers = bundle
        .split('\n')
        .filter((line) => line.startsWith('import '))
        .map((line) => /from\s*["']([^"']+)["']|import\s*["']([^"']+)["']/.exec(line))
        .map((match) => match?.[1] ?? match?.[2])
        .filter((spec): spec is string => typeof spec === 'string')
      expect(importSpecifiers.length).toBeGreaterThan(0)
      const nonBuiltin = importSpecifiers.filter(
        (spec) => !/^(node:)?(assert|async_hooks|buffer|child_process|cluster|console|constants|crypto|dgram|diagnostics_channel|dns|dns\/promises|domain|events|fs|fs\/promises|http|http2|https|inspector|module|net|os|path|path\/posix|path\/win32|perf_hooks|process|punycode|querystring|readline|readline\/promises|repl|stream|stream\/consumers|stream\/promises|stream\/web|string_decoder|sys|timers|timers\/promises|tls|trace_events|tty|url|util|util\/types|v8|vm|wasi|worker_threads|zlib)$/.test(spec),
      )
      expect(nonBuiltin).toEqual([])
      expect(readdirSync(distDir)).toEqual(['index.js'])

      // 3. Self-signed TLS cert for the redirected local endpoint.
      const openssl = Bun.spawnSync({
        cmd: [
          'openssl', 'req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '2',
          '-subj', '/CN=bedrock-runtime.us-east-1.amazonaws.com',
          '-keyout', join(fixtureDir, 'key.pem'),
          '-out', join(fixtureDir, 'cert.pem'),
        ],
        stdout: 'pipe',
        stderr: 'pipe',
      })
      expect(openssl.exitCode).toBe(0)

      // Each scenario: fresh local TLS 503 server + fresh isolated host run.
      const runScenario = async (modelBaseUrl?: string): Promise<{ result: BundleScenarioResult; requestLines: string[] }> => {
        const server = Bun.spawn({
          cmd: [HOST_NODE, join(fixtureDir, 'server.mjs'), join(fixtureDir, 'key.pem'), join(fixtureDir, 'cert.pem')],
          stdout: 'pipe',
          stderr: 'pipe',
        })
        const serverLines = collectLines(server.stdout as ReadableStream<Uint8Array>)
        try {
          const readyLine = await serverLines.waitForLine('READY:', 15000)
          const tlsPort = Number(readyLine.slice('READY:'.length))

          // Isolated host layout: the ONLY artifact plus its ESM package.json —
          // no node_modules anywhere up this tree.
          const isolated = mkdtempSync(join(tmpdir(), 'seam-host-'))
          copyFileSync(bundlePath, join(isolated, 'index.js'))
          writeFileSync(join(isolated, 'package.json'), JSON.stringify({ type: 'module' }))

          // Real host run with AWS_MAX_ATTEMPTS=3 explicitly preserved and no
          // AWS_ENDPOINT_URL* anywhere in the environment.
          const hostEnv: Record<string, string | undefined> = {
            ...process.env,
            ELECTRON_RUN_AS_NODE: '1',
            AWS_MAX_ATTEMPTS: '3',
            AWS_REGION: 'us-east-1',
            AWS_ACCESS_KEY_ID: 'seam-fixture-key',
            AWS_SECRET_ACCESS_KEY: 'seam-fixture-secret',
            AWS_EC2_METADATA_DISABLED: 'true',
            SEAM_FIXTURE_HOST: '127.0.0.1',
            SEAM_FIXTURE_PORT: String(tlsPort),
          }
          delete hostEnv.AWS_ENDPOINT_URL
          delete hostEnv.AWS_ENDPOINT_URL_BEDROCK
          if (modelBaseUrl) hostEnv.SEAM_FIXTURE_MODEL_BASE_URL = modelBaseUrl
          const host = Bun.spawn({
            cmd: [HOST_NODE, '--import', join(fixtureDir, 'preload.mjs'), join(isolated, 'index.js')],
            stdout: 'pipe',
            stderr: 'pipe',
            env: hostEnv,
          })
          const hostStderrText = await new Response(host.stderr).text()
          const hostStdoutText = await new Response(host.stdout).text()
          const hostExit = await host.exited
          rmSync(isolated, { recursive: true, force: true })
          if (hostExit !== 0) {
            throw new Error(`bundled host failed (exit ${hostExit})\n${hostStderrText}`)
          }
          const resultLine = hostStdoutText.split('\n').find((line) => line.startsWith('RESULT:'))
          expect(resultLine).toBeDefined()
          const result = JSON.parse(resultLine!.slice('RESULT:'.length)) as BundleScenarioResult
          const requestLines = serverLines.lines.filter((line) => line.startsWith('REQUEST:'))
          return { result, requestLines }
        } finally {
          server.kill()
          await serverLines.settled
        }
      }

      // Positive: the exact hostname is redirected — one structured 503 wire
      // attempt, blocked SDK retry, exactly one fixture request.
      const exact = await runScenario()
      expect(exact.result.observation).toEqual({
        attempts: 2,
        status: 503,
        networkFailure: false,
        retryBlocked: true,
        sdkException: true,
      })
      expect(exact.result.classification).toBe('retry_blocked')
      expect(exact.requestLines.length).toBe(1)
      expect(exact.requestLines[0]).toContain('/model/amazon.nova-lite-v1')

      // Negative: a suffixed lookalike hostname is NOT redirected. The request
      // goes direct — the real DNS failure surfaces as networkFailure with no
      // structured status (never the fixture's 503), and the seam still blocks
      // the SDK's retry before a second wire attempt. Zero fixture hits prove
      // substring interception would have failed this.
      const lookalike = await runScenario('https://bedrock-runtime.us-east-1.amazonaws.com.attacker')
      expect(lookalike.result.observation).toEqual({
        attempts: 2,
        status: undefined,
        networkFailure: true,
        retryBlocked: true,
        sdkException: true,
      })
      expect(lookalike.result.classification).toBe('retry_blocked')
      expect(lookalike.requestLines).toEqual([])
    } finally {
      rmSync(fixtureDir, { recursive: true, force: true })
    }
  }, 240000)
})
