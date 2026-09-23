/**
 * POO-69 Bedrock seam fixture — executed by Node (the production host runtime).
 *
 * Node's http2 is deterministic for the real NodeHttp2Handler (h2c) path; bun's
 * http2 is not. Each scenario prints one `RESULT:` JSON line and the process
 * exits non-zero when any scenario fails. The seam is installed before pi-ai is
 * dynamically imported, mirroring the POO-68 bootstrap contract.
 */
import { BedrockRuntimeClient, ConverseCommand } from '@aws-sdk/client-bedrock-runtime'
import http2 from 'node:http2'
import type { AddressInfo } from 'node:net'

interface ScenarioOutcome {
  name: string
  pass: boolean
  detail?: string
}

const outcomes: ScenarioOutcome[] = []
const PRISTINE_SEND = BedrockRuntimeClient.prototype.send
const PRISTINE_FETCH = globalThis.fetch

interface H2Server {
  port: number
  requests: string[]
  close(): Promise<void>
}

async function startH2Server(statusFor: (path: string, destroySession: () => void) => number | 'destroy'): Promise<H2Server> {
  const requests: string[] = []
  const server = http2.createServer()
  const sessions = new Set<import('node:http2').ServerHttp2Session>()
  server.on('session', (session) => {
    sessions.add(session)
    session.on('close', () => sessions.delete(session))
  })
  server.on('stream', (stream, headers) => {
    const path = String(headers[':path'] ?? '')
    requests.push(path)
    const outcome = statusFor(path, () => {
      stream.session?.destroy()
    })
    if (outcome === 'destroy') {
      stream.session?.destroy()
      return
    }
    stream.respond({ ':status': String(outcome), 'content-type': 'application/json' })
    stream.end(JSON.stringify({ message: 'bedrock seam fixture' }))
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const port = (server.address() as AddressInfo).port
  return {
    port,
    requests,
    close: async () => {
      for (const session of sessions) session.destroy()
      ;(server as unknown as { closeAllConnections?: () => void }).closeAllConnections?.()
      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, 500)
        server.close(() => {
          clearTimeout(timer)
          resolve()
        })
      })
    },
  }
}

async function runScenario(name: string, run: () => Promise<void>): Promise<void> {
  try {
    await Promise.race([
      run(),
      new Promise<never>((_, reject) => setTimeout(() => reject(new Error('scenario watchdog timeout')), 20000).unref()),
    ])
    outcomes.push({ name, pass: true })
  } catch (error) {
    outcomes.push({ name, pass: false, detail: error instanceof Error ? `${error.name}: ${error.message}` : String(error) })
  }
}

function withSeamRestored(base: string, run: (installed: { observation: import('./host-completion-policy.ts').TransportObservation; bedrockConstructor: typeof BedrockRuntimeClient }) => Promise<void>): Promise<void> {
  return import('./host-completion-policy.ts').then(async ({ installTransportObservation }) => {
    const installed = installTransportObservation(new URL(base))
    try {
      await run(installed)
    } finally {
      globalThis.fetch = PRISTINE_FETCH
      BedrockRuntimeClient.prototype.send = PRISTINE_SEND
    }
  })
}

function makeClient(bedrockConstructor: typeof BedrockRuntimeClient, port: number): BedrockRuntimeClient {
  return new bedrockConstructor({
    region: 'us-east-1',
    endpoint: `http://127.0.0.1:${port}`,
    credentials: { accessKeyId: 'fixture-access', secretAccessKey: 'fixture-secret' },
    maxAttempts: 3,
  })
}

function converse(client: BedrockRuntimeClient): Promise<unknown> {
  return client.send(new ConverseCommand({
    modelId: 'fixture.model',
    messages: [{ role: 'user', content: [{ text: 'ping' }] }],
  }))
}

function settle(promise: Promise<unknown>): Promise<{ rejected: boolean; error?: unknown }> {
  return promise.then(
    () => ({ rejected: false }),
    (error: unknown) => ({ rejected: true, error }),
  )
}

