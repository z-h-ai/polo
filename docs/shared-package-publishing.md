# `@z-h-ai/shared` publishing and POL-59 handoff

## Published boundary

The private package coordinate for this release is `@z-h-ai/shared@0.11.0` in
`https://npm.pkg.github.com`. The immutable release tag is `shared-v0.11.0`.
Only these Creator Skill entrypoints are supported for cross-repository use:

- `@z-h-ai/shared/creator-skills`
- `@z-h-ai/shared/creator-skills/fixtures`

Both entrypoints resolve to generated CommonJS runtime bundles and generated
TypeScript declarations under `dist/creator-skills`. Consumers do not compile
or import `src/creator-skills/**`.

The `Publish shared package` workflow checks out the tagged commit, runs
`prepack`, creates one tarball, proves that exact tarball in a standalone
consumer, attests it, and passes the same file to `npm publish`. GitHub Packages
rejects republishing the same name/version, so a changed package requires a new
version and tag.

## Integrity and compatibility evidence

Run the complete local proof from the repository root:

```sh
bun run packages/shared/scripts/verify-creator-skills-package.ts --output-dir /tmp/z-h-ai-shared-proof
```

The output directory contains:

- `z-h-ai-shared-0.11.0.tgz`, the exact candidate tarball.
- `proof.json`, including the tarball SHA-256, npm integrity, git commit/tag,
  compatibility versions, and every executed check.
- `clean-consumer-package-lock.json`, including the frozen install integrity.
- After a tagged workflow publication, `published-package.json`, including the
  authenticated immutable registry tarball URL and registry integrity.

The proof creates its consumer under the operating system temporary directory,
outside the Polo repository. It creates a lockfile, deletes any install tree,
runs `npm ci`, verifies CommonJS `require`, ESM `import`, `tsc --noEmit`, a
Next.js 16.2.7 Turbopack production build, and a real `next start` API request.
It also recalculates the POO-21 fixture manifest `contentDigest` through the
canonical exported algorithm and rejects Creator Skill source, tests,
developer paths, untracked manual files, and `workspace:*` dependencies in the
tarball.

## Publishing

1. Merge the implementation commit into the release source branch.
2. Create and push annotated tag `shared-v0.11.0` at that exact commit.
3. Let `.github/workflows/publish-shared-package.yml` finish. Do not run a
   second local build for publication.
4. In the GitHub package settings, grant `z-h-ai/polo-admin` Actions read
   access. This repository-level access grant is a required downstream gate.
5. Retain the workflow artifact and GitHub build-provenance attestation with
   the release record.

If GitHub Packages publishing or the repository access grant fails, stop and
escalate. A local `npm pack` tarball is verification evidence, not a supported
POL-59 dependency source.

## POL-59 migration

Replace the sibling dependency with the exact immutable version:

```json
{
  "dependencies": {
    "@z-h-ai/shared": "0.11.0"
  }
}
```

Commit this non-secret project `.npmrc`:

```ini
@z-h-ai:registry=https://npm.pkg.github.com
```

For GitHub Actions, use `actions/setup-node` with
`registry-url: https://npm.pkg.github.com`, `scope: '@z-h-ai'`, and pass the
polo-admin repository `GITHUB_TOKEN` as `NODE_AUTH_TOKEN`. Local development
and non-GitHub Docker/production builds must inject a token limited to
`read:packages`. For Docker, mount the npm configuration/token as a BuildKit
secret; never copy it into the build context or an image layer.

Then regenerate and commit POL-59's lockfile and independently run clean
`npm ci`, TypeScript, Next production build, and the real `/api/capabilities`
route. POL-59 must still complete its database, object-storage, role, and
Electron ledger/journal acceptance; this package proof does not replace those
checks.

## Breaking change and rollback

The package namespace changes from `@polo-ai/shared` to `@z-h-ai/shared`.
Cross-repository consumers must update both imports and dependency keys. The
Creator Skill product contract, fixtures, manifest ordering, and digest
algorithm are unchanged.

Rollback by pinning POL-59 to the last known-good published `@z-h-ai/shared`
version and restoring its matching lockfile. Do not roll back to a sibling
`file:` dependency, copied source, runtime alias, or manually synchronized
tarball.
