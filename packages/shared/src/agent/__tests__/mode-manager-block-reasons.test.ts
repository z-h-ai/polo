/**
 * Focused coverage for localized permission-mode block reasons (ux-error-feedback).
 *
 * The reasons surface in chat as tool-block messages, so they must resolve to
 * real copy (never a bare i18n key), keep the previous interpolation contract
 * ({{mode}} / {{shortcut}} / {{tool}} / {{method}} / {{path}}), localize for
 * zh-Hans, and keep the exact English shape that downstream consumers/tests
 * rely on.
 */
import { beforeEach, describe, expect, it } from 'bun:test';
import { i18n, setupI18n } from '../../i18n/index.ts';
import { SAFE_MODE_CONFIG, shouldAllowToolInMode } from '../../agent/mode-manager.ts';

setupI18n();

beforeEach(async () => {
  await i18n.changeLanguage('en');
});

describe('mode block reasons — English (canonical shape)', () => {
  it('blocked file tools explain mode + how to switch', () => {
    const result = shouldAllowToolInMode('Write', {}, 'safe');
    expect(result.allowed).toBe(false);
    if (!result.allowed) {
      expect(result.reason).toContain('File modifications are blocked in');
      expect(result.reason).toContain('Explore mode');
      expect(result.reason).toContain(SAFE_MODE_CONFIG.shortcutHint);
    }
  });

  it('mutating session tools keep the established prefix', () => {
    const result = shouldAllowToolInMode('mcp__session__update_user_preferences', {}, 'safe');
    expect(result.allowed).toBe(false);
    if (!result.allowed) {
      expect(result.reason).toContain('Session configuration changes are blocked in');
      expect(result.reason).toContain('sources and agents');
    }
  });

  it('api calls interpolate method and path', () => {
    const result = shouldAllowToolInMode('mcp__acme__api_create_thing', { method: 'POST', path: '/things' }, 'safe');
    expect(result.allowed).toBe(false);
    if (!result.allowed) {
      expect(result.reason).toContain('API POST /things is blocked in');
      expect(result.reason).toContain('Switch to Ask or Allow All mode');
    }
  });

  it('api calls without a path collapse the empty interpolation (no double spaces)', () => {
    const result = shouldAllowToolInMode('mcp__acme__api_create_thing', { method: 'POST' }, 'safe');
    expect(result.allowed).toBe(false);
    if (!result.allowed) {
      expect(result.reason).not.toContain('  ');
      expect(result.reason).toContain('API POST is blocked in');
    }
  });
});

describe('mode block reasons — zh-Hans localization', () => {
  beforeEach(async () => {
    await i18n.changeLanguage('zh-Hans');
  });

  it('file tool block renders the Chinese copy with mode + shortcut', () => {
    const result = shouldAllowToolInMode('Edit', {}, 'safe');
    expect(result.allowed).toBe(false);
    if (!result.allowed) {
      expect(result.reason).toContain('模式下无法修改文件');
      expect(result.reason).toContain(SAFE_MODE_CONFIG.shortcutHint);
      expect(result.reason).not.toContain('mode.blockReason.');
      expect(result.reason).not.toMatch(/File modifications are blocked/);
    }
  });

  it('blocked NotebookEdit falls to the generic tool template, localized', () => {
    const result = shouldAllowToolInMode('NotebookEdit', {}, 'safe');
    expect(result.allowed).toBe(false);
    if (!result.allowed) {
      expect(result.reason).toContain('NotebookEdit');
      expect(result.reason).toContain('模式下无法使用');
    }
  });

  it('session config block renders the Chinese copy', () => {
    const result = shouldAllowToolInMode('mcp__session__update_user_preferences', {}, 'safe');
    expect(result.allowed).toBe(false);
    if (!result.allowed) {
      expect(result.reason).toContain('模式下无法修改会话配置');
      expect(result.reason).toContain('数据源与智能体');
    }
  });

  it('MCP write block renders the Chinese copy', () => {
    const result = shouldAllowToolInMode('mcp__acme__write_thing', {}, 'safe');
    expect(result.allowed).toBe(false);
    if (!result.allowed) {
      expect(result.reason).toContain('MCP 写操作');
    }
  });

  it('api call block renders the Chinese copy with method/path', () => {
    const result = shouldAllowToolInMode('api_create_thing', { method: 'POST', path: '/things' }, 'safe');
    expect(result.allowed).toBe(false);
    if (!result.allowed) {
      expect(result.reason).toContain('无法调用 API（POST /things）');
    }
  });
});

describe('mode block reasons — all templates resolve in every locale', () => {
  const keys = [
    'mode.blockReason.bash',
    'mode.blockReason.fileEdit',
    'mode.blockReason.mcpWrite',
    'mode.blockReason.apiMutation',
    'mode.blockReason.apiCall',
    'mode.blockReason.sessionConfig',
    'mode.blockReason.tool',
  ];

  for (const language of ['en', 'zh-Hans', 'de', 'es', 'hu', 'ja', 'pl']) {
    it(`${language}: every template resolves (never a bare key) and keeps the mode-switch hint`, () => {
      const t = i18n.getFixedT(language);
      for (const key of keys) {
        const value = t(key, { mode: 'X', shortcut: 'S', tool: 'T', method: 'M', path: 'P' });
        expect(value).not.toBe(key);
        // Every locale must keep the actionable "how to switch" element.
        expect(value).toContain('S');
      }
    });
  }
});
