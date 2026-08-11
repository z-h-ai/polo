# G4 UI 原型 Phase 0：冻结输入记录（红队修正版）

状态：冻结记录已按红队结论修正（2026-08-10）；旧原型 Git 历史保存方式**待用户裁决**；逐流程场景矩阵见 `docs/g4-ui-prototype-scene-matrix.md`

依据：`docs/g4-ui-prototype-reimplementation-plan.md` §8 Phase 0；红队审查（codex sol-max，2026-08-10，日志 `.redteam/redteam-run.log`）必须修复项 #1。

## 1. Before 源码根冻结记录

| 项 | Polo 客户端源码根 | 管理端源码根 |
| --- | --- | --- |
| 路径 | `/Users/wow/project/z-h-ai/polo-dir/dev` | `/Users/wow/project/z-h-ai/polo-admin-dir/dev` |
| 冻结 commit（完整 SHA） | `01f4447cf77612ca2c62d9c7155601a51bdb7b5b` | `ce3bbdcecabe34f389f16ade46514b24558ee834` |
| 分支 / 工作树状态 | `dev` / 干净 | `dev` / 干净（2026-08-10 曾因本任务冒烟测试短暂出现 `M next-env.d.ts`，已用 `git checkout` 恢复并经 `git status` 复核干净） |
| 产品版本 | polo-ai 0.16.3（Electron + bun monorepo） | polo-admin v0.4.2（Next.js + Prisma） |
| 主题能力 | 浅色 + 深色（`ThemeContext.tsx`、`docs/DESIGN.md` 双核心色对） | 仅浅色（`globals.css` 只有 `:root` HSL token） |
| 多语言能力 | 7 语言：`de/en/es/hu/ja/pl/zh-Hans`（`packages/shared/src/i18n/locales/`） | 无 i18n 机制，页面文案硬编码中文 |
| 视觉权威来源 | `docs/DESIGN.md`（oklch 双色派生系统，accent `#5e17eb`） | `src/app/globals.css` + `tailwind.config.ts` + `src/components/admin-shell.tsx` |

### 1.1 可重复渲染证据（红队修正：附限制条件）

| 源码根 | 启动合同 | 实测结果（2026-08-10） | 限制与回退 |
| --- | --- | --- | --- |
| polo-dir/dev | `bun run webui:dev`（Vite :5175；**会先 `kill -9` 占用 5175 的进程**，执行前确认端口无占用） | HTTP 200，页面外壳可渲染 | 完整应用依赖 `/api/config` 与 WebSocket 后端；登录态页面不可无后端渲染。**Before 提取主路径 = 静态源码提取**；运行时捕获仅用于无后端可达页面。`apps/electron/dist/renderer` 被 `.gitignore` 排除且产物时间早于冻结 HEAD，**不作为证据**；如需构建产物，在冻结 commit 的临时干净副本中重建并记录 hash |
| polo-admin-dir/dev | `npm install && npm run dev -- -p 3100`（本任务已在该工作树完成 `npm install`，593 包；`next dev` 会重写 `next-env.d.ts`，每次运行后必须 `git checkout -- next-env.d.ts` 恢复） | `/login` HTTP 200，`/` HTTP 200 | DB 依赖页面需数据库；**Before 提取主路径 = 静态源码 + 登录等公开页运行时捕获** |

## 2. 输出工作树冻结记录

| 产品入口 | 输出工作树 | Git commit | 既有原型文件的 Git 跟踪状态（红队查证） |
| --- | --- | --- | --- |
| Polo 客户端 | `/Users/wow/project/z-h-ai/polo-dir/POO-41/feat/polo-client-g4-ui` | `9cf50224` | `index.html`、`review-record.md` 为 **staged addition**；`V2.html` **未跟踪** |
| 企业组织管理端 | `/Users/wow/project/z-h-ai/polo-admin-dir/POL-73/feat/enterprise-admin-ui-v1` | `ce3bbdce` | 整个 `design-demos/enterprise-admin-ui-v1/` **未跟踪** |
| 创作者工作台 | `/Users/wow/project/z-h-ai/polo-admin-dir/POL-74/feat/creator-workbench-ui-v1` | `ce3bbdce` | 整个 `design-demos/creator-workbench-ui-v1/` **未跟踪** |
| 平台运营端 | `/Users/wow/project/z-h-ai/polo-admin-dir/POL-75/feat/platform-operations-ui-v1` | `ce3bbdce` | 整个 `design-demos/platform-operations-ui-v1/` **未跟踪** |

