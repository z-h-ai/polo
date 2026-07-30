import { createInterface } from 'node:readline'
import { unlink, writeFile } from 'node:fs/promises'
import { once } from 'node:events'
import { getProcessBirthIdentity } from '../cli-thread-store.ts'

const input = createInterface({ input: process.stdin })
const [bootstrapLine] = await once(input, 'line') as [string]
input.close()
const bootstrap = JSON.parse(bootstrapLine) as {
  owner?: { ownerFile?: string }
}
const mode = process.env.POLO_TEST_FAILURE_MODE || 'hang'

const runtimeInfoFile = process.env.POLO_TEST_RUNTIME_INFO_FILE
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
    message(socket, message) {
      const envelope = JSON.parse(String(message)) as {
        id: string
        type: string
        channel?: string
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
      if (mode === 'disconnect') {
        setTimeout(() => socket.close(), 10)
      } else if (mode === 'heartbeat') {
        const ownerFile = bootstrap.owner?.ownerFile
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
