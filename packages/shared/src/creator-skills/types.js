// packages/shared/src/creator-skills/types.ts
var DEFAULT_SKILL_ARCHIVE_POLICY = {
  version: "1",
  maxArchiveBytes: 20 * 1024 * 1024,
  maxFileCount: 200,
  maxFileBytes: 5 * 1024 * 1024,
  maxExpandedBytes: 50 * 1024 * 1024
};
var HARD_SKILL_ARCHIVE_POLICY = {
  version: "hard-1",
  maxArchiveBytes: 100 * 1024 * 1024,
  maxFileCount: 1e3,
  maxFileBytes: 25 * 1024 * 1024,
  maxExpandedBytes: 250 * 1024 * 1024
};
export {
  DEFAULT_SKILL_ARCHIVE_POLICY,
  HARD_SKILL_ARCHIVE_POLICY
};
