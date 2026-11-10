/** POO-205 C7b (P1-5): the composer is the RENDER side of the personal-
 * context wall. When ChatDisplay trims the enterprise-session props (no
 * onSourcesChange / onWorkingDirectoryChange callbacks, empty source/skill
 * lists), the real FreeFormInput must render NO data-source picker, NO
 * working-directory picker and NO @-menu skill/source material — while the
 * attach-files badge keeps the composer alive. Personal props render all of
 * them (negative control). The server refuses the same writes; this is the
 * surface contract. */
import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test'
import { GlobalRegistrator } from '@happy-dom/global-registrator'
import { i18n, setupI18n } from '@polo-ai/shared/i18n'
import { createElement } from 'react'
import type { ReactElement } from 'react'

if (typeof window === 'undefined') {
  GlobalRegistrator.register({
    settings: {
      navigator: {
        userAgent:
          'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36',
      },
    },
  })
}
setupI18n()

// The working-directory badge reads the transport state through the preload
// bridge; happy-dom has no preload, so hand it the minimal surface the hook
// touches (useTransportConnectionState + use-working-directory-state, whose
// remaining window.electronAPI?. calls are all optional-chained).
;(window as unknown as { electronAPI: Record<string, unknown> }).electronAPI = {
  getTransportConnectionState: async () => ({ status: 'connected' }),
  onTransportConnectionStateChanged: () => () => {},
}

mock.module('pdfjs-dist/build/pdf.worker.min.mjs?url', () => ({
  default: 'data:application/javascript,',
}))
mock.module('@sentry/electron/renderer', () => new Proxy({}, {
  get: () => () => {},
}))
mock.module('@/components/ui/rich-text-input', () => ({
  RichTextInput: (props: { value?: string; className?: string; skills?: unknown[]; sources?: unknown[] }) =>
    createElement('div', {
      'data-testid': 'rich-input-stub',
      'data-skills-count': String(props.skills?.length ?? -1),
      'data-sources-count': String(props.sources?.length ?? -1),
      className: props.className,
    }, props.value ?? ''),
}))
mock.module('@/components/ServerDirectoryBrowser', () => ({
  ServerDirectoryBrowser: () => null,
}))
mock.module('@/components/app-shell/AttachmentPreview', () => ({
  AttachmentPreview: () => null,
}))
mock.module('@/components/chat/ElementReferenceChips', () => ({
  ElementReferenceChips: () => null,
}))
mock.module('@/components/project-context/ProjectAssetChip', () => ({
  ProjectAssetDraftChips: () => null,
}))
mock.module('@/components/project-context/AssetMentionPopover', () => ({
  AssetMentionPopover: () => null,
  useAssetMention: () => ({
    isOpen: false,
    handleInputChanged: () => false,
    handleKeyDown: () => false,
    choose: () => {},
    close: () => {},
  }),
}))
mock.module('@/components/ui/EditPopover', () => ({
  EditPopover: () => null,
  getEditConfig: () => null,
}))
mock.module('@/components/ui/label-icon', () => ({
  LabelIcon: () => createElement('span', { 'data-testid': 'label-icon-stub' }),
}))
mock.module('@/context/EscapeInterruptContext', () => ({
  useEscapeInterrupt: () => ({ showEscapeOverlay: false }),
  EscapeInterruptProvider: (props: { children?: React.ReactNode }) => props.children ?? null,
}))
mock.module('@/components/app-shell/input/ToolbarStatusSlot', () => ({
  ToolbarStatusSlot: () => null,
}))
mock.module('@/components/ui/source-avatar', () => ({
  SourceAvatar: () => createElement('span', { 'data-testid': 'source-avatar-stub' }),
}))
// Probe: the popover is mounted unconditionally (controlled open state), so
// its received sources list is observable straight from the initial HTML —
// no clicking required. An enterprise session never mounts it at all.
mock.module('@/components/ui/SourceSelectorPopover', () => ({
  SourceSelectorPopover: (props: { sources?: unknown[] }) =>
    createElement('div', {
      'data-testid': 'source-popover-probe',
      'data-count': String(props.sources?.length ?? -1),
    }),
}))
mock.module('@/components/ui/CompactSourceSelector', () => ({
  CompactSourceSelector: () => null,
}))
mock.module('@/components/ui/CompactWorkingDirectorySelector', () => ({
  CompactWorkingDirectorySelector: () => createElement('div', { 'data-testid': 'compact-wd-stub' }),
}))

