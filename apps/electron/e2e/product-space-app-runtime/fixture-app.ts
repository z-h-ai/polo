/**
 * POO-54 E2E fixture App. It is spawned as a real local-app process and only
 * uses its injected process environment (POLO_APP_API_URL /
 * POLO_APP_API_TOKEN) to call the real loopback local-app-api.v1 gateway.
 * It never imports Polo internals. After the sequence it keeps the health
 * server running until Polo stops the process.
 */
const apiUrl = process.env.POLO_APP_API_URL ?? ''
const apiToken = process.env.POLO_APP_API_TOKEN ?? ''
const resultPath = process.env.POLO_FIXTURE_RESULT_PATH ?? ''

interface RecordedCall {
  path: string
  status: number
  body: Record<string, unknown>
}

const calls: Record<string, RecordedCall> = {}

async function call(label: string, path: string, body: Record<string, unknown>): Promise<void> {
  const response = await fetch(`${apiUrl}${path}`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiToken}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  })
  let json: Record<string, unknown> = {}
  try {
    json = await response.json() as Record<string, unknown>
  } catch {
    json = {}
  }
  calls[label] = { path, status: response.status, body: json }
}

function uuid(): string {
  return crypto.randomUUID()
}

async function runSequence(): Promise<void> {
  const runId = uuid()
  try {
    await call('runStart', '/run/start', { runId })
    await call('resultReportWhileRunning', '/result/report', {
      runId,
      requestId: uuid(),
      resultId: uuid(),
      title: 'e2e result',
    })
    await call('query', '/ai/query', {
      runId,
      requestId: uuid(),
      prompt: 'say hi',
      maxOutputTokens: 64,
      timeoutMs: 10_000,
    })
    await call('finish', '/run/finish', { runId, status: 'completed' })
    await call('startAfterFinish', '/run/start', { runId: uuid() })
    await call('reportAfterFinish', '/result/report', {
      runId,
      requestId: uuid(),
      resultId: uuid(),
      title: 'late',
    })
  } catch (error) {
    calls['error'] = {
      path: 'sequence',
      status: 0,
      body: { message: error instanceof Error ? error.message : String(error) },
    }
  }
  await Bun.write(resultPath, JSON.stringify(calls, null, 2))
}

Bun.serve({
  hostname: '127.0.0.1',
  port: Number(process.env.PORT),
  fetch(request) {
    const path = new URL(request.url).pathname
    if (path === '/health') {
      return new Response('ok', {
        headers: { 'x-polo-app-health-token': process.env.POLO_APP_HEALTH_TOKEN ?? '' },
      })
    }
    return new Response('not found', { status: 404 })
  },
})

void runSequence()
