import { existsSync } from 'node:fs';
import { describe, expect, test } from 'bun:test';
import { SERVER_CORE_SOURCE_MAP, WS_STUB_PATH, resolveWithWsStub } from './ws-resolver';

describe('metro ws stub resolver (POL-230)', () => {
  test("resolves 'ws' to the empty stub without calling the default resolver", () => {
    let defaultCalled = false;
    const result = resolveWithWsStub({
      moduleName: 'ws',
      resolveDefault: () => {
        defaultCalled = true;
        return { type: 'sourceFile', filePath: '/should/not/be/used.js' };
      },
    });

    expect(defaultCalled).toBe(false);
    expect(result).toEqual({ type: 'sourceFile', filePath: WS_STUB_PATH });
    expect(existsSync(WS_STUB_PATH)).toBe(true);
  });

  test('falls through to the default resolver for other modules', () => {
    const sentinel = { type: 'sourceFile', filePath: '/fake/react.js' };
    const result = resolveWithWsStub({
      moduleName: 'react',
      resolveDefault: () => sentinel,
    });

    expect(result).toBe(sentinel);
  });
});

describe('metro server-core source map (POL-242)', () => {
  test('pins the transport client/codec subpaths to the real server-core sources', () => {
    for (const moduleName of Object.keys(SERVER_CORE_SOURCE_MAP)) {
      let defaultCalled = false;
      const result = resolveWithWsStub({
        moduleName,
        resolveDefault: () => {
          defaultCalled = true;
          return { type: 'sourceFile', filePath: '/should/not/be/used.js' };
        },
      });

      expect(defaultCalled).toBe(false);
      expect(result).toEqual({ type: 'sourceFile', filePath: SERVER_CORE_SOURCE_MAP[moduleName] });
      // Metro bundles the REAL source — the mapped files must exist.
      expect(existsSync(SERVER_CORE_SOURCE_MAP[moduleName])).toBe(true);
    }
  });

  test('does not touch unrelated @polo-ai/server-core subpaths', () => {
    const sentinel = { type: 'sourceFile', filePath: '/fake/server-core.js' };
    const result = resolveWithWsStub({
      moduleName: '@polo-ai/server-core/transport',
      resolveDefault: () => sentinel,
    });

    expect(result).toBe(sentinel);
  });
});
