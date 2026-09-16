export const CREATOR_SKILL_SAFETY_INTERVAL_MS = 24 * 60 * 60 * 1_000
export const CREATOR_SKILL_SAFETY_RETRY_MS = 5 * 60 * 1_000

export interface CreatorSkillSafetyScheduleItem {
  key: string
  lastCheckedAt?: string
}

interface CreatorSkillSafetySchedulerClock {
  now: () => number
  setTimeout: (callback: () => void, delay: number) => ReturnType<typeof setTimeout>
  clearTimeout: (timer: ReturnType<typeof setTimeout>) => void
}

const systemClock: CreatorSkillSafetySchedulerClock = {
  now: () => Date.now(),
  setTimeout: (callback, delay) => setTimeout(callback, delay),
  clearTimeout: timer => clearTimeout(timer),
}

function parsedCheckTime(value?: string): number {
  if (!value) return 0
  const parsed = Date.parse(value)
  return Number.isFinite(parsed) ? parsed : 0
}

/**
 * Keeps Creator Skill safety checks running while a workspace stays open.
 * Updates may replace the item list without losing the in-flight de-duplication
 * state, and dispose() prevents timers from surviving component unmount.
 */
export class CreatorSkillSafetyScheduler<T extends CreatorSkillSafetyScheduleItem> {
  private readonly inFlight = new Set<string>()
  private readonly nextAttemptAt = new Map<string, number>()
  private items = new Map<string, T>()
  private check: ((item: T) => Promise<boolean>) | null = null
  private timer: ReturnType<typeof setTimeout> | null = null
  private disposed = false

  constructor(
    private readonly clock: CreatorSkillSafetySchedulerClock = systemClock,
  ) {}

  update(items: T[], check: (item: T) => Promise<boolean>): void {
    // React development Strict Mode replays effect setup after cleanup while
    // preserving refs, so an update intentionally revives the same scheduler.
    this.disposed = false
    this.items = new Map(items.map(item => [item.key, item]))
    this.check = check
    for (const key of this.nextAttemptAt.keys()) {
      if (!this.items.has(key) && !this.inFlight.has(key)) {
        this.nextAttemptAt.delete(key)
      }
    }
    this.schedule()
  }

  dispose(): void {
    this.disposed = true
    this.items.clear()
    this.check = null
    if (this.timer !== null) {
      this.clock.clearTimeout(this.timer)
      this.timer = null
    }
  }

  private dueAt(item: T): number {
    const checkedAt = parsedCheckTime(item.lastCheckedAt)
    return Math.max(
      checkedAt > 0 ? checkedAt + CREATOR_SKILL_SAFETY_INTERVAL_MS : 0,
      this.nextAttemptAt.get(item.key) ?? 0,
    )
  }

  private schedule(): void {
    if (this.disposed || !this.check) return
    if (this.timer !== null) {
      this.clock.clearTimeout(this.timer)
      this.timer = null
    }

    let nextDueAt = Number.POSITIVE_INFINITY
    for (const item of this.items.values()) {
      if (this.inFlight.has(item.key)) continue
      nextDueAt = Math.min(nextDueAt, this.dueAt(item))
    }
    if (!Number.isFinite(nextDueAt)) return

    const delay = Math.max(0, Math.min(2_147_483_647, nextDueAt - this.clock.now()))
    this.timer = this.clock.setTimeout(() => {
      this.timer = null
      this.runDueChecks()
    }, delay)
  }

  private runDueChecks(): void {
    if (this.disposed || !this.check) return
    const now = this.clock.now()
    const check = this.check

    for (const item of this.items.values()) {
      if (this.inFlight.has(item.key) || this.dueAt(item) > now) continue
      this.inFlight.add(item.key)
      // Establish the normal next-check cadence before launching the request so
      // concurrent update() calls cannot start a duplicate request.
      this.nextAttemptAt.set(item.key, now + CREATOR_SKILL_SAFETY_INTERVAL_MS)
      void check(item).then(success => {
        if (!success) {
          this.nextAttemptAt.set(
            item.key,
            this.clock.now() + CREATOR_SKILL_SAFETY_RETRY_MS,
          )
        }
      }).catch(() => {
        this.nextAttemptAt.set(
          item.key,
          this.clock.now() + CREATOR_SKILL_SAFETY_RETRY_MS,
        )
      }).finally(() => {
        this.inFlight.delete(item.key)
        if (!this.items.has(item.key)) {
          this.nextAttemptAt.delete(item.key)
        }
        this.schedule()
      })
    }
    this.schedule()
  }
}
