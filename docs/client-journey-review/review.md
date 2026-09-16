<!-- POO-70:assistant-accepted-r7:start -->
## 已确认：助手流程与现有框架直接复用（D-PC-06）

用户确认上一轮文字流程，并明确现有 AI 助手功能已经实现、流程已跑通、整体框架直接复用。已有对话、附件、Skills、追问及既有恢复交互沿用；助手本条走查收口。V2 线框保留为历史演示，不作为重做要求，也不再作为待视觉批准的实施前置。

[已确认助手文字流程](/__notma/open-file?path=%2FUsers%2Fwow%2Fproject%2Fz-h-ai%2Fpolo-dir%2FPOO-70%2Fdocs%2Fclient-journey-policy-interview%2Fdocs%2Fclient-journey-review%2Fassistant-user-flows.md) · [确认原话与固定依据](/__notma/open-file?path=%2FUsers%2Fwow%2Fproject%2Fz-h-ai%2Fpolo-dir%2FPOO-70%2Fdocs%2Fclient-journey-policy-interview%2Fdocs%2Fclient-journey-review%2Fsources%2Fuser-decision-r7.md)

其他客户端旅程继续分别走查。下一条为 J-PC-02：运行中从企业切到个人空间，先用文字说明场景。已有共享规则和 D-PC-01—05 均保留，不编码。
<!-- POO-70:assistant-accepted-r7:end -->

<!-- POO-70:assistant-text-review:start -->
## 当前方式：先用文字核对助手流程

[助手用户流程与场景（文字版）](/__notma/open-file?path=%2FUsers%2Fwow%2Fproject%2Fz-h-ai%2Fpolo-dir%2FPOO-70%2Fdocs%2Fclient-journey-policy-interview%2Fdocs%2Fclient-journey-review%2Fassistant-user-flows.md)

用户指出 Skills、附件等能力已有实现，要求先用文字描述场景。正常能力直接沿用，重点核对空间/授权、等待回答、失败恢复和原对话内容；不将 V2 线框默认作为改版要求。本文说明产品预期，尚不声称已经完成实际实现差异审计。沿用已有功能确认，未新增产品决定、视觉批准或编码授权。

<!-- POO-70:assistant-text-review:end -->

<!-- POO-70:assistant-visual-v1:start -->
## 当前走查：第二条——Polo 助手、Skills 与原对话文件

[打开第二条可点击线框](/__notma/open-file?path=%2FUsers%2Fwow%2Fproject%2Fz-h-ai%2Fpolo-dir%2FPOO-70%2Fdocs%2Fclient-journey-policy-interview%2Fdocs%2Fclient-journey-review%2Fvisual-v2%2Fprototype.html) · [故事与失败恢复](/__notma/open-file?path=%2FUsers%2Fwow%2Fproject%2Fz-h-ai%2Fpolo-dir%2FPOO-70%2Fdocs%2Fclient-journey-policy-interview%2Fdocs%2Fclient-journey-review%2Fvisual-v2%2Freview.md) · [全部剩余走查范围](/__notma/open-file?path=%2FUsers%2Fwow%2Fproject%2Fz-h-ai%2Fpolo-dir%2FPOO-70%2Fdocs%2Fclient-journey-policy-interview%2Fdocs%2Fclient-journey-review%2Fvisual-coverage.md)

小王新建企业助手对话、选择材料、明确启用 Skill 并等待本机准备、发送任务、回答追问，最后从原对话打开文件。复用 J-PC-04；D-PC-01—05 保留，本次布局待用户走查，不启动产品编码。

本条包含主要失败恢复，但未展开 Sources/Automations/Browser、全部高级工具、跨空间文件转移、其他设备同步与版本深链。其余模块仍按剩余清单走查，不以此条代替全功能对齐。
<!-- POO-70:assistant-visual-v1:end -->

<!-- POO-70:app-boundary-r6:start -->
## 最新确认：App 容器边界与剩余视觉范围（D-PC-05）

FDE 负责 App 内部交互；App 打开后占据 Polo 主要内容工作区，类似浏览器中的网站。Polo 负责容器及平台能力，不统一设计每个 App 的材料、执行和结果页面。第一条主流程至打开 App 已获认可；不扩张为所有异常或完整视觉签核。V1 内部业务样例不属于 Polo 验收，后续只画 App 占位及容器控制；原 V1 仍是上一轮页面证据，尚未重画。新 SDK/API 继续延后。

[原话与确认边界](/__notma/open-file?path=%2FUsers%2Fwow%2Fproject%2Fz-h-ai%2Fpolo-dir%2FPOO-70%2Fdocs%2Fclient-journey-policy-interview%2Fdocs%2Fclient-journey-review%2Fsources%2Fuser-decision-r6.md) · [剩余视觉走查清单](/__notma/open-file?path=%2FUsers%2Fwow%2Fproject%2Fz-h-ai%2Fpolo-dir%2FPOO-70%2Fdocs%2Fclient-journey-policy-interview%2Fdocs%2Fclient-journey-review%2Fvisual-coverage.md)

推荐下一条 J-PC-04：Polo 助手 → 材料 → Skills → 提问/追问 → 原对话文件与恢复。剩余场景已有功能确认；尚未页面走查，不重新询问已有结论。继续不编码。
<!-- POO-70:app-boundary-r6:end -->

# Polo 客户端评审入口

当前：功能方案已确认，进入首条共同旅程的视觉走查，暂不推进编码。

[一页功能地图与可点击线框](/__notma/open-file?path=%2FUsers%2Fwow%2Fproject%2Fz-h-ai%2Fpolo-dir%2FPOO-70%2Fdocs%2Fclient-journey-policy-interview%2Fdocs%2Fclient-journey-review%2Fvisual-v1%2Fprototype.html) · [故事、跨端交接与覆盖清单](/__notma/open-file?path=%2FUsers%2Fwow%2Fproject%2Fz-h-ai%2Fpolo-dir%2FPOO-70%2Fdocs%2Fclient-journey-policy-interview%2Fdocs%2Fclient-journey-review%2Fvisual-v1%2Fvisual-review.md) · [共同旅程泳道图](/__notma/open-file?path=%2FUsers%2Fwow%2Fproject%2Fz-h-ai%2Fpolo-dir%2FPOO-70%2Fdocs%2Fclient-journey-policy-interview%2Fdocs%2Fclient-journey-review%2Fvisual-v1%2Fproduct-flow.html)

[已确认完整功能方案](/__notma/open-file?path=%2FUsers%2Fwow%2Fproject%2Fz-h-ai%2Fpolo-dir%2FPOO-70%2Fdocs%2Fclient-journey-policy-interview%2Fdocs%2Fclient-journey-review%2Fmodule-review.md) · [Spec与证据](/__notma/open-file?path=%2FUsers%2Fwow%2Fproject%2Fz-h-ai%2Fpolo-dir%2FPOO-70%2Fdocs%2Fclient-journey-policy-interview%2Fdocs%2Fclient-journey-review%2Fspec.md) · [原完整画布](/__notma/open-file?path=%2FUsers%2Fwow%2Fproject%2Fz-h-ai%2Fpolo-dir%2FPOO-70%2Fdocs%2Fclient-journey-policy-interview%2Fdocs%2Fclient-journey-review%2Fproduct-flow.html)

本轮灰度布局尚未视觉签核；原功能确认保留，不以一条演示代表全功能走查或真实产品验收。
