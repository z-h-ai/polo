/**
 * Managed Skills Enablement
 *
 * Per-account, per-local-workspace enablement store for user-controlled
 * local skills (global / workspace / project tiers). Bundled app skills are
 * NOT part of this store — they are always available and the schema layer
 * refuses to persist any enablement for them (POO-106 S1, SM-18a/d).
 */

import { z } from 'zod'
import type { LoadedSkill, SkillSource } from './types.ts'

/** Persisted enablement for one skill slug within one account × workspace scope. */
export interface ManagedSkillEnablementEntry {
  /** Whether the skill participates in agent composition and discovery. */
  enabled: boolean
  /** User tier the entry was written for; never `bundled`. */
  source: Exclude<SkillSource, 'bundled'>
  /** ISO-8601 timestamp of the last write. */
  updatedAt: string
}

/**
 * The on-disk document for `<managedSkillsRoot>/<accountHash>/<workspaceHash>.json`.
 * `revision` is a monotonic optimistic-lock counter: every successful write
 * increments it by one and callers echo the revision they based their change on.
 */
export interface ManagedSkillEnablementDocument {
  schemaVersion: 1
  revision: number
  updatedAt: string
  /** Keyed by skill slug. */
  entries: Record<string, ManagedSkillEnablementEntry>
}

export function createEmptyManagedSkillEnablementDocument(): ManagedSkillEnablementDocument {
  return { schemaVersion: 1, revision: 0, updatedAt: new Date(0).toISOString(), entries: {} }
}

// ============================================================
// RPC contracts — `skills.listManaged` / `skills.setManagedEnablement`
// ============================================================

/**
 * Bundled skills are always available, so the enablement write contract only
 * accepts the user tiers. This is the schema-level half of the bundled refusal;
 * the handler re-checks the bundled root for defense in depth (SM-18d).
 */
export const ManagedSkillSourceSchema = z.enum(['global', 'workspace', 'project'])
export type ManagedSkillSource = z.infer<typeof ManagedSkillSourceSchema>

const skillSlug = z.string().min(1).max(255)

export const ListManagedSkillsRequestSchema = z.object({ workspaceId: z.string().min(1) }).strict()

export interface ManagedSkillStatus {
  slug: string
  source: SkillSource
  /** Current effective enablement. Bundled entries are always `true`. */
  enabled: boolean
  /**
   * True when the row may expose an inline enablement toggle: a non-managed
   * user-tier entry that does not shadow a bundled skill (SM-04r/18e/18g).
   */
  toggleable: boolean
  /** Canonical/creator-managed entry; enablement belongs to POO-63/76 (SM-18g). */
  managed: boolean
  /** A bundled skill exists under the same slug, so disabling is refused (K1). */
  shadowedBuiltin: boolean
  /**
   * Why the entry is unavailable, separate from the enablement state. Reserved:
   * S1 inventories only successfully loaded skills, so this stays undefined.
   */
  unavailableReason?: string
}

export const ManagedSkillStatusSchema = z.object({
  slug: skillSlug,
  source: z.enum(['bundled', 'global', 'workspace', 'project']),
  enabled: z.boolean(),
  toggleable: z.boolean(),
  managed: z.boolean(),
  shadowedBuiltin: z.boolean(),
  unavailableReason: z.string().min(1).optional(),
}).strict()

export const ListManagedSkillsResponseSchema = z.object({
  ok: z.literal(true),
  workspaceId: z.string().min(1),
  /** Optimistic-lock revision of the underlying enablement document. */
  revision: z.number().int().nonnegative(),
  items: z.array(ManagedSkillStatusSchema),
}).strict()

export const SetManagedSkillEnablementRequestSchema = z.object({
  workspaceId: z.string().min(1),
  slug: skillSlug,
  source: ManagedSkillSourceSchema,
  enabled: z.boolean(),
  /** Reject the write when the stored document no longer sits at this revision. */
  expectedRevision: z.number().int().nonnegative().optional(),
}).strict()

export const SetManagedSkillEnablementResponseSchema = z.object({
  ok: z.literal(true),
  slug: skillSlug,
  enabled: z.boolean(),
  revision: z.number().int().nonnegative(),
}).strict()

export type ListManagedSkillsRequest = z.infer<typeof ListManagedSkillsRequestSchema>
export type ListManagedSkillsResponse = z.infer<typeof ListManagedSkillsResponseSchema>
export type SetManagedSkillEnablementRequest = z.infer<typeof SetManagedSkillEnablementRequestSchema>
export type SetManagedSkillEnablementResponse = z.infer<typeof SetManagedSkillEnablementResponseSchema>

/** Refusal reasons mirrored to the UI; `revision_conflict` is retryable by re-reading. */
export const MANAGED_SKILL_ENABLEMENT_ERROR_CODES = [
  'VALIDATION_ERROR',
  'workspace_context_mismatch',
  'OFFLINE_READ_ONLY',
  'bundled_skill_not_disableable',
  'managed_skill_not_toggleable',
  'shadowed_builtin_not_toggleable',
  'revision_conflict',
  'skill_not_found',
] as const
export type ManagedSkillEnablementErrorCode = (typeof MANAGED_SKILL_ENABLEMENT_ERROR_CODES)[number]

export function managedSkillEnablementError(
  errorCode: ManagedSkillEnablementErrorCode,
  extras: { revision?: number } = {},
): { ok: false; errorCode: ManagedSkillEnablementErrorCode; revision?: number } {
  return { ok: false, errorCode, ...(extras.revision !== undefined ? { revision: extras.revision } : {}) }
}

// ============================================================
// Toggle-eligibility rules (shared by server inventory and UI)
// ============================================================

/**
 * SM-18g (K2): canonical / creator-managed entries never expose a local
 * enablement toggle; their lifecycle belongs to POO-63/76.
 */
export function isCanonicalManagedSkill(skill: Pick<LoadedSkill, 'slug' | 'canonicalInstallation' | 'creatorInstallation'>): boolean {
  return Boolean(skill.canonicalInstallation)
    || Boolean(skill.creatorInstallation)
    || skill.slug.startsWith('canonical-')
}

/**
 * The single toggle-eligibility rule: only non-managed user-tier entries
 * participate in local enablement. Bundled is excluded by the type system
 * (`source !== 'bundled'`) — it is always available (SM-04r/18a/18d).
 */
export function isLocalEnablementTarget(
  skill: Pick<LoadedSkill, 'slug' | 'source' | 'canonicalInstallation' | 'creatorInstallation'>,
): boolean {
  return skill.source !== 'bundled' && !isCanonicalManagedSkill(skill)
}
