#!/usr/bin/env bash
set -euo pipefail

# Rebuild and redeploy the updates-static release publisher from this
# repository's Dockerfile (POL-269).
#
# The container's /app used to be patched in place with `docker cp`
# (the v0.19.3 hotfix), which silently reverts to the stale Zeabur image on
# any container recreation. This script replaces that practice. Per deploy it:
#
#   1. commits the RUNNING container (patch included) to a dedicated
#      updates-static-rollback:<stamp> image BEFORE building anything, and
#      proves that rollback image can execute the capability probe;
#   2. takes required backups (container /app tar, compose image line) and
#      writes rollback.env only when every required artifact verified;
#   3. builds the new image under a tag that never collides with the
#      rollback tag;
#   4. repoints only the updates-static service's image line through a strict
#      rewrite that refuses to write anything but a one-line image change;
#   5. recreates the container with the full compose parameter set and
#      verifies the capability plus the public feed, then force-recreates
#      once more as the persistence proof.
#
# Usage:
#   scripts/updates-static-deploy.sh [--ref <git-ref>] [--expect-version 0.20.0] [--dry-run]
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

# Service-block title: exactly two-space indent, bare key, colon, then only
# whitespace or a comment. Deeper-indented lines and inline junk never match,
# so `inside` cannot leak past a sibling service heading.
AWK_REWRITE='/^  [A-Za-z0-9_-]+:/ {
  key = $0
  sub(/:.*/, "", key)
  sub(/^  /, "", key)
  inside = (key == svc)
}
inside && /^    image:/ && !replaced {
  sub(/image:.*/, "image: " img)
  replaced = 1
}
{ print }'

# Prints the remote shell snippet that rewrites <current> into <candidate>
# and refuses to produce anything other than exactly one image-line change.
# Runs unchanged locally (tests) and on the host (deploy/rollback): no sudo,
# no paths baked in. Args: current candidate new_image service workdir
compose_rewrite_snippet() {
  cat <<'SNIPPET'
set -eu
current="$1"; candidate="$2"; new_image="$3"; svc="$4"; workdir="$5"
awk -v img="$new_image" -v svc="$svc" '
/^  [A-Za-z0-9_-]+:/ {
  key = $0
  sub(/:.*/, "", key)
  sub(/^  /, "", key)
  inside = (key == svc)
}
inside && /^    image:/ && !replaced {
  sub(/image:.*/, "image: " img)
  replaced = 1
}
{ print }
' "$current" > "$candidate"
if diff -U0 "$current" "$candidate" > "$workdir/rewrite.diff" 2>/dev/null; then
  echo "ERROR: compose rewrite produced no change (service '$svc' not found or has no image line)" >&2
  exit 1
fi
changed="$(grep -cE '^[+-][^+-]' "$workdir/rewrite.diff" || true)"
if [ "$changed" != "2" ]; then
  echo "ERROR: compose rewrite touched $changed lines (expected exactly one image line); refusing to install" >&2
  cat "$workdir/rewrite.diff" >&2
  exit 1
fi
if ! grep -Fqx "+    image: $new_image" "$workdir/rewrite.diff"; then
  echo "ERROR: compose rewrite did not land the expected image line 'image: $new_image'; refusing to install" >&2
  cat "$workdir/rewrite.diff" >&2
  exit 1
fi
SNIPPET
}

# Prints the remote shell snippet that validates a rollback snapshot dir and
# emits its fields as shell assignments. Fails unless every required artifact
# is present, non-empty, and readable. Args: backup_dir
rollback_snapshot_snippet() {
  cat <<'SNIPPET'
set -eu
backup_dir="$1"
env_file="$backup_dir/rollback.env"
[ -f "$env_file" ] || { echo "ERROR: $env_file missing (incomplete snapshot)" >&2; exit 1; }
grep -q '^COMPLETE=1$' "$env_file" || { echo "ERROR: $env_file is not a COMPLETE snapshot" >&2; exit 1; }
for key in ROLLBACK_IMAGE EXPECTED_IMAGE_ID BACKUP_DIR; do
  value="$(grep "^${key}=" "$env_file" | head -1 | cut -d= -f2-)" || true
  [ -n "$value" ] || { echo "ERROR: $env_file missing $key (incomplete snapshot)" >&2; exit 1; }
done
tar tzf "$backup_dir/old-app.tar.gz" >/dev/null || { echo "ERROR: old-app.tar.gz unreadable" >&2; exit 1; }
cat "$env_file"
SNIPPET
}

