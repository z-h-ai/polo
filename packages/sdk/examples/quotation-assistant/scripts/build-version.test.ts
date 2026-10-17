import { expect, test } from 'bun:test'
import { cp, mkdtemp, readFile, rm, symlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

test('example versions follow the receiving Admin SemVer contract', async () => {
  const example = resolve(dirname(fileURLToPath(import.meta.url)), '..')
  const project = await mkdtemp(resolve(tmpdir(), 'polo-quote-version-'))
  try {
    await cp(example, project, { recursive: true, filter: source => !['dist', 'node_modules', 'polo-payload.zip'].includes(source.split('/').at(-1)!) })
    await symlink(resolve(example, '../../../../node_modules'), resolve(project, 'node_modules'), 'dir')
    for (const [version, accepted] of [['01.0.0', false], ['1.0.0-x.', false], ['1.0.0+' + 'x'.repeat(60), false], ['1.0.0-rc.2+build.4', true]] as const) {
      const child = Bun.spawn([process.execPath, resolve(project, 'scripts/build.mjs')], { cwd: project, env: { ...process.env, POLO_APP_ID: 'dd96e4c8-50ec-4ffc-b33e-526c0c7b7c3f', POLO_APP_VERSION: version }, stdout: 'pipe', stderr: 'pipe' })
      await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text()])
      expect((await child.exited) === 0).toBe(accepted)
      if (accepted) expect(JSON.parse(await readFile(resolve(project, 'dist/polo-app.json'), 'utf8')).version).toBe(version)
    }
  } finally { await rm(project, { recursive: true, force: true }) }
}, 30_000)
