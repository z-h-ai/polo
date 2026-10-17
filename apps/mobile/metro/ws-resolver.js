const path = require('node:path');

const WS_STUB_PATH = path.join(__dirname, 'stub-ws.js');

// Pure resolver decision, extracted from metro.config.js so `bun test` can
// cover the ws-stub behavior without booting Metro (ws-resolver.test.ts).
function resolveWithWsStub({ moduleName, stubPath = WS_STUB_PATH, resolveDefault }) {
  if (moduleName === 'ws') {
    return { type: 'sourceFile', filePath: stubPath };
  }
  return resolveDefault();
}

module.exports = { WS_STUB_PATH, resolveWithWsStub };
