import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { fileURLToPath } from 'node:url'

// Component gallery exporter (Task: "将组件分组、分类还原为 HTML 放到组件
// 文件夹"). Renders every src/source/* component to static markup with
// react-dom/server (via a Vite SSR build so JSX + lucide assets resolve) and
// writes one self-contained HTML file per component under components/<group>/,
// plus a components/index.html overview. Every file inlines tokens.css +
// base.css so it renders standalone with no scripts and no network. Keep the
// gallery groups in sync with src/source exports.
const root = resolve(fileURLToPath(new URL('..', import.meta.url)))
const outDir = resolve(root, 'components')
const buildDir = resolve(root, 'dist-gallery')
const viteBin = process.env.VITE_BIN || resolve(root, '../../../../../dev/node_modules/.bin/vite')
const viteModule = process.env.POLO_VITE_MODULE || resolve(root, '../../../../../dev/node_modules/vite/dist/node/index.js')

// Group registry. Each entry: gallery id, display label, note, and the
// components to render — [slug, title, import specifier, expression producing
// the element, optional extra CSS files from src/styles].
const groups = [
  {
    id: 'lifecycle',
    label: '生命周期',
    note: 'Splash、onboarding wizard 各步、reauth、Workspace 选择、组织加入',
    components: [
      ['splash', 'Splash 启动屏', '../src/source/LifecycleRegion.jsx', 'SourceLifecycle({ scene: "splash", state: "normal" })', 'viewport'],
      ['onboarding-welcome', 'Onboarding 欢迎', '../src/source/LifecycleRegion.jsx', 'SourceLifecycle({ scene: "onboarding", state: "welcome" })', 'viewport'],
      ['onboarding-git-bash', 'Onboarding · Git Bash', '../src/source/OnboardingSteps.jsx', 'SourceOnboardingStep({ step: "git-bash" })', 'viewport'],
      ['onboarding-provider-select', 'Onboarding · 选择连接方式', '../src/source/OnboardingSteps.jsx', 'SourceOnboardingStep({ step: "provider-select" })', 'viewport'],
      ['onboarding-local-model', 'Onboarding · 本地模型', '../src/source/OnboardingSteps.jsx', 'SourceOnboardingStep({ step: "local-model" })', 'viewport'],
      ['onboarding-credentials', 'Onboarding · API 配置', '../src/source/OnboardingSteps.jsx', 'SourceOnboardingStep({ step: "credentials" })', 'viewport'],
      ['onboarding-copilot-code', 'Onboarding · Copilot 设备码', '../src/source/OnboardingSteps.jsx', 'SourceOnboardingStep({ step: "copilot-code" })', 'viewport'],
      ['onboarding-claude-code', 'Onboarding · Claude 授权码', '../src/source/OnboardingSteps.jsx', 'SourceOnboardingStep({ step: "claude-code" })', 'viewport'],
      ['onboarding-api-setup', 'Onboarding · 设置智能体', '../src/source/OnboardingAuth.jsx', 'SourceApiSetup({ segment: "anthropic" })', 'viewport'],
      ['onboarding-api-setup-pi', 'Onboarding · Polo AI Backend', '../src/source/OnboardingAuth.jsx', 'SourceApiSetup({ segment: "pi" })', 'viewport'],
      ['reauth', 'Reauth 重新认证', '../src/source/LifecycleRegion.jsx', 'SourceLifecycle({ scene: "reauth", state: "normal" })', 'viewport'],
      ['workspace-picker', 'Workspace 选择', '../src/source/WorkspacePicker.jsx', 'SourceWorkspacePicker({ state: "list" })', 'viewport'],
      ['organization-onboarding', '组织加入', '../src/source/OrganizationOnboarding.jsx', 'SourceOrganizationOnboarding({ state: "create" })', 'viewport'],
    ],
  },
  {
    id: 'workbench',
    label: '工作台',
    note: 'Home 启动器、组织应用卡、桌面应用菜单、Workspace 切换',
    components: [
      ['home-launcher', 'Home 启动器 (fresh profile)', '../src/source/HomeLauncher.jsx', 'SourceHomeLauncher({ poloIconSrc })', ['source-home.css'], 'viewport'],
      ['organization-app-card', '组织应用卡', '../src/source/HomeApps.jsx', 'SourceOrganizationAppsSection()', ['source-home.css'], 'panel'],
      ['app-menu', '桌面应用菜单', '../src/source/AppMenu.jsx', 'SourceDesktopAppMenu()', 'viewport'],
      ['space-switcher-topbar', 'Workspace 切换 · Topbar', '../src/source/SpaceSwitcher.jsx', 'SourceSpaceSwitcher({ state: "topbar" })', 'viewport'],
      ['space-switcher-compact', 'Workspace 切换 · Compact 抽屉', '../src/source/SpaceSwitcher.jsx', 'SourceSpaceSwitcher({ state: "compact" })', 'viewport'],
    ],
  },
  {
    id: 'assistant',
    label: '助手会话',
    note: '聊天空态、会话气泡、流式/错误/详情、会话列表、会话信息、多选、远程发送、Auth 卡',
    components: [
      ['chat-empty', '聊天空态', '../src/source/EmptyChat.jsx', 'SourceFaithfulEmptyChat({})', 'viewport'],
      ['chat-conversation', '会话气泡', '../src/source/ChatConversation.jsx', 'SourceChatConversation()', 'tall'],
      ['chat-permission', '权限请求卡', '../src/source/EmptyChat.jsx', 'SourceFaithfulEmptyChat({ permission: true })', 'viewport'],
      ['chat-streaming', '会话 · 流式响应', '../src/source/ChatStreaming.jsx', 'SourceChatStreaming()', 'tall'],
      ['chat-error', '会话 · 错误气泡', '../src/source/ChatStreaming.jsx', 'SourceChatError()', 'tall'],
      ['chat-detail', '会话 · 完整回合', '../src/source/ChatStreaming.jsx', 'SourceChatDetail()', 'tall'],
      ['session-sidebar', '会话侧栏', '../src/source/SessionSidebar.jsx', 'SourceSessionNavigator({ state: "date-grouped" })', 'panel'],
      ['chat-active-tasks', '任务徽章 + 下拉菜单', '../src/source/EdgePanels.jsx', 'SourceActiveTasksBar()', 'tall'],
      ['chat-auth-request', '凭证请求卡', '../src/source/AuthRequestRegion.jsx', 'SourceAuthRequestCard()', 'panel'],
      ['chat-auth-completed', '凭证完成', '../src/source/AuthRequestRegion.jsx', 'SourceAuthRequestCompleted()', 'panel'],
      ['chat-auth-cancelled', '凭证取消', '../src/source/AuthRequestRegion.jsx', 'SourceAuthRequestCancelled()', 'panel'],
      ['multi-select-panel', '会话多选面板', '../src/source/EdgePanels.jsx', 'SourceMultiSelectPanel()', 'viewport'],
      ['multi-select-menu', '多选批量菜单', '../src/source/EdgePanels.jsx', 'SourceBatchSessionMenu()', 'viewport'],
      ['send-remote-list', '发送到 Workspace', '../src/source/EdgePanels.jsx', 'SourceSendToWorkspace({ state: "list" })', 'viewport'],
      ['send-remote-offline', '发送 · 全部离线', '../src/source/EdgePanels.jsx', 'SourceSendToWorkspace({ state: "offline" })', 'viewport'],
      ['send-remote-transferring', '发送 · 传输中', '../src/source/EdgePanels.jsx', 'SourceSendToWorkspace({ state: "transferring" })', 'viewport'],
      ['session-info-popover', '会话信息 Popover', '../src/source/SessionInfoRegion.jsx', 'SourceSessionInfoPopover()', 'panel'],
      ['file-viewer', '文件查看器', '../src/source/SessionInfoRegion.jsx', 'SourceFileViewer()', 'panel'],
      ['file-viewer-empty', '文件查看器空态', '../src/source/SessionInfoRegion.jsx', 'SourceFileViewerEmpty()', 'panel'],
      ['fab-new-chat', '新建聊天 FAB', '../src/source/EdgePanels.jsx', 'SourceFabNewChat()', 'viewport'],
    ],
  },
  {
    id: 'resources',
    label: '资源面板',
    note: '数据源/技能/自动化空态、自动化列表与详情',
    components: [
      ['sources-empty', '数据源空态', '../src/source/ResourceEmptyPanels.jsx', 'SourceResourceEmptyPanel({ kind: "sources" })', 'viewport'],
      ['skills-empty', '技能空态', '../src/source/ResourceEmptyPanels.jsx', 'SourceResourceEmptyPanel({ kind: "skills" })', 'viewport'],
      ['automations-empty', '自动化空态', '../src/source/ResourceEmptyPanels.jsx', 'SourceResourceEmptyPanel({ kind: "automations" })', 'viewport'],
      ['automations-list', '自动化列表', '../src/source/AutomationsRegion.jsx', 'SourceAutomationsList()', 'panel'],
      ['automation-detail', '自动化详情', '../src/source/AutomationsRegion.jsx', 'SourceAutomationDetail()', 'tall'],
      ['skills-list', 'Skill 列表', '../src/source/ResourceListDetail.jsx', 'SourceSkillsList({})', 'panel'],
      ['skill-detail', 'Skill 详情', '../src/source/ResourceListDetail.jsx', 'SourceSkillDetail({})', 'panel'],
      ['sources-list', 'Source 列表', '../src/source/ResourceListDetail.jsx', 'SourceSourcesList({})', 'panel'],
      ['source-detail', 'Source 详情', '../src/source/ResourceListDetail.jsx', 'SourceSourceDetail({})', 'panel'],
    ],
  },
  {
    id: 'apps',
    label: 'Browser',
    note: '浏览器空态卡、工具栏、tab 条',
    components: [
      ['browser-empty', '浏览器空态卡', '../src/source/BrowserEmptyState.jsx', 'SourceBrowserEmptyState()', 'viewport'],
      ['browser-toolbar', '浏览器工具栏', '../src/source/BrowserRegion.jsx', 'SourceBrowserRegion({ state: "toolbar" })', 'viewport'],
      ['browser-tab-strip', '浏览器 tab 条', '../src/source/BrowserRegion.jsx', 'SourceBrowserRegion({ state: "tab-strip" })', 'viewport'],
    ],
  },
  {
    id: 'settings',
    label: '设置',
    note: '设置导航器与全部设置子页',
    components: [
      ['settings-navigator', '设置导航器', '../src/source/SettingsRegion.jsx', 'SourceSettingsNavigator({ selectedSubpage: "app" })', ['source-shell.css'], 'viewport'],
      ['settings-app', '设置 · 应用', '../src/source/SettingsRegion.jsx', 'SourceSettingsDetail({ subpage: "app" })', ['source-shell.css'], 'tall'],
      ['settings-appearance', '设置 · 外观', '../src/source/SettingsRegion.jsx', 'SourceSettingsDetail({ subpage: "appearance" })', ['source-shell.css'], 'tall'],
      ['settings-input', '设置 · 输入', '../src/source/SettingsRegion.jsx', 'SourceSettingsDetail({ subpage: "input" })', ['source-shell.css'], 'tall'],
      ['settings-workspace', '设置 · Workspace', '../src/source/SettingsRegion.jsx', 'SourceSettingsDetail({ subpage: "workspace" })', ['source-shell.css'], 'tall'],
      ['settings-permissions', '设置 · 权限', '../src/source/SettingsRegion.jsx', 'SourceSettingsDetail({ subpage: "permissions" })', ['source-shell.css'], 'tall'],
      ['settings-labels', '设置 · 标签', '../src/source/SettingsRegion.jsx', 'SourceSettingsDetail({ subpage: "labels" })', ['source-shell.css'], 'tall'],
      ['settings-messaging', '设置 · Messaging', '../src/source/SettingsRegion.jsx', 'SourceSettingsDetail({ subpage: "messaging" })', ['source-shell.css'], 'tall'],
      ['settings-server', '设置 · 服务器', '../src/source/SettingsRegion.jsx', 'SourceSettingsDetail({ subpage: "server" })', ['source-shell.css'], 'tall'],
      ['settings-shortcuts', '设置 · 快捷键', '../src/source/SettingsRegion.jsx', 'SourceSettingsDetail({ subpage: "shortcuts" })', ['source-shell.css'], 'tall'],
      ['settings-preferences', '设置 · 偏好', '../src/source/SettingsRegion.jsx', 'SourceSettingsDetail({ subpage: "preferences" })', ['source-shell.css'], 'tall'],
      ['settings-account-security', '设置 · 账号安全', '../src/source/SettingsRegion.jsx', 'SourceSettingsDetail({ subpage: "account-security" })', ['source-shell.css'], 'tall'],
    ],
  },
  {
    id: 'organization',
    label: '组织',
    note: '组织管理对话框 (成员/邀请/作品 tabs)',
    components: [
      ['organization-manage-members', '组织管理 · 成员', '../src/source/OrganizationManage.jsx', 'SourceOrganizationManage({ state: "members" })', 'viewport'],
      ['organization-manage-invitations', '组织管理 · 邀请', '../src/source/OrganizationManage.jsx', 'SourceOrganizationManage({ state: "invitations" })', 'viewport'],
      ['organization-manage-artifacts', '组织管理 · 作品', '../src/source/OrganizationManage.jsx', 'SourceOrganizationManage({ state: "artifacts" })', 'viewport'],
    ],
  },
  {
    id: 'system',
    label: '系统',
    note: '快捷键对话框、重置确认、管理员登录',
    components: [
      ['shortcuts-dialog', '快捷键对话框', '../src/source/KeyboardShortcutsDialog.jsx', 'SourceKeyboardShortcutsDialog()', 'tall'],
      ['reset-confirmation', '重置确认', '../src/source/ResetDialog.jsx', 'SourceResetConfirmation()', 'viewport'],
      ['admin-login', '管理员登录', '../src/source/AdminLogin.jsx', 'SourceAdminLogin()', ['source-admin-login.css'], 'viewport'],
      ['phone-auth', '验证码登录', '../src/source/OnboardingAuth.jsx', 'SourcePhoneAuth({ state: "entry" })', ['source-admin-login.css'], 'viewport'],
      ['phone-auth-verify', '验证码登录 · 输入验证码', '../src/source/OnboardingAuth.jsx', 'SourcePhoneAuth({ state: "verify" })', ['source-admin-login.css'], 'viewport'],
    ],
  },
]