const { TooltipProvider } = await import('@polo-ai/ui')
const { cleanup, render } = await import('@testing-library/react')
const { FreeFormInput } = await import('../FreeFormInput')
const { I18nextProvider } = await import('react-i18next')

function mountComposer(props: Record<string, unknown>): { html: () => string; unmount: () => void } {
  const view = render(createElement(
    TooltipProvider as unknown as (props: { children?: ReactElement }) => ReactElement,
    {},
    createElement(
      I18nextProvider as unknown as (props: { i18n: unknown; children?: ReactElement }) => ReactElement,
      { i18n },
      createElement(FreeFormInput, { currentModel: '', ...props } as never),
    ),
  ))
  return { html: () => view.container.innerHTML, unmount: view.unmount }
}

const SOURCE_FIXTURE = {
  config: { id: 'src-1', name: 'Personal Source', slug: 'personal-src', enabled: true, provider: 'test', type: 'mcp' },
  guide: null,
  folderPath: '/test/source',
  workspaceRootPath: '/test/workspace',
  workspaceId: 'ws-1',
}
const SKILL_FIXTURE = { slug: 'personal-skill', metadata: { name: 'Personal Skill' } }

const PERSONAL_PROPS = {
  sources: [SOURCE_FIXTURE],
  skills: [SKILL_FIXTURE],
  onSourcesChange: () => {},
  onWorkingDirectoryChange: () => {},
  workspaceId: 'ws-1',
}

// ChatDisplay's enterprise-session trim: callbacks ABSENT, lists EMPTY.
const ENTERPRISE_PROPS = {
  sources: [],
  skills: [],
  onSourcesChange: undefined,
  onWorkingDirectoryChange: undefined,
  workspaceId: 'ws-1',
}

beforeEach(() => {
  cleanup()
})

afterEach(() => {
  cleanup()
})

describe('FreeFormInput enterprise composer surfaces (POO-205 C7b)', () => {
  it('a personal session renders the data-source and working-directory pickers', () => {
    const { html, unmount } = mountComposer(PERSONAL_PROPS)
    expect(html()).toContain('Choose Sources')
    expect(html()).toContain('Work in Folder')
    unmount()
  })

  it('an enterprise session renders NEITHER picker, but keeps the composer alive', () => {
    const { html, unmount } = mountComposer(ENTERPRISE_PROPS)
    expect(html()).not.toContain('Choose Sources')
    expect(html()).not.toContain('Work in Folder')
    expect(html()).not.toContain('compact-wd-stub')
    // The composer itself is still functional — attachments remain.
    expect(html()).toContain('Attach Files')
    unmount()
  })

  it('an enterprise session feeds the @ menu NOTHING personal (empty source/skill lists)', () => {
    // The @ menu is data-driven off the skills/sources handed to the input
    // (probed via the RichTextInput stub) and to the source popover. With the
    // ChatDisplay trim both lists arrive EMPTY and the popover is not even
    // mounted, so no personal material can surface from a @ trigger.
    const { html, unmount } = mountComposer(ENTERPRISE_PROPS)
    expect(html()).toContain('data-skills-count="0"')
    expect(html()).toContain('data-sources-count="0"')
    expect(html()).not.toContain('source-popover-probe')
    unmount()
  })

  it('a personal session feeds the @ menu its source/skill material (negative control)', () => {
    const { html, unmount } = mountComposer(PERSONAL_PROPS)
    expect(html()).toContain('data-skills-count="1"')
    expect(html()).toContain('data-sources-count="1"')
    expect(html()).toContain('data-testid="source-popover-probe" data-count="1"')
    unmount()
  })
})
