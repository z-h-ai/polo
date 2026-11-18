# POO-196 e2e 对齐 POO-205 现役契约（挂账任务卡）

> 2026-11-13 由 POO-205 收尾会话起草。脚本真跑会挂在首个死引用点；本卡给出分诊结论、
> 现役替代锚点、处置方案与验收线。执行者以真实运行为准，不按静态清单盲改。

## 背景

`apps/electron/e2e/poo196-project-context/main.ts`（6499 行，入口 `run.mjs`）是「项目上下文」
主题唯一的自动化 journey（e2e 目录无 POO-205 替代脚本，**不能整体退役**）。POO-205 重构
（v0.29.0）更换了成员面板、上传、建项目交互体系的 testid 命名，脚本大量锚点落到已退役 UI。

POO-205 交付时只做了定向套件 + 真实应用手工旅程验收，未修复本脚本；收尾会话仅摘除 lint
命中的死断言段（S13/S18 UB3，commit 10d89487），其余死引用挂账到本卡。

## 已核实的现役替代锚点（执行时以此为准，仍需真跑核对）

| 旧体系（e2e 现锚定） | 现役体系（生产源码已核实） | 处置 |
|---|---|---|
| `project-members-compose*` / `project-members-invitations*` / `project-members-invitation-row` / `direct-invite` / `invite-existing/invite-target/invite-submit/invite-result` / `copy-link/copy-all*` / `result-back/result-management` / `pending-summary` / `invitations-entry/more/retry` | `ProjectMembersPanel.tsx`：`project-members-invite-action` 单入口 + `project-colleagues-page/row/row-toggle/selected/confirm/role-select/search/empty` 选人页 + 面板壳 `project-members-panel/close/backdrop/title/search/roster/roster-row/roster-count/row-manage/role-menu/role-option/remove-*` | 改锚点重写交互段；`pending-summary` 与邀请记录子页改为「旧入口不存在」退役守卫 |
| `pc-upload-*`（upload-name/digest/file-summary/preset-tag-*/submit/tag-input/tag-error/cancel/error） | `pc-batch-*`（batch-view/entry/start/list/summary/tag-input/tag-error/preset-tags/scanning/progress/retry/source/select-all/select-none/done/cancel/back/budget-note） | 改锚点重写上传段 |
| `create-project-enter-*` / `verify-phone` / `phone-verification` / `owner-input` / `owner-sync-hint` / `query-receipt` / `responsibility*` / `stored-request` / `update-guide*` / `version-mismatch` / `recovery` / `retry-enter` / `enterprise-exists` / `budget-fact` / `client-update` | `CreateProjectDialog.tsx` 现役键（`create-project-submit` :258、`create-project-submit-error` :191 等以现役源码为准）；「进入已有企业项目」旧流程已退役 | 能力仍存的改锚点；纯旧流程段摘除+退役注记（沿用 10d89487 格式） |
| `home-project-enter-error/enter-retry/readonly`、`pc-replace-*`、`pc-members-entry-plus`、`pc-tag-filter-confirmed`、`pc-mention-extra-skill:*`、`project-colleagues-query-result/retry-failed`、`project-asset-ref-status-*`、`product-space-create-project`/`product-space-select-create-project` | 逐个核对现役源码；无对应的摘段 | 分类同上 |

**fixture 提供、勿动**：`poo196-shell` / `poo196-active-session` / `poo196-space-menu-*` 由
`pages/host.tsx` 注入；`pc-library`/`pc-list`/`pc-loading` 等同（9 个 harness-provided 键）。

## 口径说明（避免重复踩坑）

死键数量随提取口径浮动：按脚本内 selector 表人工核对为 33；按全 `querySelector` 选择器
归一化自动提取为 79（含 fixture 实例键归族误差）。**不要以静态清单为验收依据**——正确
方法是：真跑 `run.mjs` → 挂在首个死点 → 对照本卡现役锚点修段 → 增量重跑，循环到 ALL PASS。

## 方法要求

1. 真实 Electron 环境跑通全程（`bun apps/electron/e2e/poo196-project-context/run.mjs`，
   环境启动方式参照 `poo161-canvas-recovery/run.mjs` 的既有套路），禁止只做静态核对。
2. 每修一族跑一次增量，挂点前移说明修复生效；不要攒到最后一次性验证。
3. 摘段时保留 fixture 复位行（参照 S18 摘除先例：closeMembersPanel/setPmFault 复位 + delay）。
4. 退役守卫写成「断言旧 testid 不出现」，防止旧 UI 回魂，不是简单删断言。
5. 修复只动 e2e 脚本与其 fixture，**不改生产代码迁就旧锚点**；发现生产确缺可观测点时
   （现役 UI 无等价 testid），在该处补 testid 属于本卡范围内的最小生产改动，单独成 commit。

## 验收线

- `run.mjs` ALL PASS；连跑 3 次无 flaky；fixture 复位不残留（下轮启动状态干净）。
- `bun run validate:ci` 不受影响（e2e 文件改动后 typecheck 仍绿）。
- 改动落在 main（e2e 不打 tag，随主线走），dev 按两分支独立提交约定同步。

## 边界与已知

- 本卡由收尾会话静态核实现役锚点，未真跑；首个死点可能与预期段落顺序不同，属正常。
- e2e 修复不阻塞 POO-205 已交付里程碑；排期由负责人定，建议放进 POO-205 收尾批。
