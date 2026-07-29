import { describe, expect, it } from 'bun:test'
import {
  WindowsJobObjectOwner,
  WindowsProcessTreeOwner,
  type WindowsJobObjectAdapter,
  type WindowsProcessRecord,
  type WindowsProcessTreeAdapter,
} from '../process-tree'

describe('WindowsProcessTreeOwner', () => {
  it('discovers and kills descendants even after the managed root has exited', async () => {
    const killed = new Set<number>()
    const processes: WindowsProcessRecord[] = [
      // Root PID 100 is intentionally absent: it already crashed.
      { pid: 101, parentPid: 100 },
      { pid: 102, parentPid: 101 },
      { pid: 900, parentPid: 1 },
    ]
    const adapter: WindowsProcessTreeAdapter = {
      snapshot: async () => processes.filter(record => !killed.has(record.pid)),
      killTree: async (pid) => {
        killed.add(pid)
      },
    }
    const owner = new WindowsProcessTreeOwner({
      rootPid: 100,
      adapter,
      sampleIntervalMs: 0,
    })

    await owner.terminate()

    expect([...killed].sort()).toEqual([101, 102])
    expect(killed.has(900)).toBe(false)
  })

  it('shares one termination operation across concurrent cleanup callers', async () => {
    let snapshots = 0
    const adapter: WindowsProcessTreeAdapter = {
      snapshot: async () => {
        snapshots += 1
        return []
      },
      killTree: async () => {},
    }
    const owner = new WindowsProcessTreeOwner({
      rootPid: 200,
      adapter,
      sampleIntervalMs: 0,
    })

    await Promise.all([owner.terminate(), owner.terminate()])
    expect(snapshots).toBe(1)
  })
})

describe('WindowsJobObjectOwner', () => {
  it('kills an inherited daemon after both root and intermediary have disappeared', async () => {
    const members = new Set<number>()
    const live = new Set([100, 101, 102, 900])
    const killed = new Set<number>()
    const adapter: WindowsJobObjectAdapter = {
      createKillOnCloseJob: () => ({ id: 'job' }),
      assignProcess: (_job, pid) => {
        members.add(pid)
      },
      terminateAndClose: () => {
        for (const pid of members) {
          if (live.has(pid)) killed.add(pid)
        }
      },
    }
    const spawnInheritingJob = (pid: number, parentPid: number) => {
      if (members.has(parentPid)) members.add(pid)
    }
    const owner = new WindowsJobObjectOwner({ adapter })
    owner.assignProcess(100)
    spawnInheritingJob(101, 100)
    spawnInheritingJob(102, 101)
    live.delete(100)
    live.delete(101)

    await owner.terminate()

    expect([...killed]).toEqual([102])
    expect(killed.has(900)).toBe(false)
  })

  it('shares one job close across concurrent cleanup callers', async () => {
    let closes = 0
    const owner = new WindowsJobObjectOwner({
      adapter: {
        createKillOnCloseJob: () => ({}),
        assignProcess: () => {},
        terminateAndClose: () => {
          closes += 1
        },
      },
    })

    await Promise.all([owner.terminate(), owner.terminate()])
    expect(closes).toBe(1)
  })
})
