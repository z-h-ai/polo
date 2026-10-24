import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'bun:test'

const script = readFileSync('scripts/updates-static-deploy.sh', 'utf8')
const dockerfile = readFileSync('infra/updates-static/Dockerfile', 'utf8')

function contextPaths(): string[] {
  const block = script.slice(script.indexOf('CONTEXT_PATHS=('), script.indexOf(')\n', script.indexOf('CONTEXT_PATHS=(')))
  return [...block.matchAll(/^  (.+)$/gm)].map((match) => match[1]!)
}

function dockerfileCopySources(): string[] {
  return dockerfile
    .split('\n')
    .filter((line) => line.startsWith('COPY ') && !line.startsWith('COPY --from'))
    .flatMap((line) => line.split(/\s+/).slice(1, -1))
}

describe('updates-static-deploy script', () => {
  it('parses as valid bash', () => {
    execFileSync('bash', ['-n', 'scripts/updates-static-deploy.sh'])
  })

  it('ships every Dockerfile COPY source in the git-archive build context', () => {
    const paths = contextPaths()
    // The Dockerfile itself rides along as the build's -f target.
    expect(paths).toContain('infra/updates-static/Dockerfile')
    for (const source of dockerfileCopySources()) {
      expect(paths).toContain(source)
    }
    expect(paths.filter((path) => path !== 'infra/updates-static/Dockerfile').sort()).toEqual(
      [...dockerfileCopySources()].sort(),
    )
  })

  it('builds the image from the shipped context, never from the operator machine', () => {
    expect(script).toContain('git archive --format=tar.gz')
    expect(script).toContain('scp -q "$context_tar"')
    expect(script).toContain('sudo docker build -f context/infra/updates-static/Dockerfile')
  })

  it('backs up the old image id, compose image line, and container /app before touching anything', () => {
    expect(script).toContain('old-image-id')
    expect(script).toContain('old-app.tar.gz')
    expect(script).toContain('OLD_IMAGE_LINE=')
    expect(script).toContain('rollback.env')
    // The backup step runs before the compose rewrite step.
    expect(script.indexOf('step 3/6')).toBeGreaterThan(-1)
    expect(script.indexOf('step 3/6')).toBeLessThan(script.indexOf('step 4/6'))
  })

  it('recreates the container with the full compose parameter set, scoped to the one service', () => {
    expect(script).toContain('sudo docker compose -p ${PROJECT} \\')
    expect(script).toContain('--project-directory ${REMOTE_BASE} \\')
    expect(script).toContain('-f ${REMOTE_COMPOSE} \\')
    expect(script).toContain('--env-file ${REMOTE_ENV} \\')
    expect(script).toContain('up -d${1:+ $1} ${SERVICE}')
  })

  it('repoints only the updates-static service image line, leaving sibling services alone', () => {
    expect(script).toContain('inside = ($0 == "  " svc ":")')
    expect(script).toContain("!replaced { sub(/image:.*/, \"image: \" img); replaced = 1 }")
  })

  it('proves persistence with a post-deploy force-recreate capability probe', () => {
    expect(script).toContain('compose_up "--force-recreate"')
    expect(script.indexOf('compose_up "--force-recreate"')).toBeGreaterThan(-1)
    // The probe runs again on the recreated container.
    const forceRecreateAt = script.indexOf('compose_up "--force-recreate"')
    const secondProbe = script.indexOf('verify_capability "force-recreated container"')
    expect(secondProbe).toBeGreaterThan(forceRecreateAt)
  })

  it('verifies the schema-3 publisher capability and the public dual-arch feed', () => {
    expect(script).toContain('POLO_RELEASE_PUBLISHER_SCHEMA=3')
    expect(script).toContain('POLO_RELEASE_PUBLISHER_ASSETS=10')
    expect(script).toContain('Polo-AI-arm64.zip')
    expect(script).toContain('Polo-AI-x64.zip')
  })

  it('bypasses the fake-ip proxy for local feed checks (infra rule 5)', () => {
    expect(script).toContain("--noproxy '*'")
  })

  it('rolls back by restoring the backed-up compose image line, never by docker cp', () => {
    expect(script).toContain('restore_compose_image_line')
    expect(script).toContain('--rollback')
    // docker cp is exactly what this script exists to retire (POL-269): no
    // executable line may invoke it (the header comment describing the old
    // practice is fine).
    const executable = script
      .split('\n')
      .filter((line) => !line.trim().startsWith('#'))
      .join('\n')
    expect(executable.includes('docker cp')).toBe(false)
  })

  it('accepts --backup-dir to roll a specific snapshot back instead of the newest', () => {
    expect(script).toContain('--backup-dir')
    expect(script).toContain('ROLLBACK_DIR')
  })

  it('refuses to run when the ref is missing any Dockerfile context file', () => {
    expect(script).toContain('git cat-file -e "${REF}:${path}"')
    expect(script).toContain('Dockerfile context incomplete')
  })

  it('dry-runs end to end without touching the host', () => {
    const output = execFileSync('bash', ['scripts/updates-static-deploy.sh', '--dry-run'], {
      encoding: 'utf8',
      env: { ...process.env, UPDATES_DEPLOY_SSH_HOST: 'dry-run.invalid' },
    })
    for (const step of ['step 1/6', 'step 2/6', 'step 3/6', 'step 4/6', 'step 5/6', 'step 6/6']) {
      expect(output).toContain(step)
    }
    expect(output).toContain('updates-static:7f89d570-schema3')
    // ssh prints the command %q-escaped, hence the backslash-escaped spaces.
    expect(output).toContain('--force-recreate\\ updates-static')
    expect(output).toContain('up\\ -d\\ updates-static')
    // Dry run prints the ssh commands instead of running them.
    expect(output).toContain('[dry-run] ssh dry-run.invalid')
    expect(output).toContain('https://updates.polo.z-h-ai.com/electron/latest')
  })
})
