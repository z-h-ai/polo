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
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { piAgentServerBuildArgs } from '../../../scripts/build/pi-build-args.ts'

const SERVER_ENTRY = join(import.meta.dir, 'index.ts')

interface Subprocess {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  proc: any
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  nextMessage: () => Promise<Record<string, unknown>>
}


/**
 * JSONL line reader over a subprocess stdout stream. The reader is created
 * ONCE per stream (repeated getReader() on a locked stream throws) and the
 * lock is released exactly when the stream terminates; partial lines are
 * buffered across reads.
 */
function createLineReader(
  stream: ReadableStream<Uint8Array>,
  closedError: () => string,
): () => Promise<Record<string, unknown>> {
  const decoder = new TextDecoder()
  let reader: ReadableStreamDefaultReader<Uint8Array> | null = null
  let buffer = ''
  return async (): Promise<Record<string, unknown>> => {
    reader ??= stream.getReader()
    try {
      for (;;) {
        const newlineIndex = buffer.indexOf('\n')
        if (newlineIndex >= 0) {
          const line = buffer.slice(0, newlineIndex).trim()
          buffer = buffer.slice(newlineIndex + 1)
          if (line) return JSON.parse(line) as Record<string, unknown>
          continue
        }
        const { value, done } = await reader.read()
        if (done) {
          // Stream terminated: release the lock before surfacing the error.
          reader.releaseLock()
          reader = null
          throw new Error(closedError())
        }
        buffer += decoder.decode(value, { stream: true })
      }
    } catch (error) {
      // A read rejection means the stream is unusable — release so a later
      // call starts from a clean reader instead of a locked stream.
      reader?.releaseLock()
      reader = null
      throw error
    }
  }
}

function spawnServer(): Subprocess {
  const proc = Bun.spawn({
    cmd: [process.execPath, SERVER_ENTRY],
    stdin: 'pipe',
    stdout: 'pipe',
    stderr: 'pipe',
  })
  const nextMessage = createLineReader(
    proc.stdout as ReadableStream<Uint8Array>,
    () => 'pi-agent-server stdout closed before the expected message',
  )
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

  // PRODUCTION HOST REGRESSION: the packaged Pi server is executed by a
  // Node 22 subprocess (the Electron main process spawned with
  // ELECTRON_RUN_AS_NODE=1) — never by bun. A bun-targeted ESM bundle
  // resolves CJS deps through `import.meta.require`, which is undefined
  // under Node and crashed the server before any model request. This test
  // builds a FRESH production bundle (shared piAgentServerBuildArgs) and
  // completes the real init/ready handshake under the Node host.
  it('a fresh production bundle completes init/ready under the ELECTRON_RUN_AS_NODE host (no import.meta.require)', async () => {
    // 1. FRESH PRODUCTION BUILD through the single shared args definition.
    const layout = mkdtempSync(join(tmpdir(), 'pi-server-node-host-'))
    // Mirror the PRODUCTION layout: the bundle lives at
    // packages/pi-agent-server/dist/index.js beside that package's
    // package.json ("type": "module") — Node's ESM loader needs it.
    const packageDir = join(layout, 'packages', 'pi-agent-server')
    const outdir = join(packageDir, 'dist')
    mkdirSync(outdir, { recursive: true })
    copyFileSync(join(import.meta.dir, '..', 'package.json'), join(packageDir, 'package.json'))
    const build = Bun.spawnSync({
      cmd: [process.execPath, ...piAgentServerBuildArgs(join(import.meta.dir, 'index.ts'), outdir)],
      cwd: join(import.meta.dir, '..', '..', '..'),
      stdout: 'pipe',
      stderr: 'pipe',
    })
    const bundlePath = join(outdir, 'index.js')
    if (build.exitCode !== 0 || !existsSync(bundlePath)) {
      throw new Error(`production bundle build failed (exit ${build.exitCode})\n${build.stderr?.toString() ?? ''}`)
    }

    // 2. BUNDLE SHAPE: node-target ESM emits createRequire — the bun-target
    // regression signature (`import.meta.require`) must be gone.
    const bundle = readFileSync(bundlePath, 'utf-8')
    expect(bundle).not.toContain('import.meta.require')
    expect(bundle).toContain('createRequire')

    // 3. REAL HOST: Node via PATH (override with POLO_PI_HOST_NODE), started
    // with ELECTRON_RUN_AS_NODE=1 exactly like the production host.
    const nodeHost = process.env.POLO_PI_HOST_NODE ?? 'node'
    const host = Bun.spawn({
      cmd: [nodeHost, join(packageDir, 'dist', 'index.js')],
      stdin: 'pipe',
      stdout: 'pipe',
      stderr: 'pipe',
      env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
    })
    try {
      host.stdin.write(
        JSON.stringify({
          type: 'init',
          sessionId: 'node-host-regression',
          workspaceRootPath: '/tmp',
          cwd: '/tmp',
        }) + '\n',
      )
      await host.stdin.flush()

      const nextMessage = createLineReader(
        host.stdout as ReadableStream<Uint8Array>,
        () => `node host closed stdout before ready; stderr pending`,
      )
      const ready = await Promise.race([
        nextMessage(),
        new Promise<never>((_, reject) => setTimeout(() => reject(new Error('timed out waiting for ready under the node host')), 20000)),
      ])
      // Same handshake contract as the bun-spawned regression above.
      expect(ready.type).toBe('ready')
      expect('callbackPort' in ready).toBe(false)
    } finally {
      host.kill()
      rmSync(layout, { recursive: true, force: true })
    }
  }, 60000)
})
