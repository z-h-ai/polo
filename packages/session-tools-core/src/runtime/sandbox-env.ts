/**
 * Shared environment sanitization for script-execution tools.
 */

import { mkdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import type { ScriptRuntimeLanguage } from './resolve-script-runtime.ts';

/**
 * Env vars stripped from subprocesses to prevent credential leakage.
 * NOTE: Keep in sync with packages/shared/src/mcp/client.ts (BLOCKED_ENV_VARS).
 */
export const BLOCKED_ENV_VARS = [
  'ANTHROPIC_API_KEY',
  'CLAUDE_CODE_OAUTH_TOKEN',
  'AWS_ACCESS_KEY_ID',
  'AWS_SECRET_ACCESS_KEY',
  'AWS_SESSION_TOKEN',
  'GITHUB_TOKEN',
  'GH_TOKEN',
  'OPENAI_API_KEY',
  'GOOGLE_API_KEY',
  'OPENROUTER_API_KEY',
  'GROQ_API_KEY',
  'MISTRAL_API_KEY',
  'DEEPSEEK_API_KEY',
  'XAI_API_KEY',
  'CEREBRAS_API_KEY',
  'HUGGINGFACE_API_KEY',
  'LLM_API_KEY',
  'STRIPE_SECRET_KEY',
  'NPM_TOKEN',
] as const;

export const TOOL_ENV_ALLOWLIST = new Set([
  'PATH',
  'HOME',
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
  'USERPROFILE',
  'APPDATA',
  'LOCALAPPDATA',
  'NODE_EXTRA_CA_CERTS',
  'SSL_CERT_FILE',
  'SSL_CERT_DIR',
]);

/**
 * Build a tool environment from an explicit allowlist. A denylist cannot
 * protect invocation credentials carried under new provider-specific names.
 */
export function createSanitizedEnv(baseEnv: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(baseEnv)) {
    if (value !== undefined && (TOOL_ENV_ALLOWLIST.has(key) || key.startsWith('LC_'))) {
      env[key] = value;
    }
  }
  return env;
}

export interface ScriptRuntimeEnvOptions {
  language: ScriptRuntimeLanguage;
  dataDir: string;
}

/**
 * Build a sanitized subprocess env with runtime-local cache/temp paths.
 *
 * For Python/uv, redirect caches away from home-directory defaults (e.g. ~/.cache/uv)
 * into the writable session data directory so sandboxed execution remains reliable.
 */
export function createScriptRuntimeEnv(
  options: ScriptRuntimeEnvOptions,
  baseEnv: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
  const env = createSanitizedEnv(baseEnv);
  const dataDir = resolve(options.dataDir);

  const tmpDir = join(dataDir, '.tmp');
  mkdirSync(tmpDir, { recursive: true });

  // Shared temp override (helps avoid host temp paths that may be blocked by FS isolation)
  env.TMPDIR = tmpDir;
  env.TMP = tmpDir;
  env.TEMP = tmpDir;

  if (options.language === 'python3') {
    const uvCacheDir = join(dataDir, '.uv-cache');
    const xdgCacheHome = join(dataDir, '.cache');
    const pythonPyCachePrefix = join(dataDir, '.pycache');

    mkdirSync(uvCacheDir, { recursive: true });
    mkdirSync(xdgCacheHome, { recursive: true });
    mkdirSync(pythonPyCachePrefix, { recursive: true });

    env.UV_CACHE_DIR = uvCacheDir;
    env.XDG_CACHE_HOME = xdgCacheHome;
    env.PYTHONPYCACHEPREFIX = pythonPyCachePrefix;
  }

  return env;
}
