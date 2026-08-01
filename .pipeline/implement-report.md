# POO-14 Implementation Report

## Change summary

- Fixed the follow-up Windows review findings: interop types now load once per PowerShell process; registry and file-backed PATH mutation preserve user-owned empty segments, trailing separators, and pre-existing entries; and irreversible claim cleanup occurs only after the install/uninstall transaction has committed.
- Added native PowerShell coverage for exact file-backed and registry-backed PATH preservation across install/uninstall, plus source-contract assertions for repeat-safe interop loading and post-commit cleanup.
- Reworked Windows terminal integration updates around identity-bound atomic claims, no-replace publication, handle-bound revalidation/deletion, and rollback that preserves concurrent replacements for `polo.cmd`, `polo-ai.cmd`, `polo-install-root.txt`, and ownership state.
- Changed the real per-user PATH update to a transacted registry read/modify/write with guarded rollback, and kept the file-backed fixture on the same claim/no-replace model.
- Added deterministic native PowerShell race coverage for install, repair, and uninstall across regular files, symlinks, rename/content/publication races, all managed leaves, and User PATH updates; wired it into the Windows isolated/full workflow gates.
- Replaced hard-coded pre-i18n terminal-command failure output with stable error codes plus localized messages, and added the new locale key to every supported locale with explicit parity/placeholder coverage.
- Preserved the existing packaged CLI/server, self-relative wrapper, discovery, and lifecycle paths.

## Key files

- `apps/electron/resources/scripts/windows-terminal-integration.ps1`
- `apps/electron/resources/scripts/tests/windows-terminal-integration-race.test.ps1`
- `apps/electron/resources/scripts/tests/windows-terminal-integration.test.ps1`
- `apps/electron/scripts/windows-terminal-integration.test.ts`
- `apps/electron/src/main/terminal-integration-command.ts`
- `apps/electron/src/main/index.ts`
- `apps/electron/src/main/__tests__/terminal-integration-command.test.ts`
- `packages/shared/src/i18n/__tests__/locale-registry.test.ts`
- `packages/shared/src/i18n/locales/{de,en,es,hu,ja,pl,zh-Hans}.json`
- `.github/workflows/electron-artifact-full.yml`
- `scripts/run-isolated-tests.sh`
- `scripts/__tests__/electron-artifact-pipeline.test.ts`
- `apps/electron/resources/release-notes/next.md`

## Validation performed

- `bun test apps/electron/scripts/windows-terminal-integration.test.ts scripts/__tests__/electron-artifact-pipeline.test.ts`
  - PASS: 14 tests, 0 failures, 303 assertions.
- `bun run typecheck:all`
  - PASS.
- `bun test apps/electron/src/main/__tests__/terminal-integration-command.test.ts apps/electron/scripts/windows-terminal-integration.test.ts scripts/__tests__/electron-artifact-pipeline.test.ts packages/shared/src/i18n/__tests__/locale-registry.test.ts packages/shared/src/i18n/__tests__/locale-parity.test.ts`
  - PASS: 89 tests, 0 failures, 420 assertions.
- `bun run typecheck:all`
  - PASS during the focused implementation validation.
- `bun run lint:i18n:parity`
  - PASS: all six non-English locale catalogs matched the English catalog (1,645 keys each at the time of the run).
- `bun run lint:i18n:sorted`
  - PASS.
- `bun run lint:i18n:coverage`
  - PASS.
- PowerShell parser validation in the already-present `mcr.microsoft.com/powershell:lts-ubuntu-22.04` container for the implementation, normal native test, and race test scripts.
  - PASS: parser returned exit code 0 for all three scripts.
- `git diff --check`
  - PASS.

## Full-suite attempt and limitations

- `bun run test` was attempted but did **not** pass and is not reported as a gate for this patch. It first encountered a pre-existing/unrelated Linux terminal-integration rollback-candidate failure in an unmodified test/source area, then the host ran out of temporary storage under `/private/var/folders`, producing a broad `ENOSPC` cascade. The run ended with 4,576 passing, 13 skipped, 343 failing, and 1 error; those failures are not represented as POO-14 validation success.
- This host is macOS. The new native Windows PowerShell transaction/race suite was syntax-checked and wired into the Windows workflow, but it was **not executed on native Windows** here. Native Windows execution remains required evidence for Win32 file-handle, registry transaction, symlink, and rename behavior.
- No real three-platform production/full lifecycle, trusted previous-release artifact, Windows production signing, or macOS signing/notarization evidence was produced locally. Those gates require the protected remote refs, release credentials/assets, and native runners described by the production workflow.
- No push was performed. Deleted historical `.pipeline/fix-report-round*.md` runtime files were intentionally neither restored nor included in the POO-14 commit.
