# G4 UI 原型契约补充（红队修正版）

状态：2026-08-10 按红队必须修复项 #4/#5/#6/#7 冻结；与主计划冲突时以主计划为准并回写此处

本文冻结主计划未展开的四组契约：capability-gap bundle 模式、统一校验器前置、After 单一生成源与 hash 闭环、产品级 manifest schema 与 review-record 两阶段确认协议。

## 1. capability-gap bundle 模式（Before 证据不足时的诚实结构）

适用：场景矩阵中证据分级为 `fully_absent`、`nearest_reference`、`ui_absent_api_present` 的流程（46 条中的大多数）。

规则：

1. before.html 不虚构旧版产品。它渲染**真实现有产品**对该场景意图的诚实回应：
   - `fully_absent`：当前产品的最近真实页面/导航状态，其中不含该能力（如现有 admin 壳层内无"圈子"导航）；scene 切换时呈现对应的真实入口尝试结果。
   - `nearest_reference`：最近参考页的真实提取（如 app-governance 单对象表单），不夸大其语义。
   - `partial_surface`：真实部分逐字提取，缺失部分不补画。
2. before/after 的 `prototype-config` scene 集逐字一致（AB 契约硬性要求）；Before 侧每个 scene 是该场景意图在当前产品中的真实落点。
3. manifest 增加顶层块：

```json
"beforeCapability": {
  "status": "fully_absent | nearest_reference | ui_absent_api_present | partial_surface",
  "attemptedEntry": "用户在当前产品中的真实入口路径",
  "negativeEvidence": ["src/app/(admin)/... 导航不含 X", "prisma schema 无 Y 模型"],
  "evidenceClass": "六档之一",
  "staticExtraction": "非 runtime 时的源码提取路径说明"
}
```

4. 校验器对 capability-gap bundle 增加规则：必须有 `beforeCapability` 块；`negativeEvidence` 至少一条且指向真实源码事实；before.html 不出现当前源码中不存在的产品 UI 元素（抽查关键文案）。

## 2. 统一校验器前置（Phase 3 黄金流程开始前完成）

`scripts/validate-g4-ui-prototypes.mjs` 重写提前到 Phase 3 之前，并在 Phase 3/4/5/6 重复运行。新校验器职责：

1. **逐 bundle 静态契约**：调用 stock `validate_bundle.py` 规则的超集——必须文件齐全；`prototype-config` 协议一致；视口含 ≥1 个 <768px；states 为完整笛卡尔积；approximate 标记与 manifest 对应；bundle 自包含（禁止 `../` 逃逸出 bundle 目录）。
2. **协议维度诚实**：管理端 bundle 不得出现单值 `themes`/`langs`；客户端 bundle 必须声明 7 语言与双主题。
3. **产品/评审单向依赖**：产品文件（index.html、before.html、after.html）不得引用或链接 comparison.html、reviews/、review-record.md、任何评审脚本；浏览器运行后检查 DOM、可见文本与实际网络请求（防隐藏注入）。评审页可以嵌产品页。
4. **46 流程覆盖**：四个产品级 manifest 合计恰好声明 46 个唯一 flow ID（PC 11 + ENT 12 + CRE 10 + OPS 13），每个指向存在的 bundle。
5. **hash 闭环**：产品级 manifest 记录每条流程的 `afterHash`；整端 index.html 内嵌对应内容块的 hash 注释，二者必须一致（见 §3）。
6. **场景矩阵符合性**：每 bundle 的 scene 集与 `g4-ui-prototype-scene-matrix.md` 一致（脚本从矩阵解析 scene ID 列表比对）。
7. **真实交互轨迹**：Phase 6 起，Playwright 按矩阵"交互轨迹"列执行并断言可观察结果。

旧版校验器正在验证的是本轮淘汰的旧结构，立即停用并重命名归档为 `scripts/legacy/validate-g4-ui-prototypes.v1.mjs`（不删除）。

## 3. After 单一生成源与整端 hash 闭环

问题：Phase 5 把 flow after.html"汇入"整端 index.html，两套 After 会漂移。

冻结方案：

