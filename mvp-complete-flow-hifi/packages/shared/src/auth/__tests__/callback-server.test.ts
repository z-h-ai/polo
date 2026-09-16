import { describe, expect, it } from 'bun:test'
import { createCallbackServer } from '../callback-server.ts'

describe('callback server connection lifecycle', () => {
  it('closes the callback connection so a later flow cannot hit a completed server', async () => {
    const first = await createCallbackServer({
      appType: 'electron',
      callbackPaths: ['/phone-auth/callback'],
    })
    const firstResponse = await fetch(
      `${first.url}/phone-auth/callback?code=first&state=one`,
    )
    await firstResponse.text()
    expect(firstResponse.headers.get('connection')).toBe('close')
    await expect(first.promise).resolves.toEqual({
      query: { code: 'first', state: 'one' },
    })

    const second = await createCallbackServer({
      appType: 'electron',
      callbackPaths: ['/phone-auth/callback'],
    })
    const secondResponse = await fetch(
      `${second.url}/phone-auth/callback?code=second&state=two`,
    )
    await secondResponse.text()
    await expect(second.promise).resolves.toEqual({
      query: { code: 'second', state: 'two' },
    })
  })
})
