/**
 * POO-70 HiFi (WS-ASSISTANT-SKILLS) — skill manager domain model.
 *
 * The 67 M06 prototype screens are "few pages × state combinations": the
 * `-100-0-1` style scene suffixes encode version | enabled | builtin bits
 * (see `prototype.html` `data-skill-state`, e.g. `1.0.0|0|1`). Components in
 * this folder are page-level surfaces driven by the `ManagedSkill` /
 * `DiscoverableSkill` props below; the suffix matrix is decoded by
 * `decodeSkillSceneBits` so demos and tests can sample scene combos directly.
 */

import type { LoadedSkill } from '../../../../shared/types'

/** Where a skill copy on this Mac came from. */
export type SkillOriginKind = 'builtin' | 'org' | 'circle' | 'personal'

/** Which space the manager is rendered in (decides the discover channel). */
export type SkillSpaceKind = 'personal' | 'enterprise'

/**
 * State bits decoded from the prototype scene matrix.
 * - version: installed version, or `none` (not installed) / `revoked`
 *   (last source invalidated)
 * - enabled: the user explicitly enabled the local copy
 * - builtin: the built-in "资料研究" skill row is available in this space
 */
export interface SkillSceneBits {
  version: 'none' | 'revoked' | string
  enabled: boolean
  builtin: boolean
}

/**
 * Decode a scene suffix like `100-0-1` / `110-1-0` / `none` / `revoked`
 * into the state bits the UI renders. `100` maps to `1.0.0`, `110` to
 * `1.1.0` (digits 1-2 = minor, digit 3 = patch).
 */
export function decodeSkillSceneBits(suffix: string): SkillSceneBits {
  if (suffix === 'none') return { version: 'none', enabled: false, builtin: true }
  if (suffix === 'revoked') return { version: 'revoked', enabled: false, builtin: true }
  const parts = suffix.split('-')
  if (parts.length !== 3 || !/^\d{3}$/.test(parts[0])) {
    throw new Error(`invalid skill scene suffix: ${suffix}`)
  }
  const [digits, enabled, builtin] = parts
  const version = `${digits[0]}.${digits[1]}.${digits[2]}`
  return { version, enabled: enabled === '1', builtin: builtin === '1' }
}

/** Coarse row state driving the badge + actions of a local skill row. */
export type LocalSkillRowState =
  | 'enabled'
  | 'disabled'
  | 'update-available'
  | 'restricted'

/**
 * A skill copy managed on this Mac (the right-hand list of the 本机 tab).
 * `skill` keeps the raw `LoadedSkill` so existing data hooks and the info
 * page stay compatible.
 */
export interface ManagedSkill {
  slug: string
  name: string
  description: string
  origin: SkillOriginKind
  /** Human-readable source line, e.g. "Polo 内置 · 随客户端更新". */
  originLabel: string
  /** Optional provider attribution, e.g. "晨星科技 · 林晓共享". */
  provider?: string
  /** Installed local version, when this row is an installed copy. */
  installedVersion?: string
  /** Newer version available from the source. */
  availableVersion?: string
  enabled: boolean
  /** Last source / authorization invalidated: copy kept, disabled. */
  restricted: boolean
  /** Why authorization failed (surfaced by 查看原因). */
  restrictedReason?: string
  /** Raw skill payload for icons / info-page navigation. */
  skill?: LoadedSkill
}

/** A skill listed on the 获取 tab (org shared library or circles). */
export interface DiscoverableSkill {
  slug: string
  name: string
  description: string
  provider: string
  version: string
  /** Glyph shown in the tile when no real icon is available. */
  glyph?: string
  /** Creator artifact id, when the entry came from the org shared library. */
  artifactId?: string
  /** Wiring for the real install channel (creator grant + install). */
  installSource?: {
    organizationId: string
    artifactId: string
  }
  /** Local copy state, when something is already installed. */
  installed?: {
    version: string
    enabled: boolean
    restricted: boolean
    updateVersion?: string
  }
}

/** Install sheet state (P-M06-INSTALL-* / P-M06-INSTALL-FAILED). */
export type SkillInstallPhase = 'review' | 'installing' | 'failed'

/** Detail sheet view (P-M06-DETAIL-* / P-M06-REMOVE-*). */
export type SkillDetailMode = 'manage' | 'confirm-uninstall' | 'confirm-uninstall-restricted'

/** Coarse row state for the badge on a discover row. */
export type DiscoverRowState = 'installable' | 'update-available' | 'installed' | 'restricted'

/** Row state for a managed local skill (restricted wins over the rest). */
export function localSkillRowState(skill: ManagedSkill): LocalSkillRowState {
  if (skill.restricted) return 'restricted'
  if (skill.availableVersion && skill.availableVersion !== skill.installedVersion) {
    return 'update-available'
  }
  return skill.enabled ? 'enabled' : 'disabled'
}

/** Row state for a discover entry, taking any installed copy into account. */
export function discoverRowState(entry: DiscoverableSkill): DiscoverRowState {
  const installed = entry.installed
  if (!installed) return 'installable'
  if (installed.restricted) return 'restricted'
  if (installed.updateVersion && installed.updateVersion !== installed.version) {
    return 'update-available'
  }
  return 'installed'
}

/**
 * Adapt a `LoadedSkill` from the existing data hooks into the managed-row
 * model. Local skills (global / workspace / project) are on by default —
 * they were already active before the manager existed. Distributed
 * (creator-installed) skills default to disabled per the R6 rule that an
 * install never auto-enables. A revoked/archived source keeps the copy,
 * forces disabled, and marks the row restricted.
 */
export function managedSkillFromLoaded(
  skill: LoadedSkill,
  overrides: Partial<ManagedSkill> = {},
): ManagedSkill {
  const installation = skill.creatorInstallation
  const restricted =
    installation?.lastKnownStatus === 'revoked'
    || installation?.lastKnownStatus === 'archived'
  const origin: SkillOriginKind = installation
    ? 'org'
    : skill.source === 'global'
      ? 'builtin'
      : 'personal'
  return {
    slug: skill.slug,
    name: skill.metadata.name,
    description: skill.metadata.description ?? '',
    origin,
    originLabel: skill.source,
    installedVersion: installation?.version,
    enabled: !installation && !restricted,
    restricted,
    restrictedReason: installation?.lastKnownStatus,
    skill,
    ...overrides,
  }
}

/**
 * Whether a managed row can actually be uninstalled through a real
 * channel: only workspace-local copies (which is where creator-installed
 * skills land) have one. Built-in/client skills and project-managed skills
 * are not removable from this machine, and rows without a backing
 * LoadedSkill (demo data) cannot execute anything.
 */
export function canUninstallManagedSkill(skill: ManagedSkill): boolean {
  return skill.skill?.source === 'workspace'
}