// SSR entry: mounts every registry component on a page and exposes the
// static markup map to Node.
const entryName = 'gallery-entry'
const entrySource = `
import { renderToStaticMarkup } from 'react-dom/server'
import React from 'react'
${[...new Set(groups.flatMap(group => group.components.map(([, , specifier]) => specifier)))].map(specifier => {
  const from = specifier
  return `import * as mod${safeName(from)} from '${from}'`
}).join('\n')}
const poloIconSrc = new URL('../assets/renderer/polo-app-icon.png', import.meta.url).href
const registry = {
${groups.map(group => group.components.map(([slug, , specifier, expression]) => {
  const ns = 'mod' + safeName(specifier)
  // Registry expressions are written `Comp({ props })`; rewrite them to
  // createElement so hooks only run inside the SSR render pass. Aliases map
  // registry shorthand to the real module export names.
  const aliases = { SourceLifecycle: 'SourceLifecycleRegion' }
  const call = expression.replace(/^(\w+)\(([\s\S]*)\)$/, (_match, fn, args) => `React.createElement(${ns}.${aliases[fn] ?? fn}, ${args.trim() || 'null'})`)
  return `  '${slug}': () => ${call},`
}).join('\n')).join('\n')}
}
export function renderAll() {
  const out = {}
  for (const [slug, makeElement] of Object.entries(registry)) {
    // Components call hooks, so element creation must happen inside the
    // render pass — never at module init.
    out[slug] = renderToStaticMarkup(makeElement())
  }
  return out
}
`
function safeName(specifier) {
  return specifier.replace(/[^A-Za-z0-9]/g, '_')
}

