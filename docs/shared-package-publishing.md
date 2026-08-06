# `@z-h-ai/shared@0.12.0` publishing and POL-59 handoff

## Candidate boundary

The follow-up release coordinate is `@z-h-ai/shared@0.12.0` in the private
GitHub Packages registry `https://npm.pkg.github.com`. The release tag is
`shared-v0.12.0`.

Coder work stops at a locally verified candidate tarball. Do not push the
branch, create or move the tag, or publish the package until Ultra-Coding has
passed. Until the tagged workflow completes, there is no registry tarball URL,
registry integrity, attestation, Actions run, or downstream access proof for
0.12.0.

The publish-only manifest is intentionally separate from the Polo monorepo
development manifest. The monorepo keeps its internal `@polo-ai/shared`
identity and source exports; staging writes a clean `@z-h-ai/shared@0.12.0`
manifest without requiring a repository-wide namespace rewrite.

The tarball supports exactly these entrypoints:

- `@z-h-ai/shared/creator-skills`
- `@z-h-ai/shared/creator-skills/fixtures`

Both resolve to built CommonJS runtime bundles and generated TypeScript
declarations below `dist/creator-skills`. Package root imports and all other
subpaths are unsupported. The tarball contains no private `src`, tests,
workspace dependencies, local paths, or manually copied shadow source.

## Breaking 0.12.0 contract

Creator Skill upload protocol v2 has no compatibility path:

- upload-grant requests require `sizeBytes` and normalized SHA-256
  `archiveChecksum`;
- grants bind `expectedSizeBytes`, `expectedArchiveChecksum`,
  `uploadGeneration`, expiry, and the exact signed COS request headers;
- upload completion requires the same `uploadGeneration + sizeBytes +
  archiveChecksum`;
- the Electron renderer computes SHA-256 incrementally with cancellation and
  bounded memory before requesting a grant;
- Safety Status is obtained from the authoritative
  `/api/installed-artifacts/status` endpoint for the exact
  `artifactId + version + archiveChecksum`, never inferred from member
  Artifact detail;
- member detail remains redacted and must not expose `validationPolicy`,
  storage keys, internal manifests, validator metadata, or validation issues.

The fixture content, slug/frontmatter validation, canonical manifest ordering,
and `contentDigest` algorithm remain unchanged.

## Local candidate proof

From the repository root, first run the failure lifecycle regressions and then
the supervised candidate proof:

```sh
bun run --cwd packages/shared test:creator-skills-package-failures
bun run packages/shared/scripts/verify-creator-skills-package-lifecycle.ts \
  --allow-dirty-snapshot \
  --output-dir /tmp/z-h-ai-shared-0.12.0-proof
```

The second command builds and stages once, packs that staging directory, and
uses the exact tarball for every candidate check. It creates a consumer outside
the Polo repository, generates a lockfile, removes `node_modules`, executes
frozen `npm ci`, and verifies:

- Node CommonJS `require` and ESM `import`;
- TypeScript 6 `tsc --noEmit`;
- Next.js 16.2.7 Turbopack production build;
- a real `next start` API route request and clean process shutdown;
- both public entrypoints, shared fixtures, canonical manifest and
  `contentDigest`;
- rejection of package root/private subpaths and negative tarball boundaries.

The candidate evidence directory contains:

- `z-h-ai-shared-0.12.0.tgz`;
- `proof.json`, including tarball SHA-256, npm integrity, git state and the
  compatibility matrix;
- `clean-consumer-package-lock.json`;
- `lifecycle-proof.json`, proving the proof command exited by itself and left
  no live descendant.

`--allow-dirty-snapshot` is only for the coder's pre-commit candidate run.
The tagged workflow runs from a clean checkout and rejects dirty or
non-reproducible prepack output.

## Tagged publication and registry proof

After Ultra-Coding passes, create `shared-v0.12.0` at the approved release
commit and let `.github/workflows/publish-shared-package.yml` prove, attest,
publish, query, and registry-verify the same tarball. It must record:

- release commit and immutable tag;
- registry tarball URL, SHA-256, npm integrity and shasum;
- build-provenance attestation;
- publish/registry proof Actions run and
  `z-h-ai-shared-0.12.0-proof` artifact;
- `registry-clean-consumer-package-lock.json`, `registry-proof.json`, and
  `registry-lifecycle-proof.json`.

A manual dispatch with `verify_published=true` may rerun registry proof but
must not republish the immutable version. Failure of publication, attestation,
metadata lookup, exact-version frozen install, or process lifecycle is a hard
escalation. A local tarball is candidate evidence only.

The successful 0.11.1 release and its historical `shared-v0.11.1` tag remain
unchanged. The failed `shared-v0.11.0` tag also remains immutable and must
never be moved or reused.

## POL-59 migration after publication

Only after both registry proof and polo-admin repository-token access proof
pass, pin the exact version:

```json
{
  "dependencies": {
    "@z-h-ai/shared": "0.12.0"
  }
}
```

Keep this non-secret scope registry configuration:

```ini
@z-h-ai:registry=https://npm.pkg.github.com
```

Regenerate and commit the frozen lockfile. GitHub Actions must install using the
polo-admin repository's own `GITHUB_TOKEN` with package read access. Local and
non-GitHub builds must inject a read-only package token through an environment
variable or BuildKit secret; never commit or bake a token into a lockfile,
`.npmrc`, log, image layer, or package.

POL-59 must independently rerun frozen `npm ci`, TypeScript, Next production
build, real capabilities/route checks, strict upload API, worker validation and
role/redaction tests. POO-21 must independently rerun the Electron
upload/Safety/install/update/uninstall Ledger and journal loop against isolated
real COS. Package proof alone does not pass either downstream task.

Rollback means pinning a previously verified immutable registry version and
restoring its matching lockfile. Never fall back to a sibling `file:`
dependency, copied source, runtime alias, or manually synchronized tarball.
