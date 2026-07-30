/**
 * Credentials that may be required by a model runtime but must not be inherited
 * by shell tools launched from that runtime.
 */
export const TOOL_CREDENTIAL_ENV_VARS = [
  'ANTHROPIC_API_KEY',
  'CLAUDE_CODE_OAUTH_TOKEN',
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
  'AWS_ACCESS_KEY_ID',
  'AWS_SECRET_ACCESS_KEY',
  'AWS_SESSION_TOKEN',
  'GITHUB_TOKEN',
  'GH_TOKEN',
  'NPM_TOKEN',
] as const;

const TOOL_ENV_ALLOWLIST_PATTERN =
  'PATH|HOME|USER|LOGNAME|SHELL|LANG|LC_*|TERM|COLORTERM|TMPDIR|TMP|TEMP|SYSTEMROOT|WINDIR|COMSPEC|PATHEXT|USERPROFILE|APPDATA|LOCALAPPDATA|NODE_EXTRA_CA_CERTS|SSL_CERT_FILE|SSL_CERT_DIR';

/**
 * Prefix a Bash tool command with an allowlist scrub inside the model
 * subprocess. The model runtime receives only a short-lived local capability;
 * a shell tool must receive neither that capability nor unrelated host secrets.
 */
export function sanitizeShellToolInput(
  toolName: string,
  input: Record<string, unknown>,
  enabled = true,
): Record<string, unknown> {
  if (!enabled || toolName !== 'Bash' || typeof input.command !== 'string') return input;
  const marker = '# polo: invocation credential isolation';
  if (input.command.startsWith(marker)) return input;
  const scrub = [
    '_polo_env_names="$(env | sed \'s/=.*//\')"',
    'for _polo_env_name in $_polo_env_names; do',
    `  case "$_polo_env_name" in ${TOOL_ENV_ALLOWLIST_PATTERN}) ;; *) unset "$_polo_env_name" 2>/dev/null || true ;; esac`,
    'done',
    'unset _polo_env_names _polo_env_name 2>/dev/null || true',
  ].join('\n');
  return {
    ...input,
    command: `${marker}\n${scrub}\n${input.command}`,
  };
}
