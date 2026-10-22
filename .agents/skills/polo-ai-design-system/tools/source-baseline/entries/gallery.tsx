/**
 * Layer-2 component gallery: REAL production components browsed with variants.
 *
 * Every card imports its component through the SAME playground registry
 * entries the interactive playground uses (`registry/settings.tsx`,
 * `registry/chat.tsx`, `registry/onboarding.tsx`), so the rendering protocol
 * (prop defaults → mockData → variant props → entry wrapper) is identical to
 * the product's own preview path. Variant switching below is a real
 * controlled React state — clicking a variant re-renders the production
 * component. The production file for each entry is listed on the card (the
 * accurate consumer index; never a copy of the implementation).
 *
 * Full-page shells (OnboardingWizard, HomePage, CircleDetailPage, TabShell)
 * are NOT duplicated here: those are layer-3 page/region scenes. This layer
 * is only for browsing individual components and their variants.
 */
import React, { useEffect, useRef } from 'react'
import { TooltipProvider } from '@polo-ai/ui'
import type { ComponentEntry, ComponentVariant } from '@/playground/registry/types'
import { settingsComponents } from '@/playground/registry/settings'
import { chatComponents } from '@/playground/registry/chat'
import { onboardingComponents } from '@/playground/registry/onboarding'

/** Baseline browsing shell catches per-entry context gaps without killing the gallery. */
class GalleryErrorBoundary extends React.Component<
  { label: string; children: React.ReactNode },
  { error: string | null }
> {
  constructor(props: { label: string; children: React.ReactNode }) {
    super(props)
    this.state = { error: null }
  }
  static getDerivedStateFromError(error: unknown) {
    return { error: error instanceof Error ? error.message : String(error) }
  }
  render() {
    if (this.state.error) {
      return (
        <div className="rounded border border-destructive/40 bg-destructive/5 p-3 text-xs text-destructive">
          <div className="font-semibold">{this.props.label} 渲染需要额外上下文</div>
          <div className="mt-1 font-mono text-[11px] leading-relaxed">{this.state.error}</div>
          <div className="mt-1 text-[11px] text-muted-foreground">
            该条目的装配上下文见其生产落点与对应页面场景（基线浏览壳不复制装配）。
          </div>
        </div>
      )
    }
    return this.props.children
  }
}

export interface GalleryEntry {
  entry: ComponentEntry
  /** Accurate production file (renderer-relative) this registry entry wraps. */
  source: string
  /** Why the entry is excluded from variant switching, when applicable. */
  excluded?: string
}

export interface GalleryGroup {
  id: string
  title: string
  note: string
  entries: GalleryEntry[]
}

const SETTINGS_SOURCE: Record<string, string> = {
  // PageDemo is the registry's own composition example: it imports the real
  // @/components/settings parts — it is NOT a direct import of pages/settings.
  'settings-page-preview': 'playground/registry/settings.tsx PageDemo（组合展示示例，import @/components/settings 真组件）',
  'settings-section': 'components/settings/SettingsSection.tsx',
  'settings-toggle': 'components/settings/SettingsToggle.tsx',
  'settings-select': 'components/settings/SettingsSelect.tsx',
  'settings-menu-select': 'components/settings/SettingsMenuSelect.tsx',
  'settings-segmented-control': 'components/settings/SettingsSegmentedControl.tsx',
  'settings-segmented-card': 'components/settings/SettingsSegmentedControl.tsx',
  'settings-radio-group': 'components/settings/SettingsRadioGroup.tsx',
  'settings-input': 'components/settings/SettingsInput.tsx',
  'settings-secret-input': 'components/settings/SettingsInput.tsx',
  'settings-textarea': 'components/settings/SettingsTextarea.tsx',
  'settings-row-divider-group': 'components/settings/SettingsRow.tsx',
}

const CHAT_SOURCE: Record<string, string> = {
  'empty-state-hint': 'components/chat/EmptyStateHint.tsx',
  'attachment-preview': 'components/app-shell/AttachmentPreview.tsx',
  'setup-auth-banner': 'components/app-shell/SetupAuthBanner.tsx',
  'active-option-badges': 'components/app-shell/ActiveOptionBadges.tsx',
  'permission-input-toggle': 'components/app-shell/input（InputContainer 权限流）+ registry/chat.tsx 场景装配',
  'turn-card-flat': '@polo-ai/ui TurnCard（packages/ui）',
  'turn-card-nested-complete': '@polo-ai/ui TurnCard（packages/ui）',
  'turn-card-nested-progress': '@polo-ai/ui TurnCard（packages/ui）',
  'turn-card-multi-task': '@polo-ai/ui TurnCard（packages/ui）',
  'turn-card-deep-nested': '@polo-ai/ui TurnCard（packages/ui）',
  'active-tasks-bar-context': 'components/app-shell/ActiveTasksBar.tsx',
  'input-container': 'components/app-shell/input（InputContainer / ChatInputZone）',
}

