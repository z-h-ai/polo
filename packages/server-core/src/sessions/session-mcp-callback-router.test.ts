/**
 * Session MCP callback router — HTTP adversarial coverage (review fix round
 * 10, issue C): the localhost callback endpoint only allows the DECLARED
 * method (POST). Any other method is rejected with 405 + Allow and NEVER
 * reaches the SessionManager.
 */
import { describe, expect, it } from 'bun:test'
import { createSessionMcpCallbackHandler } from './session-mcp-callback-router.ts'

function validPayload(): Record<string, unknown> {
  return {
    sessionId: 'adv-1',
    questions: [
      {
        id: 'q',
        header: 'H',
        question: 'Q?',
        options: [
          { id: 'a', label: 'A', description: 'a' },
          { id: 'b', label: 'B', description: 'b' },
        ],
      },
    ],
    generationAtRequest: 1,
  }
}

describe('session MCP callback router HTTP adversarial', () => {
  it('rejects PUT / DELETE / GET with 405 + Allow and never calls the SessionManager', async () => {
    let smCalls = 0
    const sm = {
      handleExternalQuestionRequested: async () => {
        smCalls++
        return Promise.resolve()
      },
    }
    const handler = createSessionMcpCallbackHandler(sm as never)

    for (const method of ['PUT', 'DELETE', 'GET']) {
      const response = await handler({
        method,
        url: 'http://localhost/request-user-input',
        json: async () => validPayload(),
      })
      expect(response.status).toBe(405)
      expect(response.headers.get('Allow')).toBe('POST')
      // The body is consumed only for POST — assert defensively for methods
      // that carry one.
      if (method !== 'GET') {
        await response.text()
      }
    }
    expect(smCalls).toBe(0)
  })

  it('accepts the declared POST with a valid payload (control)', async () => {
    let smCalls = 0
    const sm = {
      handleExternalQuestionRequested: async () => {
        smCalls++
      },
    }
    const handler = createSessionMcpCallbackHandler(sm as never)
    const response = await handler({
      method: 'POST',
      url: 'http://localhost/request-user-input',
      json: async () => validPayload(),
    })
    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ status: 'accepted' })
    expect(smCalls).toBe(1)
  })
})
