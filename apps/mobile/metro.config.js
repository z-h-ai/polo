const path = require('node:path');
const fs = require('node:fs');

const { getDefaultConfig } = require('expo/metro-config');
const { resolveWithWsStub } = require('./metro/ws-resolver');

const config = getDefaultConfig(__dirname);

// React dedupe (web 预览导出): 仓库根 node_modules 携带 react@18，而本包固定
// react 19 — 把 react / react-dom 直接映射到本包 node_modules（realpath 化，
// 兼容 worktree 里 node_modules 为 symlink 的布局），保证 Metro 只打进一份
// React（react-dom 18 + react 19 混载即白屏）。
const LOCAL_NM = fs.realpathSync(path.resolve(__dirname, 'node_modules'));
const REACT_NM = path.join(LOCAL_NM, 'react');
const REACT_DOM_NM = path.join(LOCAL_NM, 'react-dom');

// The mapped files live in the real (non-worktree) node_modules — watch them.
config.watchFolders = [...(config.watchFolders ?? []), LOCAL_NM];

function resolveReactLike(moduleName) {
  let sub = null;
  if (moduleName === 'react') sub = 'index';
  else if (moduleName === 'react-dom') sub = 'index';
  else if (moduleName.startsWith('react/')) sub = moduleName.slice('react/'.length);
  else if (moduleName.startsWith('react-dom/')) sub = moduleName.slice('react-dom/'.length);
  if (sub === null) return null;
  const base = moduleName.startsWith('react-dom') ? REACT_DOM_NM : REACT_NM;
  // moduleName may omit the extension (react/jsx-runtime) — probe candidates.
  for (const candidate of [path.join(base, sub), path.join(base, sub + '.js'), path.join(base, sub, 'index.js')]) {
    if (fs.existsSync(candidate)) return candidate;
  }
  return null;
}

// RN compat (PRD v1.6 C6): 'ws' resolves to an empty stub, everything else
// falls through to Metro's default resolver.
config.resolver.resolveRequest = (context, moduleName, platform) => {
  const reactLike = resolveReactLike(moduleName);
  if (reactLike) {
    return { type: 'sourceFile', filePath: reactLike };
  }
  return resolveWithWsStub({
    moduleName,
    resolveDefault: () => context.resolveRequest(context, moduleName, platform),
  });
};

module.exports = config;
