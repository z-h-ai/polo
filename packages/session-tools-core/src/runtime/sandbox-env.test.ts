import { describe, it, expect, afterEach } from 'bun:test';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BLOCKED_ENV_VARS, createSanitizedEnv, createScriptRuntimeEnv } from './sandbox-env.ts';

describe('sandbox-env', () => {
  const createdDirs: string[] = [];

  afterEach(() => {
    for (const dir of createdDirs.splice(0)) {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('preserves Electron custom env while stripping known credential vars', () => {
    const base: NodeJS.ProcessEnv = {
      SAFE_VAR: 'ok',
    };

    for (const key of BLOCKED_ENV_VARS) {
      base[key] = `${key.toLowerCase()}-secret`;
    }

    const sanitized = createSanitizedEnv(base);

    expect(sanitized.SAFE_VAR).toBe('ok');
    for (const key of BLOCKED_ENV_VARS) {
      expect(sanitized[key]).toBeUndefined();
    }
  });

  it('uses an allowlist only for the CLI one-shot runtime profile', () => {
    const sanitized = createSanitizedEnv({
      PATH: '/bin',
      SAFE_VAR: 'electron-custom-value',
      OPENAI_API_KEY: 'secret',
      POLO_AI_RUNTIME_PROFILE: 'cli-one-shot',
    });

    expect(sanitized.PATH).toBe('/bin');
    expect(sanitized.SAFE_VAR).toBeUndefined();
    expect(sanitized.OPENAI_API_KEY).toBeUndefined();
    expect(sanitized.POLO_AI_RUNTIME_PROFILE).toBeUndefined();
  });

  it('sets python/uv cache and temp dirs inside data directory', () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'sandbox-env-python-'));
    createdDirs.push(dataDir);

    const env = createScriptRuntimeEnv({
      language: 'python3',
      dataDir,
      credentialIsolation: true,
    }, {
      SAFE_VAR: 'ok',
      OPENAI_API_KEY: 'secret',
    });

    expect(env.SAFE_VAR).toBeUndefined();
    expect(env.OPENAI_API_KEY).toBeUndefined();

    expect(env.TMPDIR).toBe(join(dataDir, '.tmp'));
    expect(env.TMP).toBe(join(dataDir, '.tmp'));
    expect(env.TEMP).toBe(join(dataDir, '.tmp'));
    expect(env.UV_CACHE_DIR).toBe(join(dataDir, '.uv-cache'));
    expect(env.XDG_CACHE_HOME).toBe(join(dataDir, '.cache'));
    expect(env.PYTHONPYCACHEPREFIX).toBe(join(dataDir, '.pycache'));

    expect(existsSync(env.TMPDIR!)).toBe(true);
    expect(existsSync(env.UV_CACHE_DIR!)).toBe(true);
    expect(existsSync(env.XDG_CACHE_HOME!)).toBe(true);
    expect(existsSync(env.PYTHONPYCACHEPREFIX!)).toBe(true);
  });

  it('keeps Electron script tool custom environment variables', () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'sandbox-env-electron-'));
    createdDirs.push(dataDir);

    const env = createScriptRuntimeEnv({
      language: 'node',
      dataDir,
      credentialIsolation: false,
    }, {
      POLO_CUSTOM_TOOL_ENV: 'desktop-value',
      OPENAI_API_KEY: 'secret',
    });

    expect(env.POLO_CUSTOM_TOOL_ENV).toBe('desktop-value');
    expect(env.OPENAI_API_KEY).toBeUndefined();
  });

  it('does not add python-specific cache vars for node runtime', () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'sandbox-env-node-'));
    createdDirs.push(dataDir);

    const env = createScriptRuntimeEnv({
      language: 'node',
      dataDir,
    });

    expect(env.TMPDIR).toBe(join(dataDir, '.tmp'));
    expect(env.UV_CACHE_DIR).toBeUndefined();
    expect(env.XDG_CACHE_HOME).toBeUndefined();
    expect(env.PYTHONPYCACHEPREFIX).toBeUndefined();
  });
});
