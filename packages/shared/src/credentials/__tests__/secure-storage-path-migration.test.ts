import { afterEach, describe, expect, it } from 'bun:test';
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SecureStorageBackend } from '../backends/secure-storage.ts';

const temporaryDirectories: string[] = [];
const adminCredential = { type: 'admin_token' as const };

function temporaryDirectory(name: string): string {
  const directory = mkdtempSync(join(tmpdir(), `polo-secure-storage-${name}-`));
  temporaryDirectories.push(directory);
  return directory;
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { force: true, recursive: true });
  }
});

describe('secure storage CONFIG_DIR compatibility', () => {
  it('keeps the default instance on its default credentials path', async () => {
    const defaultDirectory = temporaryDirectory('default');
    const backend = new SecureStorageBackend({
      credentialsDir: defaultDirectory,
      legacyCredentialsDir: defaultDirectory,
    });

    await backend.set(adminCredential, { value: 'default-access-token' });

    expect(existsSync(join(defaultDirectory, 'credentials.enc'))).toBe(true);
    expect(await new SecureStorageBackend({
      credentialsDir: defaultDirectory,
      legacyCredentialsDir: defaultDirectory,
    }).get(adminCredential)).toEqual({ value: 'default-access-token' });
  });

  it('prefers an existing custom instance file over the old shared path', async () => {
    const root = temporaryDirectory('custom');
    const customDirectory = join(root, 'custom');
    const legacyDirectory = join(root, 'legacy');
    await new SecureStorageBackend({
      credentialsDir: legacyDirectory,
      legacyCredentialsDir: legacyDirectory,
    }).set(adminCredential, { value: 'legacy-token' });
    await new SecureStorageBackend({
      credentialsDir: customDirectory,
      legacyCredentialsDir: join(root, 'unused'),
    }).set(adminCredential, { value: 'custom-token' });

    const customBackend = new SecureStorageBackend({
      credentialsDir: customDirectory,
      legacyCredentialsDir: legacyDirectory,
    });

    expect(await customBackend.get(adminCredential)).toEqual({
      value: 'custom-token',
    });
  });

  it('keeps a brand-new custom or E2E profile empty by default', async () => {
    const root = temporaryDirectory('isolated-profile');
    const customDirectory = join(root, 'custom-e2e-profile');
    const legacyDirectory = join(root, 'legacy-default-profile');
    await new SecureStorageBackend({
      credentialsDir: legacyDirectory,
      legacyCredentialsDir: legacyDirectory,
    }).set(adminCredential, {
      value: 'default-access-token',
      refreshToken: 'default-refresh-token',
    });

    const isolated = new SecureStorageBackend({
      credentialsDir: customDirectory,
      legacyCredentialsDir: legacyDirectory,
    });

    expect(await isolated.get(adminCredential)).toBeNull();
    expect(await isolated.list()).toEqual([]);
    expect(existsSync(join(customDirectory, 'credentials.enc'))).toBe(false);
    expect(existsSync(join(legacyDirectory, 'credentials.enc'))).toBe(true);
  });

  it('migrates the old fixed-path store once only with the trusted host switch', async () => {
    const root = temporaryDirectory('migration');
    const customDirectory = join(root, 'custom');
    const legacyDirectory = join(root, 'legacy');
    const legacyBackend = new SecureStorageBackend({
      credentialsDir: legacyDirectory,
      legacyCredentialsDir: legacyDirectory,
    });
    await legacyBackend.set(adminCredential, {
      value: 'legacy-access-token',
      refreshToken: 'legacy-refresh-token',
      username: 'legacy-user',
    });
    const legacyPath = join(legacyDirectory, 'credentials.enc');
    const legacyBefore = readFileSync(legacyPath);

    const migrated = await new SecureStorageBackend({
      credentialsDir: customDirectory,
      legacyCredentialsDir: legacyDirectory,
      allowLegacyPathMigration: true,
    }).get(adminCredential);

    expect(migrated).toMatchObject({
      value: 'legacy-access-token',
      refreshToken: 'legacy-refresh-token',
      username: 'legacy-user',
    });
    expect(existsSync(join(customDirectory, 'credentials.enc'))).toBe(true);
    expect(readFileSync(legacyPath)).toEqual(legacyBefore);

    await legacyBackend.set(adminCredential, { value: 'later-legacy-token' });
    expect(await new SecureStorageBackend({
      credentialsDir: customDirectory,
      legacyCredentialsDir: legacyDirectory,
    }).get(adminCredential)).toMatchObject({
      value: 'legacy-access-token',
    });
  });

  it('never deletes or copies an unreadable shared legacy file', async () => {
    const root = temporaryDirectory('corrupt');
    const customDirectory = join(root, 'custom');
    const legacyDirectory = join(root, 'legacy');
    const legacyBackend = new SecureStorageBackend({
      credentialsDir: legacyDirectory,
      legacyCredentialsDir: legacyDirectory,
    });
    await legacyBackend.set(adminCredential, { value: 'valid-before-corruption' });
    const legacyPath = join(legacyDirectory, 'credentials.enc');
    const corrupted = Buffer.from('not-an-encrypted-credential-store');
    writeFileSync(legacyPath, corrupted);

    const result = await new SecureStorageBackend({
      credentialsDir: customDirectory,
      legacyCredentialsDir: legacyDirectory,
      allowLegacyPathMigration: true,
    }).get(adminCredential);

    expect(result).toBeNull();
    expect(readFileSync(legacyPath)).toEqual(corrupted);
    expect(existsSync(join(customDirectory, 'credentials.enc'))).toBe(false);
  });

  it('never falls back when the current instance file is corrupted', async () => {
    const root = temporaryDirectory('corrupt-current');
    const customDirectory = join(root, 'custom');
    const legacyDirectory = join(root, 'legacy');
    await new SecureStorageBackend({
      credentialsDir: legacyDirectory,
      legacyCredentialsDir: legacyDirectory,
    }).set(adminCredential, { value: 'must-not-inherit' });
    await new SecureStorageBackend({
      credentialsDir: customDirectory,
      legacyCredentialsDir: customDirectory,
    }).set(adminCredential, { value: 'custom-before-corruption' });
    const currentPath = join(customDirectory, 'credentials.enc');
    writeFileSync(currentPath, Buffer.from('corrupted-current-instance'));

    const result = await new SecureStorageBackend({
      credentialsDir: customDirectory,
      legacyCredentialsDir: legacyDirectory,
      allowLegacyPathMigration: true,
    }).get(adminCredential);

    expect(result).toBeNull();
    expect(existsSync(currentPath)).toBe(false);
    expect(await new SecureStorageBackend({
      credentialsDir: legacyDirectory,
      legacyCredentialsDir: legacyDirectory,
    }).get(adminCredential)).toEqual({ value: 'must-not-inherit' });
  });
});