mkdirSync(buildDir, { recursive: true })
const entryPath = resolve(buildDir, entryName + '.jsx')
writeFileSync(entryPath, entrySource)

// Vite SSR build resolves JSX, lucide-react, and the svg asset imports exactly
// like the prototype build.
const vite = await import(pathToFileURL(viteModule).href)
const reactPluginModule = await import(pathToFileURL(resolve(root, '../../../../../dev/node_modules/@vitejs/plugin-react/dist/index.js')).href)
const reactPlugin = (reactPluginModule.default || reactPluginModule)({ runtime: 'automatic' })
await vite.build({
  root,
  configFile: false,
  logLevel: 'warn',
  plugins: [reactPlugin],
  resolve: {
    alias: {
      react: resolve(root, '../../../../../dev/node_modules/react'),
      'react-dom': resolve(root, '../../../../../dev/node_modules/react-dom'),
      'react-dom/server': resolve(root, '../../../../../dev/node_modules/react-dom/server.node.js'),
      'lucide-react': resolve(root, '../../../../../dev/node_modules/lucide-react'),
    },
  },
  build: {
    outDir: buildDir,
    emptyOutDir: false,
    ssr: entryPath,
    rollupOptions: {
      output: { entryFileNames: 'gallery-ssr.mjs', format: 'esm' },
    },
  },
})

