---
name: polo-admin-staging-deploy
description: Deploy and roll back the updates-static release publisher (updates.polo.z-h-ai.com) from this repository's Dockerfile. Use for every updates-static image change; never patch the running container in place.
---

# updates-static deploy (updates.polo release publisher)

## The one rule

The container's `/app` must come from an image built by
`infra/updates-static/Dockerfile`, never from `docker cp`. The v0.19.3 hotfix
(POL-268) patched the live container because the Zeabur-era image still carried
the 9-asset schema-2 publisher; that patch silently reverted on the next
container recreation and is what POL-269 retired. A `docker cp` against
`vrmtxfwgyi9ebkhtkiyerzzk-updates-static-1` is a regression, not a fix.

## One-command deploy

From a repository checkout whose `<ref>` contains the change:

```bash
scripts/updates-static-deploy.sh --ref origin/dev
# After a release bumped the feed version, pin the expected online version:
scripts/updates-static-deploy.sh --ref origin/dev --expect-version 0.20.0
```

The script: packs the Dockerfile build context from the ref with
`git archive`, ships it to gz-coolify-main and builds there (the host is
x86_64 — never build locally on an arm64 machine and move the tar), commits
the RUNNING container to `updates-static-rollback:<stamp>` and proves that
image can run the capability probe, takes verified backups (container `/app`
tar, compose image line) under `/data/updates-static-deploy/backup-<ts>/`,
builds the new image under a tag that never collides with the rollback tag,
repoints only the `updates-static` service's `image:` line in the Coolify
compose file behind a one-line-diff gate, recreates the container with the
full compose parameter set, force-recreates it once more as the persistence
proof, and verifies the schema-3 capability plus the public feed.

## One-command rollback

```bash
scripts/updates-static-deploy.sh --rollback                       # newest COMPLETE snapshot
scripts/updates-static-deploy.sh --rollback --backup-dir /data/updates-static-deploy/backup-<ts>
```

Restores the compose image line to the snapshot's rollback anchor
(`updates-static-rollback:<stamp>`, a `docker commit` of the pre-deploy
container including any live patch), recreates the container, asserts the
running image id equals the anchored id, and re-probes the capability. Only
snapshots whose `rollback.env` is marked `COMPLETE=1` with a readable
`/app` tar qualify; incomplete ones are skipped with a note.

## Standing boundaries

- **Do not prune `updates-static:*` or `updates-static-rollback:*` images on
  the host.** The compose file references the local tag; pruned images leave
  the service undeeployable until the script runs again. The rollback images
  also embed the container's env snapshot — keep them on the host, never
  `docker push` or export them.
- **Coolify may rewrite the compose file** (redeploy from its UI) and revert
  the `image:` line to the old registry reference. The fix is one command:
  re-run `scripts/updates-static-deploy.sh` — it is idempotent and rebuilds
  from cache. Never hand-edit the line back with `docker cp`.
- **`--expect-version` moves with every release** (default `0.20.0`). After
  publishing a new version, pass the new one explicitly or the deploy's feed
  check fails: `--expect-version <new-version>`. A failed deploy because of a
  stale expectation is harmless — the container is already recreated with the
  new image; fix the flag and re-run.
- Deployments must run from a checkout whose ref passes the script's context
  check; a ref missing any Dockerfile COPY source aborts before anything is
  built or touched.

## Acceptance checks (all four, every deploy)

- `capability`: `bun /app/publish-electron-release.ts capability` in the
  container prints `POLO_RELEASE_PUBLISHER_SCHEMA=3` and
  `POLO_RELEASE_PUBLISHER_ASSETS=10`.
- Persistence: after `docker compose ... up -d --force-recreate updates-static`
  the capability probe still passes — this is what proves the image, not a
  live patch, carries the publisher.
- Feed: `https://updates.polo.z-h-ai.com/electron/latest/latest-mac.yml` is at
  the expected version with both `Polo-AI-x64.zip` and `Polo-AI-arm64.zip`
  entries; both ZIPs answer HTTP 200 (curl with `--noproxy '*'` locally).
- Release gate: `.github/workflows/electron-release.yml` probes the same
  capability before pulling assets, so an undeployed publisher fails the tag
  workflow with an explicit "Deploy the rebuilt infra/updates-static image
  first" message instead of publishing a broken release.

## Relation to the Coolify migration debt

The compose service still lives in the Coolify-managed project
`vrmtxfwgyi9ebkhtkiyerzzk` with a locally built image tag instead of a
registry reference. When the "migrate updates-static to a Git-built
application" backlog item lands, its Dockerfile-based build replaces the
manual `updates-static-deploy.sh` path — until then this script is the only
sanctioned way to change the publisher. Keep the Dockerfile COPY list and the
script's `CONTEXT_PATHS` in sync; the test in
`scripts/updates-static-deploy.test.ts` fails when they drift.
