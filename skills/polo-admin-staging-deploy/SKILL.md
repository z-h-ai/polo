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
```

The script: packs the Dockerfile build context from the ref with
`git archive`, ships it to gz-coolify-main and builds there (the host is
x86_64 — never build locally on an arm64 machine and move the tar), backs up
the previous image id / compose image line / container `/app` under
`/data/updates-static-deploy/backup-<ts>/`, repoints only the
`updates-static` service's `image:` line in the Coolify compose file,
recreates the container with the full compose parameter set, force-recreates
it once more as the persistence proof, and verifies the schema-3 capability
plus the public feed.

## One-command rollback

```bash
scripts/updates-static-deploy.sh --rollback                       # newest backup
scripts/updates-static-deploy.sh --rollback --backup-dir /data/updates-static-deploy/backup-<ts>
```

Restores the backed-up compose image line and recreates the container. The
old image itself stays on the host under `updates-static:<sha>-schema3`
history until pruned.

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
