import { describe, expect, it } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const repoRoot = join(import.meta.dir, '..', '..', '..', '..');

function readRepoFile(relativePath: string): string {
  return readFileSync(join(repoRoot, relativePath), 'utf-8');
}

describe('interceptor packaging contract', () => {
  it('includes interceptor-request-utils.ts in all packaging manifests/scripts', () => {
    const builderYml = readRepoFile('apps/electron/electron-builder.yml');
    const runtimePreparation = readRepoFile('scripts/build/common.ts');
    const distEntry = readRepoFile('scripts/electron-dist.ts');
    const dmgScript = readRepoFile('apps/electron/scripts/build-dmg.sh');
    const linuxScript = readRepoFile('apps/electron/scripts/build-linux.sh');
    const winScript = readRepoFile('apps/electron/scripts/build-win.ps1');

    expect(builderYml).toContain('packages/shared/src/interceptor-request-utils.ts');
    expect(runtimePreparation).toContain("'interceptor-request-utils.ts'");
    expect(distEntry).toContain('prepareRuntime(runtimeOptions)');
    for (const legacyEntry of [dmgScript, linuxScript, winScript]) {
      expect(legacyEntry.replaceAll('\\', '/')).toContain('scripts/electron-dist.ts');
    }
  });
});
