/**
 * Circle-side data shapes (POO-70 M07, ws-circles-account).
 *
 * `CircleSourcedApp` is the cross-workflow contract agreed with ws-home-apps:
 * the catalog/home side dedupes by `appId` and renders one entry per app with
 * its source lines; this module only supplies the circle-side data and the
 * source-fallback presentation (D-PC-09).
 */

/** One authorization source of a work (app/skill) coming from a circle. */
export interface CircleWorkSource {
  circleId: string
  circleName: string
  creator: string
  /** False once the user left the circle or its subscription expired. */
  valid: boolean
}

/**
 * A work authorized by one or more circles. Same `appId` from two circles is
 * a single entry with two sources — revoking one source keeps the entry.
 */
export interface CircleSourcedApp {
  appId: string
  name: string
  iconUrl?: string
  sources: CircleWorkSource[]
}

/** How the user relates to a circle right now. */
export type CircleMembershipState =
  | 'active'          // joined (free or paid & unexpired)
  | 'pendingApproval' // join request submitted, awaiting approval
  | 'expired'         // paid membership past its expiry date
  | 'left'            // user left the circle

/** Subscription terms of a paid circle. */
export interface CircleSubscription {
  /** Display price including the period, e.g. "¥39 / 月". */
  price: string
  /** ISO date (yyyy-MM-dd) the current term ends on. */
  expiresAt: string
}

/** A circle as shown in the 「我的圈子」 list. */
export interface CircleSummary {
  id: string
  name: string
  creator: string
  membership: CircleMembershipState
  /** Omitted for free circles. */
  subscription?: CircleSubscription
  /** Free-text update line under the title (e.g. 本周新增打法案例 2 篇). */
  updateNote?: string
  appCount: number
  skillCount: number
}

/** Availability of one work row inside a circle detail page. */
export type CircleWorkAvailability =
  | 'usable'          // 可使用
  | 'installable'     // 可安装（skill not installed yet）
  | 'unavailable'     // 不可用（only this circle provided it and the user left）
  | 'expired'         // 已到期（only this circle provided it and its subscription expired）
  | 'stillAuthorized' // 仍由其他圈授权（this source invalid, another valid）

/** A work row of the circle detail page (app or skill). */
export interface CircleWorkRow {
  id: string
  kind: 'app' | 'skill'
  name: string
  description?: string
  /** Version label of this circle's copy, e.g. "v1.4.0". */
  version?: string
  /** Source line shown under the name. */
  source: CircleWorkSource
  /** All source names when the same work comes from several circles. */
  sourceNames?: string[]
  /** Whether this skill is installed on this machine (apps: irrelevant). */
  installed?: boolean
  /** Extra line for shared works, e.g. 仍由晨星增长圈授权. */
  fallbackNote?: {
    kind: 'other-source' | 'install-note' | 'expired-source'
    circleName?: string
  }
  availability: CircleWorkAvailability
}

/** Appraises the works of one circle against the sourced-apps data. */
export interface CircleWorksInput {
  /**
   * The circle these rows belong to. Membership/subscription drive the
   * invalid-source reason: an expired paid circle renders its only-here
   * apps as 'expired' (已到期 + 续费恢复), a left one as 'unavailable'.
   */
  circle: Pick<CircleSummary, 'id' | 'name'> &
    Partial<Pick<CircleSummary, 'membership' | 'subscription'>>
  apps: CircleSourcedApp[]
  skills: CircleSourcedApp[]
  /** Skill ids already installed on this machine. */
  installedSkillIds?: string[]
  /** ISO date used to evaluate paid expiry (defaults to "today" at render). */
  now?: string
}