**待用户裁决（D1）**：计划 §1 称"历史版本通过 Git 追溯"，但四套 v1 原型当前均未进入 Git 历史。覆盖前必须先提交快照（每个工作树一个 `chore: snapshot G4 v1 prototypes before reimplementation` 提交），或用户明确放弃这些历史。

边界不变：Before 提取只读两个 dev 源码根；输出只写四个工作树的 `design-demos/` 与 comm-defs 的 `docs/`、`scripts/`、`.pipeline/`、`.redteam/`。

## 3. 现有 Before 表面清单（红队修正版）

### 3.1 Polo 客户端（polo-dir/dev）

| 表面 | 路径 | 红队修正 |
| --- | --- | --- |
| 助手会话组合入口 | `apps/electron/src/renderer/pages/ChatPage.tsx` | 真实会话页在此；`components/chat/` 仅辅助组件 |
| Skill 状态 | `atoms/skills.ts`（仅已加载数组，**无显式启用状态**）；失效/归档/stale UI 在 `pages/SkillInfoPage.tsx` | PC-F04 降为 partial_surface；PC-F08 证据指向 SkillInfoPage |
| 工作台首页/组织 App 卡 | `components/tab-browser/HomePage.tsx`、`OrganizationAppCard.tsx` | 维持 |
| 组织（旧模型） | `components/organization/`（Switcher/Onboarding/ManagementDialog/CreatorArtifactsPanel）、`context/OrganizationContext.tsx` | 维持；语义为旧 organizationId 模型 |
| 登录/onboarding | `components/onboarding/`、`apps/webui/src/login.html` | 维持 |
| 圈子/契约不一致 UI | 无 | fully_absent |

### 3.2 管理端（polo-admin-dir/dev）

| 表面 | 路径 | 红队修正 |
| --- | --- | --- |
| `(admin)/dashboard` | 用量统计页 | **不是**健康行动队列；OPS-F01 降为 nearest_reference |
| `(admin)/users`、`users/[id]` | 用户管理 | OPS-F02 partial_surface；OPS-F05/F06 nearest_reference |
| `(admin)/groups` | Prisma `Group` ≠ `Organization` 租户 | **不能**当企业租户管理页；OPS-F03 fully_absent |
| `(admin)/app-governance` | 单对象停用/恢复表单 | OPS-F09/F10/F11 nearest_reference |
| `(admin)/creator-skill-policy` | 政策配置页 | OPS-F08 partial_surface |
| `(admin)/audit-logs` | 审计列表 | OPS-F13 审计查看 nearest_reference |
| `(organization-console)/organization-apps`、`organization-apps/publish`、`organization-skills` | 组织作品与发布页 | ENT-F07/F08/F09 partial_surface；**CRE-F04/F05/F06 修正为 partial_surface**（旧 creator_space 页面已有创建、版本、归档/恢复、校验进度、失败/ready 状态） |
| 登录 | `login/page.tsx`、`organization-login/page.tsx` | 维持 |

## 4. 46 流程覆盖矩阵

红队判定旧矩阵"不可执行"（无稳定 scene ID、无五态适用列与 N/A 理由、无 fixture/触发方式）。可执行矩阵已重写为独立文档：**`docs/g4-ui-prototype-scene-matrix.md`**（逐 flow × scene、六档 Before 证据分类、语言/视口/角色规则、15 条流程缺口修正、ENT-F03/PC-F05 邀请落地页所有权裁决）。

## 5. Phase 0 通过条件自检（修正后）

- [x] 每条流程有明确产品文档与 Before 来源策略（六档证据分类，见场景矩阵）。
- [x] 两个源码根完整 SHA、分支、工作树状态已冻结记录（§1）。
- [x] 可渲染情况附可重复启动合同与限制（§1.1），不再推迟到 Phase 1。
- [ ] 四套 v1 原型 Git 历史保存（**待用户裁决 D1**）。
- [x] 任务目录之外文件零改动（曾有的 `next-env.d.ts` 副作用已恢复并复核）。
