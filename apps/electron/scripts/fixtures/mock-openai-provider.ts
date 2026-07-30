#!/usr/bin/env bun

import { appendFileSync, realpathSync, writeFileSync } from 'node:fs'
import { dirname, isAbsolute, join, relative, resolve } from 'node:path'

function requireFixturePath(name: string, fixtureRoot: string): string {
  const value = process.env[name]
  if (!value || !isAbsolute(value)) throw new Error(`${name} must be an absolute path`)
  const resolved = resolve(value)
  const canonical = join(realpathSync(dirname(resolved)), resolved.split(/[\\/]/).at(-1)!)
  const rel = relative(fixtureRoot, canonical)
  if (rel.startsWith('..') || isAbsolute(rel)) {
    throw new Error(`${name} must stay inside POLO_AI_ARTIFACT_E2E_ROOT`)
  }
  return canonical
}

if (process.env.POLO_AI_ARTIFACT_E2E_FIXTURE !== '1') {
  throw new Error('The mock provider is restricted to artifact E2E fixtures')
}

const fixtureRootInput = process.env.POLO_AI_ARTIFACT_E2E_ROOT
if (!fixtureRootInput || !isAbsolute(fixtureRootInput)) {
  throw new Error('POLO_AI_ARTIFACT_E2E_ROOT must be absolute')
}
const fixtureRoot = realpathSync(fixtureRootInput)
const statePath = requireFixturePath('POLO_AI_E2E_MOCK_STATE', fixtureRoot)
const logPath = requireFixturePath('POLO_AI_E2E_MOCK_LOG', fixtureRoot)
const token = process.env.POLO_AI_E2E_MOCK_TOKEN
if (!token || token.length < 20) throw new Error('POLO_AI_E2E_MOCK_TOKEN is missing or too short')

const encoder = new TextEncoder()
const server = Bun.serve({
  hostname: '127.0.0.1',
  port: 0,
  async fetch(request) {
    const url = new URL(request.url)
    if (request.headers.get('authorization') !== `Bearer ${token}`) {
      return Response.json({ error: { message: 'unauthorized' } }, { status: 401 })
    }
    if (request.method === 'GET' && url.pathname.endsWith('/models')) {
      return Response.json({
        object: 'list',
        data: [{ id: 'gpt-4o', object: 'model', owned_by: 'polo-e2e' }],
      })
    }
    if (request.method !== 'POST' || !url.pathname.endsWith('/chat/completions')) {
      return Response.json({ error: { message: 'fixture route not found' } }, { status: 404 })
    }

    const body = await request.json() as {
      stream?: boolean
      model?: string
      messages?: Array<{ role?: string; content?: unknown }>
    }
    const prompt = JSON.stringify(body.messages ?? [])
    if (!prompt.includes('hello')) {
      return Response.json({ error: { message: 'fixture expected hello prompt' } }, { status: 400 })
    }
    appendFileSync(logPath, JSON.stringify({
      at: new Date().toISOString(),
      path: url.pathname,
      model: body.model,
      stream: body.stream === true,
      sawHello: true,
    }) + '\n')

    const response = {
      id: 'chatcmpl-polo-artifact-e2e',
      object: 'chat.completion',
      created: Math.floor(Date.now() / 1000),
      model: body.model ?? 'gpt-4o',
      choices: [{
        index: 0,
        message: { role: 'assistant', content: 'artifact run completed' },
        finish_reason: 'stop',
      }],
      usage: { prompt_tokens: 1, completion_tokens: 3, total_tokens: 4 },
    }
    if (!body.stream) return Response.json(response)

    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        const send = (value: unknown) => {
          controller.enqueue(encoder.encode(`data: ${JSON.stringify(value)}\n\n`))
        }
        send({
          id: response.id,
          object: 'chat.completion.chunk',
          created: response.created,
          model: response.model,
          choices: [{ index: 0, delta: { role: 'assistant' }, finish_reason: null }],
        })
        send({
          id: response.id,
          object: 'chat.completion.chunk',
          created: response.created,
          model: response.model,
          choices: [{ index: 0, delta: { content: 'artifact run completed' }, finish_reason: null }],
        })
        send({
          id: response.id,
          object: 'chat.completion.chunk',
          created: response.created,
          model: response.model,
          choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
        })
        send({
          id: response.id,
          object: 'chat.completion.chunk',
          created: response.created,
          model: response.model,
          choices: [],
          usage: response.usage,
        })
        controller.enqueue(encoder.encode('data: [DONE]\n\n'))
        controller.close()
      },
    })
    return new Response(stream, {
      headers: { 'content-type': 'text/event-stream; charset=utf-8' },
    })
  },
})

writeFileSync(statePath, JSON.stringify({
  schemaVersion: 1,
  pid: process.pid,
  host: '127.0.0.1',
  port: server.port,
  baseUrl: `http://127.0.0.1:${server.port}/v1`,
}) + '\n', { mode: 0o600 })

const stop = () => {
  server.stop(true)
  process.exit(0)
}
process.once('SIGINT', stop)
process.once('SIGTERM', stop)
await new Promise(() => {})
