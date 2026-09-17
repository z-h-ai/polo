import { describe, expect, it, beforeAll, afterAll } from 'bun:test'
import { copyFileSync, existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawn } from 'node:child_process'
import { buildPiAgentServerBundle } from '../../../../scripts/build/pi-agent-server-staging.ts'
import { acquireHostTestSerialLock, releaseHostTestSerialLock, waitOutEarlySuiteWindow } from './host-test-serial.ts'

await waitOutEarlySuiteWindow()

const HOST_NODE = process.env.POLO_PI_HOST_NODE ?? 'node'
const PACKAGE_ROOT = join(import.meta.dir, '..', '..')
const REPO_ROOT = join(PACKAGE_ROOT, '..', '..')

const PRELOAD_MJS = `
import https from 'node:https'
import http2 from 'node:http2'
const BEDROCK_HOST = 'bedrock-runtime.us-east-1.amazonaws.com'
const targetHost = '127.0.0.1'
const targetPort = Number(process.env.HOST_FIXTURE_PORT)
if (!targetPort) throw new Error('HOST_FIXTURE_PORT missing')
function exactHostname(candidate) {
  let hostname = String(candidate).toLowerCase()
  if (hostname.startsWith('[') && hostname.endsWith(']')) hostname = hostname.slice(1, -1)
  return hostname
}
const originalConnect = http2.connect
http2.connect = function (authority, options, listener) {
  let rewritten = authority
  let hostname = null
  if (typeof authority === 'string') { try { hostname = new URL(authority).hostname } catch { hostname = null } }
  else if (authority instanceof URL) hostname = authority.hostname
  else if (authority && typeof authority === 'object') hostname = authority.hostname ?? null
  if (hostname !== null && exactHostname(hostname) === BEDROCK_HOST) {
    rewritten = 'https://' + targetHost + ':' + targetPort
    options = { ...options, rejectUnauthorized: false }
  }
  return originalConnect.call(this, rewritten, options, listener)
}
const originalRequest = https.request
https.request = function (...args) {
  const urlIndex = args.findIndex((a) => typeof a === 'string' || a instanceof URL)
  let hostname = null
  const optionsObject = args.find((a) => a && typeof a === 'object' && !Array.isArray(a) && !(a instanceof URL))
  if (urlIndex >= 0) {
    try { hostname = (typeof args[urlIndex] === 'string' ? new URL(args[urlIndex]) : args[urlIndex]).hostname } catch { hostname = null }
  }
  if (hostname === null && optionsObject) {
    const candidate = typeof optionsObject.hostname === 'string' ? optionsObject.hostname : typeof optionsObject.host === 'string' ? optionsObject.host : null
    if (candidate !== null) hostname = candidate
  }
  if (hostname !== null && exactHostname(hostname) === BEDROCK_HOST) {
    if (optionsObject) {
      const optionsIndex = args.indexOf(optionsObject)
      args[optionsIndex] = { ...optionsObject, hostname: targetHost, host: targetHost, port: targetPort, rejectUnauthorized: false }
    } else if (urlIndex >= 0) {
      const url = typeof args[urlIndex] === 'string' ? new URL(args[urlIndex]) : args[urlIndex]
      args[urlIndex] = 'https://' + targetHost + ':' + targetPort + (url.pathname || '/')
      const callbackIndex = args.findIndex((a) => typeof a === 'function')
      args.splice(callbackIndex >= 0 ? callbackIndex : args.length, 0, { rejectUnauthorized: false })
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
let requests = 0
server.on('request', (req, res) => {
  requests += 1
  console.log('REQUEST:' + String(req.url ?? ''))
  res.writeHead(503, { 'content-type': 'application/json' })
  res.end(JSON.stringify({ __type: 'ServiceUnavailableException' }))
})
server.listen(0, '127.0.0.1', () => console.log('READY:' + server.address().port))
setInterval(() => console.log('COUNT:' + requests), 200)
process.on('SIGTERM', () => process.exit(0))
`

