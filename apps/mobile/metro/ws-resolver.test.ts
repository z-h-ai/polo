import { existsSync } from 'node:fs';
import { describe, expect, test } from 'bun:test';
import { WS_STUB_PATH, resolveWithWsStub } from './ws-resolver';

describe('metro ws stub resolver (POL-5)', () => {
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
