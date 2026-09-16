import { afterEach, describe, expect, it } from 'bun:test'
import { join } from 'node:path'
import { PoloMcpClient } from '../client.ts'

const fixture = join(import.meta.dir, 'fixtures', 'mcp-server-env.mjs')
const originalCustomKey = process.env.POLO_REVIEW_CUSTOM_KEY
const originalCustomToken = process.env.POLO_REVIEW_SESSION_TOKEN

afterEach(() => {
  if (originalCustomKey === undefined) delete process.env.POLO_REVIEW_CUSTOM_KEY
  else process.env.POLO_REVIEW_CUSTOM_KEY = originalCustomKey
  if (originalCustomToken === undefined) delete process.env.POLO_REVIEW_SESSION_TOKEN
  else process.env.POLO_REVIEW_SESSION_TOKEN = originalCustomToken
})

async function snapshot(client: PoloMcpClient): Promise<Record<string, string>> {
  try {
    const result = await client.callTool('environment_snapshot', {}) as {
      content?: Array<{ type?: string; text?: string }>
    }
    return JSON.parse(result.content?.[0]?.text || '{}')
  } finally {
    await client.close()
  }
}

describe('stdio MCP environment policy', () => {
  it('uses an approved allowlist for a real CLI one-shot child process', async () => {
    process.env.POLO_REVIEW_CUSTOM_KEY = 'sk-host-custom-key-123456789'
    process.env.POLO_REVIEW_SESSION_TOKEN = 'oauth-host-token-123456789'
    const client = new PoloMcpClient({
      transport: 'stdio',
      command: process.execPath,
      args: [fixture],
      env: {
        POLO_REVIEW_BENIGN_SETTING: 'custom-value',
        LANG: process.env.LANG || 'C',
      },
    }, {
      environmentPolicy: 'cli-one-shot',
    })

    const env = await snapshot(client)
    expect(env.PATH).toBeTruthy()
    expect(env.LANG).toBeTruthy()
    expect(env.POLO_REVIEW_CUSTOM_KEY).toBeUndefined()
    expect(env.POLO_REVIEW_SESSION_TOKEN).toBeUndefined()
    expect(env.POLO_REVIEW_BENIGN_SETTING).toBeUndefined()
    expect(JSON.stringify(env)).not.toContain('sk-host-custom-key-123456789')
    expect(JSON.stringify(env)).not.toContain('oauth-host-token-123456789')
  })

  it('rejects credential-like config.env before spawning the stdio server', () => {
    expect(() => new PoloMcpClient({
      transport: 'stdio',
      command: process.execPath,
      args: [fixture],
      env: {
        POLO_REVIEW_CUSTOM_OAUTH_TOKEN: 'oauth-config-token-123456789',
      },
    }, {
      environmentPolicy: 'cli-one-shot',
    })).toThrow(
      'rejects credential-like variable: POLO_REVIEW_CUSTOM_OAUTH_TOKEN',
    )
  })

  it('preserves Electron custom environment behavior', async () => {
    process.env.POLO_REVIEW_CUSTOM_KEY = 'desktop-custom-value'
    const client = new PoloMcpClient({
      transport: 'stdio',
      command: process.execPath,
      args: [fixture],
      env: {
        POLO_REVIEW_BENIGN_SETTING: 'desktop-config-value',
      },
    }, {
      environmentPolicy: 'desktop',
    })

    const env = await snapshot(client)
    expect(env.POLO_REVIEW_CUSTOM_KEY).toBe('desktop-custom-value')
    expect(env.POLO_REVIEW_BENIGN_SETTING).toBe('desktop-config-value')
  })
})
