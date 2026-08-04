# `@z-h-ai/shared` publishing and POL-59 handoff

## Release candidate boundary

The planned private package coordinate is `@z-h-ai/shared@0.11.0` in
`https://npm.pkg.github.com`, with the planned immutable release tag
`shared-v0.11.0`. Neither the tag, registry package, package access grant, nor
attestation exists until the tagged publish workflow completes successfully.

The published tarball supports exactly these cross-repository entrypoints:

- `@z-h-ai/shared/creator-skills`
- `@z-h-ai/shared/creator-skills/fixtures`

Both resolve to generated CommonJS runtime bundles and generated TypeScript
declarations under `dist/creator-skills`. Package root imports and every other
subpath are intentionally unsupported and fail with
`ERR_PACKAGE_PATH_NOT_EXPORTED`. In particular, the published manifest does not
expose Polo's private `src/*.ts` files. Runtime dependencies are bundled; the
manifest declares `zod` because the generated public schema declarations refer
to its types.

The source `packages/shared/package.json` remains the development manifest used
inside the Polo monorepo and is marked `private` so it cannot be published by
mistake. `prepack` builds the Creator Skill outputs and stages the separate
publish-only `package.publish.json` under `dist/publish`; it does not rewrite
the development manifest. The proof packs only that staging directory. This
preserves existing monorepo source imports while ensuring the registry tarball
carries only the two self-contained public exports.

## Candidate integrity and compatibility evidence

Run the complete local candidate proof from the repository root:

```sh
bun run packages/shared/scripts/verify-creator-skills-package.ts --output-dir /tmp/z-h-ai-shared-proof
```

The output directory contains:

- `z-h-ai-shared-0.11.0.tgz`, the exact candidate tarball.
- `proof.json`, including candidate tarball SHA-256, npm integrity, git commit
  and tag state, compatibility versions, and executed checks.
- `clean-consumer-package-lock.json`, including the local tarball install
  integrity used by the candidate proof.
- Only after a successful tagged publication, `published-package.json`, with
  the authenticated registry tarball URL and registry integrity.

The proof creates its consumer under the operating system temporary directory,
outside the Polo repository. It creates a lockfile, deletes the install tree,
runs `npm ci`, verifies CommonJS `require`, ESM `import`, `tsc --noEmit`, a
Next.js 16.2.7 Turbopack production build, and a real `next start` API request.
It verifies that package root, `/protocol`, and `/package.json` are rejected,
recalculates the POO-21 fixture manifest `contentDigest` through the canonical
exported algorithm, and rejects source, tests, developer paths, undeclared
files, `workspace:*` dependencies, or any public export targeting `src/*.ts`.

This local proof validates the candidate only. It does not prove that version
`0.11.0` is present or installable from GitHub Packages.

## Publishing and registry-backed verification

After independent review approval:

1. Merge the implementation commit into the authorized release source branch.
2. Create and push annotated tag `shared-v0.11.0` at that exact commit.
3. Let `.github/workflows/publish-shared-package.yml` finish. The workflow
   proves, attests, publishes, and queries the same candidate tarball; do not
   rebuild a second tarball for publication.
4. In GitHub package settings, grant `z-h-ai/polo-admin` Actions read access.
5. Retain the workflow proof artifact, `published-package.json`, and GitHub
   build-provenance attestation with the release record.
6. In a clean directory with authenticated `@z-h-ai` registry configuration,
   install exact version `0.11.0` with a frozen lockfile. Confirm the lockfile
   registry URL/integrity matches `published-package.json`, then rerun the Node,
   TypeScript, Next build/start, route, fixtures, and unsupported-subpath checks
   against the registry-installed package.

If publication, repository access, attestation, metadata lookup, or the
registry-backed frozen install fails, stop and escalate. A local `npm pack`
tarball is candidate evidence, not a supported POL-59 dependency source.

## POL-59 migration

Only after registry-backed verification succeeds, replace the sibling
dependency with the exact immutable version:

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
publish-only surface is also deliberately narrower: root imports and subpaths
other than `/creator-skills` and `/creator-skills/fixtures` are not supported.
The Creator Skill product contract, fixtures, manifest ordering, and digest
algorithm are unchanged. Polo monorepo development imports continue to use the
development manifest and are not removed by this publish boundary.

If a registry release must be rolled back, pin POL-59 to a previously verified,
immutable `@z-h-ai/shared` registry version and restore its matching lockfile.
If no prior registry version exists, stop the rollout and escalate instead of
falling back to a sibling `file:` dependency, copied source, runtime alias, or
manually synchronized tarball.
