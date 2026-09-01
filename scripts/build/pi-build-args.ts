/**
 * The SINGLE definition of the pi-agent-server production build argument
 * list (bun + ESM because its Pi SDK deps are ESM-only; koffi external
 * because it is a native N-API module bun cannot inline).
 *
 * Dependency-free by design: both the build orchestrator
 * (scripts/build/common.ts) and the POO-53 acceptance staging
 * (packages/server-core request-user-input acceptance) consume this constant
 * so the acceptance always builds the EXACT production bundle. The caller
 * supplies the runtime executable (process.execPath under bun).
 */
export function piAgentServerBuildArgs(src: string, outdir: string): string[] {
  return [
    'build',
    src,
    '--outdir',
    outdir,
    '--target',
    'bun',
    '--format',
    'esm',
    '--external',
    'koffi',
  ];
}
