/**
 * POO-69 production-bundle seam smoke.
 *
 * Builds a REAL production-mode bundle through the shared SOT
 * (`buildPiAgentServerBundle` → `piAgentServerBuildArgs`, Node-target ESM,
 * only koffi external) with a temporary entry that installs the transport
 * seam, registers the pi-ai Bedrock provider module and triggers a real
 * model call. The artifact is copied to a node_modules-free directory and
 * executed under the Node host. A `--import` preload intercepts ONLY the
 * builtin HTTPS/HTTP2 transports for the exact Bedrock runtime hostname and
 * redirects them to a local TLS 503 server — the AWS constructor, request
 * handler and send are never replaced or mocked and AWS_ENDPOINT_URL* stays
 * unset. Proves: the server sees exactly one request, the SDK-internal retry
 * (AWS_MAX_ATTEMPTS=3) is blocked by the seam before the second wire attempt,
 * the structured 503 is observed, and the bundle has no external AWS runtime
 * imports.
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
const originalConnect = http2.connect
http2.connect = function (authority, options, listener) {
  let rewritten = authority
  if (typeof authority === 'string' && authority.includes(BEDROCK_HOST)) {
    rewritten = 'https://' + targetHost + ':' + targetPort
    options = { ...options, rejectUnauthorized: false }
  }
  return originalConnect.call(this, rewritten, options, listener)
}
const originalRequest = https.request
https.request = function (...args) {
  const optionsIndex = args.findIndex((a) => a && typeof a === 'object' && !Array.isArray(a))
  if (optionsIndex >= 0) {
    const options = args[optionsIndex]
    const hostname = typeof options === 'string' ? options : options.hostname || options.host
    if (typeof hostname === 'string' && hostname.includes(BEDROCK_HOST)) {
      args[optionsIndex] = { ...options, hostname: targetHost, host: targetHost, port: targetPort, rejectUnauthorized: false }
    }
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

describe('host transport seam in the production bundle', () => {
  it('single-attempt observation survives the real production build in a node_modules-free host', async () => {
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

      // 4. Local TLS 503 server under Node — the only wire endpoint.
      const server = Bun.spawn({
        cmd: [HOST_NODE, join(fixtureDir, 'server.mjs'), join(fixtureDir, 'key.pem'), join(fixtureDir, 'cert.pem')],
        stdout: 'pipe',
        stderr: 'pipe',
      })
      const serverLines = collectLines(server.stdout as ReadableStream<Uint8Array>)
      try {
        const readyLine = await serverLines.waitForLine('READY:', 15000)
        const tlsPort = Number(readyLine.slice('READY:'.length))

        // 5. Isolated host layout: the ONLY artifact plus its ESM package.json —
        //    no node_modules anywhere up this tree.
        const isolated = mkdtempSync(join(tmpdir(), 'seam-host-'))
        copyFileSync(bundlePath, join(isolated, 'index.js'))
        writeFileSync(join(isolated, 'package.json'), JSON.stringify({ type: 'module' }))

        // 6. Real host run with AWS_MAX_ATTEMPTS=3 explicitly preserved and no
        //    AWS_ENDPOINT_URL* anywhere in the environment.
        const hostEnv = { ...process.env }
        delete hostEnv.AWS_ENDPOINT_URL
        delete hostEnv.AWS_ENDPOINT_URL_BEDROCK
        const host = Bun.spawn({
          cmd: [HOST_NODE, '--import', join(fixtureDir, 'preload.mjs'), join(isolated, 'index.js')],
          stdout: 'pipe',
          stderr: 'pipe',
          env: {
            ...hostEnv,
            ELECTRON_RUN_AS_NODE: '1',
            AWS_MAX_ATTEMPTS: '3',
            AWS_REGION: 'us-east-1',
            AWS_ACCESS_KEY_ID: 'seam-fixture-key',
            AWS_SECRET_ACCESS_KEY: 'seam-fixture-secret',
            AWS_EC2_METADATA_DISABLED: 'true',
            SEAM_FIXTURE_HOST: '127.0.0.1',
            SEAM_FIXTURE_PORT: String(tlsPort),
          },
        })
        const hostStderrText = await new Response(host.stderr).text()
        const hostStdoutText = await new Response(host.stdout).text()
        const hostExit = await host.exited
        rmSync(isolated, { recursive: true, force: true })

        // 7. Host outcome: one wire attempt, blocked SDK retry, structured 503.
        if (hostExit !== 0) {
          throw new Error(`bundled host failed (exit ${hostExit})\n${hostStderrText}`)
        }
        const resultLine = hostStdoutText.split('\n').find((line) => line.startsWith('RESULT:'))
        expect(resultLine).toBeDefined()
        const result = JSON.parse(resultLine!.slice('RESULT:'.length)) as {
          observation: { attempts: number; status?: number; networkFailure: boolean; retryBlocked: boolean; sdkException: boolean }
          classification: string
        }
        expect(result.observation).toEqual({
          attempts: 2,
          status: 503,
          networkFailure: false,
          retryBlocked: true,
          sdkException: true,
        })
        expect(result.classification).toBe('retry_blocked')
      } finally {
        server.kill()
        await serverLines.settled
      }

      // 8. The redirected TLS server saw exactly ONE wire request.
      const requestLines = serverLines.lines.filter((line) => line.startsWith('REQUEST:'))
      expect(requestLines.length).toBe(1)
      expect(requestLines[0]).toContain('/model/amazon.nova-lite-v1')
    } finally {
      rmSync(fixtureDir, { recursive: true, force: true })
    }
  }, 180000)
})
