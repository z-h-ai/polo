# R12 独立语义复核：第二轮

复核上下文：/root/semantic_review。允许来源沿第一轮；增加最终 HTML、当前 src/mvp 与必要 src/source，以及 browser.json / invariants.json。未读生成者 review.md、自评或旧报告。

本轮正在与修复并行进行，因此此文是具体发现/修复核验记录，不是最终散列认证。当前不能判 semantic passed；需要下述残留修复及最后导出后的复查。

## 浏览器证据审阅

`browser.json`：1848 个 scene×viewport×protocol 行（308 场景、3 视口、file/http）、2110 条助手动作记录；errors 为空、checks 全部 passed。动作行证明已点击并到达声明目标，不能自行证明目标保留了业务状态。`invariants.json`：33 个针对性检查通过，覆盖原对话/新会话、隔离、积分/断网绕过、撤权卸载、技能详情、凭证空值、文件重新选择、预算和积分、表面切换等。阅读证据时四个 artifact hash 均与磁盘文件一致。

## 已核实修复

- F01 的已安装技能详情/更新/卸载/取消属性保存已补变体；restricted-remove/cancel 不再直接恢复授权。仍有其他路径，见 R01。
- F02：deleted 移除文件入口，runtime canRead/canSend 能阻止文件/新建绕过当前 scope 阻断；原记录不会因新建而读出。恢复链可用性另见 R02。
- F03：scope + conversation ID 存储；新建产生新 ID，回原会话仍保留消息；invariants 覆盖。新空会话文件假数据另见 R04。
- F04：重新选择是 file input，只有 change 选到文件才触发 reselected，取消不跳成功；invariants 验证选中文件名。
- F05：空凭证禁用提交；取消落未连接，连接落连接中。自动化和 Browser 已改用对应基线组件，不再渲染 MCP 工具表。
- F06：企业 fallback 场景移除，个人圈子说明限 personal。
- F07：个人 stream 返回/未到账/失败/恢复独立场景；“还没有”回 cut；Owner 预算查询区分充值，并保留预算独立阻断。仍有成员/直接查询漏网，见 R03。
- F08：活跃故事已移除 S-TEAM-SHARE 和旧 S-LOCAL-SKILLS；不再用不存在的企业审核状态充当故事。

## R01（高，F01 残留）：导航和再次准备仍改变三态

实际读取当前 scenes.mjs 的结果：

1. `A-enterprise-skills`（有效、未启用、未安装）点“管理版本”→`A-enterprise-detail`（有效、已启用、就绪）。personal 相同。只对 device===就绪修目标，漏未安装。
2. `A-*-uninstalled-110-0-0` 点“准备本机”→`installing`，enabled false→true、version 1.1.0→1.0.0、builtin false→true。
3. `A-*-restricted` 点通用侧栏“技能”→`skills`，同一作品从失效回有效，随后获取/启用可用。`denied` 有同类路径。
4. `builtinoff` 点“获取技能”→`discover`，builtin 又从 false 回 true。

依据：Spec PC-F04:266/268；PC-F08:305。推荐：本机状态与本人偏好按空间/作品保留，普通导航不得重置。若采用场景变体，必须涵盖通用导航和未安装准备，而非只修详情和卸载按钮。

## R02（本轮先发现，随后当前 runtime 已修）：网络重验不能清除断网

最初读取 runtime 时，fixture() 只在非 pending 的评审跳转执行；真实 retry→restored 跳转跳过 fixture，因此“可以发送”仍被离线阻断。已告知修复者。

随后读取当前源码已有 `if(key==='network'||key==='retry'&&scene.key==='offline') blocks.delete('offline')`。在隔离 Node mock 中用真实 runtime 模拟 parent show-scene 与 act(retry)，得到：offline=false/网络未恢复；重验后 scene=restored、canSend=true。该缺陷源码级修复成立；需新导出和 browser 证据跟进。

## R03（中，F07 残留）：成员预算和 Owner 直接查询仍串充值/角色

- `enterprise-budget` → 通知所有者 → `notified` → 查询 → `enterprise-checking`；文案查询“本次充值结果”，仍不是预算查询。
- `enterprise-ownerblock` 的直接“已完成，查询结果”仍落 `enterprise-checking`，未落 ownerchecking；所以 Owner 仍可掉进成员失败处理分支。
- 依据：Spec PC-N03:332/336/338/339。推荐：成员预算也独立保留 blockReason，结果/失败只查预算且不出现 Owner 写操作；Owner 所有查询入口都去 Owner 链。

## R04（中，F03 残留，修复者正在补附件）：空会话出现不存在的文件

`new` 未上传/生成 → 查看会话文件，当前 Files 展示 fallback 项目资料.pdf + 资料汇总.md。仅 saved 演示会话可有这些预置文件；新会话必须为空，选中文件后归到该会话。另新会话输出顺序目前 assistant fixture 在 getSubmitted 用户消息之前，应按用户消息后显示助手响应。

依据：Spec PC-F04:267，D-PC-03，C-R02；不能把原会话 fixture 假装成新会话已保存数据。

## R05（中，F09 残留）：空态只改内容区，列表仍有条目；OS 拒绝恢复缺提示

- empty-skills 主区“未配置技能”，SkillNavigator 仍显示圈子技能+内置技能；empty-sources 主区未配置，Navigator 仍显示项目资料已选中。
- permissiondenied 只有重新请求权限，缺 C-R06 明确要求的“已在 OS 拒绝时给设置路径，授权后主动重试”。推荐补静态系统设置路径即可，不需要编造打开 OS 的动作。
- 依据：Spec C-R02:227、C-R06:231。

## 本轮边界

没有把浏览器 pass 或独立复核当用户确认。所有助手状态/布局仍是待复看的提案。后续文件引用散列在下方，仅用于标识此轮采样，不替代 final artifact 导出后的 evidence。

```json
{
  "design-demos/polo-client-source-baseline/src/mvp/runtime.js": "47955af1f366222d635b076813e8931e011edb5bbe214f66ad418d57b882dd1f",
  "design-demos/polo-client-source-baseline/src/mvp/scenes.mjs": "520784ed4aaad4c0aa71cd30aaa16451f45da134448c7e54972e19a3e43e8225",
  "design-demos/polo-client-source-baseline/src/mvp/Assistant.jsx": "4c266b5dcf4497dfa4de370f61f583d7e66766f1832b3bab4a453b727c9b1b23",
  "docs/mvp-complete-flow-hifi/prototype-manifest.json": "fdc2854278a70eee447cb5fd8acc28b345fd7896d69fc0092ec9838b21167a11",
  "docs/mvp-complete-flow-hifi/review.html": "b5792d606eafa5023d9d02467d15dc7ff82122fccc6b308f46eced63c125d823",
  "docs/mvp-complete-flow-hifi/prototype.html": "1447b92d8b32f04850aeb3432f9d3b919f016807c62a09d41561a35fcec78310",
  "design-demos/polo-client-source-baseline/prototype.html": "c4eba4c6dc012131715882f87f852aa136cfb25119b1cabc9b15e3f49608fc03",
  "docs/mvp-complete-flow-hifi/evidence/r12/browser.json": "cffdab1b2f159c2af49fd298c3201e08e63d9a5e0f69185afb9f7d7c810a3cdb",
  "docs/mvp-complete-flow-hifi/evidence/r12/invariants.json": "4e6119cad7a7753e0517d0cbfc307da49c1ed70fd642651fcfa5586ebf4567b9"
}
```
