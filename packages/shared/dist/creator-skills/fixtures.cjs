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
name: review-helper
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
  name: "review-helper",
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
  sha256: "a063d3f9bd112e6e1d816cb2c771ccf9fb8602b942e8e82a173af9c5001c91b9"
}];
var CREATOR_SKILL_FIXTURE_CONTENT_DIGEST = "b5326fb33894331f09a1b0e80650435c8c2cd70ba45b691cf513ba9de5f9da80";
// Annotate the CommonJS export names for ESM import in node:
0 && (module.exports = {
  CREATOR_SKILL_FIXTURE_CONTENT,
  CREATOR_SKILL_FIXTURE_CONTENT_DIGEST,
  CREATOR_SKILL_FIXTURE_MANIFEST,
  CREATOR_SKILL_FIXTURE_METADATA,
  CREATOR_SKILL_FIXTURE_POLICY,
  CREATOR_SKILL_FIXTURE_SLUG
});
