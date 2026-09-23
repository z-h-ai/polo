import { describe, expect, it } from 'bun:test'
import { request } from 'node:http'
import { createCallbackServer } from '../callback-server.ts'

function requestCallback(url: string): Promise<{ connection: string | undefined; body: string }> {
  return new Promise((resolve, reject) => {
    const requestHandle = request(url, { agent: false }, response => {
      let body = ''
      response.setEncoding('utf8')
      response.on('data', chunk => { body += chunk })
      response.on('end', () => {
        const connection = response.headers.connection
        resolve({ connection: Array.isArray(connection) ? connection[0] : connection, body })
      })
    })
    requestHandle.once('error', reject)
    requestHandle.end()
  })
}

describe('callback server connection lifecycle', () => {
  it('closes the callback connection so a later flow cannot hit a completed server', async () => {
    const first = await createCallbackServer({
      appType: 'electron',
      callbackPaths: ['/phone-auth/callback'],
    })
    // Fetch may hide the hop-by-hop Connection response header depending on
    // the concurrent Bun HTTP client implementation. Assert the wire header
    // through node:http instead, which is the behavior this lifecycle needs.
    const firstResponse = await requestCallback(
      `${first.url}/phone-auth/callback?code=first&state=one`,
    )
    expect(firstResponse.connection).toBe('close')
    await expect(first.promise).resolves.toEqual({
      query: { code: 'first', state: 'one' },
    })

    const second = await createCallbackServer({
      appType: 'electron',
      callbackPaths: ['/phone-auth/callback'],
    })
    const secondResponse = await requestCallback(
      `${second.url}/phone-auth/callback?code=second&state=two`,
    )
    expect(secondResponse.body).toContain('Authorization Complete')
    await expect(second.promise).resolves.toEqual({
      query: { code: 'second', state: 'two' },
    })
  })
})