// svg/png imports become URLs to emitted assets in SSR builds; rewrite them
// to absolute file URLs so renderToStaticMarkup embeds something readable and
// the gallery exporter can inline them as data URLs.
const ssrModule = await import(pathToFileURL(resolve(buildDir, 'gallery-ssr.mjs')).href)
const markup = ssrModule.renderAll()

// Inline tokens/base css (source styles) into every page.
const tokens = readFileSync(resolve(root, 'src/styles/tokens.css'), 'utf8')
const base = readFileSync(resolve(root, 'src/styles/base.css'), 'utf8')
const cssFor = (extra) => [tokens, base, ...(extra ?? []).map(file => readFileSync(resolve(root, 'src/styles', file), 'utf8'))].join('\n')

// Inline any asset URL the SSR markup emitted (svg data or png path).
function inlineAssets(html) {
  return html.replace(/(src|href)="(\/assets\/[^"]+)"/g, (_match, attr, assetUrl) => {
    const assetPath = resolve(buildDir, '.' + assetUrl)
    if (!existsSync(assetPath)) return `${attr}="${assetUrl}"`
    const extension = assetPath.split('.').pop().toLowerCase()
    const mime = extension === 'png' ? 'image/png' : extension === 'svg' ? 'image/svg+xml' : 'image/jpeg'
    return `${attr}="data:${mime};base64,${readFileSync(assetPath).toString('base64')}"`
  })
}

