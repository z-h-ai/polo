# 变量与样式预览

适用 `native-materials-r4-dev-aligned-20261023`。不复制第二份 token 值；作用域和设计确认仍见 foundations/Spec。

| 样式体系 | 原生维护源与消费顺序 | 浏览入口 | 适用与缺口 |
|---|---|---|---|
| 产品面工作台 | `assets/tokens/workbench-base.css` → `workbench-review.css`；生产由 renderer `lib/client-workbench-style.ts` + `components/ui/client-workbench.ts` 消费 | `assets/tokens/token-preview.html`，以及基线圈子/登录/工作台的真实组件 | light 产品面；材质需 `data-client-material=light` 且非 dark。dark 仅令牌存在未验收；不覆盖设置/助手全局 |
| renderer 设置/助手 | `apps/electron/src/renderer/index.css` 及原生 imports、页面/组件 utility 类，保留 ThemeProvider 和 Tailwind 扫描 | `assets/source-baseline/entries/baseline.html?scene=settings-preferences`；`?scene=components-gallery`；playground | oklch 和原生组件；没有单独完整 renderer token 色板，最终效果需看真实组件。不要替换为工作台 hex 或只摘 :root |

编辑 CSS 源后再生成，不编辑 HTML 输出。cwd：仓库根；Python 3 可生成工作台预览：

```bash
python3 .agents/skills/polo-ai-design-system/tools/build-token-preview.py
# 比较用临时输出，不覆盖已有素材
TOKEN_PREVIEW_FILE="$(mktemp /tmp/polo-token-preview.XXXXXX)"
python3 .agents/skills/polo-ai-design-system/tools/build-token-preview.py "$TOKEN_PREVIEW_FILE"
cmp .agents/skills/polo-ai-design-system/assets/tokens/token-preview.html "$TOKEN_PREVIEW_FILE"
```

输出在 `assets/tokens/token-preview.html`；两份 CSS 与生成器是实际输入。与临时输出逐字节比较只证明再生一致，不代表浏览器样式通过。renderer/组件变动走 native-reuse.md 的 Bun/Node/Vite 依赖及 `tools/source-baseline/build.py [--check]`。目标模板导出按 usage-playbook 第 7 步；本次不修改色值或已确认设计。

保留 CSS cascade/theme/材质宿主，读最终 computed style 与成对页面截图；完整 CSS color 不要包成 `hsl(var(...))`。静态值目录、历史画廊和来源哈希不能证明真实渲染。
