// packages/shared/src/creator-skills/fixtures.ts
var CREATOR_SKILL_FIXTURE_SLUG = "review-helper";
var CREATOR_SKILL_FIXTURE_CONTENT = `---
name: Review Helper
description: Reviews changes against a checklist.
icon: "\u{1F9ED}"
requiredSources:
  - github
alwaysAllow:
  - read
---

Review the selected change carefully.
`;
var CREATOR_SKILL_FIXTURE_METADATA = {
  name: "Review Helper",
  description: "Reviews changes against a checklist.",
  icon: "\u{1F9ED}",
  requiredSources: ["github"],
  alwaysAllow: ["read"]
};
var CREATOR_SKILL_FIXTURE_POLICY = {
  version: "fixture-1",
  maxArchiveBytes: 20 * 1024 * 1024,
  maxFileCount: 200,
  maxFileBytes: 5 * 1024 * 1024,
  maxExpandedBytes: 50 * 1024 * 1024
};
var CREATOR_SKILL_FIXTURE_MANIFEST = [{
  path: "SKILL.md",
  size: new TextEncoder().encode(CREATOR_SKILL_FIXTURE_CONTENT).byteLength,
  sha256: "223c04758120adcd8cd619b9ec0b19ae3faaf3ddb57720f92a2be5101bae976f"
}];
var CREATOR_SKILL_FIXTURE_CONTENT_DIGEST = "f9999556728593a5f0f5f3e22f89b1e86793ae5232f7e11e68324ef82927136c";
export {
  CREATOR_SKILL_FIXTURE_CONTENT,
  CREATOR_SKILL_FIXTURE_CONTENT_DIGEST,
  CREATOR_SKILL_FIXTURE_MANIFEST,
  CREATOR_SKILL_FIXTURE_METADATA,
  CREATOR_SKILL_FIXTURE_POLICY,
  CREATOR_SKILL_FIXTURE_SLUG
};
