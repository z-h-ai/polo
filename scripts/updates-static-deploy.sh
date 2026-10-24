#!/usr/bin/env bash
set -euo pipefail

# Rebuild and redeploy the updates-static release publisher from this
# repository's Dockerfile (POL-269).
#
# The container's /app used to be patched in place with `docker cp`
# (the v0.19.3 hotfix), which silently reverts to the stale Zeabur image on
# any container recreation. This script replaces that practice: it packs the
# exact Dockerfile build context from a git ref, builds the image ON THE HOST
# (gz-coolify-main is x86_64; never build on an arm64 machine and ship the
# tar), backs up the previous image and container /app, repoints the Coolify
# compose service at the new image, recreates the container with the full
# compose parameter set, force-recreates it once more as the persistence
# proof, and verifies the schema-3 capability plus the public dual-arch
# update feed.
#
# Usage:
#   scripts/updates-static-deploy.sh [--ref origin/dev] [--expect-version 0.19.3] [--dry-run]
#   scripts/updates-static-deploy.sh --rollback [--backup-dir /data/updates-static-deploy/backup-<ts>]
#
# Rules honored (see ~/.agents/skills/z-h-ai-infra/SKILL.md):
#   4. compose operations always carry the full project parameter set;
#   5. local curl checks bypass the fake-ip proxy with --noproxy '*'.

PROJECT="vrmtxfwgyi9ebkhtkiyerzzk"
SERVICE="updates-static"
REMOTE_BASE="/data/coolify/services/${PROJECT}"
REMOTE_COMPOSE="${REMOTE_BASE}/docker-compose.yml"
REMOTE_ENV="${REMOTE_BASE}/.env"
REMOTE_WORK_ROOT="/data/updates-static-deploy"
CONTAINER="${PROJECT}-${SERVICE}-1"
PUBLIC_FEED="https://updates.polo.z-h-ai.com/electron/latest"
# Deployments run from an operator machine through the full-access host key;
# the CI forced-command key (updates-server-exec.sh) can only docker exec.
SSH_HOST="${UPDATES_DEPLOY_SSH_HOST:-gz-main}"

# Files the Dockerfile COPYs; keep in sync with infra/updates-static/Dockerfile.
CONTEXT_PATHS=(
  infra/updates-static/Dockerfile
  infra/updates-static/package.json
  infra/updates-static/polo-release-pull
  infra/updates-static/polo-release-job
  infra/updates-static/PoloCaddyfile
  scripts/electron-release-contract.ts
  scripts/electron-release-draft-identity.ts
  scripts/publish-electron-release.ts
  scripts/polo-release-job.ts
  scripts/polo-release-pull.ts
  scripts/strict-semver.ts
  scripts/strict-semver-pattern.txt
)

# Rewrites the image line inside the updates-static service block only; every
# other service keeps its own image. Runs on the host (mawk-compatible: no {n}
# intervals), so $0 stays single-quoted across the ssh hop.
AWK_REWRITE='/^  [A-Za-z0-9_-]+: *$/ { inside = ($0 == "  " svc ":") }
inside && /^    image:/ && !replaced { sub(/image:.*/, "image: " img); replaced = 1 }
{ print }'

REF="origin/dev"
EXPECT_VERSION="0.19.3"
DRY_RUN=0
ROLLBACK=0
ROLLBACK_DIR=""

log() { printf '[updates-static-deploy] %s\n' "$*"; }

usage() {
  grep '^#' "${BASH_SOURCE[0]}" | sed 's/^#\{1,\} \{0,1\}//'
  exit 2
}

while [ "$#" -gt 0 ]; do
  case "$1" in
    --ref) REF="$2"; shift 2 ;;
    --expect-version) EXPECT_VERSION="$2"; shift 2 ;;
    --dry-run) DRY_RUN=1; shift ;;
    --rollback) ROLLBACK=1; shift ;;
    --backup-dir) ROLLBACK_DIR="$2"; shift 2 ;;
    *) usage ;;
  esac
done

run_remote() {
  if [ "$DRY_RUN" -eq 1 ]; then
    printf '  [dry-run] ssh %s %q\n' "$SSH_HOST" "$1"
    return 0
  fi
  ssh "$SSH_HOST" "$1"
}

require_repo_root() {
  [ -f infra/updates-static/Dockerfile ] || {
    log "ERROR: run from the repository root (missing infra/updates-static/Dockerfile)"
    exit 1
  }
  for path in "${CONTEXT_PATHS[@]}"; do
    git cat-file -e "${REF}:${path}" 2>/dev/null || {
      log "ERROR: ${REF} does not contain ${path} (Dockerfile context incomplete)"
      exit 1
    }
  done
}

