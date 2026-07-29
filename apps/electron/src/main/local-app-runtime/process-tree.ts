import { spawn } from 'child_process'

const WINDOWS_PROCESS_QUERY_LIMIT_BYTES = 4 * 1024 * 1024
const WINDOWS_COMMAND_TIMEOUT_MS = 5_000
const DEFAULT_SAMPLE_INTERVAL_MS = 1_000
const TERMINATION_PASSES = 4
const JOB_OBJECT_EXTENDED_LIMIT_INFORMATION = 9
const JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE = 0x00002000
const PROCESS_TERMINATE = 0x0001
const PROCESS_SET_QUOTA = 0x0100

export interface WindowsProcessRecord {
  pid: number
  parentPid: number
}

export interface WindowsProcessTreeAdapter {
  snapshot(): Promise<WindowsProcessRecord[]>
  killTree(pid: number): Promise<void>
}

export interface WindowsProcessTreeOwnerOptions {
  rootPid: number
  adapter: WindowsProcessTreeAdapter
  sampleIntervalMs?: number
}

export interface WindowsJobObjectAdapter {
  createKillOnCloseJob(): unknown
  assignProcess(job: unknown, pid: number): void
  terminateAndClose(job: unknown): void
}

export interface WindowsJobObjectOwnerOptions {
  adapter: WindowsJobObjectAdapter
  fallback?: WindowsProcessTreeOwner
}

/**
 * Owns a Windows Job Object configured with KILL_ON_JOB_CLOSE. Unlike process
 * snapshots, job membership is inherited by descendants while they are
 * created, so ownership survives the root and any short-lived intermediary.
 */
export class WindowsJobObjectOwner {
  private readonly adapter: WindowsJobObjectAdapter
  private readonly job: unknown
  private fallback?: WindowsProcessTreeOwner
  private terminationPromise?: Promise<void>

  constructor(options: WindowsJobObjectOwnerOptions) {
    this.adapter = options.adapter
    this.job = this.adapter.createKillOnCloseJob()
    this.fallback = options.fallback
  }

  assignProcess(pid: number): void {
    this.adapter.assignProcess(this.job, pid)
  }

  setSnapshotFallback(fallback: WindowsProcessTreeOwner): void {
    this.fallback?.dispose()
    this.fallback = fallback
  }

  terminate(): Promise<void> {
    if (this.terminationPromise) return this.terminationPromise
    this.terminationPromise = this.performTermination()
    return this.terminationPromise
  }

  private async performTermination(): Promise<void> {
    try {
      this.adapter.terminateAndClose(this.job)
      this.fallback?.dispose()
    } catch (jobError) {
      if (!this.fallback) throw jobError
      await this.fallback.terminate()
    }
  }
}

/**
 * Tracks descendants while the root is alive and retains historical parent
 * PIDs, so a final snapshot can still find children after the root exits.
 */
export class WindowsProcessTreeOwner {
  private readonly rootPid: number
  private readonly adapter: WindowsProcessTreeAdapter
  private readonly ownedPids = new Set<number>()
  private readonly sampleIntervalMs: number
  private sampleTimer?: ReturnType<typeof setInterval>
  private samplePromise?: Promise<WindowsProcessRecord[]>
  private terminationPromise?: Promise<void>

  constructor(options: WindowsProcessTreeOwnerOptions) {
    this.rootPid = options.rootPid
    this.adapter = options.adapter
    this.sampleIntervalMs = options.sampleIntervalMs ?? DEFAULT_SAMPLE_INTERVAL_MS
    this.ownedPids.add(this.rootPid)
    if (this.sampleIntervalMs > 0) {
      this.sampleTimer = setInterval(() => {
        void this.refreshOwnership().catch(() => {})
      }, this.sampleIntervalMs)
      this.sampleTimer.unref?.()
      void this.refreshOwnership().catch(() => {})
    }
  }

  terminate(): Promise<void> {
    if (this.terminationPromise) return this.terminationPromise
    this.terminationPromise = this.performTermination()
    return this.terminationPromise
  }

  dispose(): void {
    this.stopSampling()
  }