# Prints the remote snippet that picks the rollback snapshot: the requested
# --backup-dir hard-verified, or the newest backup-* that passes verification.
# Printed via printf (never an expanding heredoc): the embedded verification
# snippet contains $(...) that must reach the host verbatim.
rollback_resolve_snippet() {
  local snippet
  snippet="$(rollback_snapshot_snippet)"
  if [ -n "$ROLLBACK_DIR" ]; then
    # $() strips trailing newlines: re-add one so VERIFY lands on its own line.
    printf "bash -s -- '%s' <<'VERIFY'\n%s\nVERIFY\n" "$ROLLBACK_DIR" "$snippet"
  else
    printf 'target=""\n'
    printf 'for candidate in $(ls -d backup-* 2>/dev/null | sort -r); do\n'
    printf "  if bash -s -- \"\$candidate\" <<'VERIFY'\n"
    printf '%s\n' "$snippet"
    printf 'VERIFY\n'
    printf '  then\n    target="$candidate"\n    break\n'
    printf '  else\n    echo "note: $candidate incomplete, trying older snapshot" >&2\n  fi\n'
    printf 'done\n'
    printf '[ -n "$target" ] || { echo "ERROR: no complete snapshot found under %s" >&2; exit 1; }\n' \
      "${REMOTE_WORK_ROOT}"
  fi
}

REF=""
EXPECT_VERSION="0.20.0"
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
  run_remote "set -eu; sudo docker compose -p ${PROJECT} \
    --project-directory ${REMOTE_BASE} \
    -f ${REMOTE_COMPOSE} \
    --env-file ${REMOTE_ENV} \
    up -d${1:+ $1} ${SERVICE}"
}

# Installs a compose file produced by compose_rewrite_snippet in the host
# work dir, after the snippet's own one-line-diff gate has passed.
install_compose_candidate() {
  local new_image="$1"
  run_remote "set -eu; sudo cp ${REMOTE_COMPOSE} ${REMOTE_WORK_ROOT}/compose.current && \
bash -s -- ${REMOTE_WORK_ROOT}/compose.current ${REMOTE_WORK_ROOT}/compose.candidate '${new_image}' '${SERVICE}' ${REMOTE_WORK_ROOT} <<'REWRITE'
$(compose_rewrite_snippet)
REWRITE
sudo cp ${REMOTE_WORK_ROOT}/compose.candidate ${REMOTE_COMPOSE} && \
sudo grep -A2 '^  ${SERVICE}:' ${REMOTE_COMPOSE} | grep -q 'image: ${new_image}'"
}

verify_capability() {
  local label="$1" strict="$2"
  local output
  if [ "$DRY_RUN" -eq 1 ]; then
    printf '  [dry-run] verify %s capability via docker exec\n' "$label"
    return 0
  fi
  output="$(ssh "$SSH_HOST" "set -eu; sudo docker exec ${CONTAINER} bun /app/publish-electron-release.ts capability")"
  printf '%s\n' "$output"
  grep -q '^POLO_RELEASE_PUBLISHER_SCHEMA=' <<<"$output" || {
    log "ERROR: ${label} did not report a publisher schema"
    exit 1
  }
  if [ "$strict" = "strict" ]; then
    grep -qx 'POLO_RELEASE_PUBLISHER_SCHEMA=3' <<<"$output" \
      && grep -qx 'POLO_RELEASE_PUBLISHER_ASSETS=10' <<<"$output" || {
      log "ERROR: ${label} capability probe failed (expected SCHEMA=3 and ASSETS=10)"
      exit 1
    }
  fi
  log "${label}: capability probe ok${strict:+ (schema-3 strict)}"
}

