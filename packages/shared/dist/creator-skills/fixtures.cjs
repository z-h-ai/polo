"use strict";
var __defProp = Object.defineProperty;
var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __hasOwnProp = Object.prototype.hasOwnProperty;
var __export = (target, all) => {
  for (var name in all)
    __defProp(target, name, { get: all[name], enumerable: true });
};
var __copyProps = (to, from, except, desc) => {
  if (from && typeof from === "object" || typeof from === "function") {
    for (let key of __getOwnPropNames(from))
      if (!__hasOwnProp.call(to, key) && key !== except)
        __defProp(to, key, { get: () => from[key], enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable });
  }
  return to;
};
var __toCommonJS = (mod) => __copyProps(__defProp({}, "__esModule", { value: true }), mod);

// src/creator-skills/fixtures.ts
var fixtures_exports = {};
__export(fixtures_exports, {
  CREATOR_SKILL_FIXTURE_CONTENT: () => CREATOR_SKILL_FIXTURE_CONTENT,
  CREATOR_SKILL_FIXTURE_CONTENT_DIGEST: () => CREATOR_SKILL_FIXTURE_CONTENT_DIGEST,
  CREATOR_SKILL_FIXTURE_MANIFEST: () => CREATOR_SKILL_FIXTURE_MANIFEST,
  CREATOR_SKILL_FIXTURE_METADATA: () => CREATOR_SKILL_FIXTURE_METADATA,
  CREATOR_SKILL_FIXTURE_POLICY: () => CREATOR_SKILL_FIXTURE_POLICY,
  CREATOR_SKILL_FIXTURE_SLUG: () => CREATOR_SKILL_FIXTURE_SLUG
});
module.exports = __toCommonJS(fixtures_exports);
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
// Annotate the CommonJS export names for ESM import in node:
0 && (module.exports = {
  CREATOR_SKILL_FIXTURE_CONTENT,
  CREATOR_SKILL_FIXTURE_CONTENT_DIGEST,
  CREATOR_SKILL_FIXTURE_MANIFEST,
  CREATOR_SKILL_FIXTURE_METADATA,
  CREATOR_SKILL_FIXTURE_POLICY,
  CREATOR_SKILL_FIXTURE_SLUG
});
