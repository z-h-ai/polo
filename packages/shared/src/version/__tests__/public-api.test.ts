import { describe, expect, it } from 'bun:test';

import * as version from '../index.ts';

describe('shared version API', () => {
  it('only exposes the application version; desktop updates use electron-updater YAML manifests', () => {
    expect(Object.keys(version).sort()).toEqual(['APP_VERSION', 'getAppVersion']);
    expect(version.getAppVersion()).toBe(version.APP_VERSION);
  });
});