verify_public_feed() {
  local strict="$1"
  if [ "$DRY_RUN" -eq 1 ]; then
    printf '  [dry-run] verify %s{latest-mac.yml,zip} over HTTPS\n' "$PUBLIC_FEED"
    return 0
  fi
  local manifest
  manifest="$(curl --noproxy '*' -fsSL "${PUBLIC_FEED}/latest-mac.yml")"
  if [ "$strict" = "strict" ]; then
    grep -q "^version: ${EXPECT_VERSION}\$" <<<"$manifest" || {
      log "ERROR: latest-mac.yml is not at ${EXPECT_VERSION}"
      exit 1
    }
    grep -q 'url: Polo-AI-arm64.zip' <<<"$manifest" \
      && grep -q 'url: Polo-AI-x64.zip' <<<"$manifest" || {
      log "ERROR: latest-mac.yml lost the dual-architecture entries"
      exit 1
    }
  fi
  # Loose mode (rollback): only assert the feed still serves an updater
  # manifest and the x64 ZIP — historical states may lack arm64 entries.
  local zip status
  for zip in Polo-AI-x64.zip Polo-AI-arm64.zip; do
    status="$(curl --noproxy '*' -fsSL -o /dev/null -w '%{http_code}' -I "${PUBLIC_FEED}/${zip}" || true)"
    if [ "$strict" = "strict" ]; then
      [ "$status" = "200" ] || { log "ERROR: ${zip} returned HTTP ${status}"; exit 1; }
    elif [ "$zip" = "Polo-AI-x64.zip" ]; then
      [ "$status" = "200" ] || { log "ERROR: rolled-back feed serves ${zip} as HTTP ${status}"; exit 1; }
    fi
  done
  log "public feed check ok (${strict:-loose})"
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
  local rollback_image="updates-static-rollback:${stamp}"
  local context_tar
  context_tar="$(mktemp "${TMPDIR:-/tmp}/updates-static-context.XXXXXX")"

  log "deploying ${REF} (${short_sha}) as ${image_tag}; rollback anchor ${rollback_image}"
  log "step 1/6: packing Dockerfile build context from ${REF}"
  if [ "$DRY_RUN" -ne 1 ]; then
    git archive --format=tar.gz -o "$context_tar" "${REF}" -- "${CONTEXT_PATHS[@]}"
  fi

  log "step 2/6: anchoring the rollback image and taking verified backups"
  # Everything in this step must succeed before anything is built or
  # recreated: the running container is committed (docker cp patch included)
  # to a tag the new build can never overwrite, the /app tar and the compose
  # image line are captured and validated, and only then is rollback.env
  # atomically marked COMPLETE.
  run_remote "set -eu; sudo mkdir -p ${remote_build_dir} ${REMOTE_WORK_ROOT} ${backup_dir} && \
sudo chown \$(id -un) ${remote_build_dir} ${REMOTE_WORK_ROOT} ${backup_dir} && \
old_id=\$(sudo docker inspect ${CONTAINER} --format '{{.Image}}') && \
[ -n \"\$old_id\" ] && \
sudo docker commit ${CONTAINER} ${rollback_image} >/dev/null && \
committed_id=\$(sudo docker image inspect ${rollback_image} --format '{{.Id}}') && \
[ -n \"\$committed_id\" ] && \
sudo docker run --rm --entrypoint /bin/sh ${rollback_image} -c 'bun /app/publish-electron-release.ts capability' | grep -q '^POLO_RELEASE_PUBLISHER_SCHEMA=' && \
sudo docker exec ${CONTAINER} tar czf - -C / app > ${backup_dir}/old-app.tar.gz && \
tar tzf ${backup_dir}/old-app.tar.gz >/dev/null && \
[ -s ${backup_dir}/old-app.tar.gz ] && \
img_line=\$(sudo grep -A2 '^  ${SERVICE}:' ${REMOTE_COMPOSE} | grep '^    image:' | head -1) && \
[ -n \"\$img_line\" ] && \
img_ref=\${img_line#*image: } && \
[ -n \"\$img_ref\" ] && \
printf 'ROLLBACK_IMAGE=%s\nEXPECTED_IMAGE_ID=%s\nOLD_IMAGE_LINE=image: %s\nDEPLOYED_IMAGE=%s\nBACKUP_DIR=%s\nAPP_TAR=old-app.tar.gz\n' \
  '${rollback_image}' \"\$committed_id\" \"\$img_ref\" '${image_tag}' '${backup_dir}' > ${backup_dir}/rollback.env.tmp && \
printf 'COMPLETE=1\n' >> ${backup_dir}/rollback.env.tmp && \
mv ${backup_dir}/rollback.env.tmp ${backup_dir}/rollback.env && \
cat ${backup_dir}/rollback.env"

  log "step 3/6: shipping context and building on the host (x86_64, separate tag)"
  if [ "$DRY_RUN" -ne 1 ]; then
    scp -q "$context_tar" "${SSH_HOST}:${remote_build_dir}/context.tar.gz"
  else
    printf '  [dry-run] scp %s %s:%s/context.tar.gz\n' "$context_tar" "$SSH_HOST" "$remote_build_dir"
  fi
  run_remote "set -eu; cd ${remote_build_dir} && mkdir -p context && tar xzf context.tar.gz -C context && \
sudo docker build -f context/infra/updates-static/Dockerfile -t ${image_tag} context && \
sudo docker image inspect ${image_tag} --format '{{.Id}} {{.Architecture}}'"

  log "step 4/6: repointing compose ${SERVICE}.image (one-line gate) and recreating"
  install_compose_candidate "$image_tag"
  compose_up

  log "step 5/6: verifying capability (USB-01) and the public feed (USB-03)"
  verify_capability "deployed container" strict
  verify_public_feed strict

  log "step 6/6: force-recreate persistence proof (USB-02) and rollback pointer"
  compose_up "--force-recreate"
  verify_capability "force-recreated container" strict
  log "backup dir on host: ${backup_dir} (rollback.env, old-app.tar.gz; rollback image ${rollback_image})"
  log "rollback: scripts/updates-static-deploy.sh --rollback"
  rm -f "$context_tar"
}

