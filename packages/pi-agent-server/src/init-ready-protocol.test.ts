/**
 * Pi subprocess init/ready protocol regression.
 *
 * The deleted session MCP sidecar chain used to leave ONE extra lifetime in
 * the Pi backend: every init unconditionally started an unauthenticated
 * /call-llm HTTP listener on 127.0.0.1, and `ready` carried its callbackPort
 * that no production consumer ever read. This regression locks in the
 * current single-channel contract:
 *   - `ready` no longer carries a `callbackPort` field at all;
 *   - a normal init/ready exchange creates NO internal HTTP listener.
 *
 * call_llm / request_user_input stay on the sole production channel:
 * tool_execute_request → executeSessionTool → awaited SessionToolContext.
 */
import { describe, expect, it } from 'bun:test'
import { join } from 'node:path'

const SERVER_ENTRY = join(import.meta.dir, 'index.ts')

interface Subprocess {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  proc: any
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  nextMessage: () => Promise<Record<string, unknown>>
}

function spawnServer(): Subprocess {
  const proc = Bun.spawn({
    cmd: [process.execPath, SERVER_ENTRY],
    stdin: 'pipe',
    stdout: 'pipe',
    stderr: 'pipe',
  })
  const decoder = new TextDecoder()
  let buffer = ''
  const nextMessage = async (): Promise<Record<string, unknown>> => {
    for (;;) {
      const newlineIndex = buffer.indexOf('\n')
      if (newlineIndex >= 0) {
        const line = buffer.slice(0, newlineIndex).trim()
        buffer = buffer.slice(newlineIndex + 1)
        if (line) return JSON.parse(line) as Record<string, unknown>
        continue
      }
      const { value, done } = await proc.stdout.getReader().read()
      if (done) throw new Error('pi-agent-server stdout closed before the expected message')
      buffer += decoder.decode(value, { stream: true })
    }
  }
  return { proc, nextMessage }
}

function hasLsof(): boolean {
  const probe = Bun.spawnSync({ cmd: ['which', 'lsof'], stdout: 'pipe', stderr: 'pipe' })
  return probe.exitCode === 0
}

describe('pi-agent-server init/ready protocol', () => {
  it('a normal init/ready exchange carries NO callbackPort and creates NO internal HTTP listener', async () => {
    const { proc, nextMessage } = spawnServer()
    try {
      proc.stdin.write(
        JSON.stringify({
          type: 'init',
          sessionId: 'init-ready-regression',
          workspaceRootPath: '/tmp',
          cwd: '/tmp',
        }) + '\n',
      )
      await proc.stdin.flush()

      const ready = await Promise.race([
        nextMessage(),
        new Promise<never>((_, reject) => setTimeout(() => reject(new Error('timed out waiting for ready')), 20000)),
      ])
      expect(ready.type).toBe('ready')
      // PROTOCOL: the ready message no longer carries a callback port — the
      // deleted sidecar chain has no leftover protocol field.
      expect('callbackPort' in ready).toBe(false)

      // NO INTERNAL LISTENER: the subprocess owns no listening TCP socket.
      if (hasLsof()) {
        const scan = Bun.spawnSync({
          cmd: ['lsof', '-nP', '-iTCP', '-sTCP:LISTEN', '-a', '-p', String(proc.pid)],
          stdout: 'pipe',
          stderr: 'pipe',
        })
        const lines = scan.stdout.toString().split('\n').filter(l => l.trim().length > 0)
        expect(lines).toEqual([])
      }
    } finally {
      proc.kill()
    }
  }, 30000)
})
