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
 * hostname is NOT redirected (direct connection, zero fixture hits), the
 * https.request overload matrix and the three-state Node URL/options host
 * precedence (own-enumerable values only, per ObjectAssign semantics:
 * non-empty hostname > non-empty host > URL hostname; explicit empty/undefined/
 * non-string values are invalid and never redirected; inherited and
 * non-enumerable properties are ignored) redirect only when the
 * Node-effective target is the exact Bedrock host, and the bundle has no
 * external AWS runtime imports.
 */
import { describe, expect, it } from 'bun:test'
import { copyFileSync, existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { buildPiAgentServerBundle } from '../../../scripts/build/pi-agent-server-staging.ts'

const HOST_NODE = process.env.POLO_PI_HOST_NODE ?? 'node'

// Shape names in harness declaration order (the harness resolves Promise.all
// in input order, so results arrive in this exact order).
const HARNESS_SHAPE_ORDER = [
  'options-only',
  'string-options',
  'url-options',
  'string-callback',
  'url-callback',
  'conflict-string-exact-url-lookalike-hostname',
  'conflict-string-lookalike-url-exact-hostname',
  'conflict-url-exact-url-lookalike-hostname',
  'conflict-url-lookalike-url-exact-hostname',
  'conflict-empty-string-exact-url-lookalike-host',
  'conflict-empty-string-lookalike-url-exact-host',
  'conflict-empty-url-exact-url-lookalike-host',
  'conflict-empty-url-lookalike-url-exact-host',
  'invalid-string-exact-url-empty-hostname',
  'invalid-url-exact-url-empty-hostname',
  'invalid-string-exact-url-nonstring-hostname',
  'invalid-url-exact-url-nonstring-hostname',
  'inherited-string-exact-url-lookalike-hostname',
  'inherited-string-lookalike-url-exact-hostname',
  'inherited-url-exact-url-lookalike-hostname',
  'inherited-url-lookalike-url-exact-hostname',
  'nonenum-string-exact-url-lookalike-hostname',
  'nonenum-string-lookalike-url-exact-hostname',
  'nonenum-url-exact-url-lookalike-hostname',
  'nonenum-url-lookalike-url-exact-hostname',
  'undef-string-exact-url-undefined-hostname',
  'undef-url-exact-url-undefined-hostname',
  'nonstringhost-string-exact-url-nonstring-host',
  'nonstringhost-url-exact-url-nonstring-host',
  'emptyhost-string-exact-url-empty-host',
  'emptyhost-url-exact-url-empty-host',
]
const MODE_SHAPES = HARNESS_SHAPE_ORDER.slice(0, 5)
const CONFLICT_LOOKALIKE_HOSTNAME_SHAPES = [
  'conflict-string-exact-url-lookalike-hostname',
  'conflict-url-exact-url-lookalike-hostname',
]
const CONFLICT_EXACT_HOSTNAME_SHAPES = [
  'conflict-string-lookalike-url-exact-hostname',
  'conflict-url-lookalike-url-exact-hostname',
]
const CONFLICT_EMPTY_LOOKALIKE_HOST_SHAPES = [
  'conflict-empty-string-exact-url-lookalike-host',
  'conflict-empty-url-exact-url-lookalike-host',
]
const CONFLICT_EMPTY_EXACT_HOST_SHAPES = [
  'conflict-empty-string-lookalike-url-exact-host',
  'conflict-empty-url-lookalike-url-exact-host',
]
const INHERITED_REDIRECTED_SHAPES = [
  'inherited-string-exact-url-lookalike-hostname',
  'inherited-url-exact-url-lookalike-hostname',
]
const INHERITED_NEVER_SHAPES = [
  'inherited-string-lookalike-url-exact-hostname',
  'inherited-url-lookalike-url-exact-hostname',
]
const NONENUM_REDIRECTED_SHAPES = [
  'nonenum-string-exact-url-lookalike-hostname',
  'nonenum-url-exact-url-lookalike-hostname',
]
const NONENUM_NEVER_SHAPES = [
  'nonenum-string-lookalike-url-exact-hostname',
  'nonenum-url-lookalike-url-exact-hostname',
]
const UNDEF_HOSTNAME_NEVER_SHAPES = [
  'undef-string-exact-url-undefined-hostname',
  'undef-url-exact-url-undefined-hostname',
]
const NONSTRING_HOST_NEVER_SHAPES = [
  'nonstringhost-string-exact-url-nonstring-host',
  'nonstringhost-url-exact-url-nonstring-host',
]
const EMPTY_HOST_NEVER_SHAPES = [
  'emptyhost-string-exact-url-empty-host',
  'emptyhost-url-exact-url-empty-host',
]
const ALL_SHAPES = HARNESS_SHAPE_ORDER
const FIXTURE_REDIRECTED_SHAPES = [
  ...MODE_SHAPES,
  ...CONFLICT_EXACT_HOSTNAME_SHAPES,
  ...CONFLICT_EMPTY_EXACT_HOST_SHAPES,
  ...INHERITED_REDIRECTED_SHAPES,
  ...NONENUM_REDIRECTED_SHAPES,
]
const FIXTURE_NEVER_SHAPES = [
  ...CONFLICT_LOOKALIKE_HOSTNAME_SHAPES,
  ...CONFLICT_EMPTY_LOOKALIKE_HOST_SHAPES,
  'invalid-string-exact-url-empty-hostname',
  'invalid-url-exact-url-empty-hostname',
  'invalid-string-exact-url-nonstring-hostname',
  'invalid-url-exact-url-nonstring-hostname',
  ...INHERITED_NEVER_SHAPES,
  ...NONENUM_NEVER_SHAPES,
  ...UNDEF_HOSTNAME_NEVER_SHAPES,
  ...NONSTRING_HOST_NEVER_SHAPES,
  ...EMPTY_HOST_NEVER_SHAPES,
]
// Wire paths the harness uses per shape (conflict shapes use short codes).
const SHAPE_PATHS: Record<string, string> = {
  'options-only': 'options-only',
  'string-options': 'string-options',
  'url-options': 'url-options',
  'string-callback': 'string-callback',
  'url-callback': 'url-callback',
  'conflict-string-exact-url-lookalike-hostname': 'conflict-a',
  'conflict-string-lookalike-url-exact-hostname': 'conflict-b',
  'conflict-url-exact-url-lookalike-hostname': 'conflict-c',
  'conflict-url-lookalike-url-exact-hostname': 'conflict-d',
  'conflict-empty-string-exact-url-lookalike-host': 'conflict-e',
  'conflict-empty-string-lookalike-url-exact-host': 'conflict-f',
  'conflict-empty-url-exact-url-lookalike-host': 'conflict-g',
  'conflict-empty-url-lookalike-url-exact-host': 'conflict-h',
  'invalid-string-exact-url-empty-hostname': 'invalid-a',
  'invalid-url-exact-url-empty-hostname': 'invalid-b',
  'invalid-string-exact-url-nonstring-hostname': 'invalid-c',
  'invalid-url-exact-url-nonstring-hostname': 'invalid-d',
  'inherited-string-exact-url-lookalike-hostname': 'inherited-a',
  'inherited-string-lookalike-url-exact-hostname': 'inherited-b',
  'inherited-url-exact-url-lookalike-hostname': 'inherited-c',
  'inherited-url-lookalike-url-exact-hostname': 'inherited-d',
  'nonenum-string-exact-url-lookalike-hostname': 'nonenum-a',
  'nonenum-string-lookalike-url-exact-hostname': 'nonenum-b',
  'nonenum-url-exact-url-lookalike-hostname': 'nonenum-c',
  'nonenum-url-lookalike-url-exact-hostname': 'nonenum-d',
  'undef-string-exact-url-undefined-hostname': 'undef-a',
  'undef-url-exact-url-undefined-hostname': 'undef-b',
  'nonstringhost-string-exact-url-nonstring-host': 'nonstringhost-a',
  'nonstringhost-url-exact-url-nonstring-host': 'nonstringhost-b',
  'emptyhost-string-exact-url-empty-host': 'emptyhost-a',
  'emptyhost-url-exact-url-empty-host': 'emptyhost-b',
}

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
function hostnameFromHostOption(host) {
  if (typeof host !== 'string') return null
  try { return new URL('https://' + host).hostname } catch { return host }
}
// Node-compatible effective host, three states (never collapse distinct
// outcomes), where "explicit" means OWN ENUMERABLE only — Node's URL/options
// merge is ObjectAssign semantics, so inherited and non-enumerable properties
// are ignored (empirically verified: connections follow the URL hostname):
//   non-empty string hostname  > non-empty string host  > URL hostname
//   explicit empty/non-string values are invalid — no URL fallback, never
//   redirected (Node throws or lands on a non-Bedrock default for those).
//   { state: 'option', host }  — explicit non-empty host field
//   { state: 'invalid' }       — explicit empty/non-string value, no fallback
//   { state: 'url' }           — relevant fields truly absent
function ownEnumerable(optionsObject, key) {
  return Object.prototype.propertyIsEnumerable.call(optionsObject, key)
}
function nodeOptionHost(optionsObject) {
  if (!optionsObject) return { state: 'url' }
  let sawEmptyHostname = false
  if (ownEnumerable(optionsObject, 'hostname')) {
    const hostname = optionsObject.hostname
    if (typeof hostname === 'string' && hostname.length > 0) return { state: 'option', host: hostname }
    if (typeof hostname !== 'string') return { state: 'invalid' }
    sawEmptyHostname = true
  }
  if (ownEnumerable(optionsObject, 'host')) {
    const host = optionsObject.host
    if (typeof host === 'string' && host.length > 0) return { state: 'option', host }
    return { state: 'invalid' }
  }
  return sawEmptyHostname ? { state: 'invalid' } : { state: 'url' }
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
  const urlIndex = args.findIndex((a) => typeof a === 'string' || a instanceof URL)
  const optionsIndex = args.findIndex((a) => a && typeof a === 'object' && !Array.isArray(a) && !(a instanceof URL))
  let url = null
  if (urlIndex >= 0) {
    try { url = typeof args[urlIndex] === 'string' ? new URL(args[urlIndex]) : args[urlIndex] } catch { url = null }
  }
  // Node-compatible host precedence, three states: a non-empty hostname wins
  // over a non-empty host, and both override the URL hostname; an explicit
  // empty/non-string value is invalid — the request is left untouched (Node
  // rejects it or lands on a non-Bedrock default), never redirected; only
  // truly absent fields fall back to the URL hostname.
  const optionsObject = optionsIndex >= 0 ? args[optionsIndex] : undefined
  const optionHost = nodeOptionHost(optionsObject)
  const hostname = optionHost.state === 'option'
    ? hostnameFromHostOption(optionHost.host)
    : (optionHost.state === 'url' && url ? url.hostname : null)
  if (hostname === null || exactHostname(hostname) !== BEDROCK_HOST) {
    return originalRequest.apply(this, args)
  }
  if (optionsIndex >= 0) {
    args[optionsIndex] = { ...optionsObject, hostname: targetHost, host: targetHost, port: targetPort, rejectUnauthorized: false }
  } else {
    // (url, callback) overload: rewrite the URL preserving path/query and
    // splice an overriding options object before the callback so the local
    // self-signed fixture TLS validates.
    args[urlIndex] = 'https://' + targetHost + ':' + targetPort + (url.pathname || '/') + (url.search || '')
    const callbackIndex = args.findIndex((a) => typeof a === 'function')
    args.splice(callbackIndex >= 0 ? callbackIndex : args.length, 0, { rejectUnauthorized: false })
  }
  return originalRequest.apply(this, args)
}
`

const TLS_SERVER_MJS = `
import http2 from 'node:http2'
import { readFileSync } from 'node:fs'
const [key, cert] = [process.argv[2], process.argv[3]].map((p) => readFileSync(p))
const server = http2.createSecureServer({ key, cert, allowHTTP1: true })
// The compat 'request' handler serves BOTH h2 streams and allowHTTP1 h1
// requests; mixing it with a raw 'stream' handler double-dispatches h2.
server.on('request', (req, res) => {
  console.log('REQUEST:' + String(req.url ?? ''))
  res.writeHead(503, { 'content-type': 'application/json' })
  res.end(JSON.stringify({ __type: 'ServiceUnavailableException' }))
})
server.listen(0, '127.0.0.1', () => {
  console.log('READY:' + server.address().port)
})
setInterval(() => {}, 1000)
process.on('SIGTERM', () => process.exit(0))
`

// Exercises every legal https.request overload shape against the preload.
const HARNESS_MJS = `
import https from 'node:https'
const BEDROCK_HOST = 'bedrock-runtime.us-east-1.amazonaws.com'
const mode = process.argv[2]
const modeHost = mode === 'lookalike' ? BEDROCK_HOST + '.attacker' : BEDROCK_HOST
const target = 'https://' + modeHost
const inheritedLookalikeHostname = Object.create({ hostname: BEDROCK_HOST + '.attacker' })
const inheritedExactHostname = Object.create({ hostname: BEDROCK_HOST })
function nonEnumHostnameOptions(value) {
  const options = { method: 'GET' }
  Object.defineProperty(options, 'hostname', { value, enumerable: false })
  return options
}
setTimeout(() => { console.log('HARNESS-TIMEOUT'); process.exit(3) }, 30000).unref()
function shape(label, makeRequest) {
  return new Promise((resolve) => {
    let req
    try {
      req = makeRequest((res) => {
        let body = ''
        res.setEncoding('utf8')
        res.on('data', (chunk) => { body += chunk })
        res.on('end', () => resolve({ shape: label, ok: true, status: res.statusCode, body }))
      })
    } catch (error) {
      // https.request throws synchronously for invalid option values.
      resolve({ shape: label, ok: false, code: error.code ?? String(error) })
      return
    }
    req.on('error', (error) => resolve({ shape: label, ok: false, code: error.code ?? String(error) }))
    req.end()
  })
}
const results = await Promise.all([
  shape('options-only', (cb) => https.request({ hostname: modeHost, port: 443, path: '/shape/options-only', method: 'GET' }, cb)),
  shape('string-options', (cb) => https.request(target + '/shape/string-options', { method: 'GET' }, cb)),
  shape('url-options', (cb) => https.request(new URL(target + '/shape/url-options'), { method: 'GET' }, cb)),
  shape('string-callback', (cb) => https.request(target + '/shape/string-callback', cb)),
  shape('url-callback', (cb) => https.request(new URL(target + '/shape/url-callback'), cb)),
  // URL/options precedence conflicts (fixed combinations, both input kinds):
  // explicit options.hostname must override the URL hostname in Node, so the
  // effective target decides redirection.
  shape('conflict-string-exact-url-lookalike-hostname', (cb) => https.request('https://' + BEDROCK_HOST + '/shape/conflict-a', { hostname: BEDROCK_HOST + '.attacker', method: 'GET' }, cb)),
  shape('conflict-string-lookalike-url-exact-hostname', (cb) => https.request('https://' + BEDROCK_HOST + '.attacker' + '/shape/conflict-b', { hostname: BEDROCK_HOST, method: 'GET' }, cb)),
  shape('conflict-url-exact-url-lookalike-hostname', (cb) => https.request(new URL('https://' + BEDROCK_HOST + '/shape/conflict-c'), { hostname: BEDROCK_HOST + '.attacker', method: 'GET' }, cb)),
  shape('conflict-url-lookalike-url-exact-hostname', (cb) => https.request(new URL('https://' + BEDROCK_HOST + '.attacker' + '/shape/conflict-d'), { hostname: BEDROCK_HOST, method: 'GET' }, cb)),
  // Empty-string hostname must fall back to the non-empty host (never to the
  // URL hostname) — same precedence matrix with hostname:'' in both input kinds.
  shape('conflict-empty-string-exact-url-lookalike-host', (cb) => https.request('https://' + BEDROCK_HOST + '/shape/conflict-e', { hostname: '', host: BEDROCK_HOST + '.attacker', method: 'GET' }, cb)),
  shape('conflict-empty-string-lookalike-url-exact-host', (cb) => https.request('https://' + BEDROCK_HOST + '.attacker' + '/shape/conflict-f', { hostname: '', host: BEDROCK_HOST, method: 'GET' }, cb)),
  shape('conflict-empty-url-exact-url-lookalike-host', (cb) => https.request(new URL('https://' + BEDROCK_HOST + '/shape/conflict-g'), { hostname: '', host: BEDROCK_HOST + '.attacker', method: 'GET' }, cb)),
  shape('conflict-empty-url-lookalike-url-exact-host', (cb) => https.request(new URL('https://' + BEDROCK_HOST + '.attacker' + '/shape/conflict-h'), { hostname: '', host: BEDROCK_HOST, method: 'GET' }, cb)),
  // Invalid explicit hostname values: Node never sends these to the exact
  // Bedrock host (empty hostname lands on a non-Bedrock default, non-string
  // throws ERR_INVALID_ARG_TYPE) — the preload must not redirect either.
  shape('invalid-string-exact-url-empty-hostname', (cb) => https.request('https://' + BEDROCK_HOST + '/shape/invalid-a', { hostname: '', method: 'GET' }, cb)),
  shape('invalid-url-exact-url-empty-hostname', (cb) => https.request(new URL('https://' + BEDROCK_HOST + '/shape/invalid-b'), { hostname: '', method: 'GET' }, cb)),
  shape('invalid-string-exact-url-nonstring-hostname', (cb) => https.request('https://' + BEDROCK_HOST + '/shape/invalid-c', { hostname: 123, method: 'GET' }, cb)),
  shape('invalid-url-exact-url-nonstring-hostname', (cb) => https.request(new URL('https://' + BEDROCK_HOST + '/shape/invalid-d'), { hostname: 123, method: 'GET' }, cb)),
  // Inherited (proto) and non-enumerable hostname properties are ignored by
  // Node's ObjectAssign merge — the effective target is the URL hostname.
  //   inherited/nonenum lookalike hostname on an exact URL → redirected
  //   inherited/nonenum exact hostname on a lookalike URL → not redirected
  shape('inherited-string-exact-url-lookalike-hostname', (cb) => https.request('https://' + BEDROCK_HOST + '/shape/inherited-a', inheritedLookalikeHostname, cb)),
  shape('inherited-string-lookalike-url-exact-hostname', (cb) => https.request('https://' + BEDROCK_HOST + '.attacker' + '/shape/inherited-b', inheritedExactHostname, cb)),
  shape('inherited-url-exact-url-lookalike-hostname', (cb) => https.request(new URL('https://' + BEDROCK_HOST + '/shape/inherited-c'), inheritedLookalikeHostname, cb)),
  shape('inherited-url-lookalike-url-exact-hostname', (cb) => https.request(new URL('https://' + BEDROCK_HOST + '.attacker' + '/shape/inherited-d'), inheritedExactHostname, cb)),
  shape('nonenum-string-exact-url-lookalike-hostname', (cb) => https.request('https://' + BEDROCK_HOST + '/shape/nonenum-a', nonEnumHostnameOptions(BEDROCK_HOST + '.attacker'), cb)),
  shape('nonenum-string-lookalike-url-exact-hostname', (cb) => https.request('https://' + BEDROCK_HOST + '.attacker' + '/shape/nonenum-b', nonEnumHostnameOptions(BEDROCK_HOST), cb)),
  shape('nonenum-url-exact-url-lookalike-hostname', (cb) => https.request(new URL('https://' + BEDROCK_HOST + '/shape/nonenum-c'), nonEnumHostnameOptions(BEDROCK_HOST + '.attacker'), cb)),
  shape('nonenum-url-lookalike-url-exact-hostname', (cb) => https.request(new URL('https://' + BEDROCK_HOST + '.attacker' + '/shape/nonenum-d'), nonEnumHostnameOptions(BEDROCK_HOST), cb)),
  // Own-enumerable undefined hostname: explicit but invalid — never redirected.
  shape('undef-string-exact-url-undefined-hostname', (cb) => https.request('https://' + BEDROCK_HOST + '/shape/undef-a', { hostname: undefined, method: 'GET' }, cb)),
  shape('undef-url-exact-url-undefined-hostname', (cb) => https.request(new URL('https://' + BEDROCK_HOST + '/shape/undef-b'), { hostname: undefined, method: 'GET' }, cb)),
  // Own-enumerable invalid host field (non-string / empty): never redirected.
  shape('nonstringhost-string-exact-url-nonstring-host', (cb) => https.request('https://' + BEDROCK_HOST + '/shape/nonstringhost-a', { host: 123, method: 'GET' }, cb)),
  shape('nonstringhost-url-exact-url-nonstring-host', (cb) => https.request(new URL('https://' + BEDROCK_HOST + '/shape/nonstringhost-b'), { host: 123, method: 'GET' }, cb)),
  shape('emptyhost-string-exact-url-empty-host', (cb) => https.request('https://' + BEDROCK_HOST + '/shape/emptyhost-a', { host: '', method: 'GET' }, cb)),
  shape('emptyhost-url-exact-url-empty-host', (cb) => https.request(new URL('https://' + BEDROCK_HOST + '/shape/emptyhost-b'), { host: '', method: 'GET' }, cb)),
])
console.log('HARNESS:' + JSON.stringify(results))
process.exit(0)
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

  it('https.request overload matrix redirects only exact-host shapes', async () => {
    const fixtureDir = mkdtempSync(join(import.meta.dir, 'host-transport-overload-'))
    try {
      writeFileSync(join(fixtureDir, 'preload.mjs'), PRELOAD_MJS)
      writeFileSync(join(fixtureDir, 'server.mjs'), TLS_SERVER_MJS)
      writeFileSync(join(fixtureDir, 'harness.mjs'), HARNESS_MJS)
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

      const runHarness = async (mode: string): Promise<{ results: Array<{ shape: string; ok: boolean; status?: number; body?: string; code?: string }>; requestLines: string[] }> => {
        const server = Bun.spawn({
          cmd: [HOST_NODE, join(fixtureDir, 'server.mjs'), join(fixtureDir, 'key.pem'), join(fixtureDir, 'cert.pem')],
          stdout: 'pipe',
          stderr: 'pipe',
        })
        const serverLines = collectLines(server.stdout as ReadableStream<Uint8Array>)
        try {
          const readyLine = await serverLines.waitForLine('READY:', 15000)
          const tlsPort = Number(readyLine.slice('READY:'.length))
          const harness = Bun.spawn({
            cmd: [HOST_NODE, '--import', join(fixtureDir, 'preload.mjs'), join(fixtureDir, 'harness.mjs'), mode],
            stdout: 'pipe',
            stderr: 'pipe',
            env: { ...process.env, SEAM_FIXTURE_HOST: '127.0.0.1', SEAM_FIXTURE_PORT: String(tlsPort) },
          })
          const harnessStdoutText = await new Response(harness.stdout).text()
          const harnessStderrText = await new Response(harness.stderr).text()
          const harnessExit = await harness.exited
          if (harnessExit !== 0) {
            throw new Error(`overload harness failed (exit ${harnessExit})\n${harnessStderrText}`)
          }
          const resultLine = harnessStdoutText.split('\n').find((line) => line.startsWith('HARNESS:'))
          expect(resultLine).toBeDefined()
          const results = JSON.parse(resultLine!.slice('HARNESS:'.length)) as Array<{ shape: string; ok: boolean; status?: number; body?: string; code?: string }>
          const requestLines = serverLines.lines.filter((line) => line.startsWith('REQUEST:'))
          return { results, requestLines }
        } finally {
          server.kill()
          await serverLines.settled
        }
      }

      // Exact host: every effective-exact shape is redirected to the local
      // fixture (its distinctive 503 body proves the response came from it).
      const exact = await runHarness('exact')
      expect(exact.results).toHaveLength(ALL_SHAPES.length)
      expect(exact.results.map((result) => result.shape)).toEqual(ALL_SHAPES)
      // Frozen freeze-count drift guard: the never/redirected partition must
      // exactly cover every harness shape with no duplicates or omissions.
      expect(FIXTURE_REDIRECTED_SHAPES).toHaveLength(13)
      expect(FIXTURE_NEVER_SHAPES).toHaveLength(18)
      expect([...FIXTURE_REDIRECTED_SHAPES, ...FIXTURE_NEVER_SHAPES].sort()).toEqual([...ALL_SHAPES].sort())
      expect(new Set(FIXTURE_NEVER_SHAPES).size).toBe(FIXTURE_NEVER_SHAPES.length)
      expect(new Set(FIXTURE_REDIRECTED_SHAPES).size).toBe(FIXTURE_REDIRECTED_SHAPES.length)
      const byShape = (results: Array<{ shape: string }>, names: string[]): Array<{ ok: boolean; status?: number; body?: string }> =>
        (results as Array<{ shape: string; ok: boolean; status?: number; body?: string }>).filter((result) => names.includes(result.shape))
      const isFixtureMarked = (result: { ok: boolean; status?: number; body?: string }): boolean =>
        result.ok && result.status === 503 && (result.body ?? '').includes('ServiceUnavailableException')
      expect(byShape(exact.results, MODE_SHAPES).every(isFixtureMarked)).toBe(true)
      // URL/options precedence: explicit lookalike options.hostname — and an
      // empty-string hostname falling back to a lookalike host — override the
      // exact URL (no redirect); an explicit exact hostname (or an empty
      // hostname falling back to an exact host) overrides the lookalike URL
      // (redirect).
      expect(byShape(exact.results, CONFLICT_LOOKALIKE_HOSTNAME_SHAPES).every((result) => !isFixtureMarked(result))).toBe(true)
      expect(byShape(exact.results, CONFLICT_EXACT_HOSTNAME_SHAPES).every(isFixtureMarked)).toBe(true)
      expect(byShape(exact.results, CONFLICT_EMPTY_LOOKALIKE_HOST_SHAPES).every((result) => !isFixtureMarked(result))).toBe(true)
      expect(byShape(exact.results, CONFLICT_EMPTY_EXACT_HOST_SHAPES).every(isFixtureMarked)).toBe(true)
      // Invalid explicit hostnames (empty string / non-string): Node never
      // sends these to Bedrock — they must produce no fixture hit at all.
      expect(byShape(exact.results, FIXTURE_NEVER_SHAPES.filter((shape) => shape.startsWith('invalid-'))).every((result) => !isFixtureMarked(result))).toBe(true)
      // Inherited / non-enumerable hostname properties are ignored (ObjectAssign
      // semantics, empirically verified): the effective target is the URL
      // hostname, so exact URLs redirect and lookalike URLs do not.
      expect(byShape(exact.results, INHERITED_REDIRECTED_SHAPES).every(isFixtureMarked)).toBe(true)
      expect(byShape(exact.results, INHERITED_NEVER_SHAPES).every((result) => !isFixtureMarked(result))).toBe(true)
      expect(byShape(exact.results, NONENUM_REDIRECTED_SHAPES).every(isFixtureMarked)).toBe(true)
      expect(byShape(exact.results, NONENUM_NEVER_SHAPES).every((result) => !isFixtureMarked(result))).toBe(true)
      expect(byShape(exact.results, UNDEF_HOSTNAME_NEVER_SHAPES).every((result) => !isFixtureMarked(result))).toBe(true)
      expect(byShape(exact.results, NONSTRING_HOST_NEVER_SHAPES).every((result) => !isFixtureMarked(result))).toBe(true)
      expect(byShape(exact.results, EMPTY_HOST_NEVER_SHAPES).every((result) => !isFixtureMarked(result))).toBe(true)
      expect(exact.requestLines.length).toBe(FIXTURE_REDIRECTED_SHAPES.length)
      for (const shape of FIXTURE_REDIRECTED_SHAPES) {
        expect(exact.requestLines.some((line) => line.includes('/shape/' + SHAPE_PATHS[shape]))).toBe(true)
      }
      for (const shape of FIXTURE_NEVER_SHAPES) {
        expect(exact.requestLines.some((line) => line.includes('/shape/' + SHAPE_PATHS[shape]))).toBe(false)
      }

      // Lookalike host: no mode shape is redirected. Zero fixture hits is the
      // hard no-interception proof; a hostile network may answer lookalike DNS
      // with its own responses, so only fixture-marked successes would fail
      // this. The fixed conflict cases behave identically in this mode: the
      // Node-effective exact targets (explicit or empty-hostname fallback) are
      // still redirected.
      const lookalike = await runHarness('lookalike')
      expect(lookalike.results).toHaveLength(ALL_SHAPES.length)
      expect(byShape(lookalike.results, MODE_SHAPES).every((result) => !isFixtureMarked(result))).toBe(true)
      expect(byShape(lookalike.results, CONFLICT_LOOKALIKE_HOSTNAME_SHAPES).every((result) => !isFixtureMarked(result))).toBe(true)
      expect(byShape(lookalike.results, CONFLICT_EMPTY_LOOKALIKE_HOST_SHAPES).every((result) => !isFixtureMarked(result))).toBe(true)
      expect(byShape(lookalike.results, CONFLICT_EXACT_HOSTNAME_SHAPES).every(isFixtureMarked)).toBe(true)
      expect(byShape(lookalike.results, CONFLICT_EMPTY_EXACT_HOST_SHAPES).every(isFixtureMarked)).toBe(true)
      expect(byShape(lookalike.results, FIXTURE_NEVER_SHAPES.filter((shape) => shape.startsWith('invalid-'))).every((result) => !isFixtureMarked(result))).toBe(true)
      expect(byShape(lookalike.results, INHERITED_REDIRECTED_SHAPES).every(isFixtureMarked)).toBe(true)
      expect(byShape(lookalike.results, INHERITED_NEVER_SHAPES).every((result) => !isFixtureMarked(result))).toBe(true)
      expect(byShape(lookalike.results, NONENUM_REDIRECTED_SHAPES).every(isFixtureMarked)).toBe(true)
      expect(byShape(lookalike.results, NONENUM_NEVER_SHAPES).every((result) => !isFixtureMarked(result))).toBe(true)
      expect(byShape(lookalike.results, UNDEF_HOSTNAME_NEVER_SHAPES).every((result) => !isFixtureMarked(result))).toBe(true)
      expect(byShape(lookalike.results, NONSTRING_HOST_NEVER_SHAPES).every((result) => !isFixtureMarked(result))).toBe(true)
      expect(byShape(lookalike.results, EMPTY_HOST_NEVER_SHAPES).every((result) => !isFixtureMarked(result))).toBe(true)
      // In lookalike mode the redirected fixture hits are: the fixed
      // lookalike-URL + explicit/empty-fallback exact-hostname conflicts
      // (conflict-b/d, empty f/h) and the fixed exact-URL inherited/nonenum
      // shapes — the mode shapes themselves are never redirected.
      expect(lookalike.requestLines.length).toBe(FIXTURE_REDIRECTED_SHAPES.length - MODE_SHAPES.length)
      const lookalikeRedirectedPaths = FIXTURE_REDIRECTED_SHAPES.filter((shape) => !MODE_SHAPES.includes(shape))
      expect(lookalike.requestLines.every((line) => lookalikeRedirectedPaths.some((shape) => line.includes('/shape/' + SHAPE_PATHS[shape])))).toBe(true)
      for (const shape of [...MODE_SHAPES, ...FIXTURE_NEVER_SHAPES]) {
        expect(lookalike.requestLines.some((line) => line.includes('/shape/' + SHAPE_PATHS[shape]))).toBe(false)
      }
    } finally {
      rmSync(fixtureDir, { recursive: true, force: true })
    }
  }, 120000)
})
