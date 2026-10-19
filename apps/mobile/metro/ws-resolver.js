const path = require('node:path');

const WS_STUB_PATH = path.join(__dirname, 'stub-ws.js');

// POL-242: the mobile conn layer consumes the server-core WsRpc transport.
// The package's exports map only exposes "./transport" (its index), whose
// transitive `node:http`/`node:https` imports are unresolvable under Metro —
// so the app pins the exact subpaths it needs to the real source files (same
// app-side adaptation spirit as the 'ws' stub; packages/* stay untouched).
// tsc checks these specifiers against types/shared-protocol.d.ts instead.
const PACKAGES_ROOT = path.join(__dirname, '..', '..', '..', 'packages');

const SERVER_CORE_SOURCE_MAP = {
  '@polo-ai/server-core/transport/client': path.join(
    PACKAGES_ROOT,
    'server-core',
    'src',
    'transport',
    'client.ts',
  ),
  '@polo-ai/server-core/transport/codec': path.join(
    PACKAGES_ROOT,
    'server-core',
    'src',
    'transport',
    'codec.ts',
  ),
};

// Pure resolver decision, extracted from metro.config.js so `bun test` can
// cover the ws-stub behavior without booting Metro (ws-resolver.test.ts).
function resolveWithWsStub({ moduleName, stubPath = WS_STUB_PATH, resolveDefault }) {
  if (moduleName === 'ws') {
    return { type: 'sourceFile', filePath: stubPath };
  }
  const serverCoreSource = SERVER_CORE_SOURCE_MAP[moduleName];
  if (serverCoreSource) {
    return { type: 'sourceFile', filePath: serverCoreSource };
  }
  return resolveDefault();
}

module.exports = { WS_STUB_PATH, SERVER_CORE_SOURCE_MAP, resolveWithWsStub };
