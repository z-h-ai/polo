# POO-21 / POO-26 v0.12.0 Integration Report

## Integration scope

This follow-up branch starts from POO-21 commit `54d51093` and integrates the two independently reviewed POO-26 strict-contract commits. The original POO-21 worktree and its untracked session/design files remain untouched.

- Upload grant and completion require the same `sizeBytes`, `archiveChecksum`, and current `uploadGeneration`.
- Electron renderer performs chunked, cancellable SHA-256 and direct object-storage PUT without exposing an account token or sending ZIP bytes through main/server-core.
- AdminClient uses the authoritative `/api/installed-artifacts/status` endpoint for exact artifact/version/checksum Safety lookup.
- Member detail responses remain stripped of storage, validation-policy, manifest, and internal validation metadata.
- The published package identity is `@z-h-ai/shared@0.12.0`; release tag, registry tarball, attestation, and polo-admin clean-consumer proof are recorded by POO-26.

## POO-26 release evidence

- Release commit: `7bbde0b78bcaafdc0e785ad404373820f5c4b7b5`
- Tag: `shared-v0.12.0`
- Candidate/registry SHA-256: `385609a812223c7dc3c947689bd915e68c69c7ff970247e0ea303059c3c98711`
- Publish workflow: `https://github.com/z-h-ai/polo/actions/runs/31083340263`
- polo-admin downstream proof: `https://github.com/z-h-ai/polo-admin/actions/runs/31083974149`

## POO-21 baseline evidence retained

The POO-21 baseline previously proved a real loopback Admin/Electron lifecycle, authenticated server-core download boundaries, install/update/uninstall Ledger and journal behavior, and `skills:changed` refresh. That proof used the older Admin contract and must now be rerun against the POL-59 strict asynchronous service and isolated COS staging resources.

## Latest dev integration

- Merged current `origin/dev` while preserving the strict upload v2 flow, authoritative Safety endpoint, Member response redaction, renderer-only archive hashing/upload, and authenticated download boundary.
- Resolved overlapping Creator Skill/AdminClient changes together with the newer Catalog, authentication-timeout, Electron packaging, and CLI work from `dev`.
- Focused Creator Skill suites passed: 88 standard tests, 10 isolated server-core boundary tests, and 15 isolated panel interaction tests.
- `bun run typecheck:all`, Creator Skill E2E TypeScript validation, and `bun run electron:build` passed on the merged tree.
- The first full regression exposed a `dev`-side release preflight bug: redirected `electron:dist` prepared the complete runtime before reaching the CLI artifact fail-closed guard, so its 5-second regression timed out after about 103 seconds. `scripts/electron-dist.ts` now rejects the test-only output override before any runtime preparation. The focused regression passed in 67 ms, and the full rerun passed with `5282 passed / 19 skipped` plus every isolated suite.

## 2026-08-06 real staging E2E fixes

- The real staging E2E initially failed before launch because the main-process harness bundled `koffi` and esbuild attempted to inline all platform-specific `.node` binaries.
- Marked `koffi` external and made the temporary harness resolve the repository native dependency; the authenticated download wrapper now treats Fetch `preconnect` as optional because Electron/Node Fetch does not guarantee that extension.
- Fixed a stale cross-account Catalog result after Owner changes a Member role by invalidating the organization-wide cache on member update/remove. Added a regression proving a cached Member view observes a newly visible draft after promotion.
- Aligned the authoritative Safety request with POL-59: `{ identities: [...] }` and algorithm-labelled `sha256:<digest>` on the wire, while retaining the canonical 64-character checksum inside the desktop contract.
- Removed the contradictory E2E assertion that required Member detail to expose `validationPolicy`; the same response is still recursively checked to reject validation policy, manifest, upload generation, and internal validation metadata.

## Real POL-59 staging acceptance

`POO21_ADMIN_BASE_URL=http://127.0.0.1:3000 bun run electron:e2e:creator-skill` passed against the deployed staging Admin, validation/cleanup workers, PostgreSQL, and real Tencent COS through a loopback safety proxy. The proxy only kept the harness loopback-only invariant and rewrote the public download URL back to that local gateway; upstream API, direct PUT, workers, and COS remained real.

- Owner created the Creator Space, draft, and versions; Member management and draft download were rejected.
- Bob was promoted to Manager and published `1.0.0` and `1.1.0`, then demoted to Member for download and install.
- Negative checks passed: invalid credentials/body, stale upload generation, Member management, and cross-user download token binding.
- Electron install/update/uninstall passed with progress stages `download`, `validate`, `prepare`, `commit`, `refresh`; `skills:changed` fired three times and two cleanup-safe backups remained.
- Accepted versions used distinct archive checksums/content digests; staging cleanup then removed 2 users, 8 retry organizations, 8 artifacts, 9 versions, and all 9 referenced COS objects. Post-cleanup database counts are zero for the fixture users, organizations, and artifacts.

## Remaining acceptance gate

The real cross-repository lifecycle gate is now satisfied. Final regression passed with `5283 passed / 19 skipped` in the 429-file standard suite, every isolated suite passing, `bun run typecheck:all` passing, and `bun run electron:build` passing. Do not mark POO-21 complete until a fresh independent reviewer returns `pass`.

## 2026-08-06 reviewer round 1 remediation

- Restored `CreatorSkillUploadGrant.headers` as an optional field in the source type, Zod response schema, and public package declaration. The new archive identity fields remain required, preserving the strict v2 contract without breaking older Admin responses.
- Moved the renderer incremental SHA-256 implementation into a focused module and documented its FIPS 180-4 provenance, endian/padding rules, unsigned 32-bit arithmetic, bounded-memory purpose, and safe counter invariant.
- Fixed the staging stale-generation check to send the full required archive identity. It now asserts the HTTP 409 conflict produced after schema validation instead of accepting any generic rejection.
- Extended the real staging Electron E2E to read the committed Ledger after install, assert an empty Ledger and no journals after uninstall, and exercise startup recovery in a separate Electron-as-Node process against a deliberately persisted `preparing` crash journal.
- The extended real Tencent COS staging lifecycle passed with `ledgerCommitted`, `journalsCleaned`, and `restartRecoveryPassed` all true. The rerun fixture was removed together with 2 users, 2 organizations, 2 artifacts, 3 versions, and all 3 COS objects.
- Final standard suite evidence: one isolated full run passed `5303 / 5303` with 19 skips and 0 failures. Two prior full runs exposed the repository's existing RPC registration ordering flake (the same four tests passed immediately in isolation); the final full run and all isolated suites were green. `bun run typecheck:all` and `bun run electron:build` passed.

The remaining release gate is an independent reviewer `pass` plus manual GitHub token revocation/replacement described in the POL-59 report.