function collectLines(stream: import('node:stream').Readable, onLine: (line: string) => void): void {
  let buffer = ''
  stream.setEncoding('utf8')
  stream.on('data', (chunk) => {
    buffer += chunk
    for (;;) {
      const newline = buffer.indexOf('\n')
      if (newline < 0) return
      const line = buffer.slice(0, newline).trim()
      buffer = buffer.slice(newline + 1)
      if (line) onLine(line)
    }
  })
}

describe('pi-agent-server production bundle host dispatch', () => {
  beforeAll(async () => { await acquireHostTestSerialLock() })
  afterAll(() => releaseHostTestSerialLock())

  it('builds the single-file production bundle and serves BOTH the isolated host worker and the ordinary session protocol', async () => {
    const fixtureDir = mkdtempSync(join(tmpdir(), 'host-bundle-'))
    const distDir = join(fixtureDir, 'dist')
    try {
      await buildPiAgentServerBundle({
        sourceEntry: join(PACKAGE_ROOT, 'src', 'index.ts'),
        distDir,
      }, REPO_ROOT)
      const bundlePath = join(distDir, 'index.js')
      expect(existsSync(bundlePath)).toBe(true)
      expect(readdirSync(distDir)).toEqual(['index.js'])
      const bundle = readFileSync(bundlePath, 'utf-8')
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

      const isolated = mkdtempSync(join(tmpdir(), 'host-bundle-run-'))
      try {
      copyFileSync(bundlePath, join(isolated, 'index.js'))
      writeFileSync(join(isolated, 'package.json'), JSON.stringify({ type: 'module' }))

      const openssl = Bun.spawnSync({
        cmd: ['openssl', 'req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '2', '-subj', '/CN=bedrock-runtime.us-east-1.amazonaws.com', '-keyout', join(fixtureDir, 'key.pem'), '-out', join(fixtureDir, 'cert.pem')],
        stdout: 'pipe',
        stderr: 'pipe',
      })
      expect(openssl.exitCode).toBe(0)
      writeFileSync(join(fixtureDir, 'preload.mjs'), PRELOAD_MJS)
      writeFileSync(join(fixtureDir, 'server.mjs'), TLS_SERVER_MJS)

      const server = spawn(HOST_NODE, [join(fixtureDir, 'server.mjs'), join(fixtureDir, 'key.pem'), join(fixtureDir, 'cert.pem')], { stdio: ['ignore', 'pipe', 'pipe'] })
      const serverRequests: string[] = []
      collectLines(server.stdout!, (line) => {
        if (line.startsWith('REQUEST:')) serverRequests.push(line.slice('REQUEST:'.length))
      })
      // The isolated bundle dir is cleaned on every exit path (R5 minor 2).
      try {
        const ready = await new Promise<number>((resolve, reject) => {
          const timer = setTimeout(() => reject(new Error('fixture server did not become ready')), 20000)
          collectLines(server.stdout!, (line) => {
            if (line.startsWith('READY:')) {
              clearTimeout(timer)
              resolve(Number(line.slice('READY:'.length)))
            }
          })
        })
        expect(ready).toBeGreaterThan(0)

        const hostRequest = JSON.stringify({
          type: 'host_completion', version: 1, parentValidation: 'sessionless-host-llm-executor.v1', requestId: 'req-bedrock',
          route: { kind: 'catalog', provider: 'amazon-bedrock', transportBaseUrl: 'https://bedrock-runtime.us-east-1.amazonaws.com/' },
          model: 'pi/amazon.nova-lite-v1:0', prompt: 'bundle host smoke', maxOutputTokens: 16, timeoutMs: 60000,
          credential: { type: 'iam', accessKeyId: 'AKIA-ambient-canary', secretAccessKey: 'ambient-aws-secret-canary', region: 'us-east-1' },
        }) + '\n'
        const hostRun = await new Promise<{ code: number | null; stdout: string; stderr: string }>((resolve) => {
          const child = spawn('/usr/bin/nice', ['-n', '20', HOST_NODE, '--import', join(fixtureDir, 'preload.mjs'), join(isolated, 'index.js'), '--host-completion-v1'], {
            env: { ...process.env, PATH: process.env.PATH, HOME: process.env.HOME, TMPDIR: process.env.TMPDIR, ELECTRON_RUN_AS_NODE: '1', AWS_MAX_ATTEMPTS: '3', AWS_ACCESS_KEY_ID: 'ambient-key-canary', AWS_SECRET_ACCESS_KEY: 'ambient-aws-secret-canary', AWS_PROFILE: 'ambient-profile', AWS_BEDROCK_SKIP_AUTH: '1', AWS_ENDPOINT_URL_BEDROCK: 'https://ambient-endpoint-canary.invalid', HOST_FIXTURE_PORT: String(ready) },
            stdio: ['pipe', 'pipe', 'pipe'],
          })
          let stdout = ''
          let stderr = ''
          child.stdout.on('data', (data) => { stdout += data })
          child.stderr.on('data', (data) => { stderr += data })
          child.stdin.end(hostRequest)
          const killTimer = setTimeout(() => child.kill('SIGKILL'), 90000)
          child.on('close', (code) => {
            clearTimeout(killTimer)
            resolve({ code, stdout, stderr })
          })
        })
        expect(hostRun.code).toBe(0)
        const resultLines = hostRun.stdout.split('\n').filter((line) => line.trim().length > 0)
        expect(resultLines).toHaveLength(1)
        const result = JSON.parse(resultLines[0]) as { type: string; requestId: string; model: string; status: string; text?: string; error: { code: string; reason: string; message: string } }
        expect(result).toMatchObject({ type: 'host_completion_result', version: 1, requestId: 'req-bedrock', model: 'pi/amazon.nova-lite-v1:0', status: 'failed' })
        expect(result.error).toEqual({ code: 'provider_failed', reason: 'provider_request_failed', message: 'LLM provider request failed' })
        expect(result.text).toBeUndefined()
        expect(serverRequests).toHaveLength(1)
        expect(serverRequests[0]).toContain('/model/amazon.nova-lite-v1%3A0/converse-stream')
        for (const canary of ['ambient-key-canary', 'ambient-aws-secret-canary', 'ambient-profile', 'ambient-endpoint-canary']) {
          expect(hostRun.stdout).not.toContain(canary)
          expect(hostRun.stderr).not.toContain(canary)
        }

        const ordinaryRun = await new Promise<{ code: number | null; stdout: string }>((resolve) => {
          const child = spawn('/usr/bin/nice', ['-n', '20', HOST_NODE, join(isolated, 'index.js')], {
            env: { ...process.env, PATH: process.env.PATH, HOME: process.env.HOME, TMPDIR: process.env.TMPDIR, ELECTRON_RUN_AS_NODE: '1' },
            stdio: ['pipe', 'pipe', 'pipe'],
          })
          let stdout = ''
          child.stdout.on('data', (data) => { stdout += data })
          child.stdin.end(JSON.stringify({ type: 'init', sessionId: 'host-bundle-ordinary', cwd: '/tmp' }) + '\n')
          const killTimer = setTimeout(() => child.kill('SIGKILL'), 60000)
          child.on('close', (code) => {
            clearTimeout(killTimer)
            resolve({ code, stdout })
          })
        })
        const ordinaryLines = ordinaryRun.stdout.split('\n').filter((line) => line.trim().length > 0).map((line) => JSON.parse(line) as Record<string, unknown>)
        expect(ordinaryLines[0]?.type).toBe('ready')
        expect(ordinaryLines[0]).not.toHaveProperty('callbackPort')
      } finally {
        server.kill()
      }
      } finally {
        rmSync(isolated, { recursive: true, force: true })
      }
    } finally {
      rmSync(fixtureDir, { recursive: true, force: true })
    }
  }, 360000)
})
