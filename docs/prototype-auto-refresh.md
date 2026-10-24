# 设计素材维护：main 集成与新任务准备

状态（2026-10-24）：**Agent 工作流入口已采用**（本文件随 `Merge feat/prototype-auto-refresh-20261023 into main` 进入 main，两个只读检查入口在 main 实测 current）；**可选 CI 未启用且未实测**（仓库变量 `DESIGN_MATERIAL_CHECK` 未设置，main push 的 check job 实际 skipped），远程 CI 只在本地工作流层面核实过触发关系。检查、维护、采用、软件发布分别处理。模型可以替换；不新增常驻进程或逐次编辑监听。

## 两个触发时机

| 时机 | 检查对象 | 过期时怎么办 |
| --- | --- | --- |
| 最终合入 main 前 | 已集成且解决冲突的候选源码；在验收锁定 HEAD 之前 | 同批更新三层素材，完成验证后一起评审、合入 |
| 创建新任务前 | 该任务实际选定的源码基线 | 在隔离维护候选修复，采用后重新绑定依赖任务；独立任务可继续 |

这两个 Hook 是 Agent 工作流中的明确步骤，不依赖 Claude/Codex 特定的 Stop/PostToolUse 事件。
同一冻结基线的批量建卡可以复用检查记录；每次 commit、push 和会话结束不自动生成。
运行入口和维护命令由项目 Skill 的 references/usage-playbook.md 统一维护。

## 检查命令与结果

仓库根目录、Python 3.12+；只读检测不需要 Bun/Node/模型密钥：

```bash
python3 scripts/prototype_refresh.py --boundary main-integration --check
python3 scripts/prototype_refresh.py --boundary new-task --check
```

两者调用同一个检测函数，核对仓库内素材的源文件、生成器输入、已登记输出和设计模型源绑定。
检测历史范围覆盖上次素材生成后的变动；新文件及未提交的 UI 也进入检查。既有输入按实际字节判断，
不因素材提交后 HEAD 改变而重新生成。忽略的构建中间物由实际再生检查验证，不当作全新 UI。
变量预览另外调用已有生成器写到临时目录比对，不写仓库。
CLI 参数错误/读取失败 exit 2；需要维护 exit 3（JSON status=needs-maintenance）；当前 exit 0。
省略 --check 只查看计划。边界检测拒绝 --last-success/--output/--force 等参数；CI 缓存不能掩盖仓库素材过期。
检测是便宜的漂移筛查，不证明完整覆盖、浏览器表现或产品验收；维护收口需运行项目完整检查。

## Git 与发布边界

检查不写仓库。维护写回素材会产生 Git changes；它不自动 commit、push、改版本号、打 tag 或调用 release-finish。
最终集成时把素材与功能放入同一候选，在验收之前完成；不要 main push 后再机器人补一笔提交。
新任务发现过期时，修复留在隔离候选，待采用再锁定任务依据；不直接回写 main。

具体例子：按钮改成蓝色 → 候选同步页面/组件/变量预览 → 一起验证、合入 → 按既有授权发一次版本。
如果只是修复素材索引，走普通维护，不调用 git-flow-release-finish，也不创建 v* 或 shared-v* tag。

发布/部署触发关系（main@37ee5703 实测核实 + GitHub Actions 运行记录）：main push 触发 validate；
Electron 发布由 v* tag 触发，共享包发布由 shared-v* tag 触发（两者另有手动入口）。
git-flow-release-finish 会合并、tag 和 push，不是素材维护工具。
GitHub repo hooks API 返回空列表，但这不能证明所有外部应用的部署订阅均已核实；
不能宣称任意 push 都不会部署。采用后仍应核对实际部署订阅，仅对已确认的纯文档/素材路径跳过部署；
混有生产源码仍执行正常校验。不要用 [skip ci] 掩盖真实生产变化。
既有问题（非素材维护引入）：validate 的「Reject Windows-illegal filenames」步骤在
`core.quotePath=true` 下给中文文件名加引号后误判为非法字符，v0.17.0 起的历史证据文件触发，
main push 的 validate 因此红；修复属仓库 CI 策略裁决，不在素材维护授权范围内。

若最终合并/冲突处理改变源码，先重查再验收。发布脚本无法在合并与 tag/push 之间停下时，
调用前必须证明最终输入等于受检候选；不能证明就保留候选并停止发布，不能发布后才补素材。

## CI 只作兜底

prototype-refresh.yml 的 main push job 只读检查，默认 DESIGN_MATERIAL_CHECK 未设 true 时不运行。
它仅报告过期，不能在发布后替代前置门禁。workflow_dispatch 只生成诊断原型包与 generated.patch，
不会回填仓库或触发软件发布。已有下载产物不等于仓库 Skill 已更新。
当前状态：仓库变量未设置（首次 main push 实测该 job skipped），运行时无 hook；
远程 CI 的 check/诊断路径未实测，仅本地工作流核实。

## 手动原型包

在干净源码 checkout 安装项目依赖与 Playwright 后，可执行：

```bash
HUSKY=0 ELECTRON_SKIP_BINARY_DOWNLOAD=1 bun install --frozen-lockfile
python3 -m pip install -r scripts/prototype-browser-requirements.txt
python3 -m playwright install chromium
python3 scripts/prototype_refresh.py --force --output /tmp/polo-preview-unique
```

包内 index.html、result.json、browser.json、screenshots/、assets/ 和 generated.patch 供审阅。
补丁只含既有四个生成文件，不能代替模型更新、场景补充、完整维护和采用。
图形验证覆盖注册场景默认态；完整交互、Electron IPC/后端、视觉裁决另行验证。
