/**
 * POO-196 R3 (consensus P3/D6) — the home "项目" directory device state.
 *
 * One record is a SUCCESSFUL entry into a project on THIS device (P3: 只记
 * 成功进入 — the write happens only after the switch transaction committed
 * and the target scope was actually entered, D13 step 7; B4b/project-entry
 * owns that call site). The records drive ONLY the home card ordering —
 * never an authorization, membership or activity fact, and nothing here
 * fabricates server-side activity.
 *
 * Records are keyed per ACCOUNT (P3 按账号隔离): an account switch can never
 * leak one account's ordering into another's. Persistence is the renderer's
 * localStorage, best-effort and bounded; a corrupted or unavailable store
 * fails closed to an empty record set and the sort degrades to the stable
 * name fallback. The D6 r3 list negotiation will eventually feed the卡片
 * collection itself — this module intentionally knows nothing about it.
 */

export interface ProjectVisitRecord {
  productSpaceId: string
  /** Epoch ms of the last committed entry on this device. */
  lastEnteredAt: number
}

const PROJECT_VISIT_STORAGE_PREFIX = 'poo196.projects:visit-order:'
const PROJECT_VISIT_MAX_ENTRIES = 200
const projectVisitsByAccount = new Map<string, Map<string, number>>()

function storageKey(accountId: string): string {
  return PROJECT_VISIT_STORAGE_PREFIX + accountId
}

function loadVisits(accountId: string): Map<string, number> {
  const cached = projectVisitsByAccount.get(accountId)
  if (cached) return cached
  const records = new Map<string, number>()
  try {
    const raw = window.localStorage.getItem(storageKey(accountId))
    if (raw) {
      const parsed: unknown = JSON.parse(raw)
      if (parsed && typeof parsed === 'object') {
        for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
          if (!key) continue
          if (typeof value === 'number' && Number.isFinite(value) && value >= 0) {
            records.set(key, value)
          }
        }
      }
    }
  } catch {
    // Fail closed to an empty record set — never block the directory.
  }
  projectVisitsByAccount.set(accountId, records)
  return records
}

function persistVisits(accountId: string, records: Map<string, number>): void {
  try {
    // Bound the record set: evict the OLDEST entry first.
    while (records.size > PROJECT_VISIT_MAX_ENTRIES) {
      let oldestKey: string | null = null
      let oldestAt = Infinity
      for (const [key, at] of records) {
        if (at < oldestAt) {
          oldestAt = at
          oldestKey = key
        }
      }
      if (oldestKey === null) break
      records.delete(oldestKey)
    }
    const payload: Record<string, number> = {}
    for (const [key, at] of records) payload[key] = at
    window.localStorage.setItem(storageKey(accountId), JSON.stringify(payload))
  } catch {
    // Persistence is best-effort: the in-memory records keep the session order.
  }
}

/**
 * Records one committed entry into `productSpaceId` for `accountId`.
 * Device-local sort preference only — callers must invoke this ONLY after the
 * project was actually entered (a failed entry must not reorder the cards).
 */
export function recordProjectVisit(accountId: string, productSpaceId: string, now = Date.now()): void {
  if (!accountId || !productSpaceId) return
  const records = loadVisits(accountId)
  records.set(productSpaceId, Math.max(now, 0))
  persistVisits(accountId, records)
}

/**
 * The account's visit records, most recent first. Equal timestamps order by
 * stable productSpaceId (code point ascending) so a same-tick double entry
 * still produces a deterministic order.
 */
export function readProjectVisitOrder(accountId: string): ProjectVisitRecord[] {
  if (!accountId) return []
  return [...loadVisits(accountId).entries()]
    .map(([productSpaceId, lastEnteredAt]) => ({ productSpaceId, lastEnteredAt }))
    .sort((left, right) =>
      right.lastEnteredAt - left.lastEnteredAt
      || (left.productSpaceId < right.productSpaceId ? -1 : left.productSpaceId > right.productSpaceId ? 1 : 0))
}

/** Test-only: drop every per-account visit record. */
// ── P12-5 purpose cache ──────────────────────────────────────────────────────
// The D6 r3 negotiation carries each project's introduction (Enterprise
// purpose). HomePage caches what it fetched here so the session-creation
// path (App.handleCreateSession → projectContext) can attach the SAME
// authoritative projection without a second request. Best-effort memory
// only: a cold renderer simply omits the optional introduction — the title
// always rides the space summary.

const projectPurposesByAccount = new Map<string, Map<string, string>>()

/** Cache fetched purposes per account (called with the r3 directory payload). */
export function rememberProjectPurposes(accountId: string, entries: ReadonlyArray<{ id: string; purpose?: string }>): void {
  let map = projectPurposesByAccount.get(accountId)
  if (!map) {
    map = new Map()
    projectPurposesByAccount.set(accountId, map)
  }
  for (const entry of entries) {
    if (typeof entry.purpose === 'string' && entry.purpose.length > 0) {
      map.set(entry.id, entry.purpose)
    }
  }
}

/** The cached introduction for one project, or undefined when unknown. */
export function readProjectPurpose(accountId: string, productSpaceId: string): string | undefined {
  return projectPurposesByAccount.get(accountId)?.get(productSpaceId)
}

export function __resetProjectVisitsForTests(): void {
  projectPurposesByAccount.clear()
  projectVisitsByAccount.clear()
}

/**
 * The P3 home directory order: visited projects first by recency (stable id
 * breaks ties), then never-visited projects by the CURRENT locale's name
 * comparison, then by id. Pure — no localStorage access, no i18next call —
 * so the HomePage grid stays a deterministic function of its inputs.
 */
export function sortProjectDirectory<T extends { id: string; name: string }>(
  entries: readonly T[],
  visits: readonly ProjectVisitRecord[],
  locale?: string,
): T[] {
  const enteredAt = new Map<string, number>()
  for (const visit of visits) enteredAt.set(visit.productSpaceId, visit.lastEnteredAt)
  let collator: Intl.Collator | null = null
  try {
    collator = new Intl.Collator(locale)
  } catch {
    collator = null
  }
  const compareNames = (left: T, right: T): number => {
    const byName = collator
      ? collator.compare(left.name, right.name)
      : left.name.localeCompare(right.name)
    return byName || (left.id < right.id ? -1 : left.id > right.id ? 1 : 0)
  }
  return [...entries].sort((left, right) => {
    const leftAt = enteredAt.get(left.id)
    const rightAt = enteredAt.get(right.id)
    if (leftAt !== undefined && rightAt !== undefined) {
      return rightAt - leftAt || (left.id < right.id ? -1 : left.id > right.id ? 1 : 0)
    }
    if (leftAt !== undefined) return -1
    if (rightAt !== undefined) return 1
    return compareNames(left, right)
  })
}
