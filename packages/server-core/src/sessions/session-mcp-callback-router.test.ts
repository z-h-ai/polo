/**
 * Session MCP callback router — HTTP adversarial coverage: the localhost
 * callback endpoint only allows the DECLARED method (POST; 405 + Allow
 * otherwise) and only parses bodies declared as exact `application/json`
 * (415 otherwise). Rejected requests NEVER reach the SessionManager — the
 * state-changing loopback route must not be reachable by simple cross-origin
 * non-JSON POSTs that skip CORS preflight.
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
      handleSessionMcpQuestionRequested: async () => {
        smCalls++
        return Promise.resolve()
      },
    }
    const handler = createSessionMcpCallbackHandler(sm as never)

    for (const method of ['PUT', 'DELETE', 'GET']) {
      const response = await handler({
        method,
        url: 'http://localhost/request-user-input',
        headers: new Headers({ 'content-type': 'application/json' }),
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
      handleSessionMcpQuestionRequested: async () => {
        smCalls++
      },
    }
    const handler = createSessionMcpCallbackHandler(sm as never)
    const response = await handler({
      method: 'POST',
      url: 'http://localhost/request-user-input',
      headers: new Headers({ 'content-type': 'application/json' }),
      json: async () => validPayload(),
    })
    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ status: 'accepted' })
    expect(smCalls).toBe(1)
  })

  it('rejects a non-JSON Content-Type with 415 BEFORE reading the body — the SessionManager is never called', async () => {
    let smCalls = 0
    const sm = {
      handleSessionMcpQuestionRequested: async () => {
        smCalls++
      },
    }
    const handler = createSessionMcpCallbackHandler(sm as never)
    let bodyReads = 0

    for (const contentType of ['text/plain', 'text/plain; charset=utf-8', 'application/x-www-form-urlencoded', '']) {
      const response = await handler({
        method: 'POST',
        url: 'http://localhost/request-user-input',
        headers: new Headers(contentType ? { 'content-type': contentType } : {}),
        // A VALID JSON body behind a wrong media type must never be parsed.
        json: async () => {
          bodyReads++
          return validPayload()
        },
      })
      expect(response.status).toBe(415)
      expect((await response.json())).toEqual({ error: 'Unsupported Media Type: expected application/json' })
    }
    expect(smCalls).toBe(0)
    expect(bodyReads).toBe(0)
  })

  it('accepts application/json with optional parameters (charset) and rejects +json sub-type suffixes', async () => {
    let smCalls = 0
    const sm = {
      handleSessionMcpQuestionRequested: async () => {
        smCalls++
      },
    }
    const handler = createSessionMcpCallbackHandler(sm as never)

    const ok = await handler({
      method: 'POST',
      url: 'http://localhost/request-user-input',
      headers: new Headers({ 'content-type': 'application/json; charset=utf-8' }),
      json: async () => validPayload(),
    })
    expect(ok.status).toBe(200)
    expect(smCalls).toBe(1)

    const suffix = await handler({
      method: 'POST',
      url: 'http://localhost/request-user-input',
      headers: new Headers({ 'content-type': 'application/vnd.api+json' }),
      json: async () => validPayload(),
    })
    expect(suffix.status).toBe(415)
    expect(smCalls).toBe(1)
  })
})
