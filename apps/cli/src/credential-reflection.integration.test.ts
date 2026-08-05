import { afterEach, describe, expect, it } from 'bun:test'
import {
  createServer,
  request as httpRequest,
  type IncomingMessage,
  type Server,
} from 'node:http'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  startInvocationCredentialProxy,
  type InvocationCredentialProxy,
} from '@polo-ai/shared/credentials'
import {
  RootedSessionStorage,
  type StoredSession,
} from '@polo-ai/shared/sessions'
import { createCliThread } from './cli-thread-store.ts'
import { ExecEventAdapter } from './exec-event-adapter.ts'
import { stderrErrorLine } from './terminal-output.ts'

const tempDirs: string[] = []
const proxies: InvocationCredentialProxy[] = []
const servers: Server[] = []

afterEach(async () => {
  await Promise.all(proxies.splice(0).map((proxy) => proxy.close()))
  await Promise.all(
    servers.splice(0).map(
      (server) => new Promise<void>((resolve) => server.close(() => resolve())),
    ),
  )
  await Promise.all(
    tempDirs.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  )
})

async function listen(server: Server): Promise<string> {
  servers.push(server)
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('server did not bind')
  return `http://127.0.0.1:${address.port}`
}

async function requestModelSurface(
  url: string,
  capability: string,
): Promise<{ body: string; headers: IncomingMessage['headers'] }> {
  return new Promise((resolve, reject) => {
    const request = httpRequest(url, {
      headers: { authorization: `Bearer ${capability}` },
    }, (response) => {
      const chunks: Buffer[] = []
      response.on('data', (chunk) => chunks.push(Buffer.from(chunk)))
      response.on('end', () => resolve({
        body: Buffer.concat(chunks).toString('utf-8'),
        headers: response.headers,
      }))
    })
    request.once('error', reject)
    request.end()
  })
}

describe('credential reflection isolation', () => {
  it('keeps reflected API and OAuth credentials out of every CLI-visible surface', async () => {
    const apiKey = 'sk-reflection-e2e-api-key-123456'
    const oauthToken = 'oauth-reflection-e2e-token-123456'
    const body = `provider:${apiKey}:Authorization: Bearer ${oauthToken}:done`
    const upstreamUrl = await listen(createServer((_request, response) => {
      response.writeHead(200, {
        authorization: `Bearer ${oauthToken}`,
        'x-provider-debug': `${apiKey}:${oauthToken}`,
        'content-length': String(Buffer.byteLength(body)),
      })
      const split = Math.floor(body.length / 2)
      response.write(body.slice(0, split))
      response.end(body.slice(split))
    }))
    const proxy = await startInvocationCredentialProxy({
      upstreamBaseUrl: upstreamUrl,
      headers: {
        'x-api-key': apiKey,
        authorization: `Bearer ${oauthToken}`,
      },
      credentialHeaders: [{ name: 'authorization', format: 'bearer' }],
    })
    proxies.push(proxy)

    const modelSurface = await requestModelSurface(proxy.url, proxy.capability)
    const modelVisible = JSON.stringify(modelSurface)
    expect(modelVisible).not.toContain(apiKey)
    expect(modelVisible).not.toContain(oauthToken)
    expect(modelSurface.headers.authorization).toBeUndefined()

    const root = await mkdtemp(join(tmpdir(), 'polo-credential-reflection-'))
    tempDirs.push(root)
    const previousConfigDir = process.env.POLO_AI_CONFIG_DIR
    process.env.POLO_AI_CONFIG_DIR = root
    try {
      const thread = await createCliThread({
        origin: 'cli-exec',
        configurationScopeId: 'global',
        configurationWorkspacePath: root,
        workingDirectory: root,
        persistence: 'persistent',
      })
      const storage = new RootedSessionStorage(thread.sessionsRoot, {
        secrets: [apiKey, oauthToken],
      })
      const session: StoredSession = {
        id: 'session-1',
        workspaceRootPath: root,
        name: `metadata ${apiKey} Authorization: Bearer ${oauthToken}`,
        createdAt: 1,
        lastUsedAt: 1,
        messages: [{
          id: 'assistant-1',
          type: 'assistant',
          content: `${modelSurface.body} ${apiKey} ${oauthToken}`,
        }],
        tokenUsage: {
          inputTokens: 0,
          outputTokens: 0,
          totalTokens: 0,
          contextTokens: 0,
          costUsd: 0,
        },
      }
      await storage.save(session)
      const sessionJsonl = await readFile(
        storage.getSessionFilePath(root, session.id),
        'utf-8',
      )
      const metadata = sessionJsonl.split('\n', 1)[0]!
      const threadMetadata = await readFile(join(thread.directory, 'thread.json'), 'utf-8')

      let jsonl = ''
      let logs = ''
      const originalStdoutWrite = process.stdout.write
      const originalStderrWrite = process.stderr.write
      process.stdout.write = ((chunk: string | Uint8Array) => {
        jsonl += String(chunk)
        return true
      }) as typeof process.stdout.write
      process.stderr.write = ((chunk: string | Uint8Array) => {
        logs += String(chunk)
        return true
      }) as typeof process.stderr.write
      try {
        const adapter = new ExecEventAdapter({
          json: true,
          secrets: [apiKey, oauthToken],
        })
        adapter.start(thread.metadata.threadId)
        adapter.agentMessage(`${modelSurface.body} ${apiKey} ${oauthToken}`)
        adapter.completed()
        process.stderr.write(
          stderrErrorLine(
            adapter.redact(`Authorization: Bearer ${oauthToken} key=${apiKey}`),
            'never',
          ),
        )
      } finally {
        process.stdout.write = originalStdoutWrite
        process.stderr.write = originalStderrWrite
      }

      for (const surface of [
        sessionJsonl,
        metadata,
        threadMetadata,
        jsonl,
        logs,
      ]) {
        expect(surface).not.toContain(apiKey)
        expect(surface).not.toContain(oauthToken)
        expect(surface).not.toContain(`Bearer ${oauthToken}`)
      }
      for (const line of jsonl.trim().split('\n')) expect(() => JSON.parse(line)).not.toThrow()
    } finally {
      if (previousConfigDir === undefined) delete process.env.POLO_AI_CONFIG_DIR
      else process.env.POLO_AI_CONFIG_DIR = previousConfigDir
    }
  })
})
