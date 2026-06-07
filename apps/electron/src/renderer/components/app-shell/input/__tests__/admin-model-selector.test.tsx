import React from 'react'
import { describe, expect, it, mock } from 'bun:test'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { renderToStaticMarkup } from 'react-dom/server'
import type { StoredConfig } from '@polo-ai/shared/config'
import type { LlmConnectionWithStatus } from '@config/llm-connections'
import { NoLlmConfigBanner } from '@/components/NoLlmConfigBanner'
import {
  AdminLlmModelSelectorPanel,
  resolveAdminModelSelection,
} from '../AdminLlmModelSelectorPanel'
import { DesktopAdminLlmModelSelectorControls } from '../DesktopAdminLlmModelSelectorControls'

function connection(
  slug: string,
  name: string,
  models: string[],
  defaultModel: string,
  overrides: Partial<LlmConnectionWithStatus> = {},
): LlmConnectionWithStatus {
  return {
    slug,
    name,
    providerType: 'anthropic',
    authType: 'api_key',
    models,
    defaultModel,
    createdAt: 1,
    isAuthenticated: true,
    ...overrides,
  }
}

const anthropic = connection(
  'anthropic-api',
  'Anthropic API',
  ['claude-opus-4-6', 'claude-sonnet-4-6', 'claude-haiku-4-6'],
  'claude-sonnet-4-6',
  { isDefault: true },
)

const openai = connection(
  'openai-api',
  'OpenAI API',
  ['gpt-5.1', 'gpt-5.1-mini'],
  'gpt-5.1',
)

function storedConfig(llmConnections: LlmConnectionWithStatus[]): StoredConfig {
  return {
    version: '1.0.0',
    workspaces: [],
    defaultLlmConnection: llmConnections.find(c => c.isDefault)?.slug ?? llmConnections[0]?.slug,
    llmConnections,
  } as unknown as StoredConfig
}

function renderSelector(config: StoredConfig, currentModel = '') {
  return renderToStaticMarkup(
    <AdminLlmModelSelectorPanel
      llmConnections={(config.llmConnections ?? []) as LlmConnectionWithStatus[]}
      currentConnection={config.defaultLlmConnection ?? undefined}
      currentModel={currentModel}
      onConnectionChange={() => {}}
      onModelChange={() => {}}
    />,
  )
}

describe('AdminLlmModelSelectorPanel', () => {
  it('renders a connection dropdown with all StoredConfig LLM connections', () => {
    const html = renderSelector(storedConfig([anthropic, openai]))

    expect(html).toContain('aria-label="LLM 连接"')
    expect(html).toContain('value="anthropic-api" selected=""')
    expect(html).toContain('Anthropic API')
    expect(html).toContain('OpenAI API')
  })

  it('renders the selected connection models and preselects its default model', () => {
    const html = renderSelector(storedConfig([anthropic, openai]))

    expect(html).toContain('aria-label="LLM 模型"')
    expect(html).toContain('claude-opus-4-6')
    expect(html).toContain('claude-sonnet-4-6')
    expect(html).toContain('claude-haiku-4-6')
    expect(html).toContain('value="claude-sonnet-4-6" selected=""')
    expect(html).not.toContain('gpt-5.1-mini')
  })

  it('switches connections by selecting the target default model', () => {
    const onConnectionChange = mock()
    const onModelChange = mock()

    resolveAdminModelSelection({
      llmConnections: [anthropic, openai],
      targetConnectionSlug: 'openai-api',
      currentModel: 'claude-sonnet-4-6',
      onConnectionChange,
      onModelChange,
    })

    expect(onConnectionChange).toHaveBeenCalledWith('openai-api')
    expect(onModelChange).toHaveBeenCalledWith('gpt-5.1', 'openai-api')
  })

  it('saves model changes within the current connection', () => {
    const onConnectionChange = mock()
    const onModelChange = mock()

    resolveAdminModelSelection({
      llmConnections: [anthropic, openai],
      targetConnectionSlug: 'anthropic-api',
      targetModel: 'claude-opus-4-6',
      currentConnectionSlug: 'anthropic-api',
      currentModel: 'claude-sonnet-4-6',
      onConnectionChange,
      onModelChange,
    })

    expect(onConnectionChange).not.toHaveBeenCalled()
    expect(onModelChange).toHaveBeenCalledWith('claude-opus-4-6', 'anthropic-api')
  })

  it('renders NoLlmConfigBanner when StoredConfig has no assigned connections', () => {
    const html = renderSelector(storedConfig([]))

    expect(html).toContain('role="status"')
    expect(html).toContain('暂无可用的 LLM 配置，请联系管理员')
    expect(html).not.toContain('aria-label="LLM 连接"')
    expect(html).not.toContain('aria-label="LLM 模型"')
  })

  it('does not render connection self-service controls', () => {
    const html = renderSelector(storedConfig([anthropic, openai]))

    expect(html).not.toContain('Add Connection')
    expect(html).not.toContain('Edit')
    expect(html).not.toContain('Delete')
    expect(html).not.toContain('Configure API Key')
  })

  it('hides the connection selector for exactly one assigned connection', () => {
    const html = renderSelector(storedConfig([anthropic]))

    expect(html).not.toContain('aria-label="LLM 连接"')
    expect(html).toContain('aria-label="LLM 模型"')
    expect(html).toContain('claude-sonnet-4-6')
  })
})

