import { spawn } from 'node:child_process'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const scriptDir = dirname(fileURLToPath(import.meta.url))
const repositoryRoot = resolve(scriptDir, '../../..')
const proofScript = join(scriptDir, 'verify-creator-skills-package.ts')
const defaultTimeoutMs = 10 * 60_000

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
    await new Promise(resolvePromise => setTimeout(resolvePromise, 100))
  }
  return true
}

async function terminateProcessGroup(groupId: number): Promise<void> {
  if (!processGroupExists(groupId)) return
  process.kill(-groupId, 'SIGTERM')
  if (await waitForProcessGroupExit(groupId, 5_000)) return
  process.kill(-groupId, 'SIGKILL')
  assert(
    await waitForProcessGroupExit(groupId, 5_000),
    `proof process group ${groupId} survived SIGKILL`,
  )
}

async function main(): Promise<void> {
  const forwardedArgs: string[] = []
  let outputDir: string | undefined
  let allowDirtySnapshot = false
  const args = process.argv.slice(2)

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index]!
    if (arg === '--allow-dirty-snapshot') {
      allowDirtySnapshot = true
      continue
    }
    forwardedArgs.push(arg)
    if (arg === '--output-dir') {
      const value = args[index + 1]
      assert(value && !value.startsWith('--'), '--output-dir requires a path')
      outputDir = resolve(value)
    }
  }

  let removeOutputDir = false
  if (!outputDir) {
    outputDir = await mkdtemp(join(tmpdir(), 'z-h-ai-shared-lifecycle-proof-'))
    forwardedArgs.push('--output-dir', outputDir)
    removeOutputDir = true
  } else {
    await mkdir(outputDir, { recursive: true })
  }

  const timeoutMs = Number(process.env.SHARED_PACKAGE_PROOF_TIMEOUT_MS ?? defaultTimeoutMs)
  assert(Number.isFinite(timeoutMs) && timeoutMs > 0, 'proof timeout must be a positive number')

  const child = spawn('bun', ['run', proofScript, ...forwardedArgs], {
    cwd: repositoryRoot,
    detached: true,
    env: {
      ...process.env,
      CI: '1',
      ...(allowDirtySnapshot ? { SHARED_PACKAGE_PROOF_ALLOW_DIRTY: '1' } : {}),
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  assert(child.pid, 'proof process did not receive a pid')
  const processGroupId = child.pid
  let stderr = ''
  const stdoutListener = (chunk: Buffer): void => { process.stdout.write(chunk) }
  const stderrListener = (chunk: Buffer): void => {
    stderr = `${stderr}${chunk.toString()}`.slice(-64_000)
    process.stderr.write(chunk)
  }
  child.stdout.on('data', stdoutListener)
  child.stderr.on('data', stderrListener)

  let watchdog: ReturnType<typeof setTimeout> | undefined
  try {
    const result = await Promise.race([
      new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolvePromise, rejectPromise) => {
        child.once('error', rejectPromise)
        child.once('close', (code, signal) => resolvePromise({ code, signal }))
      }),
      new Promise<never>((_resolvePromise, rejectPromise) => {
        watchdog = setTimeout(() => {
          rejectPromise(new Error(
            `proof command did not exit by itself within ${timeoutMs}ms; this is a regression failure`,
          ))
        }, timeoutMs)
      }),
    ])
    assert(
      result.code === 0,
      `proof command exited with code ${result.code ?? 'null'} and signal ${result.signal ?? 'none'}`
      + (stderr ? `\n${stderr}` : ''),
    )
    assert(
      await waitForProcessGroupExit(processGroupId, 2_000),
      'proof command exited but left a live descendant in its process group',
    )

    const proof = JSON.parse(await readFile(join(outputDir, 'proof.json'), 'utf8')) as {
      package?: string
      checks?: Record<string, string>
      nextProductionProcess?: { forcedKill?: boolean }
    }
    assert(
      proof.checks?.nextProductionProcessLifecycle === 'passed',
      'proof evidence is missing the Next production process lifecycle check',
    )
    assert(
      proof.nextProductionProcess?.forcedKill === false,
      'Next production server required SIGKILL instead of exiting after SIGTERM',
    )
    const lifecycleEvidence = {
      schemaVersion: 1,
      package: proof.package,
      environment: 'CI-style non-interactive',
      stdio: 'piped',
      exitCode: result.code,
      exitSignal: result.signal,
      processGroupReaped: true,
      checks: {
        proofCommandExitedByItself: 'passed',
        noLiveDescendantProcess: 'passed',
      },
    }
    await writeFile(
      join(outputDir, 'lifecycle-proof.json'),
      `${JSON.stringify(lifecycleEvidence, null, 2)}\n`,
    )
    console.log('CI-style proof lifecycle regression passed')
  } catch (error) {
    await terminateProcessGroup(processGroupId)
    throw error
  } finally {
    if (watchdog) clearTimeout(watchdog)
    child.stdout.off('data', stdoutListener)
    child.stderr.off('data', stderrListener)
    child.stdout.destroy()
    child.stderr.destroy()
    if (removeOutputDir) await rm(outputDir, { recursive: true, force: true })
  }
}

main().catch(error => {
  console.error(error)
  process.exitCode = 1
})
