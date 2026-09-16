import { createInterface } from 'node:readline'
import { appendFile, readFile, unlink, writeFile } from 'node:fs/promises'
import { once } from 'node:events'
import { dirname, resolve } from 'node:path'
import { getProcessBirthIdentity } from '../cli-thread-store.ts'

const input = createInterface({ input: process.stdin })
const [bootstrapLine] = await once(input, 'line') as [string]
input.close()
const bootstrap = JSON.parse(bootstrapLine) as {
  owner?: { ownerFile?: string }
  runtimeConfig?: { connection?: unknown }
}
const ownerFile = bootstrap.owner?.ownerFile
const fixtureConfig = ownerFile
  ? JSON.parse(await readFile(
      resolve(dirname(ownerFile), '..', '..', '..', '..', '.polo-lifecycle-fixture.json'),
      'utf-8',
    ).catch(() => '{}')) as { mode?: string; runtimeInfoFile?: string; traceFile?: string }
  : {}
const mode = fixtureConfig.mode || 'hang'

if (fixtureConfig.traceFile) {
  await appendFile(fixtureConfig.traceFile, `${JSON.stringify({
    type: 'bootstrap',
    connection: bootstrap.runtimeConfig?.connection,
  })}\n`)
}

const runtimeInfoFile = fixtureConfig.runtimeInfoFile
if (runtimeInfoFile) {
  await writeFile(runtimeInfoFile, JSON.stringify({
    pid: process.pid,
    processIdentity: getProcessBirthIdentity(process.pid),
  }))
}

const server = Bun.serve({
  hostname: '127.0.0.1',
  port: 0,
  fetch(request, bunServer) {
    if (bunServer.upgrade(request)) return undefined
    return new Response('upgrade required', { status: 426 })
  },
  websocket: {
    async message(socket, message) {
      const envelope = JSON.parse(String(message)) as {
        id: string
        type: string
        channel?: string
        args?: unknown[]
      }
      if (envelope.type === 'handshake') {
        socket.send(JSON.stringify({
          id: envelope.id,
          type: 'handshake_ack',
          protocolVersion: '1.0',
          clientId: crypto.randomUUID(),
          registeredChannels: [],
        }))
        return
      }
      if (envelope.type !== 'request') return

      if (fixtureConfig.traceFile) {
        await appendFile(fixtureConfig.traceFile, `${JSON.stringify({
          type: 'request',
          channel: envelope.channel,
          args: envelope.args,
        })}\n`)
      }

      const result = envelope.channel === 'sessions:create'
        ? { id: 'fixture-session' }
        : null
      socket.send(JSON.stringify({
        id: envelope.id,
        type: 'response',
        channel: envelope.channel,
        result,
      }))

      if (envelope.channel !== 'sessions:sendMessage') return
      if (mode === 'complete') {
        const sessionId = String(envelope.args?.[0] ?? 'fixture-session')
        socket.send(JSON.stringify({
          id: crypto.randomUUID(),
          type: 'event',
          channel: 'session:event',
          args: [{
            type: 'text_complete',
            sessionId,
            text: 'fixture complete',
            isIntermediate: false,
          }],
        }))
        socket.send(JSON.stringify({
          id: crypto.randomUUID(),
          type: 'event',
          channel: 'session:event',
          args: [{ type: 'complete', sessionId }],
        }))
      } else if (mode === 'disconnect') {
        setTimeout(() => socket.close(), 10)
      } else if (mode === 'heartbeat') {
        if (ownerFile) void unlink(ownerFile).catch(() => {})
      }
    },
  },
})

process.stdout.write(`POLO_AI_SERVER_URL=ws://127.0.0.1:${server.port}\n`)

let stopping = false
process.on('SIGTERM', () => {
  if (stopping) return
  stopping = true
  void server.stop(true)
  process.exit(0)
})
await new Promise(() => {})
