# POO-70 视觉验收与修复循环提示词

供开发交付后的独立视觉检查使用；本文件生成不启动验收、不修改 Notma 任务，也不接管正在运行的执行者。

```text
对 POO-70 本批客户端交付执行「视觉 Review → 修复 → 复验」循环，实际执行并留证，直到范围完整且没有未关闭的明确视觉缺陷。

来源工作树：/Users/wow/project/z-h-ai/polo-dir/integration/poo70-client-entry-r15；Notma workspace：/Users/wow/project/z-h-ai/team-workspace。以下路径相对来源仓库根：
需求 docs/client-journey-review/spec.md；视觉参照 docs/mvp-complete-flow-hifi/prototype.html 及其 prototype-manifest.json；项目 Skill .agents/skills/polo-ai-design-system/SKILL.md；计划 docs/client-journey-review/development-plan/plan.md、task-index.json、design-propagation.md。

1. 读取最新主/子卡、集成 HEAD、现有验收记录及相关 Skill，确认交付、owner、WIP、依赖和有效设计来源。按 POO-77 登录/自动注册、POO-78 首页/导航、POO-79 圈子列表详情及全批回归分阶段检查。只检查本批已交付范围；仍在开发的项目列为待交付，不接管原执行者。修复从当前集成线建立独立 worktree，保护现有改动。
2. 使用 e2e-acceptance，由独立 Acceptor 实际操作产品；视觉 Reviewer 与 Coder 使用不同上下文。浏览器用 zcode，先读其工具 Skill。核对真实 Renderer/Electron 环境及合法 fixture，锁定本轮 HEAD、来源哈希和 scene/state/viewport 库存；在 1440×900、1024×768 覆盖卡内相关页面、空态、加载、错误、禁用、到期、确认与恢复。按真实动作进入状态，不注入 DOM；未实现、环境失败和外部接口缺失分别记录，不伪造通过。
3. 为实际产品与对应原型保存同状态同视口的整页配对截图，包含必要的长页/嵌套滚动内容；核对颜色、字体、尺寸、布局、间距、圆角、阴影、遮挡和滚动反馈。Reviewer 必须实际打开每组图片，结合 computed styles/几何断言判断；不能以页面打开、截图数量或生成检查代替视觉通过。记录每个缺陷的场景、期望/实际、图片、来源规则、严重度和建议修复。
4. 有缺陷就交 Coder 修复本批 UI/必要交互，Acceptor 不改业务源。修复权威源并按既有方式生成消费者，不手改生成出口。复用现有组件，保留共享应用卡、统一圈子列表、顶栏主体滚动分隔线等规则；不扩展管理技能页或 Polo 助手内部代码。运行受影响测试/typecheck/build，由独立 code-reviewer（GLM-5.3）审查修复至通过，再由集成 owner 合入本批集成线。
5. 修复后锁定新 HEAD，独立 Acceptor 重放原失败场景及一个合法相邻场景，检查共享组件的所有受影响页面；新版本重新采集对应证据，Reviewer 再审。继续「发现→修复→复验」，不要只列建议后退出。每轮保留原记录，禁止复用旧 HEAD 截图、修改参照来迁就实现、降低阈值或缩减范围。重复失败先定位最小根因；确需产品裁决时用例子和推荐方案单列，其他可完成检查继续。
6. 最终在集成后的精确 HEAD 核对完整库存与有效证据，完成独立审图和资源清理，再出具结论：已修复项、逐项结果、最终提交、证据路径、未执行/阻塞/待裁决项。本轮是补充视觉对照 Review，不能因原节点选择 smoke 就省略逐页比较，也不擅自改写原任务 YAML 或将本轮视觉通过当作完整业务 Acceptance；有缺口不能声称整体通过。当前明确风格/入口/文案与待复看的设计决定分别报告。不要自动标 Done、推送、合并 dev/main 或部署。
```