async function main(): Promise<void> {
  process.env.AWS_REGION = 'us-east-1'
  process.env.AWS_ACCESS_KEY_ID = 'fixture-access'
  process.env.AWS_SECRET_ACCESS_KEY = 'fixture-secret'
  process.env.AWS_EC2_METADATA_DISABLED = 'true'
  for (const key of ['AWS_PROFILE', 'AWS_ENDPOINT_URL', 'HTTP_PROXY', 'HTTPS_PROXY', 'http_proxy', 'https_proxy']) {
    delete process.env[key]
  }

  // AWS_MAX_ATTEMPTS stays at 3 for every scenario: the single wire attempt must
  // come from the request-handler seam, not from a disabled retry config.
  process.env.AWS_MAX_ATTEMPTS = '3'

  await runScenario('constructor identity is exact', async () => {
    const { installTransportObservation } = await import('./host-completion-policy.ts')
    const installed = installTransportObservation(new URL('http://127.0.0.1:9/v1'))
    try {
      if (installed.bedrockConstructor !== BedrockRuntimeClient) {
        throw new Error('bedrockConstructor is not the directly imported BedrockRuntimeClient')
      }
      const client = new installed.bedrockConstructor({ region: 'us-east-1' })
      if (!(client instanceof installed.bedrockConstructor)) {
        throw new Error('client does not share the seam constructor identity')
      }
      client.destroy()
    } finally {
      globalThis.fetch = PRISTINE_FETCH
      BedrockRuntimeClient.prototype.send = PRISTINE_SEND
    }
  })

  await runScenario('401 keeps its numeric status and marks sdkException', async () => {
    const server = await startH2Server(() => 401)
    try {
      await withSeamRestored(`http://127.0.0.1:${server.port}/v1`, async (installed) => {
        const client = makeClient(installed.bedrockConstructor, server.port)
        const outcome = await settle(converse(client))
        if (!outcome.rejected) throw new Error('send should reject on 401')
        const observation = installed.observation
        if (observation.attempts !== 1 || observation.status !== 401 || observation.sdkException !== true || observation.retryBlocked || observation.networkFailure) {
          throw new Error(`unexpected observation ${JSON.stringify(observation)}`)
        }
        if (server.requests.length !== 1) throw new Error(`expected 1 wire request, saw ${server.requests.length}`)
        client.destroy()
      })
    } finally {
      await server.close()
    }
  })

  await runScenario('403 keeps its numeric status', async () => {
    const server = await startH2Server(() => 403)
    try {
      await withSeamRestored(`http://127.0.0.1:${server.port}/v1`, async (installed) => {
        const client = makeClient(installed.bedrockConstructor, server.port)
        const outcome = await settle(converse(client))
        if (!outcome.rejected) throw new Error('send should reject on 403')
        if (installed.observation.status !== 403 || installed.observation.attempts !== 1) {
          throw new Error(`unexpected observation ${JSON.stringify(installed.observation)}`)
        }
        client.destroy()
      })
    } finally {
      await server.close()
    }
  })

  await runScenario('503 retried by the SDK is blocked before the second wire attempt', async () => {
    const server = await startH2Server(() => 503)
    try {
      await withSeamRestored(`http://127.0.0.1:${server.port}/v1`, async (installed) => {
        const client = makeClient(installed.bedrockConstructor, server.port)
        const outcome = await settle(converse(client))
        if (!outcome.rejected) throw new Error('send should reject after retry block')
        const observation = installed.observation
        if (observation.attempts !== 2 || observation.status !== 503 || observation.retryBlocked !== true || observation.sdkException !== true) {
          throw new Error(`unexpected observation ${JSON.stringify(observation)}`)
        }
        if (server.requests.length !== 1) {
          throw new Error(`server must see exactly one attempt, saw ${server.requests.length}`)
        }
        client.destroy()
      })
    } finally {
      await server.close()
    }
  })

  await runScenario('destroyed first wire attempt surfaces as a terminal network failure', async () => {
    const server = await startH2Server(() => 'destroy')
    try {
      await withSeamRestored(`http://127.0.0.1:${server.port}/v1`, async (installed) => {
        const client = makeClient(installed.bedrockConstructor, server.port)
        const outcome = await settle(converse(client))
        if (!outcome.rejected) throw new Error('send should reject after destroyed attempt')
        const observation = installed.observation
        // A destroyed h2 session is classified by the SDK as non-retryable, so the
        // observation ends with exactly one real attempt marked networkFailure.
        if (observation.networkFailure !== true || observation.attempts !== 1 || observation.retryBlocked || observation.sdkException !== true) {
          throw new Error(`unexpected observation ${JSON.stringify(observation)}`)
        }
        if (server.requests.length !== 1) throw new Error(`expected 1 wire request, saw ${server.requests.length}`)
        client.destroy()
      })
    } finally {
      await server.close()
    }
  })

  await runScenario('non-callable request handler is refused before the original send', async () => {
    const server = await startH2Server(() => 200)
    try {
      await withSeamRestored(`http://127.0.0.1:${server.port}/v1`, async (installed) => {
        const client = makeClient(installed.bedrockConstructor, server.port)
        const handler = (client.config as { requestHandler: { handle: unknown } }).requestHandler
        handler.handle = null
        // The guard throws synchronously before the original send runs.
        const outcome = await settle((async () => converse(client))())
        if (!outcome.rejected) throw new Error('send should refuse without a callable handle')
        if (!(outcome.error instanceof Error) || !outcome.error.message.includes('no callable handle')) {
          throw new Error(`unexpected refusal error: ${String(outcome.error)}`)
        }
        if (installed.observation.attempts !== 0) throw new Error('blocked send must not count an attempt')
        if (server.requests.length !== 0) throw new Error('blocked send must not reach the wire')
        client.destroy()
      })
    } finally {
      await server.close()
    }
  })

  await runScenario('pi-ai Bedrock provider shares the seam constructor and wire gate', async () => {
    const server = await startH2Server(() => 503)
    const previousEnv = { ...process.env }
    try {
      await withSeamRestored(`http://127.0.0.1:${server.port}/v1`, async (installed) => {
        // Mirror the POO-68 bootstrap contract: install the seam BEFORE pi-ai loads.
        const [{ getModel, setBedrockProviderModule, streamSimple }, { bedrockProviderModule }] = await Promise.all([
          import('@mariozechner/pi-ai'),
          import('@mariozechner/pi-ai/bedrock-provider'),
        ])
        setBedrockProviderModule(bedrockProviderModule)
        const model = { ...getModel('amazon-bedrock', 'amazon.nova-lite-v1:0'), baseUrl: `http://127.0.0.1:${server.port}` }
        const events = streamSimple(model, {
          systemPrompt: '',
          messages: [{ role: 'user', content: 'hi', timestamp: Date.now() }],
        }, {})
        for await (const event of events) {
          if (event.type === 'error') break
        }
        const observation = installed.observation
        if (observation.attempts !== 2 || observation.status !== 503 || observation.retryBlocked !== true || observation.sdkException !== true) {
          throw new Error(`unexpected observation ${JSON.stringify(observation)}`)
        }
        if (server.requests.length !== 1) {
          throw new Error(`pi-ai client must be wire-gated after one attempt, server saw ${server.requests.length}`)
        }
      })
    } finally {
      process.env = previousEnv
      await server.close()
    }
  })

  for (const outcome of outcomes) {
    console.log(`RESULT:${JSON.stringify(outcome)}`)
  }
  if (outcomes.some((outcome) => !outcome.pass)) {
    process.exit(1)
  }
  process.exit(0)
}

void main()
