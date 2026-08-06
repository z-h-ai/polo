import { spawn } from 'node:child_process'
import { mkdir, mkdtemp, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const scriptDir = dirname(fileURLToPath(import.meta.url))
const workerScript = join(scriptDir, 'proof-failure-lifecycle-worker.ts')
const lifecycleScript = join(scriptDir, 'verify-creator-skills-package-lifecycle.ts')
const scenarioTimeoutMs = 5_000

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message)
}

function processGroupExists(groupId: number): boolean {
  try {
    process.kill(-groupId, 0)
    return true
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ESRCH') return false
    if ((error as NodeJS.ErrnoException).code === 'EPERM') return true
    throw error
  }
}

async function waitForProcessGroupExit(groupId: number, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs
  while (processGroupExists(groupId)) {
    if (Date.now() >= deadline) return false
    await new Promise(resolvePromise => setTimeout(resolvePromise, 50))
  }
  return true
}

async function terminateProcessGroup(groupId: number): Promise<void> {
  if (!processGroupExists(groupId)) return
  process.kill(-groupId, 'SIGTERM')
  if (await waitForProcessGroupExit(groupId, 1_000)) return
  process.kill(-groupId, 'SIGKILL')
  assert(await waitForProcessGroupExit(groupId, 1_000), `process group ${groupId} survived SIGKILL`)
}

async function runScenario(
  name: string,
  args: string[],
  env: NodeJS.ProcessEnv,
  expectedCode: number,
): Promise<{ stdout: string; stderr: string; elapsedMs: number }> {
  const startedAt = Date.now()
  const child = spawn(process.execPath, args, {
    detached: true,
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  let stdout = ''
  let stderr = ''
  const stdoutListener = (chunk: Buffer): void => { stdout += chunk.toString() }
  const stderrListener = (chunk: Buffer): void => { stderr += chunk.toString() }
  let errorListener: ((error: Error) => void) | undefined
  let closeListener: ((code: number | null, signal: NodeJS.Signals | null) => void) | undefined
  const settled = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolvePromise, rejectPromise) => {
    errorListener = rejectPromise
    closeListener = (code, signal) => resolvePromise({ code, signal })
    child.once('error', errorListener)
    child.once('close', closeListener)
  })
  child.stdout.on('data', stdoutListener)
  child.stderr.on('data', stderrListener)
  let processGroupId: number | undefined
  let watchdog: ReturnType<typeof setTimeout> | undefined
  try {
    if (!child.pid) await settled
    assert(child.pid, `${name} did not receive a process group id`)
    processGroupId = child.pid
    const result = await Promise.race([
      settled,
      new Promise<never>((_resolvePromise, rejectPromise) => {
        watchdog = setTimeout(() => rejectPromise(new Error(
          `${name} did not exit by itself within ${scenarioTimeoutMs}ms`,
        )), scenarioTimeoutMs)
      }),
    ])
    assert(
      result.code === expectedCode,
      `${name} exited with ${result.code ?? 'null'}/${result.signal ?? 'none'} instead of ${expectedCode}`
      + (stderr ? `\n${stderr}` : ''),
    )
    assert(
      await waitForProcessGroupExit(processGroupId, 1_000),
      `${name} exited but left a live descendant process`,
    )
    return { stdout, stderr, elapsedMs: Date.now() - startedAt }
  } catch (error) {
    if (processGroupId) await terminateProcessGroup(processGroupId)
    throw error
  } finally {
    if (watchdog) clearTimeout(watchdog)
    if (errorListener) child.off('error', errorListener)
    if (closeListener) child.off('close', closeListener)
    child.stdout.off('data', stdoutListener)
    child.stderr.off('data', stderrListener)
    child.stdout.destroy()
    child.stderr.destroy()
  }
}

async function main(): Promise<void> {
  for (const scenario of ['early-exit', 'spawn-error']) {
    const result = await runScenario(
      `managed route ${scenario}`,
      ['run', workerScript, scenario],
      process.env,
      0,
    )
    assert(result.stdout.includes(`${scenario} cancellation regression passed`), result.stdout)
    assert(result.elapsedMs < scenarioTimeoutMs, `${scenario} exceeded the short failure bound`)
    process.stdout.write(result.stdout)
  }

  const sandboxRoot = await mkdtemp(join(tmpdir(), 'z-h-ai-wrapper-spawn-error-'))
  const tempRoot = join(sandboxRoot, 'tmp')
  const emptyPath = join(sandboxRoot, 'empty-path')
  await mkdir(tempRoot)
  await mkdir(emptyPath)
  try {
    const result = await runScenario(
      'lifecycle wrapper missing bun',
      ['run', lifecycleScript],
      {
        ...process.env,
        PATH: emptyPath,
        TMPDIR: tempRoot,
        TMP: tempRoot,
        TEMP: tempRoot,
      },
      1,
    )
    assert(result.stderr.includes('ENOENT'), `wrapper lost original ENOENT:\n${result.stderr}`)
    assert(
      !result.stderr.includes('proof process did not receive a pid'),
      `wrapper masked ENOENT with pid assertion:\n${result.stderr}`,
    )
    assert((await readdir(tempRoot)).length === 0, 'wrapper did not remove its automatic temp dir')
    assert(result.elapsedMs < scenarioTimeoutMs, 'wrapper spawn error exceeded the short failure bound')
    console.log(`wrapper spawn-error cleanup regression passed in ${result.elapsedMs}ms`)
  } finally {
    await rm(sandboxRoot, { recursive: true, force: true })
  }
}

main().catch(error => {
  console.error(error)
  process.exitCode = 1
})
