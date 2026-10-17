const { getDefaultConfig } = require('expo/metro-config');
const { resolveWithWsStub } = require('./metro/ws-resolver');

const config = getDefaultConfig(__dirname);

// RN compat (PRD v1.6 C6): 'ws' resolves to an empty stub, everything else
// falls through to Metro's default resolver.
config.resolver.resolveRequest = (context, moduleName, platform) =>
  resolveWithWsStub({
    moduleName,
    resolveDefault: () => context.resolveRequest(context, moduleName, platform),
  });

module.exports = config;
