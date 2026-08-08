import { execFileSync } from 'node:child_process'
import { access, copyFile, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { build } from 'esbuild'

const scriptDir = dirname(fileURLToPath(import.meta.url))
const packageRoot = resolve(scriptDir, '..')
const srcRoot = join(packageRoot, 'src')
const distRoot = join(packageRoot, 'dist')

async function main(): Promise<void> {
  await rm(distRoot, { recursive: true, force: true })

  await build({
    entryPoints: [
      join(srcRoot, 'creator-skills', 'index.ts'),
      join(srcRoot, 'creator-skills', 'fixtures.ts'),
      join(srcRoot, 'admin', 'creator-app-publishing.ts'),
    ],
    outdir: distRoot,
    outbase: srcRoot,
    bundle: true,
    format: 'cjs',
    platform: 'node',
    target: 'node20',
    outExtension: { '.js': '.cjs' },
    logLevel: 'silent',
    sourcemap: false,
    legalComments: 'none',
  })

  for (const output of [
    join(distRoot, 'creator-skills', 'index.cjs'),
    join(distRoot, 'creator-skills', 'fixtures.cjs'),
    join(distRoot, 'admin', 'creator-app-publishing.cjs'),
  ]) {
    const normalized = (await readFile(output, 'utf8')).replace(/[ \t]+$/gm, '').trimEnd()
    await writeFile(output, `${normalized}\n`)
  }

  execFileSync(
    'bun',
    ['x', 'tsc', '-p', join(packageRoot, 'tsconfig.creator-skills.json')],
    {
      cwd: packageRoot,
      stdio: 'inherit',
    },
  )

  await mkdir(join(distRoot, 'admin'), { recursive: true })
  await copyFile(
    join(srcRoot, 'creator-app-publishing.public.d.ts'),
    join(distRoot, 'admin', 'creator-app-publishing.d.ts'),
  )

  for (const output of [
    join(distRoot, 'creator-skills', 'index.cjs'),
    join(distRoot, 'creator-skills', 'fixtures.cjs'),
    join(distRoot, 'creator-skills', 'index.d.ts'),
    join(distRoot, 'creator-skills', 'fixtures.d.ts'),
    join(distRoot, 'admin', 'creator-app-publishing.cjs'),
    join(distRoot, 'admin', 'creator-app-publishing.d.ts'),
  ]) {
    await access(output)
  }
}

main().catch(error => {
  console.error(error)
  process.exitCode = 1
})