function pageDocument({ title, body, css, note, height }) {
  return `<!doctype html>
<html lang="zh-Hans" data-theme="light">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<meta name="color-scheme" content="light dark">
<title>${title} · Polo 组件画廊</title>
<style>
${css}
</style>
<style>
/* Gallery chrome only — not part of the translated component. */
html, body { overflow: auto; height: auto; }
#root { min-height: 100%; }
.gallery-body { position: relative; min-height: ${height}; background: var(--background); }
.gallery-note { position: fixed; left: 12px; bottom: 10px; z-index: 999; padding: 4px 10px; border-radius: 6px; background: color-mix(in srgb, var(--foreground) 4%, var(--background)); box-shadow: var(--shadow-minimal); color: var(--fg-50); font-size: 11px; user-select: none; }
.gallery-dark-toggle { position: fixed; right: 12px; bottom: 10px; z-index: 999; padding: 4px 10px; border-radius: 6px; border: 1px solid color-mix(in srgb, var(--foreground) 15%, transparent); background: var(--background); color: var(--foreground); font-size: 11px; box-shadow: var(--shadow-minimal); }
/* Canvas-embed mode (?embed=1): the gallery index frames components in iframes
   and provides its own chrome, so hide the per-page note and theme toggle. */
.gallery-embed .gallery-note, .gallery-embed .gallery-dark-toggle { display: none; }
</style>
</head>
<body>
<script>if (new URLSearchParams(location.search).get('embed') === '1') document.documentElement.classList.add('gallery-embed')</script>
<div id="root"><div class="gallery-body">${body}</div></div>
<div class="gallery-note">${note}</div>
<button class="gallery-dark-toggle" onclick="document.documentElement.dataset.theme = document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark'">切换主题</button>
</body>
</html>
`
}

mkdirSync(outDir, { recursive: true })
const indexRows = []
for (const group of groups) {
  const groupDir = resolve(outDir, group.id)
  mkdirSync(groupDir, { recursive: true })
  // Entries are [slug, title, specifier, expression, extraCss?, size]; the
  // trailing size tier is not part of the page export.
  for (const [slug, title, , , extraCss] of group.components.map(entry => entry.filter(part => typeof part !== 'string' || !['viewport', 'tall', 'panel'].includes(part)))) {
    const body = inlineAssets(markup[slug] ?? '')
    const file = resolve(groupDir, slug + '.html')
    writeFileSync(file, pageDocument({
      title,
      body,
      css: cssFor(extraCss),
      note: `${group.label} / ${title} — 静态翻译自 Renderer 源码`,
      height: slug.includes('settings') ? '100vh' : '100vh',
    }))
    indexRows.push({ group: group.id, slug, title })
  }
}

