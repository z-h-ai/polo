import { expect, test } from 'bun:test'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

test('packaging rejects empty assets and ambiguous static entries before producing an upload', async () => {
  const script = resolve(dirname(fileURLToPath(import.meta.url)), 'package.mjs')
  for (const defect of ['empty-html', 'empty-js', 'empty-css', 'no-entry', 'multiple-entries']) {
    const project = await mkdtemp(resolve(tmpdir(), 'polo-invalid-quote-'))
    try {
      await mkdir(resolve(project, 'dist'))
      for (const [name, content] of Object.entries({ 'index.html': '<script src="./app.js"></script>', 'app.js': 'console.log("quote")', 'app.css': 'body{color:black}' })) {
        const empty = defect === ({ 'index.html': 'empty-html', 'app.js': 'empty-js', 'app.css': 'empty-css' } as Record<string, string>)[name]
        await writeFile(resolve(project, 'dist', name), empty ? '' : content)
      }
      await writeFile(resolve(project, 'dist/polo-app.json'), JSON.stringify({ schemaVersion: 1, appId: 'quote', version: '1.0.0', runtime: 'static', entry: defect === 'no-entry' ? [] : defect === 'multiple-entries' ? ['index.html', 'app.js'] : ['index.html'], healthcheck: '/', webPath: '/', permissions: [] }))
      const child = Bun.spawn([process.execPath, script], { cwd: project, stdout: 'pipe', stderr: 'pipe' })
      await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text()])
      expect(await child.exited).not.toBe(0)
      expect(await Bun.file(resolve(project, 'polo-payload.zip')).exists()).toBe(false)
    } finally {
      await rm(project, { recursive: true, force: true })
    }
  }
}, 30_000)
