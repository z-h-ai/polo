// IMPORTANT: mock-utils must stay the FIRST local import — it installs the
// mock window.electronAPI as a module-load side effect before any renderer
// module reads it (same contract as playground.tsx).
import '@/playground/mock-utils'
import { installBaselineApiFixtures } from './fixtures'

// Baseline-only backend fixtures ride on top of the playground mock.
installBaselineApiFixtures(window.electronAPI as unknown as Record<string, unknown>)

import React from 'react'
import ReactDOM from 'react-dom/client'
import { Provider as JotaiProvider } from 'jotai'
import { setupI18n } from '@polo-ai/shared/i18n'
import i18n from 'i18next'
import { initReactI18next } from 'react-i18next'
import { ActionRegistryProvider } from '@/actions'
import { ThemeProvider } from '@/context/ThemeContext'
import { EscapeInterruptProvider } from '@/context/EscapeInterruptContext'
import { DismissibleLayerProvider } from '@/context/DismissibleLayerContext'
import { ProductSpaceProvider } from '@/context/ProductSpaceContext'
import { MemberCatalogProvider } from '@/context/MemberCatalogContext'
import { MemberCircleResourceProvider } from '@/context/MemberCircleResourceContext'
import { ModalProvider } from '@/context/ModalContext'
import { TabShellProvider } from '@/context/TabShellContext'
import { TooltipProvider } from '@polo-ai/ui'
import { PlaygroundAppShellProvider } from '@/playground/PlaygroundAppShellProvider'
import { useClientMaterialScope } from '@/components/ui/client-workbench'
import { baselineScenes, sceneRegions, productSpaceFixture } from './scenes'
import './baseline.css'

// Runtime scene registry for verification sweeps: the sweep asserts
// baseline-manifest.json `scenes` equals this exact list, so the manifest can
// never drift from what actually renders.
;(window as unknown as { __BASELINE_SCENE_IDS__: string[] }).__BASELINE_SCENE_IDS__ =
  baselineScenes.map(s => s.id)

setupI18n([initReactI18next])
// Same default the product entry resolves (main.tsx: stored ?? 'zh-Hans');
// production i18n resources stay untouched.
void i18n.changeLanguage('zh-Hans')

/** Read ?scene= from search or hash (either works, mirroring the prototype). */
function requestScene(): string | null {
  const search = new URLSearchParams(window.location.search)
  const hash = new URLSearchParams(window.location.hash.slice(1))
  return hash.get('scene') || search.get('scene')
}

/** pure=1 renders the scene alone — no title bar, no catalog link. */
function requestPure(): boolean {
  const search = new URLSearchParams(window.location.search)
  const hash = new URLSearchParams(window.location.hash.slice(1))
  return (hash.get('pure') || search.get('pure')) === '1'
}

function CatalogCard(props: { id: string; region: string; title: string; note: string }) {
  return (
    <a
      href={`?scene=${props.id}`}
      className="block rounded-xl border border-border bg-surface p-4 transition-colors hover:border-accent"
    >
      <div className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">{props.region}</div>
      <div className="mt-1 text-sm font-semibold text-foreground">{props.title}</div>
      <div className="mt-1 font-mono text-[11px] text-muted-foreground">?scene={props.id}</div>
      <p className="mt-2 text-xs leading-relaxed text-muted-foreground">{props.note}</p>
    </a>
  )
}