// Overview index: a Figma-style infinite canvas. Each component is laid out
// as a frame (an iframe showing the exported page in embed mode) on a
// pannable/zoomable board, grouped by catalog group with Figma-like section
// labels. Pure inline script, still no network.
//
// Frames are sized by the component's logical design size, not one uniform
// box: 'viewport' = full app window (1440x900), 'tall' = full-page scrollable
// content (1000x1500), 'panel' = partial side panel (560x640). Frames render
// at half scale so the canvas shows real proportions while staying compact.
//
// Perf: 43 live iframes are expensive. The canvas therefore lays out cheap
// placeholder boxes up front and mounts the real iframe only when a frame
// enters the viewport (IntersectionObserver), parking it (display:none) when
// it leaves. Transform writes are batched per frame via rAF.
const SIZES = {
  viewport: { w: 1440, h: 900 },
  tall: { w: 1000, h: 1500 },
  panel: { w: 560, h: 640 },
}
const RENDER_SCALE = 0.5 // frames are drawn at half their logical size
const GAP_X = 64
const GAP_Y = 120
const SECTION_PAD = 48
const TITLE_H = 26
const frames = []
for (const group of groups) {
  // Entries carry the size tier as their last element (after the optional
  // extra-css list). Row-cluster by tier so each row has one uniform height.
  const tierOf = entry => entry[entry.length - 1]
  const tiers = ['viewport', 'tall', 'panel']
  const rows = []
  for (const tier of tiers) {
    const items = group.components.filter(entry => tierOf(entry) === tier)
    for (let i = 0; i < items.length; i += 3) rows.push(items.slice(i, i + 3))
  }
  const laidOut = []
  let y = SECTION_PAD + 44
  let maxWidth = 0
  for (const row of rows) {
    const rowTier = tierOf(row[0])
    const { w, h } = SIZES[rowTier]
    const drawW = w * RENDER_SCALE
    const drawH = h * RENDER_SCALE
    row.forEach((entry, index) => {
      laidOut.push({
        type: 'frame',
        title: entry[1],
        href: `./${group.id}/${entry[0]}.html`,
        size: rowTier,
        x: index * (drawW + GAP_X),
        y,
      })
    })
    maxWidth = Math.max(maxWidth, row.length * drawW + (row.length - 1) * GAP_X)
    y += drawH + TITLE_H + GAP_Y
  }
  frames.push({ type: 'section', label: group.label, note: group.note })
  frames.push(...laidOut)
  frames.push({ type: 'break', advance: y + GAP_Y - SECTION_PAD - 44 + SECTION_PAD + 44 - GAP_Y })
}
const framesJs = JSON.stringify(frames, null, 2)