  private async performTermination(): Promise<void> {
    this.stopSampling()

    for (let pass = 0; pass < TERMINATION_PASSES; pass += 1) {
      let snapshot: WindowsProcessRecord[]
      try {
        snapshot = await this.refreshOwnership()
      } catch (error) {
        await Promise.allSettled(
          [...this.ownedPids]
            .filter(pid => pid !== process.pid)
            .map(pid => this.adapter.killTree(pid)),
        )
        if (pass === TERMINATION_PASSES - 1) throw error
        await new Promise(resolve => setTimeout(resolve, 50))
        continue
      }
      const liveOwned = snapshot
        .filter(processRecord => this.ownedPids.has(processRecord.pid))
        .map(processRecord => processRecord.pid)
        .filter(pid => pid !== process.pid)
      if (liveOwned.length === 0) return
      await Promise.allSettled(liveOwned.map(pid => this.adapter.killTree(pid)))
      await new Promise(resolve => setTimeout(resolve, 50))
    }

    const finalSnapshot = await this.refreshOwnership()
    const survivors = finalSnapshot
      .filter(processRecord => this.ownedPids.has(processRecord.pid))
      .map(processRecord => processRecord.pid)
      .filter(pid => pid !== process.pid)
    if (survivors.length > 0) {
      throw new Error(`Windows process tree still has live descendants: ${survivors.join(', ')}`)
    }
  }

  private refreshOwnership(): Promise<WindowsProcessRecord[]> {
    if (this.samplePromise) return this.samplePromise
    const sample = this.adapter.snapshot()
      .then((snapshot) => {
        let changed = true
        while (changed) {
          changed = false
          for (const processRecord of snapshot) {
            if (
              !this.ownedPids.has(processRecord.pid)
              && this.ownedPids.has(processRecord.parentPid)
            ) {
              this.ownedPids.add(processRecord.pid)
              changed = true
            }
          }
        }
        return snapshot
      })
      .finally(() => {
        if (this.samplePromise === sample) this.samplePromise = undefined
      })
    this.samplePromise = sample
    return sample
  }

  private stopSampling(): void {
    if (!this.sampleTimer) return
    clearInterval(this.sampleTimer)
    this.sampleTimer = undefined
  }
}

export function createWindowsProcessTreeOwner(rootPid: number): WindowsProcessTreeOwner {
  return new WindowsProcessTreeOwner({
    rootPid,
    adapter: {
      snapshot: queryWindowsProcesses,
      killTree: killWindowsProcessTree,
    },
  })
}

export async function createWindowsJobObjectOwner(): Promise<WindowsJobObjectOwner> {
  if (process.platform !== 'win32') {
    throw new Error('Windows Job Objects are only available on win32')
  }
  const koffi = await import('koffi')
  const kernel32 = koffi.load('kernel32.dll')
  const createJobObject = kernel32.func(
    '__stdcall',
    'CreateJobObjectW',
    'void *',
    ['void *', 'str16'],
  )
  const setInformationJobObject = kernel32.func(
    '__stdcall',
    'SetInformationJobObject',
    'bool',
    ['void *', 'int', 'void *', 'uint32'],
  )
  const openProcess = kernel32.func(
    '__stdcall',
    'OpenProcess',
    'void *',
    ['uint32', 'bool', 'uint32'],
  )
  const assignProcessToJobObject = kernel32.func(
    '__stdcall',
    'AssignProcessToJobObject',
    'bool',
    ['void *', 'void *'],
  )
  const terminateJobObject = kernel32.func(
    '__stdcall',
    'TerminateJobObject',
    'bool',
    ['void *', 'uint32'],
  )
  const closeHandle = kernel32.func(
    '__stdcall',
    'CloseHandle',
    'bool',
    ['void *'],
  )
  const getLastError = kernel32.func(
    '__stdcall',
    'GetLastError',
    'uint32',
    [],
  )
  const pointerSize = koffi.sizeof('void *')
  const informationSize = pointerSize === 8 ? 144 : 112

  const windowsError = (operation: string): Error =>
    new Error(`${operation} failed with Windows error ${getLastError()}`)

  return new WindowsJobObjectOwner({
    adapter: {
      createKillOnCloseJob() {
        const job = createJobObject(null, null)
        if (!job) throw windowsError('CreateJobObjectW')
        const information = Buffer.alloc(informationSize)
        // LimitFlags has a stable offset after the two LARGE_INTEGER fields.
        information.writeUInt32LE(JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE, 16)
        if (!setInformationJobObject(
          job,
          JOB_OBJECT_EXTENDED_LIMIT_INFORMATION,
          information,
          information.length,
        )) {
          const error = windowsError('SetInformationJobObject')
          closeHandle(job)
          throw error
        }
        return job
      },
      assignProcess(job, pid) {
        const processHandle = openProcess(
          PROCESS_TERMINATE | PROCESS_SET_QUOTA,
          false,
          pid,
        )
        if (!processHandle) throw windowsError(`OpenProcess(${pid})`)
        try {
          if (!assignProcessToJobObject(job, processHandle)) {
            throw windowsError(`AssignProcessToJobObject(${pid})`)
          }
        } finally {
          closeHandle(processHandle)
        }
      },
      terminateAndClose(job) {
        // TerminateJobObject makes normal stop deterministic. Closing the last
        // handle is the authoritative KILL_ON_JOB_CLOSE guarantee.
        terminateJobObject(job, 1)
        if (!closeHandle(job)) throw windowsError('CloseHandle(job)')
      },
    },
  })
}