# infra skill rule 4: the full compose parameter set, always; scoped to the
# updates-static service so no sibling service is ever recreated.
compose_up() {
  run_remote "sudo docker compose -p ${PROJECT} \
    --project-directory ${REMOTE_BASE} \
    -f ${REMOTE_COMPOSE} \
    --env-file ${REMOTE_ENV} \
    up -d${1:+ $1} ${SERVICE}"
}

replace_compose_image_line() {
  local new_image="$1"
  # The Coolify service dir is root-owned: rewrite through a scratch file the
  # ssh user can write, then move into place as root. The .pre-deploy copy is
  # an extra safety net on top of the backup dir snapshot.
  run_remote "sudo cp ${REMOTE_COMPOSE} ${REMOTE_COMPOSE}.pre-deploy && \
sudo cat ${REMOTE_COMPOSE}.pre-deploy | awk -v img='${new_image}' -v svc='${SERVICE}' '${AWK_REWRITE}' > ${REMOTE_WORK_ROOT}/compose.new && \
sudo mv ${REMOTE_WORK_ROOT}/compose.new ${REMOTE_COMPOSE} && \
sudo grep -A2 '^  ${SERVICE}:' ${REMOTE_COMPOSE} | grep -q 'image: ${new_image}'"
}

restore_compose_image_line() {
  local old_image="$1"
  run_remote "sudo cat ${REMOTE_COMPOSE} | awk -v img='${old_image}' -v svc='${SERVICE}' '${AWK_REWRITE}' > ${REMOTE_WORK_ROOT}/compose.rollback && \
sudo mv ${REMOTE_WORK_ROOT}/compose.rollback ${REMOTE_COMPOSE} && \
sudo grep -A2 '^  ${SERVICE}:' ${REMOTE_COMPOSE} | grep -q 'image: ${old_image}'"
}

verify_capability() {
  local label="$1"
  local output
  if [ "$DRY_RUN" -eq 1 ]; then
    printf '  [dry-run] verify %s capability via docker exec\n' "$label"
    return 0
  fi
  output="$(ssh "$SSH_HOST" "sudo docker exec ${CONTAINER} bun /app/publish-electron-release.ts capability")"
  printf '%s\n' "$output"
  grep -qx 'POLO_RELEASE_PUBLISHER_SCHEMA=3' <<<"$output" \
    && grep -qx 'POLO_RELEASE_PUBLISHER_ASSETS=10' <<<"$output" || {
    log "ERROR: ${label} capability probe failed (expected SCHEMA=3 and ASSETS=10)"
    exit 1
  }
  log "${label}: capability SCHEMA=3 ASSETS=10 confirmed"
}

verify_public_feed() {
  if [ "$DRY_RUN" -eq 1 ]; then
    printf '  [dry-run] verify %s{latest-mac.yml,zip} over HTTPS\n' "$PUBLIC_FEED"
    return 0
  fi
  local manifest
  manifest="$(curl --noproxy '*' -fsSL "${PUBLIC_FEED}/latest-mac.yml")"
  grep -q "^version: ${EXPECT_VERSION}\$" <<<"$manifest" || {
    log "ERROR: latest-mac.yml is not at ${EXPECT_VERSION}"
    exit 1
  }
  grep -q 'url: Polo-AI-arm64.zip' <<<"$manifest" \
    && grep -q 'url: Polo-AI-x64.zip' <<<"$manifest" || {
    log "ERROR: latest-mac.yml lost the dual-architecture entries"
    exit 1
  }
  local zip status
  for zip in Polo-AI-x64.zip Polo-AI-arm64.zip; do
    status="$(curl --noproxy '*' -fsSL -o /dev/null -w '%{http_code}' -I "${PUBLIC_FEED}/${zip}")"
    [ "$status" = "200" ] || {
      log "ERROR: ${zip} returned HTTP ${status}"
      exit 1
    }
  done
  log "public feed: ${EXPECT_VERSION} dual-architecture manifest + both ZIPs HTTP 200"
}