function CatalogMode() {
  return (
    <main className="mx-auto max-w-5xl px-8 py-10">
      <header className="mb-8">
        <h1 className="text-xl font-semibold text-foreground">当前实现基线 · 场景目录</h1>
        <p className="mt-1 max-w-3xl text-sm text-muted-foreground">
          每个场景由本分支 <code className="rounded bg-muted px-1">apps/electron/src/renderer</code> 真实组件渲染，
          fixture 只替换后端数据。点场景进入纯页面模式（无本说明栏）；地址同时支持
          <code className="mx-1 rounded bg-muted px-1">?scene=ID</code> 与
          <code className="mx-1 rounded bg-muted px-1">#scene=ID</code>。
        </p>
      </header>
      {sceneRegions.map(region => {
        const scenes = baselineScenes.filter(s => s.region === region)
        if (!scenes.length) return null
        return (
          <section key={region} className="mb-8">
            <h2 className="mb-3 border-b border-border pb-1 text-xs font-semibold uppercase tracking-wider text-muted-foreground">
              {region} · {scenes.length}
            </h2>
            <div className="grid grid-cols-1 gap-3 md:grid-cols-2 lg:grid-cols-3">
              {scenes.map(s => <CatalogCard key={s.id} {...s} />)}
            </div>
          </section>
        )
      })}
    </main>
  )
}

function PureSceneMode(props: { id: string; pure: boolean }) {
  const scene = baselineScenes.find(s => s.id === props.id)
  if (!scene) {
    return (
      <main className="mx-auto max-w-3xl px-8 py-16 text-center text-sm text-muted-foreground">
        未知场景 <code>{props.id}</code>。
        <a className="ml-2 underline" href="?">返回场景目录</a>
      </main>
    )
  }
  if (props.pure) {
    return <main className="min-h-screen">{scene.render()}</main>
  }
  if (scene.fullBleed) {
    // Shell-owned geometry: the scene keeps its own full-height layout; the
    // catalog link floats above it without adding padding or an annotation bar.
    return (
      <main className="relative min-h-screen">
        {scene.render()}
        <a
          className="absolute right-4 top-2 z-50 rounded bg-surface/80 px-2 py-1 text-xs text-muted-foreground underline"
          href="?"
        >
          返回目录
        </a>
      </main>
    )
  }
  return (
    <main className="min-h-screen px-8 py-8">
      <div className="mb-4 flex items-center justify-between border-b border-border pb-2">
        <span className="text-xs text-muted-foreground">{scene.title}</span>
        <span className="flex items-center gap-3">
          <a className="text-xs text-muted-foreground underline" href={`?scene=${props.id}&pure=1`}>纯页面模式</a>
          <a className="text-xs text-muted-foreground underline" href="?">返回目录</a>
        </span>
      </div>
      {scene.render()}
    </main>
  )
}

const sceneId = requestScene()
const pureMode = requestPure()

/**
 * Publishes the POO-105 light-material scope through the REAL product hook
 * (the same one TabShell.tsx calls for the workbench host). Onboarding scenes
 * instead mount OnboardingWizard, which calls the hook itself; the two hosts
 * are mutually exclusive in the product, never nested twice here.
 */
function BaselineMaterialScope({ children }: { children: React.ReactNode }) {
  useClientMaterialScope()
  return <>{children}</>
}

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <JotaiProvider>
      <TooltipProvider>
        <ThemeProvider>
          <ActionRegistryProvider>
          <EscapeInterruptProvider>
            {/* App.tsx mounts this above ModalProvider; TopBar/AppMenu need it. */}
            <DismissibleLayerProvider>
            <BaselineMaterialScope>
              <ProductSpaceProvider value={productSpaceFixture}>
              <PlaygroundAppShellProvider>
                <MemberCatalogProvider>
                  <MemberCircleResourceProvider>
                    <ModalProvider>
                      <TabShellProvider
                        workspaceId="playground-workspace"
                        productSpaceScope={{ accountId: productSpaceFixture.accountId, productSpaceId: productSpaceFixture.activeProductSpaceId }}
                      >
                        {sceneId ? <PureSceneMode id={sceneId} pure={pureMode} /> : <CatalogMode />}
                      </TabShellProvider>
                    </ModalProvider>
                  </MemberCircleResourceProvider>
                </MemberCatalogProvider>
              </PlaygroundAppShellProvider>
            </ProductSpaceProvider>
            </BaselineMaterialScope>
            </DismissibleLayerProvider>
          </EscapeInterruptProvider>
          </ActionRegistryProvider>
        </ThemeProvider>
      </TooltipProvider>
    </JotaiProvider>
  </React.StrictMode>
)
