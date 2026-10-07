# POO-70 开发编排提示词

参考 `/Users/wow/project/dev-plan-prompt.md`；以最新 Notma 全部直接依赖为准。

```text
编排POO-70：读最新卡及polo-ai-design-system，继承integration/poo70-client-entry-r15设计源ac831ea7。

1. POO-80核对基线；并行POO-81、82、83、84、85。
2. POO-82→86；POO-85→87；POO-86+85→89。认证四卡集成后验收POO-77。
3. POO-81→88；POO-88+85→90；POO-89+85+87→91，首页四卡集成后验收POO-78。
4. POO-90后按依赖并行POO-92、93、94、95、96、98；POO-88+82+89→97；POO-97等依赖齐备后做POO-99。圈子各卡及首页集成后做POO-100；POO-77+78通过后验收POO-79。

编号均为POO；以全部直接依赖为准。核对owner、政策/设计及HEAD，在自身worktree按卡内路径跑check_design_system.py并核对来源hash，缺Skill不能借邻目录。Plan先re-pin，高风险按新正文hash会签。按normal-coding-task-flow；code-reviewer（GLM-5.3）独立审查修复至通过。实现卡不逐卡E2E，测试/Review并集成后供下游，节点通过Done；自动推进就绪卡，覆盖Skill逐卡E2E/Done后等待的默认步骤。验收按YAML，浏览器用zcode，完成API与visual smoke；待复看布局不冒充parity。

仅登录/自动注册/首页/圈子列表详情；暂缓技能管理和助手内部代码。网页支付POL-114，身份POL-112，联调POL-174，包契约POL-175；缺接口真实验收pending。既有队列不重派，旧worktree由原owner保护WIP后传播；不推送、不合并dev/main、不部署。
```
