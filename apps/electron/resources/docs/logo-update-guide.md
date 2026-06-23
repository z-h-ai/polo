# Logo 更新指南

更新 Polo AI logo 时需要同步修改以下文件。遗漏任何一处都会导致新旧 logo 混用。

## 1. 源文件 & 平台图标

| 文件 | 说明 |
|------|------|
| `apps/electron/resources/source.png` | 主源图，2048×2048 PNG，所有平台图标由此生成 |
| `apps/electron/resources/icon.icns` | macOS 图标（由脚本生成） |
| `apps/electron/resources/icon.ico` | Windows 图标（由脚本生成，需要 ImageMagick） |
| `apps/electron/resources/icon.png` | Linux 图标 512×512（由脚本生成） |

**操作步骤：**

```bash
cd apps/electron/resources

# 方法 A：从 SVG 渲染高清 PNG（推荐）
python3 -c "
import cairosvg
cairosvg.svg2png(url='your-logo.svg', write_to='source.png', output_width=2048, output_height=2048)
"

# 方法 B：直接替换 source.png（确保 ≥1024×1024）

# 生成平台图标
./generate-icons.sh source.png
```

> 依赖：`brew install imagemagick`（生成 .ico），`pip install cairosvg`（SVG 渲染）

## 2. SVG 图标

| 文件 | 用途 |
|------|------|
| `apps/electron/resources/icon.svg` | Electron favicon / 通用 SVG 图标 |
| `apps/electron/resources/icon.icon/Assets/icon.svg` | macOS 26+ Liquid Glass 图标（系统提供背景） |
| `apps/webui/src/public/favicon.svg` | WebUI favicon |

这三个文件内容相同：无背景的 Polo 字标 SVG，使用品牌色 `#5e17eb`。

## 3. 品牌 Logo PNG

`apps/electron/resources/polo-ai-logos/` 目录：

| 文件 | 说明 |
|------|------|
| `polo_ai_app_icon.png` | 应用图标（亮色背景） |
| `polo_ai_app_icon_dark.png` | 应用图标（暗色背景） |
| `polo_ai_logo_black.png` | 深色字标（透明背景） |
| `polo_ai_logo_white.png` | 白色字标（透明背景） |

## 4. 前端内联 SVG 组件

代码中有多处内联的 SVG logo 组件，使用 `currentColor` 跟随主题颜色：

| 文件 | 组件 | 用途 |
|------|------|------|
| `apps/electron/src/renderer/components/icons/PoloAiSymbol.tsx` | `PoloAiSymbol` | 菜单栏 logo（Desktop & Mobile） |
| `apps/electron/src/renderer/components/icons/PoloAiLogo.tsx` | `PoloAiLogo` | Electron 内品牌 logo |
| `packages/ui/src/components/chat/SessionViewer.tsx` | `PoloAiLogo`（内联） | 会话查看器底部品牌标识 |
| `apps/viewer/src/components/Header.tsx` | `PoloAiLogo`（内联） | Viewer 页头 logo |

> 注意：SessionViewer 和 Header 中的 `PoloAiLogo` 是**各自文件内定义的局部组件**，不是从 `PoloAiLogo.tsx` 导入的，需要分别更新。

## 5. Renderer 资产 SVG

| 文件 | 说明 |
|------|------|
| `apps/electron/src/renderer/assets/polo_ai_logo_c.svg` | 被 `PoloAiAppIcon.tsx` 引用的品牌 SVG |

## 6. Playground 图标注册表

| 文件 | 说明 |
|------|------|
| `apps/electron/src/renderer/playground/registry/icons.tsx` | 组件描述文字，确保与新 logo 一致 |

## 品牌色

| 名称 | 值 |
|------|-----|
| 主色（Polo Purple） | `#5e17eb` |

## Checklist

更新 logo 后逐项确认：

- [ ] `source.png` 已替换
- [ ] `./generate-icons.sh` 已运行，icon.icns / icon.ico / icon.png 已更新
- [ ] 3 个 SVG 文件已更新（icon.svg、Liquid Glass SVG、webui favicon）
- [ ] `polo-ai-logos/` 4 个 PNG 已更新
- [ ] `polo_ai_logo_c.svg` 已更新
- [ ] `PoloAiSymbol.tsx` 内联 SVG 已更新
- [ ] `PoloAiLogo.tsx` 内联 SVG 已更新
- [ ] `SessionViewer.tsx` 内联 PoloAiLogo 已更新
- [ ] `Header.tsx` 内联 PoloAiLogo 已更新
- [ ] `icons.tsx` 描述文字已更新
- [ ] 启动 Electron 应用，确认 Dock 图标、菜单 logo、应用内 logo 均为新设计
