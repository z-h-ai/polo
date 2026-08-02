import { describe, expect, it } from 'bun:test'
import {
  CREATOR_SKILL_SAFETY_INTERVAL_MS,
  CreatorSkillSafetyScheduler,
} from '../creator-skill-safety-scheduler'

async function flushPromises(): Promise<void> {
  await Promise.resolve()
  await Promise.resolve()
  await Promise.resolve()
  await Promise.resolve()
}

class FakeClock {
  nowValue = 1_000_000
  nextId = 1
  timers = new Map<number, { at: number; callback: () => void }>()

  readonly now = () => this.nowValue
  readonly setTimeout = (callback: () => void, delay: number) => {
    const id = this.nextId++
    this.timers.set(id, { at: this.nowValue + delay, callback })
    return id as unknown as ReturnType<typeof setTimeout>
  }
  readonly clearTimeout = (timer: ReturnType<typeof setTimeout>) => {
    this.timers.delete(timer as unknown as number)
  }

  advance(milliseconds: number): void {
    this.nowValue += milliseconds
    while (true) {
      const next = [...this.timers.entries()]
        .filter(([, timer]) => timer.at <= this.nowValue)
        .sort((left, right) => left[1].at - right[1].at)[0]
      if (!next) return
      this.timers.delete(next[0])
      next[1].callback()
    }
  }
}

describe('CreatorSkillSafetyScheduler', () => {
  it('rechecks every 24 hours without requiring an item-list update', async () => {
    const clock = new FakeClock()
    const scheduler = new CreatorSkillSafetyScheduler(clock)
    let checks = 0
    scheduler.update([{ key: 'skill', lastCheckedAt: undefined }], async () => {
      checks += 1
      return true
    })

    clock.advance(0)
    await flushPromises()
    expect(checks).toBe(1)

    clock.advance(CREATOR_SKILL_SAFETY_INTERVAL_MS)
    await flushPromises()
    expect(checks).toBe(2)
    scheduler.dispose()
  })

  it('deduplicates an in-flight request across item updates', async () => {
    const clock = new FakeClock()
    const scheduler = new CreatorSkillSafetyScheduler(clock)
    let checks = 0
    let finish!: (success: boolean) => void
    const pending = new Promise<boolean>(resolve => {
      finish = resolve
    })
    const item = { key: 'skill', lastCheckedAt: undefined }
    scheduler.update([item], async () => {
      checks += 1
      return pending
    })
    clock.advance(0)
    scheduler.update([item], async () => {
      checks += 1
      return true
    })
    clock.advance(0)
    expect(checks).toBe(1)

    finish(true)
    await pending
    await Promise.resolve()
    expect(checks).toBe(1)
    scheduler.dispose()
  })

  it('clears its pending timer when disposed', () => {
    const clock = new FakeClock()
    const scheduler = new CreatorSkillSafetyScheduler(clock)
    let checks = 0
    scheduler.update([{
      key: 'skill',
      lastCheckedAt: new Date(clock.nowValue).toISOString(),
    }], async () => {
      checks += 1
      return true
    })
    expect(clock.timers.size).toBe(1)

    scheduler.dispose()
    clock.advance(CREATOR_SKILL_SAFETY_INTERVAL_MS)
    expect(clock.timers.size).toBe(0)
    expect(checks).toBe(0)
  })
})
