# POO-70 master-r10 整理与原型同步记录

日期：2026-09-17

## 确认依据

- 推荐消息：`msg_0023750a6d4c79b6016aaa66819a6887d08efbc9395fdfa936`。
- 用户确认：`msg_01a0a9a3-bbdd-7333-a786-06be70da033d`，“好，按你的推荐处理，修改文档”。
- 当前规则：D-PC-09；确认原文和替代关系见 `user-decision-r10.md`。
- master-r10 修改前主说明：`docs/mvp-complete-flow-hifi/sources/poo70-spec-before-master-r10.md`。
- master-r10 修改前 manifest：`docs/mvp-complete-flow-hifi/sources/prototype-manifest-before-master-r10.json`。

## 本轮修正

- 删除“POL-68 与 POL-94 多圈冲突待决/优先 POL-94”的当前结论，明确 D-PC-09 已替代 POL-94 旧单圈限制。
- 明确同一作品可分发到多个圈子，作品、版本和发布生命周期唯一；每圈关系、成员、价格、收入和关闭责任独立。
- 明确我的空间按作品 ID 去重并保留全部有效来源；单一来源失效仍可用；最后来源失效才阻断。
- 明确企业空间只消费企业实例，不显示个人圈子来源。
- 保留手动续费、退款/结算、首发延期及其他未决事项原结论。

## 过时交接更正

此前发给 POL-116 的事件 `evt_3750ff41cd984b6e9dbc7bec817310b7` 把多圈分发误报为未决冲突。当前更正为：用户已在 2026-09-16 接受多圈分发推荐；后续跨端收口应消费 D-PC-09，不应重新等待该项裁决。本轮按约束不并发修改 POL-116。

## 状态

- 产品规则已确认。
- 受影响的原型页面和来源显示为“修改待复看”；规则确认不等于布局或视觉验收。
- 未启动产品编码、实施计划、部署或新 AI run；未操作旧原型卡。

## POO-70 正文发布与读回

- 更新前即时读回 rev：`31d845c105702c93b1ee5ba20bdec427e44c80de753009e4ae256b3fb6fa1a83`。
- 使用任务正文接口 `PUT /api/tasks/POO-70/body` 提交 `base_rev` 与完整 `base_body`；返回 `merged=false`、`conflict=false`。
- 发布后再次通过 `notma-cli task show POO-70 --json` 读回 rev：`1ae4e9fd889af3aa758d2d31a299673add0966959eca496756251db427626ab3`。
- 读回正文顶部标记为 `POO-70:master-r10`，状态仍为 `in-progress`；未改变原有历史正文、负责人、分支或优先级。

## 原型同步与验证

- 原型 revision：`poo70-master-r10-v2-4`；92 个场景、1383 条可点击 transition、50 条确认、4 条故事。
- 受影响场景：`P-M03-ALL-APPS`、`P-M07-LEAVE`、`P-M07-SOURCE-FALLBACK`、`P-M07-EXPIRED`、`P-M11-BLOCKED-EXPIRED`，并复核 `P-M03-HOME-ENT` 的企业隔离。
- 示例明确为同一创作者“晨星增长工作室”向晨星增长圈、晨星设计圈分发同一作品；同时修正最后来源失效页运行菜单仍显示企业空间名称的残留。
- 结构校验通过：v2 high-fidelity，92 scenes；旧版 manifest 作为 `--previous` 基线通过差异校验。
- 全边点击检查通过：1383/1383；D-PC-07 与 D-PC-09 定向 smoke 均通过。
- 92 个场景在 1440×900 与 1024×768 双视口完成审计；无横向溢出或元素越界。受影响截图已人工检查。
- 上述是原型结构与交互证据，不等于正式产品实现或 owner 视觉验收。