const ONBOARDING_SOURCE: Record<string, string> = {
  'provider-select-step': 'components/onboarding/ProviderSelectStep.tsx',
  'welcome-step': 'components/onboarding/WelcomeStep.tsx',
  'api-setup-step': 'components/onboarding/APISetupStep.tsx',
  'credentials-step-api-key': 'components/onboarding/CredentialsStep.tsx',
  'credentials-step-oauth': 'components/onboarding/CredentialsStep.tsx',
  'credentials-step-copilot': 'components/onboarding/CredentialsStep.tsx',
  'completion-step': 'components/onboarding/CompletionStep.tsx',
  'git-bash-warning': 'components/onboarding/GitBashWarning.tsx',
}

function pick(components: ComponentEntry[], source: Record<string, string>, excluded?: Record<string, string>): GalleryEntry[] {
  return components
    .filter(e => source[e.id])
    .map(entry => ({ entry, source: source[entry.id], excluded: excluded?.[entry.id] }))
}

/**
 * Registry order is the product's own order. Whole-shell entries
 * (onboarding-flow-demo / onboarding-wizard) stay out: the login-* scenes
 * already render the real OnboardingWizard full shell.
 */
export const galleryGroups: GalleryGroup[] = [
  {
    id: 'gallery-settings',
    title: 'Settings 组件（@/components/settings）',
    note: '12 个注册条目全部收列；交互（开关/选择/输入）为真实受控组件。',
    entries: pick(settingsComponents, SETTINGS_SOURCE),
  },
  {
    id: 'gallery-chat',
    title: '聊天与业务组件（Chat / Turn Cards / Chat Inputs）',
    note: 'playground chat 注册的全部条目；wrapper/mockData 协议与 playground 同源。',
    entries: pick(chatComponents, CHAT_SOURCE),
  },
  {
    id: 'gallery-onboarding',
    title: 'Onboarding 步骤组件（@/components/onboarding）',
    note: '步骤件收列；整壳 OnboardingWizard 不在画廊重复（见 login-* 页面场景）。',
    entries: pick(onboardingComponents, ONBOARDING_SOURCE, {
      'onboarding-flow-demo': 'demo 组合件，非生产组件',
      'onboarding-wizard': '整壳由 login-* 场景承载',
    }),
  },
].filter(g => g.entries.length > 0)

/** playground rendering protocol: defaults → mockData → variant props. */
function mergedProps(entry: ComponentEntry, variant: ComponentVariant | null): Record<string, unknown> {
  const defaults = Object.fromEntries(entry.props.map(p => [p.name, p.defaultValue]))
  return { ...defaults, ...(entry.mockData?.() ?? {}), ...(variant?.props ?? {}) }
}

function VariantStage(props: { entry: ComponentEntry; variant: ComponentVariant | null }) {
  const Component = props.entry.component
  const Wrapper = props.entry.wrapper
  const content = <Component {...mergedProps(props.entry, props.variant)} />
  return (
    <GalleryErrorBoundary label={props.entry.name}>
      <TooltipProvider>
        {Wrapper ? <Wrapper>{content}</Wrapper> : content}
      </TooltipProvider>
    </GalleryErrorBoundary>
  )
}

/**
 * R12 (baseline display layer only): chat input components focus themselves
 * on mount, and the browser scrolls the focused element into view — which
 * yanked the page away from the gallery header on first open and after
 * variant re-renders. The guard corrects ONLY automatic (non-user) scrolling
 * for a short window: the first real user scroll intent — wheel, touch,
 * pointer press or key — cancels it immediately, so user scrolling always
 * wins. Listeners and the RAF loop are removed on cancel/timeout. Focus is
 * never touched: real typing into preview inputs keeps working, and the
 * production components are unchanged.
 */
function scrollGuard(ms: number, hold: () => void) {
  const until = performance.now() + ms
  const events = ['wheel', 'touchstart', 'pointerdown', 'keydown'] as const
  let raf = 0
  let done = false
  const cancel = () => {
    if (done) return
    done = true
    for (const name of events) window.removeEventListener(name, cancel, true)
    cancelAnimationFrame(raf)
  }
  for (const name of events) {
    window.addEventListener(name, cancel, { capture: true, passive: true })
  }
  const step = () => {
    if (done) return
    hold()
    if (performance.now() < until) raf = requestAnimationFrame(step)
    else cancel()
  }
  raf = requestAnimationFrame(step)
}

function pinScrollToTop(ms = 1200) {
  scrollGuard(ms, () => {
    if (window.scrollY !== 0) window.scrollTo(0, 0)
  })
}

function keepViewport(ms = 600) {
  const y0 = window.scrollY
  scrollGuard(ms, () => {
    if (Math.abs(window.scrollY - y0) > 1) window.scrollTo(0, y0)
  })
}

