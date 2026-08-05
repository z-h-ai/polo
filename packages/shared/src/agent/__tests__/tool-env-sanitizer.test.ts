import { describe, expect, it } from 'bun:test';
import { sanitizeShellToolInput, TOOL_CREDENTIAL_ENV_VARS } from '../tool-env-sanitizer.ts';

describe('sanitizeShellToolInput', () => {
  it('removes model credentials from an independently spawned Bash tool', async () => {
    if (process.platform === 'win32') return;
    const secret = 'tool-env-secret-123456';
    const input = sanitizeShellToolInput('Bash', {
      command: 'printf "%s|%s" "$ANTHROPIC_API_KEY" "$UNRELATED_HOST_SECRET"',
    });
    const proc = Bun.spawn(['bash', '-c', String(input.command)], {
      stdout: 'pipe',
      stderr: 'pipe',
      env: {
        ...process.env,
        ANTHROPIC_API_KEY: secret,
        UNRELATED_HOST_SECRET: 'must-not-reach-tool',
      },
    });
    const [exitCode, stdout] = await Promise.all([
      proc.exited,
      new Response(proc.stdout).text(),
    ]);

    expect(exitCode).toBe(0);
    expect(stdout).toBe('|');
    expect(String(input.command)).not.toContain(secret);
  });

  it('covers every invocation credential key stripped from other tool runtimes', () => {
    expect(TOOL_CREDENTIAL_ENV_VARS).toContain('CLAUDE_CODE_OAUTH_TOKEN');
    expect(TOOL_CREDENTIAL_ENV_VARS).toContain('AWS_SESSION_TOKEN');
    expect(TOOL_CREDENTIAL_ENV_VARS).toContain('LLM_API_KEY');
  });

  it('leaves Electron Pi Bash commands unchanged when isolation is disabled', () => {
    const input = { command: 'printf "%s" "$POLO_CUSTOM_TOOL_ENV"' };
    expect(sanitizeShellToolInput('Bash', input, false)).toBe(input);
  });
});
