import { execFileSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, dirname, join } from 'node:path'
import { afterAll, describe, expect, it } from 'bun:test'

const SCRIPT = join(process.cwd(), 'scripts', 'updates-static-deploy.sh')
const script = readFileSync(SCRIPT, 'utf8')

function contextPaths(): string[] {
  const block = script.slice(
    script.indexOf('CONTEXT_PATHS=('),
    script.indexOf(')\n', script.indexOf('CONTEXT_PATHS=(')),
  )
  return [...block.matchAll(/^  (.+)$/gm)].map((match) => match[1]!)
}

function dockerfileCopySources(): string[] {
  const dockerfile = readFileSync('infra/updates-static/Dockerfile', 'utf8')
  return dockerfile
    .split('\n')
    .filter((line) => line.startsWith('COPY ') && !line.startsWith('COPY --from'))
    .flatMap((line) => line.split(/\s+/).slice(1, -1))
}

// A throwaway git repo carrying every Dockerfile context file, so tests pass
// an explicit --ref and never depend on the moving origin/dev reference.
const fixtures: string[] = []

function makeFixtureRepo({ omit }: { omit?: string } = {}): { root: string; sha: string } {
  const root = mkdtempSync(join(tmpdir(), 'updates-static-deploy-fixture-'))
  fixtures.push(root)
  for (const path of contextPaths()) {
    if (path === omit) continue
    mkdirSync(join(root, dirname(path)), { recursive: true })
    writeFileSync(join(root, path), `fixture: ${path}\n`)
  }
  execFileSync('git', ['init'], { cwd: root })
  execFileSync('git', ['config', 'user.email', 'fixture@example.com'], { cwd: root })
  execFileSync('git', ['config', 'user.name', 'fixture'], { cwd: root })
  execFileSync('git', ['add', '-A'], { cwd: root })
  execFileSync('git', ['commit', '-m', 'fixture'], { cwd: root })
  const sha = execFileSync('git', ['rev-parse', '--short', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim()
  return { root, sha }
}

function runDry(fixture: { root: string; sha: string }, extraArgs: string[] = []): string {
  return execFileSync(
    'bash',
    [SCRIPT, '--dry-run', '--ref', fixture.sha, ...extraArgs],
    { cwd: fixture.root, encoding: 'utf8', env: { ...process.env, UPDATES_DEPLOY_SSH_HOST: 'dry-run.invalid' } },
  )
}

// Runs `bash <scriptPath> <args...>` expecting failure; returns stderr.
function runExpectingFailure(
  scriptAndArgs: string[],
  options: { cwd?: string; env?: Record<string, string | undefined> } = {},
): string {
  const proc = Bun.spawnSync(['bash', ...scriptAndArgs], {
    cwd: options.cwd ?? process.cwd(),
    stdout: 'pipe',
    stderr: 'pipe',
    env: { ...process.env, UPDATES_DEPLOY_SSH_HOST: 'dry-run.invalid', ...options.env },
  })
  expect(proc.exitCode).not.toBe(0)
  const text = new TextDecoder()
  return text.decode(proc.stdout) + text.decode(proc.stderr)
}

// Renders one of the script's remote snippets through a source-guarded shell
// so the exact bytes that would run on the host run here.
function renderSnippet(fn: 'compose_rewrite_snippet' | 'rollback_resolve_snippet'): string {
  return execFileSync(
    'bash',
    ['-c', `source '${SCRIPT}'; ${fn === 'rollback_resolve_snippet' && process.env.FIXTURE_WORK_ROOT ? `REMOTE_WORK_ROOT='${process.env.FIXTURE_WORK_ROOT}'; ` : ''}${fn}`],
    { encoding: 'utf8' },
  )
}

afterAll(() => {
  for (const root of fixtures) rmSync(root, { recursive: true, force: true })
})

describe('updates-static-deploy script', () => {
  it('parses as valid bash', () => {
    execFileSync('bash', ['-n', SCRIPT])
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

  it('builds from the shipped context on the host, never on the operator machine', () => {
    expect(script).toContain('git archive --format=tar.gz')
    expect(script).toContain('scp -q "$context_tar"')
    expect(script).toContain('sudo docker build -f context/infra/updates-static/Dockerfile')
  })

  it('commits the running container to a dedicated rollback tag before building', () => {
    const commitAt = script.indexOf('sudo docker commit ${CONTAINER} ${rollback_image}')
    const buildAt = script.indexOf('sudo docker build -f context/infra/updates-static/Dockerfile')
    expect(commitAt).toBeGreaterThan(-1)
    expect(buildAt).toBeGreaterThan(commitAt)
    // Rollback and deploy tags must never share a name.
    expect(script).toContain('rollback_image="updates-static-rollback:${stamp}"')
    expect(script).toContain('image_tag="updates-static:${short_sha}-schema3"')
  })

  it('proves the rollback image can run the capability probe before anything changes', () => {
    expect(script).toContain(
      "sudo docker run --rm --entrypoint /bin/sh ${rollback_image} -c 'bun /app/publish-electron-release.ts capability'",
    )
    expect(script).toContain("grep -q '^POLO_RELEASE_PUBLISHER_SCHEMA='")
  })

  it('takes required backups strictly: no || true before the compose rewrite', () => {
    const anchorStep = script.indexOf('step 2/6')
    const rewriteStep = script.indexOf('step 4/6')
    const deployBody = script.slice(anchorStep, rewriteStep)
    expect(deployBody).not.toContain('|| true')
    expect(deployBody).toContain('tar tzf ${backup_dir}/old-app.tar.gz >/dev/null')
    expect(deployBody).toContain('[ -s ${backup_dir}/old-app.tar.gz ]')
    // The extracted image reference must be non-empty before rollback.env is
    // written (the remote string escapes the quotes, hence the loose match).
    expect(deployBody).toMatch(/\[ -n .{0,3}\$img_ref/)
    // rollback.env is marked COMPLETE only after every artifact verified.
    expect(deployBody).toContain('rollback.env.tmp')
    expect(deployBody).toContain('COMPLETE=1')
  })

  it('recreates the container with the full compose parameter set, scoped to the one service', () => {
    expect(script).toContain('sudo docker compose -p ${PROJECT} \\')
    expect(script).toContain('--project-directory ${REMOTE_BASE} \\')
    expect(script).toContain('-f ${REMOTE_COMPOSE} \\')
    expect(script).toContain('--env-file ${REMOTE_ENV} \\')
    expect(script).toContain('up -d${1:+ $1} ${SERVICE}')
  })

  it('gates the compose rewrite on exactly one changed image line', () => {
    expect(script).toContain('changed" != "2"')
    expect(script).toContain('refusing to install')
    expect(script).toContain('grep -Fqx "+    image: $new_image"')
  })

  it('asserts the rolled-back container runs the anchored image id', () => {
    expect(script).toContain('[ "$running_id" = "$EXPECTED_IMAGE_ID" ]')
    expect(script).toContain('expected rollback anchor')
  })

  it('refuses incomplete rollback snapshots and picks the newest complete one', () => {
    expect(script).toContain("grep -q '^COMPLETE=1$'")
    expect(script).toContain('incomplete, trying older snapshot')
    expect(script).toContain('no complete snapshot found')
  })

  it('bypasses the fake-ip proxy for local feed checks (infra rule 5)', () => {
    expect(script).toContain("--noproxy '*'")
  })

  it('never uses docker cp (supplementary: the flow is image-borne by construction)', () => {
    const executable = script
      .split('\n')
      .filter((line) => !line.trim().startsWith('#'))
      .join('\n')
    expect(executable.includes('docker cp')).toBe(false)
  })

  describe('compose rewrite snippet', () => {
    const work = mkdtempSync(join(tmpdir(), 'updates-static-deploy-rewrite-'))
    fixtures.push(work)

    function writeCompose(content: string): string {
      writeFileSync(join(work, 'current.yml'), content)
      return join(work, 'current.yml')
    }

    it('changes exactly the target image line and never a sibling service', () => {
      const current = writeCompose(
        [
          'services:',
          '  polo-postgres:',
          '    image: registry.example/postgres:16',
          '  updates-static:',
          '    image: registry.example/updates:old',
          '  polo-api: # heading with an inline comment',
          '    image: registry.example/api:v1',
          '      updates-static:',
          '        image: trap-six-space',
          '    other-key: value',
          '',
        ].join('\n'),
      )
      const snippet = renderSnippet('compose_rewrite_snippet')
      const snippetPath = join(work, 'rewrite.sh')
      writeFileSync(snippetPath, snippet)
      execFileSync(
        'bash',
        [snippetPath, current, join(work, 'candidate.yml'), 'updates-static:abc1234-schema3', 'updates-static', work],
      )
      const result = readFileSync(join(work, 'candidate.yml'), 'utf8')
      expect(result).toContain('image: updates-static:abc1234-schema3')
      expect(result).toContain('image: registry.example/api:v1')
      expect(result).toContain('image: trap-six-space')
      expect(result).toContain('image: registry.example/postgres:16')
      expect(result.match(/updates-static:abc1234-schema3/g)).toHaveLength(1)
    })

    it('refuses to install when the service block is missing', () => {
      const snippetPath = join(work, 'rewrite.sh')
      writeFileSync(snippetPath, renderSnippet('compose_rewrite_snippet'))
      const stderr = runExpectingFailure([
        snippetPath,
        join(work, 'current.yml'),
        join(work, 'c2.yml'),
        'whatever',
        'no-such-service',
        work,
      ])
      expect(stderr).toContain('produced no change')
    })
  })

  describe('rollback snapshot verification', () => {
    const work = mkdtempSync(join(tmpdir(), 'updates-static-deploy-rollback-'))
    fixtures.push(work)

    function makeSnapshot(name: string, { complete = true, tarOk = true } = {}): string {
      const dir = join(work, name)
      mkdirSync(dir, { recursive: true })
      const fields = [
        'ROLLBACK_IMAGE=updates-static-rollback:stamp',
        'EXPECTED_IMAGE_ID=sha256:deadbeef',
        'OLD_IMAGE_LINE=image: registry.example/updates:old',
        `BACKUP_DIR=${dir}`,
        'APP_TAR=old-app.tar.gz',
      ]
      writeFileSync(join(dir, 'rollback.env'), `${fields.join('\n')}\n${complete ? 'COMPLETE=1\n' : ''}`)
      if (tarOk) {
        const payload = join(dir, 'app')
        mkdirSync(payload, { recursive: true })
        writeFileSync(join(payload, 'publish-electron-release.ts'), 'x\n')
        execFileSync('tar', ['czf', join(dir, 'old-app.tar.gz'), '-C', dir, 'app'])
      } else {
        writeFileSync(join(dir, 'old-app.tar.gz'), 'not a tar')
      }
      return dir
    }

    function runVerify(dir: string): { ok: boolean; output: string } {
      const snippetPath = join(work, 'verify.sh')
      writeFileSync(
        snippetPath,
        execFileSync('bash', ['-c', `source '${SCRIPT}'; rollback_snapshot_snippet`], { encoding: 'utf8' }),
      )
      const proc = Bun.spawnSync(['bash', snippetPath, dir], { stdout: 'pipe', stderr: 'pipe' })
      const text = new TextDecoder()
      return {
        ok: proc.exitCode === 0,
        output: text.decode(proc.stdout) + text.decode(proc.stderr),
      }
    }

    it('accepts a complete snapshot and prints its fields', () => {
      const dir = makeSnapshot('backup-good')
      const result = runVerify(dir)
      expect(result.ok).toBe(true)
      expect(result.output).toContain('ROLLBACK_IMAGE=updates-static-rollback:stamp')
      expect(result.output).toContain('EXPECTED_IMAGE_ID=sha256:deadbeef')
    })

    it('rejects snapshots missing the COMPLETE mark, a key, or a readable tar', () => {
      expect(runVerify(makeSnapshot('backup-nocomplete', { complete: false })).ok).toBe(false)
      expect(
        runVerify(makeSnapshot('backup-notar', { tarOk: false })).ok,
      ).toBe(false)
      const keyless = join(work, 'backup-keyless')
      mkdirSync(keyless, { recursive: true })
      writeFileSync(join(keyless, 'rollback.env'), 'COMPLETE=1\nROLLBACK_IMAGE=\n')
      expect(runVerify(keyless).ok).toBe(false)
    })

    it('scan mode resolves the newest complete snapshot, skipping incomplete ones', () => {
      makeSnapshot('backup-aaa', { complete: false })
      makeSnapshot('backup-zzz')
      process.env.FIXTURE_WORK_ROOT = work
      const resolveScript = renderSnippet('rollback_resolve_snippet')
      delete process.env.FIXTURE_WORK_ROOT
      const resolvePath = join(work, 'resolve.sh')
      writeFileSync(resolvePath, resolveScript)
      const output = execFileSync('bash', [resolvePath], { cwd: work, encoding: 'utf8' })
      expect(output).toContain('BACKUP_DIR=' + join(work, 'backup-zzz'))
    })
  })

  describe('end-to-end dry run', () => {
    it('runs all six steps against an explicit fixture ref without touching the host', () => {
      const fixture = makeFixtureRepo()
      const output = runDry(fixture)
      for (const step of ['step 1/6', 'step 2/6', 'step 3/6', 'step 4/6', 'step 5/6', 'step 6/6']) {
        expect(output).toContain(step)
      }
      const tag = `updates-static:${fixture.sha}-schema3`
      expect(output).toContain(tag)
      expect(output).toContain('updates-static-rollback:')
      // ssh prints commands %q-escaped, hence the backslash-escaped space.
      expect(output).toContain('sudo\\ docker\\ commit')
      // ssh prints commands %q-escaped, hence the backslash-escaped spaces.
      expect(output).toContain('up\\ -d\\ updates-static')
      expect(output).toContain('--force-recreate\\ updates-static')
      expect(output).toContain('[dry-run] ssh dry-run.invalid')
      expect(output).toContain('https://updates.polo.z-h-ai.com/electron/latest')
    })

    it('fails fast when the ref is missing a Dockerfile context file', () => {
      const fixture = makeFixtureRepo({ omit: 'scripts/strict-semver.ts' })
      const output = runExpectingFailure([SCRIPT, '--dry-run', '--ref', fixture.sha], { cwd: fixture.root })
      expect(output).toContain('Dockerfile context incomplete')
    })

    it('fails fast when run outside the repository root', () => {
      const outside = mkdtempSync(join(tmpdir(), 'updates-static-deploy-outside-'))
      fixtures.push(outside)
      const stderr = runExpectingFailure([SCRIPT, '--dry-run', '--ref', 'HEAD'], { cwd: outside })
      expect(stderr).toContain('repository root')
    })

    it('dry-run rollback plans the restore without executing it', () => {
      const fixture = makeFixtureRepo()
      const output = execFileSync(
        'bash',
        [SCRIPT, '--dry-run', '--ref', fixture.sha, '--rollback'],
        { cwd: fixture.root, encoding: 'utf8', env: { ...process.env, UPDATES_DEPLOY_SSH_HOST: 'dry-run.invalid' } },
      )
      expect(output).toContain('newest COMPLETE backup-* snapshot')
      expect(output).toContain('updates-static-rollback:<stamp>')
      expect(output).toContain('up\\ -d\\ updates-static')
    })
  })
})