rollback() {
  if [ -n "$ROLLBACK_DIR" ]; then
    log "rolling back using requested snapshot ${ROLLBACK_DIR} (completeness hard-verified on host)"
  else
    log "no --backup-dir given: picking the newest COMPLETE backup-* snapshot on host"
  fi
  local env_content
  if [ "$DRY_RUN" -eq 1 ]; then
    printf '  [dry-run] ssh %s <resolve + hard-verify snapshot>\n' "$SSH_HOST"
    ROLLBACK_IMAGE="updates-static-rollback:<stamp>"
    EXPECTED_IMAGE_ID="sha256:<committed-id>"
  else
    env_content="$(resolve_snapshot_on_host)"
    ROLLBACK_IMAGE="$(grep '^ROLLBACK_IMAGE=' <<<"$env_content" | head -1 | cut -d= -f2-)"
    EXPECTED_IMAGE_ID="$(grep '^EXPECTED_IMAGE_ID=' <<<"$env_content" | head -1 | cut -d= -f2-)"
    [ -n "$ROLLBACK_IMAGE" ] && [ -n "$EXPECTED_IMAGE_ID" ] || {
      log "ERROR: could not resolve a complete snapshot"
      exit 1
    }
  fi
  log "restoring ${SERVICE}.image to ${ROLLBACK_IMAGE} (expect container image ${EXPECTED_IMAGE_ID})"
  install_compose_candidate "$ROLLBACK_IMAGE"
  compose_up
  if [ "$DRY_RUN" -ne 1 ]; then
    local running_id
    running_id="$(ssh "$SSH_HOST" "set -eu; sudo docker inspect ${CONTAINER} --format '{{.Image}}'")"
    [ "$running_id" = "$EXPECTED_IMAGE_ID" ] || {
      log "ERROR: container runs ${running_id}, expected rollback anchor ${EXPECTED_IMAGE_ID}"
      exit 1
    }
    log "container image id matches the rollback anchor"
  fi
  verify_capability "rolled-back container" loose
  verify_public_feed loose
}

# Resolves the snapshot to roll back to, on the host. With --backup-dir the
# given dir is hard-verified; otherwise backup-* dirs are tried newest first
# and the first complete one wins. Prints the resolved rollback.env fields.
resolve_snapshot_on_host() {
  local remote_script
  remote_script="$(cat <<REMOTE
set -eu
cd ${REMOTE_WORK_ROOT}
$(rollback_resolve_snippet)
REMOTE
)"
  ssh "$SSH_HOST" "$remote_script"
}

if [ "${BASH_SOURCE[0]}" = "$0" ]; then
  if [ "$ROLLBACK" -eq 1 ]; then
    rollback
  else
    deploy
  fi
fi
