import { spawn } from 'node:child_process'
import { proveManagedRouteProcess } from './managed-route-process.ts'

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

async function waitForProcessGroupExit(groupId: number): Promise<boolean> {
  const deadline = Date.now() + 1_000
  while (processGroupExists(groupId)) {
    if (Date.now() >= deadline) return false
    await new Promise(resolvePromise => setTimeout(resolvePromise, 25))
  }
  return true
}

async function main(): Promise<void> {
  const scenario = process.argv[2]
  assert(
    scenario === 'early-exit' || scenario === 'spawn-error',
    'scenario must be early-exit or spawn-error',
  )
  const missingCommand = '/definitely-missing/z-h-ai-next-proof'
  const child = scenario === 'early-exit'
    ? spawn(process.execPath, ['-e', 'process.exit(23)'], {
        detached: true,
        stdio: ['ignore', 'pipe', 'pipe'],
      })
    : spawn(missingCommand, [], {
        detached: true,
        stdio: ['ignore', 'pipe', 'pipe'],
      })
  const processGroupId = child.pid
  const startedAt = Date.now()
  let caught: unknown
  try {
    await proveManagedRouteProcess(
      child,
      'http://127.0.0.1:9/expected-not-to-respond',
      {
        label: 'failure lifecycle test server',
        earlyExitMessage: 'Next production server exited before the proof route responded',
        routeTimeoutMs: 120_000,
        retryIntervalMs: 500,
      },
    )
  } catch (error) {
    caught = error
  }

  const elapsedMs = Date.now() - startedAt
  assert(caught instanceof Error, `${scenario} unexpectedly succeeded`)
  assert(elapsedMs < 2_000, `${scenario} took ${elapsedMs}ms instead of cancelling immediately`)
  if (scenario === 'early-exit') {
    assert(
      caught.message === 'Next production server exited before the proof route responded',
      `early-exit error was replaced: ${caught.message}`,
    )
    assert(processGroupId, 'early-exit child did not receive a process group id')
    assert(
      await waitForProcessGroupExit(processGroupId),
      'early-exit child left a live descendant process',
    )
  } else {
    assert(
      (caught as NodeJS.ErrnoException).code === 'ENOENT',
      `spawn error did not preserve ENOENT: ${caught.message}`,
    )
    assert(caught.message.includes(missingCommand), 'spawn error lost the original command path')
  }
  console.log(`${scenario} cancellation regression passed in ${elapsedMs}ms`)
}

main().catch(error => {
  console.error(error)
  process.exitCode = 1
})