const indexHtml = `<!doctype html>
<html lang="zh-Hans" data-theme="light">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Polo 组件画廊 · Canvas</title>
<style>
${cssFor()}
html, body { height: 100%; overflow: hidden; }
body { font-size: 14px; }
#canvas-viewport { position: fixed; inset: 0; overflow: hidden; cursor: grab; background: var(--fg-2); }
#canvas-viewport.panning { cursor: grabbing; }
/* Figma-style dot grid; scales with zoom via a CSS var. */
#canvas-world { position: absolute; top: 0; left: 0; transform-origin: 0 0; will-change: transform; }
#canvas-grid { position: fixed; inset: 0; pointer-events: none; background-image: radial-gradient(color-mix(in srgb, var(--foreground) 14%, transparent) 1px, transparent 1px); background-size: var(--grid, 24px) var(--grid, 24px); opacity: .5; }
.canvas-section { position: absolute; pointer-events: none; }
.canvas-section .canvas-section-label { font-size: 20px; font-weight: 600; color: var(--foreground); letter-spacing: -.01em; }
.canvas-section .canvas-section-note { margin-top: 2px; font-size: 12px; color: var(--fg-50); }
.canvas-frame-link { position: absolute; display: block; text-decoration: none; color: inherit; }
.canvas-frame-card { position: relative; border-radius: 10px; overflow: hidden; background: var(--background); box-shadow: var(--shadow-minimal), 0 0 0 1px color-mix(in srgb, var(--foreground) 10%, transparent); }
.canvas-frame-card iframe { position: absolute; top: 0; left: 0; border: 0; transform-origin: 0 0; pointer-events: none; }
.canvas-frame-title { margin-top: 7px; font-size: 12px; color: var(--fg-50); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.canvas-frame-link:hover .canvas-frame-card { box-shadow: var(--shadow-minimal), 0 0 0 2px var(--accent); }
.canvas-frame-link:hover .canvas-frame-title { color: var(--accent); }
#canvas-hud { position: fixed; top: 14px; left: 16px; z-index: 50; display: flex; align-items: center; gap: 10px; padding: 7px 12px; border-radius: 9px; background: var(--background); box-shadow: var(--shadow-minimal), 0 0 0 1px color-mix(in srgb, var(--foreground) 10%, transparent); font-size: 12.5px; }
#canvas-hud .canvas-hud-title { font-weight: 600; }
#canvas-hud .canvas-hud-hint { color: var(--fg-50); }
#canvas-zoom { min-width: 52px; text-align: center; font-variant-numeric: tabular-nums; color: var(--foreground); }
#canvas-hud button { border: 0; background: transparent; color: var(--foreground); font-size: 14px; padding: 2px 7px; border-radius: 6px; }
#canvas-hud button:hover { background: color-mix(in srgb, var(--foreground) 6%, transparent); }
#canvas-theme { position: fixed; top: 14px; right: 16px; z-index: 50; padding: 7px 12px; border-radius: 9px; border: 0; background: var(--background); color: var(--foreground); font-size: 12.5px; box-shadow: var(--shadow-minimal), 0 0 0 1px color-mix(in srgb, var(--foreground) 10%, transparent); }
</style>
</head>
<body>
<div id="canvas-grid"></div>
<div id="canvas-viewport"><div id="canvas-world"></div></div>
<div id="canvas-hud">
  <span class="canvas-hud-title">Polo 组件画廊</span>
  <span class="canvas-hud-hint">拖拽平移 · ⌘/Ctrl+滚轮缩放 · 点击 frame 打开</span>
  <button id="canvas-zoom-out" aria-label="缩小">−</button>
  <span id="canvas-zoom">100%</span>
  <button id="canvas-zoom-in" aria-label="放大">+</button>
  <button id="canvas-fit" title="适配全部 (0)">适配</button>
</div>
<button id="canvas-theme" onclick="document.documentElement.dataset.theme = document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark'">切换主题</button>
<script>
const FRAMES = ${framesJs};
const SIZES = ${JSON.stringify(SIZES)};
const RENDER_SCALE = ${RENDER_SCALE};
const GAP_X = ${GAP_X}, GAP_Y = ${GAP_Y}, SECTION_PAD = ${SECTION_PAD}, TITLE_H = ${TITLE_H}
const world = document.getElementById('canvas-world')
const viewport = document.getElementById('canvas-viewport')
const grid = document.getElementById('canvas-grid')
const zoomLabel = document.getElementById('canvas-zoom')
let scale = 1, panX = 0, panY = 0

// Build placeholder DOM (no iframes yet); track world bounds for fit().
let cursorY = 0, minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity
const frameEntries = []
for (const item of FRAMES) {
  if (item.type === 'section') {
    const section = document.createElement('div')
    section.className = 'canvas-section'
    section.style.left = '0px'
    section.style.top = cursorY + 'px'
    section.innerHTML = '<div class="canvas-section-label">' + item.label + '</div><div class="canvas-section-note">' + item.note + '</div>'
    world.appendChild(section)
    minY = Math.min(minY, cursorY)
    continue
  }
  if (item.type === 'break') { cursorY += item.advance; continue }
  const drawW = SIZES[item.size].w * RENDER_SCALE
  const drawH = SIZES[item.size].h * RENDER_SCALE
  const link = document.createElement('a')
  link.className = 'canvas-frame-link'
  link.href = item.href
  link.target = '_blank'
  link.rel = 'noopener'
  link.style.left = item.x + 'px'
  link.style.top = (cursorY + item.y) + 'px'
  link.innerHTML = '<div class="canvas-frame-card" style="width:' + drawW + 'px;height:' + drawH + 'px"></div><div class="canvas-frame-title">' + item.title + '</div>'
  world.appendChild(link)
  frameEntries.push({ item, link, drawW, drawH, mounted: false, iframe: null })
  minX = Math.min(minX, item.x); minY = Math.min(minY, cursorY + item.y)
  maxX = Math.max(maxX, item.x + drawW); maxY = Math.max(maxY, cursorY + item.y + drawH + TITLE_H)
}
world.style.width = (maxX + 400) + 'px'
world.style.height = (maxY + 400) + 'px'

// Lazy-mount: a frame gets its real iframe only while near the viewport.
const io = new IntersectionObserver(entries => {
  for (const entry of entries) {
    const record = frameEntries.find(f => f.link === entry.target)
    if (!record) continue
    if (entry.isIntersecting) mount(record)
    else park(record)
  }
}, { root: viewport, rootMargin: '600px 600px' })

function mount(record) {
  if (record.iframe) { record.iframe.style.display = ''; return }
  const iframe = document.createElement('iframe')
  iframe.src = record.item.href + '?embed=1'
  iframe.loading = 'lazy'
  iframe.title = record.item.title
  iframe.tabIndex = -1
  // Render the page at the component's logical size, then scale down to the
  // drawn frame size — so proportions match the real app window.
  iframe.style.width = SIZES[record.item.size].w + 'px'
  iframe.style.height = SIZES[record.item.size].h + 'px'
  iframe.style.transform = 'scale(' + (RENDER_SCALE) + ')'
  record.link.querySelector('.canvas-frame-card').appendChild(iframe)
  record.iframe = iframe
  record.mounted = true
}
function park(record) {
  if (record.iframe) record.iframe.style.display = 'none'
  record.mounted = false
}
frameEntries.forEach(record => io.observe(record.link))

let rafPending = false
function apply() {
  if (rafPending) return
  rafPending = true
  requestAnimationFrame(() => {
    rafPending = false
    world.style.transform = 'translate(' + panX + 'px,' + panY + 'px) scale(' + scale + ')'
    const dot = Math.max(8, Math.min(56, 24 * scale))
    grid.style.setProperty('--grid', dot + 'px')
    grid.style.backgroundSize = dot + 'px ' + dot + 'px'
    grid.style.backgroundPosition = panX + 'px ' + panY + 'px'
    zoomLabel.textContent = Math.round(scale * 100) + '%'
  })
}
function zoomAt(next, cx = innerWidth / 2, cy = innerHeight / 2) {
  const prev = scale
  scale = Math.min(2.5, Math.max(.05, next))
  panX = cx - (cx - panX) * (scale / prev)
  panY = cy - (cy - panY) * (scale / prev)
  apply()
}
function fit() {
  // Fit horizontally (width-first): the canvas is tall, so frame the full
  // content width and let the user pan vertically. Still capped to 100%.
  const w = maxX - minX
  scale = Math.max(.1, Math.min((innerWidth - 120) / w, 1))
  panX = (innerWidth - w * scale) / 2 - minX * scale
  panY = 40 - minY * scale
  apply()
}
viewport.addEventListener('wheel', event => {
  event.preventDefault()
  if (event.metaKey || event.ctrlKey) {
    zoomAt(scale * Math.exp(-event.deltaY * .0022), event.clientX, event.clientY)
  } else {
    panX -= event.deltaX; panY -= event.deltaY
    apply()
  }
}, { passive: false })
let panning = false, startX = 0, startY = 0, baseX = 0, baseY = 0
viewport.addEventListener('pointerdown', event => {
  panning = true; startX = event.clientX; startY = event.clientY; baseX = panX; baseY = panY
  viewport.classList.add('panning')
})
window.addEventListener('pointermove', event => {
  if (!panning) return
  panX = baseX + (event.clientX - startX); panY = baseY + (event.clientY - startY)
  apply()
})
window.addEventListener('pointerup', () => { panning = false; viewport.classList.remove('panning') })
document.getElementById('canvas-zoom-in').addEventListener('click', () => zoomAt(scale * 1.25))
document.getElementById('canvas-zoom-out').addEventListener('click', () => zoomAt(scale / 1.25))
document.getElementById('canvas-fit').addEventListener('click', fit)
window.addEventListener('keydown', event => {
  if (event.key === '0') fit()
  if (event.key === '=' || event.key === '+') zoomAt(scale * 1.25)
  if (event.key === '-') zoomAt(scale / 1.25)
})
fit()
</script>
</body>
</html>
`
writeFileSync(resolve(outDir, 'index.html'), indexHtml)

// Clean the SSR build output; it is a build artifact, not a reviewed asset.
rmSync(buildDir, { recursive: true, force: true })
console.log(`Wrote components/ gallery: ${indexRows.length} component pages across ${groups.length} groups + index.html`)
