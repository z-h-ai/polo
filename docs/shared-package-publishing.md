# `@z-h-ai/shared` publishing and POL-59 handoff

## Release candidate boundary

The planned private package coordinate is `@z-h-ai/shared@0.11.1` in
`https://npm.pkg.github.com`, with the planned immutable release tag
`shared-v0.11.1`. Neither that tag, registry package, package access grant, nor
attestation exists until the tagged publish workflow completes successfully.

`shared-v0.11.0` is an immutable failed publication-attempt tag at commit
`27ec7083ecce131818b24026edef283eda10c380`. GitHub Actions run `30870120001`
completed the candidate clean-consumer proof with SHA-256
`25fd5d8d61013b6ce01692117f8b75d7220f8390ce31e7a7c04994268ff9d067`,
but an orphaned `next-server` kept the proof process alive until the job timed
out. Attestation, publish, registry metadata capture, and artifact upload never
ran, and `@z-h-ai/shared@0.11.0` was not published. Do not delete, move, or
reuse that tag; POL-59 must consume `0.11.1` after its successful publication
and registry-backed verification.

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

The CI workflow and lifecycle regression run the proof through the supervised
entrypoint below. It uses piped non-interactive stdio, waits for the proof
command to close by itself, and fails if any descendant remains alive; its
watchdog is a failure guard, never a successful timeout path.

```sh
bun run packages/shared/scripts/verify-creator-skills-package-lifecycle.ts \
  --output-dir /tmp/z-h-ai-shared-proof
```

The output directory contains:

- `z-h-ai-shared-0.11.1.tgz`, the exact candidate tarball.
- `proof.json`, including candidate tarball SHA-256, npm integrity, git commit
  and tag state, compatibility versions, and executed checks.
- `lifecycle-proof.json`, proving the CI-style proof command exited by itself
  and left no live descendant process.
- `clean-consumer-package-lock.json`, including the local tarball install
  integrity used by the candidate proof.
- Only after a successful tagged publication, `published-package.json`, with
  the authenticated registry tarball URL and registry integrity.

The proof creates its consumer under the operating system temporary directory,
outside the Polo repository. It creates a lockfile, deletes the install tree,
runs `npm ci`, verifies CommonJS `require`, ESM `import`, `tsc --noEmit`, a
Next.js 16.2.7 Turbopack production build, and a real `next start` API request.
The route proof invokes the installed Next CLI directly through Node, sends
`SIGTERM`, waits for process close, escalates to `SIGKILL` only on cleanup
failure, and then removes listeners and closes both output streams.
It verifies that package root, `/protocol`, and `/package.json` are rejected,
recalculates the POO-21 fixture manifest `contentDigest` through the canonical
exported algorithm, and rejects source, tests, developer paths, undeclared
files, `workspace:*` dependencies, or any public export targeting `src/*.ts`.

This local proof validates the candidate only. It does not prove that version
`0.11.1` is present or installable from GitHub Packages.

## Publishing and registry-backed verification

After independent review approval:

1. Merge the implementation commit into the authorized release source branch.
2. Create and push annotated tag `shared-v0.11.1` at that exact commit. Preserve
   the existing failed-attempt tag `shared-v0.11.0` unchanged.
3. Let `.github/workflows/publish-shared-package.yml` finish. The workflow
   proves, attests, publishes, and queries the same candidate tarball; do not
   rebuild a second tarball for publication.
4. In GitHub package settings, grant `z-h-ai/polo-admin` Actions read access.
5. Retain the workflow proof artifact, `published-package.json`, and GitHub
   build-provenance attestation with the release record.
6. In a clean directory with authenticated `@z-h-ai` registry configuration,
   install exact version `0.11.1` with a frozen lockfile. Confirm the lockfile
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
    "@z-h-ai/shared": "0.11.1"
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
