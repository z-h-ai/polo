import type {
  CreatorSkillManifestEntry,
  SkillArchivePolicy,
  SkillVersionMetadata,
} from './types.ts'

export const CREATOR_SKILL_FIXTURE_SLUG = 'review-helper'

export const CREATOR_SKILL_FIXTURE_CONTENT = `---
name: review-helper
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
  name: 'review-helper',
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
  sha256: 'a063d3f9bd112e6e1d816cb2c771ccf9fb8602b942e8e82a173af9c5001c91b9',
}]

export const CREATOR_SKILL_FIXTURE_CONTENT_DIGEST =
  'b5326fb33894331f09a1b0e80650435c8c2cd70ba45b691cf513ba9de5f9da80'
