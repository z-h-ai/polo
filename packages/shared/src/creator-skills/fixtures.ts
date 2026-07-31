import type {
  CreatorSkillManifestEntry,
  SkillArchivePolicy,
  SkillVersionMetadata,
} from './types'

export const CREATOR_SKILL_FIXTURE_SLUG = 'review-helper'

export const CREATOR_SKILL_FIXTURE_CONTENT = `---
name: Review Helper
description: Reviews changes against a checklist.
icon: "🧭"
requiredSources:
  - github
alwaysAllow:
  - read
---

Review the selected change carefully.
`

export const CREATOR_SKILL_FIXTURE_METADATA: SkillVersionMetadata = {
  name: 'Review Helper',
  description: 'Reviews changes against a checklist.',
  icon: '🧭',
  requiredSources: ['github'],
  alwaysAllow: ['read'],
}

export const CREATOR_SKILL_FIXTURE_POLICY: SkillArchivePolicy = {
  version: 'fixture-1',
  maxArchiveBytes: 20 * 1024 * 1024,
  maxFileCount: 200,
  maxFileBytes: 5 * 1024 * 1024,
  maxExpandedBytes: 50 * 1024 * 1024,
}

export const CREATOR_SKILL_FIXTURE_MANIFEST: CreatorSkillManifestEntry[] = [{
  path: 'SKILL.md',
  size: new TextEncoder().encode(CREATOR_SKILL_FIXTURE_CONTENT).byteLength,
  sha256: '223c04758120adcd8cd619b9ec0b19ae3faaf3ddb57720f92a2be5101bae976f',
}]

export const CREATOR_SKILL_FIXTURE_CONTENT_DIGEST =
  'f9999556728593a5f0f5f3e22f89b1e86793ae5232f7e11e68324ef82927136c'
