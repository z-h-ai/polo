/**
 * Skills Module
 *
 * Workspace skills are specialized instructions that extend Claude's capabilities.
 */

export * from './types.ts';
export {
  MANAGED_SKILL_ENABLEMENT_ERROR_CODES,
  ManagedSkillSourceSchema,
  ListManagedSkillsRequestSchema,
  ListManagedSkillsResponseSchema,
  SetManagedSkillEnablementRequestSchema,
  SetManagedSkillEnablementResponseSchema,
  createEmptyManagedSkillEnablementDocument,
  isCanonicalManagedSkill,
  isLocalEnablementTarget,
  managedSkillEnablementError,
} from './managed.ts';
export type {
  ListManagedSkillsRequest,
  ListManagedSkillsResponse,
  ManagedSkillEnablementDocument,
  ManagedSkillEnablementEntry,
  ManagedSkillEnablementErrorCode,
  ManagedSkillSource,
  ManagedSkillStatus,
  SetManagedSkillEnablementRequest,
  SetManagedSkillEnablementResponse,
} from './managed.ts';
export { BUNDLED_SKILLS_ASSET_DIRNAME, getBundledSkillsRoot } from './bundled.ts';
export {
  GLOBAL_AGENT_SKILLS_DIR,
  PROJECT_AGENT_SKILLS_DIR,
  loadSkill,
  loadAllSkills,
  invalidateSkillsCache,
  loadSkillBySlug,
  loadBundledSkills,
  loadBundledSkill,
  loadEffectiveBundledSkills,
  getSkillIconPath,
  deleteSkill,
  skillExists,
  listSkillSlugs,
  skillNeedsIconDownload,
  downloadSkillIcon,
} from './storage.ts';
