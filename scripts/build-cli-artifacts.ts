import { createHash } from 'node:crypto'
import { chmodSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'

const root = join(import.meta.dir, '..')
const artifactOutputOverride = process.env.POLO_AI_CLI_ARTIFACT_OUTPUT_DIR
if (artifactOutputOverride && !Bun.argv.includes('--allow-test-output-override')) {
  throw new Error(
    'POLO_AI_CLI_ARTIFACT_OUTPUT_DIR is test-only and requires the direct artifact builder ' +
    'flag --allow-test-output-override; production electron:build/electron:dist fail closed.',
  )
}
const electronDist = artifactOutputOverride
  ? resolve(artifactOutputOverride)
  : join(root, 'apps', 'electron', 'dist')
const cliDir = join(electronDist, 'cli')
const serverDir = join(electronDist, 'server')
const cliEntry = join(root, 'apps', 'cli', 'src', 'index.ts')
const serverEntry = join(root, 'packages', 'server', 'src', 'index.ts')

const packagePaths = [
  'package.json',
  'apps/electron/package.json',
  'apps/cli/package.json',
  'packages/server/package.json',
]
const versions = packagePaths.map((path) => ({
  path,
  version: JSON.parse(readFileSync(join(root, path), 'utf8')).version as string,
}))
if (new Set(versions.map(({ version }) => version)).size !== 1) {
  throw new Error(`Release versions must match: ${JSON.stringify(versions)}`)
}

rmSync(cliDir, { recursive: true, force: true })
rmSync(serverDir, { recursive: true, force: true })
mkdirSync(cliDir, { recursive: true })
mkdirSync(serverDir, { recursive: true })

const cliBuild = await Bun.build({
  entrypoints: [cliEntry],
  outdir: cliDir,
  naming: 'polo-cli.js',
  target: 'bun',
  format: 'esm',
  minify: false,
})
if (!cliBuild.success) {
  throw new AggregateError(cliBuild.logs, 'CLI bundle build failed')
}

// markitdown-js imports CommonJS xlsx as a default export. Normalize that
// dependency only while producing the standalone server bundle.
const serverBuild = await Bun.build({
  entrypoints: [serverEntry],
  outdir: serverDir,
  naming: 'polo-server.js',
  target: 'bun',
  format: 'esm',
  minify: false,
  plugins: [{
    name: 'markitdown-xlsx-interop',
    setup(builder) {
      builder.onLoad({ filter: /markitdown-js\/dist\/markitdown\.js$/ }, async ({ path }) => ({
        contents: (await Bun.file(path).text()).replace(
          'import XLSX from "xlsx";',
          'import * as XLSX from "xlsx";',
        ),
        loader: 'js',
      }))
    },
  }],
})
if (!serverBuild.success) {
  throw new AggregateError(serverBuild.logs, 'Headless server bundle build failed')
}

const cliPath = join(cliDir, 'polo-cli.js')
const serverPath = join(serverDir, 'polo-server.js')
const cliPackagePath = join(cliDir, 'package.json')
if (process.platform !== 'win32') {
  chmodSync(cliPath, 0o755)
  chmodSync(serverPath, 0o755)
}

const sourceCliPackage = JSON.parse(
  readFileSync(join(root, 'apps', 'cli', 'package.json'), 'utf8'),
) as { name?: string; license?: string }
const rootPackage = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')) as {
  license?: string
}
writeFileSync(cliPackagePath, `${JSON.stringify({
  name: sourceCliPackage.name ?? '@polo-ai/cli',
  version: versions[0]!.version,
  type: 'module',
  main: './polo-cli.js',
  bin: {
    polo: './polo-cli.js',
    'polo-ai': './polo-cli.js',
  },
  license: sourceCliPackage.license ?? rootPackage.license ?? 'Apache-2.0',
}, null, 2)}\n`)

const sha256 = (path: string): string =>
  createHash('sha256').update(readFileSync(path)).digest('hex')

writeFileSync(join(cliDir, 'artifact-manifest.json'), `${JSON.stringify({
  schemaVersion: 1,
  version: versions[0]!.version,
  runtime: 'bun',
  artifacts: {
    cli: { path: 'dist/cli/polo-cli.js', sha256: sha256(cliPath) },
    cliPackage: { path: 'dist/cli/package.json', sha256: sha256(cliPackagePath) },
    server: { path: 'dist/server/polo-server.js', sha256: sha256(serverPath) },
  },
}, null, 2)}\n`)

console.log(`Built packaged Polo CLI: ${cliPath}`)
console.log(`Built packaged Polo server: ${serverPath}`)