/** One production component with real, clickable variant switching. */
function GalleryCard({ item }: { item: GalleryEntry }) {
  const variants = item.entry.variants ?? []
  const [selected, setSelected] = React.useState<number | 'all'>(variants.length ? 'all' : 0)
  const active = selected === 'all' ? null : variants[selected]
  const selectVariant = (option: number | 'all') => {
    if (option === selected) return
    keepViewport()          // variant re-render may mount an auto-focusing input
    setSelected(option)
  }
  return (
    <section className="rounded-xl border border-border bg-surface p-4">
      <header className="flex flex-wrap items-baseline justify-between gap-2">
        <h3 className="text-sm font-semibold text-foreground">{item.entry.name}</h3>
        <code className="font-mono text-[11px] text-muted-foreground">{item.entry.id}</code>
      </header>
      <p className="mt-1 text-xs leading-relaxed text-muted-foreground">{item.entry.description}</p>
      <p className="mt-1 text-[11px] text-muted-foreground">
        生产落点：<code className="rounded bg-muted px-1">{item.source}</code>
      </p>
      {variants.length > 0 && (
        <div className="mt-3 flex flex-wrap items-center gap-2" data-variant-switch={`gallery-${item.entry.id}`}>
          <span className="text-[11px] uppercase tracking-wider text-muted-foreground">变体</span>
          {(['all', ...variants.map((_, i) => i)] as Array<'all' | number>).map(option => (
            <button
              key={String(option)}
              type="button"
              onClick={() => selectVariant(option)}
              className={
                'rounded-full border px-2.5 py-0.5 text-xs transition-colors ' +
                (selected === option
                  ? 'border-accent bg-accent/10 text-accent'
                  : 'border-border text-muted-foreground hover:text-foreground')
              }
            >
              {option === 'all' ? '全部' : variants[option].name}
            </button>
          ))}
        </div>
      )}
      <div className="mt-3 space-y-4">
        {selected === 'all' && variants.length > 0
          ? variants.map(v => (
              <div key={v.name}>
                <div className="mb-1 text-[11px] font-semibold text-muted-foreground">{v.name}{v.description ? ` — ${v.description}` : ''}</div>
                <VariantStage entry={item.entry} variant={v} />
              </div>
            ))
          : <VariantStage entry={item.entry} variant={active} />}
      </div>
    </section>
  )
}

/** The full layer-2 gallery: group filter tabs + one card per production component. */
export function ComponentGallery() {
  // Default to the settings group: opening on "all" mounts every chat input at
  // once, whose auto-focus scroll hides the gallery header (R12 evidence:
  // initial scrollY≈17100). Settings first, "全部" stays available.
  const [activeGroup, setActiveGroup] = React.useState<string>('gallery-settings')
  const rootRef = useRef<HTMLDivElement>(null)
  // The pin starts AFTER the group's React commit (effect phase), not at click
  // time: mounting "全部" (32 cards) blocks the main thread for longer than a
  // click-time guard window, so the auto-focus scroll fired right after the
  // block survived it (evidence: scrollY=17393 after switching to "全部").
  // Starting here spends the whole window on post-commit focus scrolls; user
  // input still cancels immediately (scrollGuard).
  useEffect(() => {
    pinScrollToTop(1200)
  }, [activeGroup])
  const selectGroup = (id: string) => {
    if (id === activeGroup) return
    setActiveGroup(id)      // the effect above pins after the new group mounts
  }
  const groups = activeGroup === 'all' ? galleryGroups : galleryGroups.filter(g => g.id === activeGroup)
  const total = galleryGroups.reduce((n, g) => n + g.entries.length, 0)
  return (
    <div className="mx-auto max-w-4xl" ref={rootRef}>
      <header className="mb-6">
        <h1 className="text-lg font-semibold text-foreground">组件画廊（当前实现基线 · 第二层）</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          {total} 个生产组件条目，直接 import 自 <code className="rounded bg-muted px-1">apps/electron/src/renderer</code>
          与 <code className="rounded bg-muted px-1">@polo-ai/ui</code>；渲染协议与 playground 注册同源，变体切换真实生效。
          每张卡标注生产落点（准确索引，非实现复制）。整页/区域组合见场景目录其余分组。
        </p>
      </header>
      <div className="mb-6 flex flex-wrap gap-2" data-gallery-filter>
        {(['all', ...galleryGroups.map(g => g.id)] as string[]).map(id => {
          const group = galleryGroups.find(g => g.id === id)
          return (
            <button
              key={id}
              type="button"
              onClick={() => selectGroup(id)}
              className={
                'rounded-full border px-3 py-1 text-xs transition-colors ' +
                (activeGroup === id
                  ? 'border-accent bg-accent/10 font-semibold text-accent'
                  : 'border-border text-muted-foreground hover:text-foreground')
              }
            >
              {id === 'all' ? `全部（${total}）` : `${group!.title}（${group!.entries.length}）`}
            </button>
          )
        })}
      </div>
      {groups.map(group => (
        <section key={group.id} id={group.id} className="mb-10">
          <h2 className="mb-1 border-b border-border pb-1 text-xs font-semibold uppercase tracking-wider text-muted-foreground">
            {group.title}
          </h2>
          <p className="mb-4 mt-1 text-[11px] text-muted-foreground">{group.note}</p>
          <div className="space-y-6">
            {group.entries.map(item => <GalleryCard key={item.entry.id} item={item} />)}
          </div>
        </section>
      ))}
    </div>
  )
}
