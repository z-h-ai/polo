import { createHash } from 'node:crypto'
import { chmodSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const root = join(import.meta.dir, '..')
const electronDist = join(root, 'apps', 'electron', 'dist')
const cliDir = join(electronDist, 'cli')
const serverDir = join(electronDist, 'server')
const cliEntry = join(root, 'apps', 'cli', 'src', 'index.ts')
const serverEntry = join(root, 'packages', 'server', 'src', 'index.ts')

const versions = {
  app: JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).version as string,
  electron: JSON.parse(readFileSync(join(root, 'apps', 'electron', 'package.json'), 'utf8')).version as string,
  cli: JSON.parse(readFileSync(join(root, 'apps', 'cli', 'package.json'), 'utf8')).version as string,
  server: JSON.parse(readFileSync(join(root, 'packages', 'server', 'package.json'), 'utf8')).version as string,
}

if (new Set(Object.values(versions)).size !== 1) {
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

// markitdown-js currently imports a CommonJS xlsx package as a default export.
// Bun's stricter bundler rejects that edge even though it is valid at runtime.
// Normalize only that dependency during the server bundle build.
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

function sha256(path: string): string {
  return createHash('sha256').update(readFileSync(path)).digest('hex')
}

const sourceCliPackage = JSON.parse(
  readFileSync(join(root, 'apps', 'cli', 'package.json'), 'utf8'),
) as { name?: string; license?: string }
const cliPackage = {
  name: sourceCliPackage.name ?? '@polo-ai/cli',
  version: versions.cli,
  type: 'module',
  main: './polo-cli.js',
  bin: {
    polo: './polo-cli.js',
    'polo-ai': './polo-cli.js',
  },
  license: sourceCliPackage.license
    ?? JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).license
    ?? 'Apache-2.0',
}
writeFileSync(cliPackagePath, `${JSON.stringify(cliPackage, null, 2)}\n`, 'utf8')

const manifest = {
  schemaVersion: 1,
  version: versions.app,
  runtime: 'bun',
  generatedAt: new Date().toISOString(),
  artifacts: {
    cli: { path: 'dist/cli/polo-cli.js', sha256: sha256(cliPath) },
    cliPackage: { path: 'dist/cli/package.json', sha256: sha256(cliPackagePath) },
    server: { path: 'dist/server/polo-server.js', sha256: sha256(serverPath) },
  },
}
writeFileSync(
  join(cliDir, 'artifact-manifest.json'),
  `${JSON.stringify(manifest, null, 2)}\n`,
  'utf8',
)

console.log(`✓ Built Polo CLI ${versions.app}: ${cliPath}`)
console.log(`✓ Built packaged server ${versions.app}: ${serverPath}`)
