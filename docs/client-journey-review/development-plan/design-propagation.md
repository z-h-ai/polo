# 客户端 Design System 传播路径

版本：`poo70-client-design-r2-20261004`，2026-10-04。本次只更新设计来源、计划及任务引用，没有启动业务开发。机器可核对的提交、来源哈希和任务正文版本见 [design-propagation.json](design-propagation.json)。

## 已进入集成线的内容

设计源提交：`ac831ea71a798030806f4e0906bdc93292bc918b`。

集成分支：`integration/poo70-client-entry-r15`。工作树：`/Users/wow/project/z-h-ai/polo-dir/integration/poo70-client-entry-r15`。从 POO-70 原有代码基线继承，保留现有登录、首页和顶栏；POO-80 开工前核对已建立的这条线，不再重复创建。

闭包包括项目 Skill、canonical design-system.json、foundations.md、基础/增量样式、工作台模板、组件脚本、消费 manifest、文档原型/评审出口及生成/检查命令。不得只复制 SKILL.md。`docs/mvp-complete-flow-hifi/prototype.html` 继续是当前产品入口，维护源移入 Skill，入口由既有生成方式更新；没有维护第二份可编辑原型。

G4/固定 Renderer 的历史证据和已完成卡的封存记录保持原版本。当前来源刷新不改写历史 receipt，也不把待复看的新组合布局升级为已验收设计。政策准备及实际 runtime 尚未锁定。

## 后续任务的传播顺序

1. POO-70 维护需求及项目设计源；生成并核对最新原型出口，提交本次来源闭包。
2. 集成 owner 将该闭包更新到 `integration/poo70-client-entry-r15`，核对实际 HEAD；本次源提交与计划更新已在这条线交付。
3. POO-80 核对集成线、政策/设计继承及活跃 owner。新开发卡通过 Notma 的 worktree 流程，从当时集成线最新 HEAD 建立或 re-pin 本卡上下文；创建顺序不替代依赖图。
4. 每张卡在自己的 worktree 检查最低源提交、文件哈希及生成闭包。按最新正文锁定 Plan；旧正文哈希上的 Review/高风险会签不复用于更新后的 Plan。源码/政策不匹配时由原 owner 调整真实来源和消费者，不能只改 hash 让检查通过。
5. 实现结果逐卡集成后供下游；POO-77、78、79 按原 YAML 集中验收。visual smoke 保持原范围，不因来源更新变成逐卡 E2E 或 parity。
6. 后续 dev/main/release 按对应已授权集成/发布流程消费整套闭包；本次本地集成交付不代表远端推送、正式发布或产品验收。

每卡开工前在**本卡自己的仓库**执行：

```sh
git merge-base --is-ancestor ac831ea71a798030806f4e0906bdc93292bc918b HEAD
python3 docs/mvp-complete-flow-hifi/tools/check_design_system.py
```

同时核对卡内 `design_source_preparation.sources`。祖先检查、生成检查、卡片哈希三者都需要；单独存在 Skill 文件不能证明继承。来源合法更新后先更新模型、生成出口及任务绑定，再重新锁定。代码实际实现引用保持本卡自己的真实路径。

## 既有客户端队列与工作树

POO-70 和 POO-77～100 更新了当前绑定；POO-44、47、48、49、52、55～66、74～76 共 20 张既有客户端队列卡仅追加同一来源与 re-pin 说明，保留原业务范围、依赖和验收，不纳入本批或自动启动。

本轮只读核查的已有 POO-47、52、55、57 工作树均未包含这个项目 Skill。POO-52 还存在 18 项未提交路径，保留原样；其他三个工作树核查时干净。它们的物理传播状态仍是 `owner_repin_required`，不能声称已经更新。后续由原 owner 检查活跃执行、WIP、分叉及消费者，再决定与集成线重整或仅引入设计闭包；引入后仍须在该工作树重新跑上述核查。

POO-41 冻结评审、POO-71 已完成原型及 done 卡的历史记录不回写。POO-45 是真实实现 Before 证据生产任务，也不按新设计目标重写。

## 本轮验证范围

设计生成器一致性及项目闭包检查通过；统一原型结构检查 256 项通过。51 个本批相关场景在 1440×900、1024×768 共 102 个组合，对提取前后可见 DOM、几何及 computed styles 做一致性比较，通过。比较时统一暂停动画，避免旋转图标/弹窗入场的采样时间差；没有改变业务状态或放宽差异阈值。

这些结果证明来源提取保持原型呈现，不证明真实 Electron/API/支付/安装或业务 Acceptance。历史 quality-report 仍绑定旧版本；本次证据临时保存，不覆盖历史证据或将其标成当前验收。
