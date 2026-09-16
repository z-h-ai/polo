import { describe, it, expect } from 'bun:test';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { resolveScriptRuntime } from './resolve-script-runtime.ts';

describe('resolveScriptRuntime', () => {
  it('prefers POLO_AI_UV for python3', () => {
    const prev = process.env.POLO_AI_UV;
    process.env.POLO_AI_UV = '/tmp/custom-uv';

    try {
      const resolved = resolveScriptRuntime('python3', { isPackaged: false });
      expect(resolved.command).toBe('/tmp/custom-uv');
      expect(resolved.argsPrefix).toEqual(['run', '--python', '3.12']);
      expect(resolved.source).toBe('env');
    } finally {
      if (prev === undefined) delete process.env.POLO_AI_UV;
      else process.env.POLO_AI_UV = prev;
    }
  });

  it('prefers bundled uv when env is missing', () => {
    const prevUv = process.env.POLO_AI_UV;
    delete process.env.POLO_AI_UV;

    const base = mkdtempSync(join(tmpdir(), 'runtime-resolver-'));
    const uvPath = join(base, 'resources', 'bin', `${process.platform}-${process.arch}`, process.platform === 'win32' ? 'uv.exe' : 'uv');
    mkdirSync(join(base, 'resources', 'bin', `${process.platform}-${process.arch}`), { recursive: true });
    writeFileSync(uvPath, '');

    try {
      const resolved = resolveScriptRuntime('python3', { isPackaged: true, resourcesBasePath: base });
      expect(resolved.command).toBe(uvPath);
      expect(resolved.source).toBe('bundled');
    } finally {
      if (prevUv === undefined) delete process.env.POLO_AI_UV;
      else process.env.POLO_AI_UV = prevUv;
    }
  });

  it('blocks PATH fallback in packaged mode', () => {
    const prevUv = process.env.POLO_AI_UV;
    const prevBase = process.env.POLO_AI_RESOURCES_BASE;
    const prevRoot = process.env.POLO_AI_APP_ROOT;
    delete process.env.POLO_AI_UV;
    delete process.env.POLO_AI_RESOURCES_BASE;
    delete process.env.POLO_AI_APP_ROOT;

    try {
      expect(() => resolveScriptRuntime('python3', { isPackaged: true })).toThrow(
        'packaged app'
      );
    } finally {
      if (prevUv === undefined) delete process.env.POLO_AI_UV;
      else process.env.POLO_AI_UV = prevUv;
      if (prevBase === undefined) delete process.env.POLO_AI_RESOURCES_BASE;
      else process.env.POLO_AI_RESOURCES_BASE = prevBase;
      if (prevRoot === undefined) delete process.env.POLO_AI_APP_ROOT;
      else process.env.POLO_AI_APP_ROOT = prevRoot;
    }
  });

  it('rejects bare POLO_AI_NODE command in packaged mode', () => {
    const prev = process.env.POLO_AI_NODE;
    process.env.POLO_AI_NODE = 'node';

    try {
      expect(() => resolveScriptRuntime('node', { isPackaged: true })).toThrow(
        'do not allow PATH-based runtime resolution'
      );
    } finally {
      if (prev === undefined) delete process.env.POLO_AI_NODE;
      else process.env.POLO_AI_NODE = prev;
    }
  });

  it('recognizes the headless server packaged-mode value', () => {
    const prevPackaged = process.env.POLO_AI_IS_PACKAGED;
    const prevNode = process.env.POLO_AI_NODE;
    process.env.POLO_AI_IS_PACKAGED = 'true';
    process.env.POLO_AI_NODE = 'node';

    try {
      expect(() => resolveScriptRuntime('node')).toThrow(
        'do not allow PATH-based runtime resolution'
      );
    } finally {
      if (prevPackaged === undefined) delete process.env.POLO_AI_IS_PACKAGED;
      else process.env.POLO_AI_IS_PACKAGED = prevPackaged;
      if (prevNode === undefined) delete process.env.POLO_AI_NODE;
      else process.env.POLO_AI_NODE = prevNode;
    }
  });

  it('prefers POLO_AI_BUN for bun in dev', () => {
    const prev = process.env.POLO_AI_BUN;
    process.env.POLO_AI_BUN = '/tmp/custom-bun';

    try {
      const resolved = resolveScriptRuntime('bun', { isPackaged: false });
      expect(resolved.command).toBe('/tmp/custom-bun');
      expect(resolved.argsPrefix).toEqual([]);
      expect(resolved.source).toBe('env');
    } finally {
      if (prev === undefined) delete process.env.POLO_AI_BUN;
      else process.env.POLO_AI_BUN = prev;
    }
  });
});
