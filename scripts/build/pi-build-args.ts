/**
 * The SINGLE definition of the pi-agent-server production build argument
 * list (Node-target ESM because the production host is a Node 22 subprocess
 * — the Electron main process spawned with ELECTRON_RUN_AS_NODE=1; koffi
 * external because it is a native N-API module the bundler cannot inline).
 *
 * WHY NOT --target bun: a bun-targeted ESM bundle resolves CJS deps through
 * `var __require = import.meta.require`, which is undefined under Node — the
 * server crashed on boot (`__require is not a function`) before any model
 * request. `--target node` emits `createRequire(import.meta.url)` instead,
 * which works under both Node and bun runtimes.
 *
 * Dependency-free by design: the build orchestrator (scripts/build/
 * common.ts), the shared build entry (scripts/build/build-pi-agent-server.ts
 * consumed by the package build script and Docker), the electron dev entry
 * (scripts/electron-dev.ts) and the production acceptance staging
 * (packages/server-core request-user-input acceptance) all consume this
 * constant so every path builds the EXACT production bundle. The caller
 * supplies the runtime executable (process.execPath under bun).
 */
export function piAgentServerBuildArgs(src: string, outdir: string): string[] {
  return [
    'build',
    src,
    '--outdir',
    outdir,
    '--target',
    'node',
    '--format',
    'esm',
    '--external',
    'koffi',
  ];
}
