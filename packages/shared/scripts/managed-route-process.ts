import type { ChildProcess } from 'node:child_process'

export type ManagedProcessLifecycle = {
  forcedKill: boolean
  shutdownDurationMs: number
}

type ChildOutcome =
  | { kind: 'close'; code: number | null; signal: NodeJS.Signals | null }
  | { kind: 'error'; error: Error }

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message)
}

function abortReason(signal: AbortSignal): Error {
  if (signal.reason instanceof Error) return signal.reason
  const error = new Error('Route polling was aborted')
  error.name = 'AbortError'
  return error
}

async function abortableDelay(timeoutMs: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) throw abortReason(signal)
  await new Promise<void>((resolvePromise, rejectPromise) => {
    const onAbort = (): void => {
      clearTimeout(timeout)
      signal.removeEventListener('abort', onAbort)
      rejectPromise(abortReason(signal))
    }
    const timeout = setTimeout(() => {
      signal.removeEventListener('abort', onAbort)
      resolvePromise()
    }, timeoutMs)
    signal.addEventListener('abort', onAbort, { once: true })
  })
}

export async function waitForRoute(
  url: string,
  signal: AbortSignal,
  timeoutMs = 120_000,
  retryIntervalMs = 500,
): Promise<Record<string, unknown>> {
  const controller = new AbortController()
  let lastError: unknown
  const timeoutError = new Error(`Timed out waiting for ${url}`)
  const onAbort = (): void => { controller.abort(abortReason(signal)) }
  const timeout = setTimeout(() => {
    const detail = lastError instanceof Error ? `: ${lastError.message}` : ''
    timeoutError.message = `Timed out waiting for ${url}${detail}`
    controller.abort(timeoutError)
  }, timeoutMs)

  if (signal.aborted) onAbort()
  else signal.addEventListener('abort', onAbort, { once: true })

  try {
    while (true) {
      if (controller.signal.aborted) throw abortReason(controller.signal)
      try {
        const response = await fetch(url, { signal: controller.signal })
        const body = await response.text()
        if (response.ok) return JSON.parse(body) as Record<string, unknown>
        lastError = new Error(`unexpected response status ${response.status}: ${body}`)
      } catch (error) {
        if (controller.signal.aborted) throw abortReason(controller.signal)
        lastError = error
      }
      await abortableDelay(retryIntervalMs, controller.signal)
    }
  } finally {
    clearTimeout(timeout)
    signal.removeEventListener('abort', onAbort)
  }
}

function observeChild(child: ChildProcess): {
  settled: Promise<ChildOutcome>
  cleanup: () => void
} {
  let resolveOutcome!: (outcome: ChildOutcome) => void
  const settled = new Promise<ChildOutcome>(resolvePromise => {
    resolveOutcome = resolvePromise
  })
  const onError = (error: Error): void => { resolveOutcome({ kind: 'error', error }) }
  const onClose = (code: number | null, signal: NodeJS.Signals | null): void => {
    resolveOutcome({ kind: 'close', code, signal })
  }
  child.once('error', onError)
  child.once('close', onClose)
  return {
    settled,
    cleanup: () => {
      child.off('error', onError)
      child.off('close', onClose)
    },
  }
}

async function settlesWithin<T>(promise: Promise<T>, timeoutMs: number): Promise<boolean> {
  let timeout: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      promise.then(() => true),
      new Promise<boolean>(resolvePromise => {
        timeout = setTimeout(() => resolvePromise(false), timeoutMs)
      }),
    ])
  } finally {
    if (timeout) clearTimeout(timeout)
  }
}

async function terminateChild(
  child: ChildProcess,
  settled: Promise<ChildOutcome>,
  label: string,
): Promise<ManagedProcessLifecycle> {
  const startedAt = Date.now()
  if (!child.pid || child.exitCode !== null || child.signalCode !== null) {
    await settled
    return { forcedKill: false, shutdownDurationMs: Date.now() - startedAt }
  }

  child.kill('SIGTERM')
  if (await settlesWithin(settled, 5_000)) {
    return { forcedKill: false, shutdownDurationMs: Date.now() - startedAt }
  }

  child.kill('SIGKILL')
  assert(await settlesWithin(settled, 5_000), `${label} did not exit after SIGKILL`)
  return { forcedKill: true, shutdownDurationMs: Date.now() - startedAt }
}

export async function proveManagedRouteProcess(
  child: ChildProcess,
  url: string,
  options: {
    label: string
    earlyExitMessage: string
    routeTimeoutMs?: number
    retryIntervalMs?: number
  },
): Promise<{ response: Record<string, unknown>; lifecycle: ManagedProcessLifecycle }> {
  const observer = observeChild(child)
  const routeAbort = new AbortController()
  const stdoutListener = (chunk: Buffer): void => { process.stdout.write(chunk) }
  const stderrListener = (chunk: Buffer): void => { process.stderr.write(chunk) }
  child.stdout?.on('data', stdoutListener)
  child.stderr?.on('data', stderrListener)
  let response: Record<string, unknown> | undefined
  let lifecycle: ManagedProcessLifecycle | undefined
  const routePromise = waitForRoute(
    url,
    routeAbort.signal,
    options.routeTimeoutMs,
    options.retryIntervalMs,
  )

  try {
    response = await Promise.race([
      routePromise,
      observer.settled.then(outcome => {
        if (outcome.kind === 'error') throw outcome.error
        throw new Error(options.earlyExitMessage)
      }),
    ])
  } finally {
    routeAbort.abort(new Error('Route polling cancelled because the server settled'))
    await routePromise.catch(() => undefined)
    try {
      lifecycle = await terminateChild(child, observer.settled, options.label)
    } finally {
      observer.cleanup()
      child.stdout?.off('data', stdoutListener)
      child.stderr?.off('data', stderrListener)
      child.stdout?.destroy()
      child.stderr?.destroy()
    }
  }
  assert(response, 'Route response is missing')
  assert(lifecycle, 'Managed process lifecycle evidence is missing')
  return { response, lifecycle }
}
