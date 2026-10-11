import { expect, it } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

it('real startup syncs bundled docs and defaults into each original configured instance without accessing the shared home', () => {
  const ownedRoot = mkdtempSync(join(tmpdir(), 'polo-doc-root-'))
  const checkout = resolve(import.meta.dir, '../../../..')
  // A fresh process per instance matches CONFIG_DIR's existing import-time
  // contract. The guard denies the old shared-home path before any IO.
  const probe = `
    import { mock } from 'bun:test';
    import * as fs from 'node:fs';
    import { homedir } from 'node:os';
    import { join, resolve } from 'node:path';
    const original = {...fs};
    const foreignRoots = [join(homedir(), '.polo-ai'), join(homedir(), '.claude')];
    const blocked = [];
    const guarded = {};
    for (const key of ['existsSync','mkdirSync','readFileSync','writeFileSync','readdirSync','copyFileSync']) {
      guarded[key] = (...args) => {
        for (const value of args.slice(0, key === 'copyFileSync' ? 2 : 1)) {
          if (typeof value !== 'string') continue;
          const target = resolve(value);
          if (foreignRoots.some(root => target === root || target.startsWith(root + '/'))) {
            blocked.push(key);
            throw new Error('FOREIGN_HOME_IO_DENIED');
          }
        }
        return original[key](...args);
      };
    }
    mock.module('fs', () => ({...original, ...guarded}));
    const assets = await import('./packages/shared/src/utils/paths.ts');
    assets.setBundledAssetsRoot(join(process.cwd(), 'apps/electron'));
    const expectedAssets = original.realpathSync(join(process.cwd(), 'apps/electron/resources'));
    if (original.realpathSync(assets.getBundledAssetsDir('.')) !== expectedAssets) throw new Error('BUNDLE_SOURCE_MISMATCH');
    const storage = await import('./packages/shared/src/config/storage.ts');
    const docs = await import('./packages/shared/src/docs/index.ts');
    const permissions = await import('./packages/shared/src/agent/permissions-config.ts');
    storage.ensureConfigDir();
    permissions.ensureDefaultPermissions();
    if (storage.CONFIG_DIR !== process.env.POLO_AI_CONFIG_DIR || docs.getDocsDir() !== join(storage.CONFIG_DIR, 'docs')) throw new Error('DOC_CONFIG_ROOT_MISMATCH');
    const bundledNames = original.readdirSync(join(expectedAssets, 'docs')).sort();
    const copiedNames = docs.listDocs().sort();
    if (!docs.docsExist() || JSON.stringify(copiedNames) !== JSON.stringify(bundledNames)) throw new Error('DOC_SET_MISMATCH');
    for (const name of bundledNames) {
      if (docs.getDocPath(name) !== join(storage.CONFIG_DIR, 'docs', name)) throw new Error('DOC_PATH_MISMATCH');
      if (!original.readFileSync(docs.getDocPath(name)).equals(original.readFileSync(join(expectedAssets, 'docs', name)))) throw new Error('DOC_BYTES_MISMATCH');
    }
    for (const name of ['config-defaults.json','permissions/default.json']) {
      if (!original.readFileSync(join(storage.CONFIG_DIR, name)).equals(original.readFileSync(join(expectedAssets, name)))) throw new Error('STARTUP_BYTES_MISMATCH');
    }
    storage.ensureConfigDir();
    if (blocked.length !== 0) throw new Error('FOREIGN_HOME_IO_ATTEMPTED');
    console.log(JSON.stringify({ok:true, configDir:storage.CONFIG_DIR, docCount:copiedNames.length, foreignHomeAttempts:blocked.length}));
  `
  try {
    for (const name of ['instance-a', 'instance-b']) {
      const configDir = join(ownedRoot, name)
      const run = Bun.spawnSync([process.execPath, '--eval', probe], {
        cwd: checkout,
        env: { ...process.env, POLO_AI_CONFIG_DIR: configDir, POLO_AI_DEBUG: '0' },
        stdout: 'pipe', stderr: 'pipe', timeout: 15_000,
      })
      expect(run.exitCode, run.stderr.toString()).toBe(0)
      const result = JSON.parse(run.stdout.toString().trim())
      expect(result).toMatchObject({ ok: true, configDir, foreignHomeAttempts: 0 })
      expect(result.docCount).toBeGreaterThan(0)
    }
  } finally {
    rmSync(ownedRoot, { recursive: true, force: true })
  }
})
