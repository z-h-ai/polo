/**
 * Minimal inherited environment for invocation-scoped runtime/model processes.
 *
 * This is intentionally an allowlist. Unknown parent variables may contain
 * credentials under product- or company-specific names and must never cross
 * the CLI runtime boundary.
 */
export const SAFE_RUNTIME_ENV_KEYS = new Set([
  'PATH',
  'USER',
  'LOGNAME',
  'SHELL',
  'LANG',
  'TERM',
  'COLORTERM',
  'TMPDIR',
  'TMP',
  'TEMP',
  'SYSTEMROOT',
  'WINDIR',
  'COMSPEC',
  'PATHEXT',
]);

export function createSafeRuntimeEnvironment(
  baseEnv: NodeJS.ProcessEnv = process.env,
  explicit: Record<string, string | undefined> = {},
): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(baseEnv)) {
    if (value === undefined) continue;
    if (SAFE_RUNTIME_ENV_KEYS.has(key) || key.startsWith('LC_')) {
      env[key] = value;
    }
  }
  for (const [key, value] of Object.entries(explicit)) {
    if (value !== undefined) env[key] = value;
  }
  return env;
}