describe('NoLlmConfigBanner', () => {
  it('uses status semantics for screen readers', () => {
    const html = renderToStaticMarkup(<NoLlmConfigBanner />)

    expect(html).toContain('role="status"')
    expect(html).toContain('暂无可用的 LLM 配置，请联系管理员')
  })
})

describe('desktop and compact model selector integration', () => {
  const inputDir = resolve(import.meta.dir, '..')

  it('renders desktop FreeFormInput admin connection and model controls for multiple connections', () => {
    const html = renderToStaticMarkup(
      <DesktopAdminLlmModelSelectorControls
        llmConnections={[anthropic, openai]}
        currentConnection="anthropic-api"
        currentModel="claude-sonnet-4-6"
        onConnectionChange={() => {}}
        onModelChange={() => {}}
      />,
    )

    expect(html).toContain('aria-label="LLM 连接"')
    expect(html).toContain('aria-label="LLM 模型"')
    expect(html).toContain('Anthropic API')
    expect(html).toContain('OpenAI API')
    expect(html).toContain('claude-opus-4-6')
    expect(html).toContain('claude-sonnet-4-6')
    expect(html).toContain('value="anthropic-api" selected=""')
    expect(html).toContain('value="claude-sonnet-4-6" selected=""')
  })

  it('wires NoLlmConfigBanner into the desktop FreeFormInput dropdown path', () => {
    const source = readFileSync(resolve(inputDir, 'FreeFormInput.tsx'), 'utf8')

    expect(source).toContain("import { NoLlmConfigBanner } from '@/components/NoLlmConfigBanner'")
    expect(source).toContain('llmConnections.length === 0 ?')
    expect(source).toContain('<NoLlmConfigBanner')
  })

  it('wires admin selector controls into the desktop FreeFormInput dropdown path', () => {
    const source = readFileSync(resolve(inputDir, 'FreeFormInput.tsx'), 'utf8')

    expect(source).toContain("import { DesktopAdminLlmModelSelectorControls } from './DesktopAdminLlmModelSelectorControls'")
    expect(source).toContain('<DesktopAdminLlmModelSelectorControls')
    expect(source).toContain('llmConnections={llmConnections}')
    expect(source).toContain('currentConnection={effectiveConnection}')
  })

  it('does not wire connection-mutating vision toggles into model selectors', () => {
    const freeFormSource = readFileSync(resolve(inputDir, 'FreeFormInput.tsx'), 'utf8')
    const compactSource = readFileSync(resolve(inputDir, 'CompactModelSelector.tsx'), 'utf8')

    expect(freeFormSource).not.toContain('useModelVisionToggle')
    expect(compactSource).not.toContain('useModelVisionToggle')
    expect(freeFormSource).not.toContain('handleToggleModelVision')
    expect(compactSource).not.toContain('toggleVision')
  })
})
