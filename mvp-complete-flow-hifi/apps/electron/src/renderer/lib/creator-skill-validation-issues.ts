import type { TFunction } from 'i18next'

const STABLE_VALIDATION_ISSUE_CODES = new Set([
  'absolute_path',
  'ambiguous_path',
  'archive_checksum_mismatch',
  'content_digest_mismatch',
  'duplicate_path',
  'entry_read_failed',
  'executable_binary',
  'invalid_creator_icon',
  'invalid_icon_format',
  'invalid_path',
  'invalid_skill_content',
  'invalid_windows_path',
  'invalid_zip',
  'local_policy_exceeded',
  'local_scan_race',
  'local_type_mismatch',
  'manifest_mismatch',
  'max_archive_bytes_exceeded',
  'max_entry_count_exceeded',
  'max_expanded_bytes_exceeded',
  'max_file_bytes_exceeded',
  'max_file_count_exceeded',
  'nested_archive',
  'packaging_noise_removed',
  'path_traversal',
  'path_type_conflict',
  'portable_path_conflict',
  'root_directory_mismatch',
  'skill_file_count',
  'skill_structure_type_mismatch',
  'unexpected_skill_path',
  'unsupported_entry_type',
  'windows_reserved_name',
])

export function translateCreatorSkillValidationIssue(
  t: TFunction,
  issueCode: string,
): string {
  const unknown = t('creatorSkills.validation.issue.unknown')
  if (!STABLE_VALIDATION_ISSUE_CODES.has(issueCode)) return unknown
  return t(`creatorSkills.validation.issue.${issueCode}`, {
    defaultValue: unknown,
  })
}