1. **单一生成源**：每条流程的 After 页面区块以片段文件存于 `flows/<flow-id>/assets/after-sections/*.html`（仅产品内容区块，无评审 UI）。`after.html` 与整端 `index.html` 都由装配脚本 `scripts/assemble-g4-prototypes.mjs` 从这些片段生成。
2. **hash 记录**：装配脚本计算每片段 SHA-256，写入 flow bundle manifest（`afterSections[].hash`）与产品级 manifest（`flows[].afterHash`）。整端 index.html 在对应区块末尾带不可见注释 `<!-- g4:section <flow-id> <hash> -->`。
3. **反向重跑**：修改整端 index.html 中任何流程区块后，必须重跑装配并更新受影响 bundle；校验器发现 hash 不一致即失败。
4. before.html 不参与装配（每条流程的 Before 独立提取，不进入整端产品）。

## 4. 产品级 prototype-manifest.json schema

每个产品入口根目录一份，schemaVersion `g4-product/1.0.0`：

```json
{
  "schemaVersion": "g4-product/1.0.0",
  "product": { "slug": "polo-client-g4-ui", "name": "Polo 客户端", "taskId": "POO-41" },
  "sourceBaseline": {
    "repo": "/Users/wow/project/z-h-ai/polo-dir/dev",
    "gitRevision": "01f4447cf77612ca2c62d9c7155601a51bdb7b5b",
    "capturedAt": "ISO-8601",
    "renderEvidence": "static_surface 主路径说明"
  },
  "protocol": { "themes": ["light", "dark"], "langs": ["zh-Hans", "en", "de", "es", "hu", "ja", "pl"], "viewports": [] },
  "flows": [
    {
      "id": "PC-F04",
      "bundle": "flows/pc-f04",
      "evidenceClass": "partial_surface",
      "scenes": ["skills-list"],
      "afterHash": "sha256…",
      "indexSections": ["home#skills", "assistant#skill-call"],
      "screenshots": 12,
      "browserCheck": { "status": "pass", "at": "ISO-8601" }
    }
  ],
  "coverageSummary": { "flows": 11, "scenes": 0, "approximations": 0 },
  "explicitNonGoals": ["手机端完整管理体验"]
}
```

管理端产品 manifest 省略 `themes`/`langs`。`indexSections` 把流程映射到整端入口的可导航位置，供 §2.6 与评审中心使用。

## 5. review-record 两阶段确认协议

每个产品入口的 `review-record.md` 分两个阶段提交，代理不得预填确认信息：

- **提交 A（冻结物）**：原型 HTML/manifest/截图/校验结果齐备时提交。记录：源码基线 SHA、artifact 文件清单、校验器输出摘要、覆盖矩阵符合性。此时"产品确认"列一律为"待确认"。
- **产品评审**：用户在提交 A 上评审（review 中心 + comparison 页面）。
- **提交 B（确认记录）**：用户确认后写入——`artifactCommit: <提交 A 的 SHA>`、确认人、ISO-8601 时间、确认范围（逐流程或整端）、evidence digest（校验器输出 hash）、明确未进入本版的非目标。冻结后任何改动使提交 B 失效，需重新确认。

四个端各自独立走 A/B；G4-B 通过要求四端都完成提交 B 且全部校验通过。

## 6. 逐任务回写回证

Phase 6 冻结时，按 `docs/implementation-orchestration-plan.md` 的回写字段，把四端冻结结果（artifactCommit、确认日期、确认人、覆盖摘要）回写到 POO-41、POL-73、POL-74、POL-75 及 POL-68 的任务记录，并保留回写动作的服务端/工具回证（输出日志或 API 响应）。回写使用的具体工具在 Phase 6 开始前与用户确认。

## 7. 红队结论处置对照

| 必须修复项 | 处置 | 位置 |
| --- | --- | --- |
| #1 Phase 0 重冻结 | 已修正（完整 SHA、渲染证据、工作树诚实状态）；v1 git 历史待用户裁决 D1 | phase0-baseline.md |
| #2 可执行场景矩阵 | 已重写（46 流程 × scene、15 缺口修正、ENT-F03 拥有落地页） | scene-matrix.md |
| #3 视口/语言/省略规则 | 已冻结（全包 <768px、客户端 7 语言、管理端省略不支持维度） | scene-matrix.md §0 |
| #4 capability-gap 契约 | 本文 §1（ Before 证据六档重新分类已入矩阵） | 本文 |
| #5 校验器前置+单向依赖+交互轨迹 | 本文 §2；validator 重写为 Phase 3 前置任务 | 本文 |
| #6 After 单一生成源+hash 闭环 | 本文 §3 | 本文 |
| #7 review-record 两阶段+回写回证 | 本文 §5、§6 | 本文 |
