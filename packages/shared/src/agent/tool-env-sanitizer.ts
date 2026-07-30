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

/**
 * Prefix a Bash tool command with an environment scrub inside the model
 * subprocess. Returning a new input object lets the SDK execute the sanitized
 * command without putting invocation credentials in the runtime process.env.
 */
export function sanitizeShellToolInput(
  toolName: string,
  input: Record<string, unknown>,
  enabled = true,
): Record<string, unknown> {
  if (!enabled || toolName !== 'Bash' || typeof input.command !== 'string') return input;
  const marker = '# polo: invocation credential isolation';
  if (input.command.startsWith(marker)) return input;
  const unset = `unset ${TOOL_CREDENTIAL_ENV_VARS.join(' ')} 2>/dev/null || true`;
  return {
    ...input,
    command: `${marker}\n${unset}\n${input.command}`,
  };
}