async function queryWindowsProcesses(): Promise<WindowsProcessRecord[]> {
  const command = [
    'Get-CimInstance Win32_Process',
    '| Select-Object ProcessId,ParentProcessId',
    '| ConvertTo-Json -Compress',
  ].join(' ')
  const output = await runWindowsCommand('powershell.exe', [
    '-NoLogo',
    '-NoProfile',
    '-NonInteractive',
    '-Command',
    command,
  ], true)
  const normalizedOutput = output.trim().replace(/^\uFEFF/, '')
  if (!normalizedOutput) return []
  const parsed = JSON.parse(normalizedOutput) as
    | { ProcessId?: unknown; ParentProcessId?: unknown }
    | Array<{ ProcessId?: unknown; ParentProcessId?: unknown }>
  const records = Array.isArray(parsed) ? parsed : [parsed]
  return records.flatMap((record) => {
    const pid = Number(record.ProcessId)
    const parentPid = Number(record.ParentProcessId)
    return Number.isSafeInteger(pid) && pid > 0 && Number.isSafeInteger(parentPid)
      ? [{ pid, parentPid }]
      : []
  })
}

async function killWindowsProcessTree(pid: number): Promise<void> {
  await runWindowsCommand('taskkill', ['/pid', String(pid), '/T', '/F'], false)
}

function runWindowsCommand(
  command: string,
  args: string[],
  requireSuccess: boolean,
): Promise<string> {
  return new Promise((resolveCommand, rejectCommand) => {
    const child = spawn(command, args, {
      windowsHide: true,
      shell: false,
      stdio: ['ignore', 'pipe', 'ignore'],
    })
    const chunks: Buffer[] = []
    let bytes = 0
    let settled = false
    const finish = (error?: Error, output = '') => {
      if (settled) return
      settled = true
      clearTimeout(timeout)
      if (error) rejectCommand(error)
      else resolveCommand(output)
    }
    const timeout = setTimeout(() => {
      child.kill()
      finish(new Error(`${command} exceeded ${WINDOWS_COMMAND_TIMEOUT_MS}ms`))
    }, WINDOWS_COMMAND_TIMEOUT_MS)
    child.stdout?.on('data', (chunk: Buffer) => {
      bytes += chunk.length
      if (bytes <= WINDOWS_PROCESS_QUERY_LIMIT_BYTES) chunks.push(chunk)
    })
    child.once('error', error => finish(error))
    child.once('exit', (code) => {
      if (bytes > WINDOWS_PROCESS_QUERY_LIMIT_BYTES) {
        finish(new Error('Windows process snapshot exceeded its output limit'))
      } else if (requireSuccess && code !== 0) {
        finish(new Error(`${command} exited with code ${code ?? 'null'}`))
      } else {
        finish(undefined, Buffer.concat(chunks).toString('utf8'))
      }
    })
  })
}