deploy() {
  require_repo_root
  local short_sha
  short_sha="$(git rev-parse --short "${REF}")"
  local image_tag="updates-static:${short_sha}-schema3"
  local stamp
  stamp="$(date +%Y%m%d-%H%M%S)"
  local remote_build_dir="${REMOTE_WORK_ROOT}/build-${stamp}"
  local backup_dir="${REMOTE_WORK_ROOT}/backup-${stamp}"
  local context_tar
  # X sequence must end the template for BSD mktemp (macOS); git archive -o
  # picks the compression from --format, not the file name.
  context_tar="$(mktemp "${TMPDIR:-/tmp}/updates-static-context.XXXXXX")"

  log "deploying ${REF} (${short_sha}) as ${image_tag}"
  log "step 1/6: packing Dockerfile build context from ${REF}"
  if [ "$DRY_RUN" -ne 1 ]; then
    git archive --format=tar.gz -o "$context_tar" "${REF}" -- "${CONTEXT_PATHS[@]}"
  fi

  log "step 2/6: shipping context and building on the host (x86_64)"
  # /data is root-owned on the host: create as root, then hand the work root
  # to the ssh user so scp/untar/tar-redirection need no elevation.
  run_remote "sudo mkdir -p ${remote_build_dir} ${REMOTE_WORK_ROOT} ${backup_dir} && \
sudo chown \$(id -un) ${remote_build_dir} ${REMOTE_WORK_ROOT} ${backup_dir}"
  if [ "$DRY_RUN" -ne 1 ]; then
    scp -q "$context_tar" "${SSH_HOST}:${remote_build_dir}/context.tar.gz"
  else
    printf '  [dry-run] scp %s %s:%s/context.tar.gz\n' "$context_tar" "$SSH_HOST" "$remote_build_dir"
  fi
  run_remote "cd ${remote_build_dir} && mkdir -p context && tar xzf context.tar.gz -C context && \
sudo docker build -f context/infra/updates-static/Dockerfile -t ${image_tag} context && \
sudo docker image inspect ${image_tag} --format '{{.Id}} {{.Architecture}}'"

  log "step 3/6: backing up previous image, compose image line, and container /app"
  run_remote "sudo docker inspect ${CONTAINER} --format '{{.Image}}' > ${backup_dir}/old-image-id && \
(sudo docker exec ${CONTAINER} tar czf - -C / app > ${backup_dir}/old-app.tar.gz || true) && \
sudo grep -A2 '^  ${SERVICE}:' ${REMOTE_COMPOSE} | grep '^    image:' | head -1 | awk '{print \$2}' | sed 's/^/OLD_IMAGE_LINE=/' > ${backup_dir}/rollback.env && \
printf 'BACKUP_DIR=%s\n' '${backup_dir}' >> ${backup_dir}/rollback.env && \
sudo docker images --format '{{.ID}} {{.Repository}}:{{.Tag}}' | grep -F \"\$(sed 's/^OLD_IMAGE_LINE=//' ${backup_dir}/rollback.env)\" >> ${backup_dir}/rollback.env || true && \
cat ${backup_dir}/rollback.env && ls -la ${backup_dir}"

  log "step 4/6: repointing compose ${SERVICE}.image and recreating the container"
  replace_compose_image_line "$image_tag"
  compose_up

  log "step 5/6: verifying capability (USB-01) and the public feed (USB-03)"
  verify_capability "deployed container"
  verify_public_feed

  log "step 6/6: force-recreate persistence proof (USB-02) and rollback pointer"
  compose_up "--force-recreate"
  verify_capability "force-recreated container"
  log "backup dir on host: ${backup_dir} (old-image-id, old-image-line/rollback.env, old-app.tar.gz)"
  log "rollback: scripts/updates-static-deploy.sh --rollback"
  rm -f "$context_tar"
}

rollback() {
  if [ -z "$ROLLBACK_DIR" ]; then
    ROLLBACK_DIR="\$(ls -d ${REMOTE_WORK_ROOT}/backup-* 2>/dev/null | sort | tail -1)"
  fi
  log "rolling back using ${ROLLBACK_DIR}"
  local env_content
  env_content="$(run_remote "cat ${ROLLBACK_DIR}/rollback.env")"
  local old_image
  old_image="$(grep '^OLD_IMAGE_LINE=' <<<"$env_content" | head -1 | cut -d= -f2-)"
  [ -n "$old_image" ] || { log "ERROR: rollback.env has no OLD_IMAGE_LINE"; exit 1; }
  log "restoring ${SERVICE}.image to ${old_image}"
  restore_compose_image_line "$old_image"
  compose_up
  log "verifying the running container uses the backed-up image id:"
  run_remote "sudo docker inspect ${CONTAINER} --format '{{.Image}}' && cat ${ROLLBACK_DIR}/old-image-id"
  verify_capability "rolled-back container"
  verify_public_feed
}

if [ "$ROLLBACK" -eq 1 ]; then
  rollback
else
  deploy
fi
