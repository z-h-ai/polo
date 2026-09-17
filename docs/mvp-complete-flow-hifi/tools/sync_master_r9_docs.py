#!/usr/bin/env python3
"""Synchronize the human review documents with the master-r9 manifest."""

from __future__ import annotations

import re
from pathlib import Path


BUNDLE = Path(__file__).resolve().parents[1]


def replace_once(text: str, old: str, new: str, label: str) -> str:
    if text.count(new) >= 1:
        return text
    count = text.count(old)
    if count != 1:
        raise RuntimeError(f"{label}: expected one match, found {count}")
    return text.replace(old, new, 1)


def sync_feature_map() -> None:
    path = BUNDLE / "feature-map.md"
    text = path.read_text(encoding="utf-8")
    replacements = [
        ("修订 `poo70-dpc07-v2-2`", "修订 `poo70-master-r9-v2-3`", "feature revision"),
        ("90 场景的交互全部静态声明为 1375 条 transitions（D-PC-07 收口后）", "91 场景的交互全部静态声明为 1364 条 transitions（master-r9 / D-PC-08 修订后）", "feature counts"),
        ("### M02 空间切换 — 覆盖：8 屏 · 完整（集成候选还原）", "### M02 空间切换 — 覆盖：9 屏 · 完整（集成候选 + 已确认补页）", "feature M02 heading"),
        ("要点：无活动直切、有活动先确认；全部终止后才提交切换", "要点：无活动直切、有活动先确认；`P-M02-CONFIRM-PERSONAL` 补齐个人空间有活动时切企业的确认；全部终止后才提交切换", "feature M02 rule"),
        ("用户价值：常用 App 一步直达；其余按来源（企业/圈子/个人）可找、可查、可解释。", "用户价值：常用 App 一步直达；个人目录聚合多个圈子的有效权益，企业目录只展示企业向本人分发的作品，来源可查、可解释。", "feature M03 value"),
        ("| M02 空间切换 | 8 | integ 8 | 完整（集成候选还原） |", "| M02 空间切换 | 9 | integ 8 · adjust 1 | 完整（集成候选 + 已确认补页） |", "feature M02 count"),
        ("| **合计** | **90** | 90 场景 · 1375 条 transitions，全部自 `P-M01-INVITE-BROWSER` 可达（BFS 90/90） |", "| **合计** | **91** | 91 场景 · 1364 条 transitions，全部自 `P-M01-INVITE-BROWSER` 可达（BFS 91/91） |", "feature totals"),
        ("| M03/M04 关闭/M07 入口/M09 提示方案 + M10 管理入口统一账号菜单 | D-PC-07 | 首页布局、`P-M04-CLOSE-ACTIVE`、`P-M07-LIST`、`P-M09-*`、`P-M10-MENU` |", "| M03/M04 关闭/M07 入口/M09 提示方案 + M10 管理入口统一账号菜单 | D-PC-07 | 首页布局、`P-M04-CLOSE-ACTIVE`、`P-M07-LIST`、`P-M09-*`、`P-M10-MENU` |\n| 圈子只聚合到个人空间；企业无圈子；私域不等于仅邀请；有活动切企业先确认 | D-PC-08 | `P-M03-ALL-APPS`、`P-M03-HOME-ENT`、`P-M07-EMPTY`、`P-M02-CONFIRM-PERSONAL` |", "feature DPC08"),
        ("`tools/smoke_edges.py`（1375 边逐条点击核对）→ `tools/audit_viewports.py`（90×2 溢出/可达审计 + 36 张截图）", "`tools/rebuild_master_r9.py`（同步 D-PC-08 与新增确认页）→ `tools/smoke_review.py`（1364 边逐条点击核对）→ `tools/audit_viewports.py`（91×2 溢出/可达审计 + 37 张截图）", "feature toolchain"),
    ]
    for old, new, label in replacements:
        text = replace_once(text, old, new, label)
    path.write_text(text, encoding="utf-8")


def sync_review() -> None:
    path = BUNDLE / "review.md"
    text = path.read_text(encoding="utf-8")
    replacements = [
        ("修订 `poo70-dpc07-v2-2`（自 `poo71-hifi-v2-1` 按 D-PC-07 收口重建）", "修订 `poo70-master-r9-v2-3`（继承 D-PC-07，按 master-r9 / D-PC-08 同步）", "review revision"),
        ("看到全部待裁决项", "查看本轮修订与后续输入", "review promise"),
        ("（90 场景、1375 条 transitions 全部静态声明", "（91 场景、1364 条 transitions 全部静态声明", "review counts"),
        ("现状→本轮差异→依据→评审问题 + 本轮待裁决三项", "现状→本轮差异→依据→下一次复看问题", "review shell wording"),
        ("（见 §6 待裁决 9）", "（见 §6）", "review branch reference"),
        ("## 3. 页面索引（90 屏全量）", "## 3. 页面索引（91 屏全量）", "review index heading"),
        ("90 场景全部自 `P-M01-INVITE-BROWSER` 可达", "91 场景全部自 `P-M01-INVITE-BROWSER` 可达", "review reachability"),
        ("### M02 空间切换（8 屏）", "### M02 空间切换（9 屏）", "review M02 heading"),
        ("| [P-M02-CONFIRM](prototype.html#scene=P-M02-CONFIRM) | 切换确认 · 终止 3 项 | 集成候选已实现 | 展示将终止的 App 与助手任务；取消留在原空间（C-R04）。 |", "| [P-M02-CONFIRM](prototype.html#scene=P-M02-CONFIRM) | 切换确认 · 终止 3 项 | 集成候选已实现 | 展示将终止的 App 与助手任务；取消留在原空间（C-R04）。 |\n| [P-M02-CONFIRM-PERSONAL](prototype.html#scene=P-M02-CONFIRM-PERSONAL) | 切换确认 · 从我的空间到企业 | 调整关键页 | 个人空间有活动时先确认终止；取消留在我的空间，确认后才进入企业（D-PC-08 / C-R04）。 |", "review new scene"),
        ("企业首页按 D-PC-07 不放管理卡（现状差异见待裁决清单）。", "企业首页按 D-PC-07 不放管理卡；按 D-PC-08 只展示企业作品，不出现个人圈子或圈子通知。", "review enterprise home"),
        ("合计 **90** 屏。", "合计 **91** 屏。", "review total"),
        ("晨星科技首页，运行中 3 项；按 D-PC-07 不放管理卡（见待裁决项）", "晨星科技首页，运行中 3 项；按 D-PC-07 不放管理卡，管理入口只在账号菜单", "review story2"),
    ]
    for old, new, label in replacements:
        text = replace_once(text, old, new, label)

    dpc08 = """**master-r9 / D-PC-08 同步**：圈子权益只聚合到“我的空间”，企业目录不继承个人圈子且不出现圈子订阅通知；圈子私域入口覆盖分享链接、二维码、定向邀请、付费或审批，不虚构公开市场。新增 [P-M02-CONFIRM-PERSONAL](prototype.html#scene=P-M02-CONFIRM-PERSONAL)，补齐个人空间有活动时切企业的确认与取消路径。本轮状态为“修改待复看”。\n\n"""
    text = replace_once(text, "**v2 契约说明**", dpc08 + "**v2 契约说明**", "review DPC08 summary")

    story1 = """| 步 | 操作 | 到达屏 | 你会看到 / 验证点 |
| --- | --- | --- | --- |
| 1 | 打开原型，进入登录页 | [P-M01-LOGIN-PASSWORD](prototype.html#scene=P-M01-LOGIN-PASSWORD) | G4 login-split 双栏：品牌故事 + 登录方式切换（密码/验证码）+ 协议说明，与 POO-41 冻结稿同构 |
| 2 | 输入账号密码，点「登录」 | [P-M01-PERSONAL-PREP](prototype.html#scene=P-M01-PERSONAL-PREP) | 唯一的“我的空间”准备中；重试幂等，不产生第二个空间 |
| 3 | 准备完成自动进入首页 | [P-M03-HOME-ZERO](prototype.html#scene=P-M03-HOME-ZERO) | 首登零常用：Polo 助手始终可用，并引导“全部 Apps” |
| 4 | 点「全部 Apps」 | [P-M03-ALL-APPS](prototype.html#scene=P-M03-ALL-APPS) | “我的空间”只聚合多个圈子的有效作品；圈子不是空间，同名 App 按来源区分 |
| 5 | 使用后回个人首页 | [P-M03-HOME-PERSONAL](prototype.html#scene=P-M03-HOME-PERSONAL) | Polo 助手固定；常用 Apps 来自个人已有权益；“我的圈子”管理关系 |
| 6 | 选择“晨星科技”且个人有运行项 | [P-M02-CONFIRM-PERSONAL](prototype.html#scene=P-M02-CONFIRM-PERSONAL) | 先说明将终止的个人空间活动；取消仍在个人空间，确认后才切换 |
| 7 | 进入企业首页 | [P-M03-HOME-ENT](prototype.html#scene=P-M03-HOME-ENT) | 只展示企业导入、启用并向本人分发的作品，不出现个人圈子或圈子通知 |
| 8 | 打开有更新的 App | [P-M04-PREPARE](prototype.html#scene=P-M04-PREPARE) | 权限说明 + 下载校验；可取消，准备成功后再打开 |
| 9 | 使用 App | [P-M04-APP-VIEW](prototype.html#scene=P-M04-APP-VIEW) | App 占满主内容工作区；FDE 区域为中性占位，业务结果由 App 负责 |
| 10 | 查看运行状态 | [P-M04-RUNTIME](prototype.html#scene=P-M04-RUNTIME) | 只列当前企业空间的 App/助手活动 |
| 11 | 打开 Polo 助手 | [P-M05-CHAT](prototype.html#scene=P-M05-CHAT) | G4 三栏助手框架；当前空间的会话、Skills 与计量主体一致 |
| 12 | 打开会话文件 | [P-M08-FILES](prototype.html#scene=P-M08-FILES) | 附件与生成文件留在原对话；无独立文件汇总页 |"""
    pattern = re.compile(r"\| 步 \| 操作 \| 到达屏 \| 你会看到 / 验证点 \|\n\| --- \| --- \| --- \| --- \|\n.*?\n\n变体分支：", re.S)
    text, count = pattern.subn(story1 + "\n\n变体分支：", text, count=1)
    if count != 1:
        raise RuntimeError(f"review story1: expected one match, found {count}")

    status_section = """## 6. 已解决项与后续输入

本轮没有新增必须由产品 owner 裁决的客户端行为。下列历史待决已按确认结果或责任边界重新分类：

| 项目 | 当前状态 | 处理 |
| --- | --- | --- |
| 企业首页管理入口 | 已确认（D-PC-07） | 企业首页不放管理卡；有资格的入口只在账号菜单 |
| 个人有活动时切企业 | 已确认（D-PC-08 / C-R04） | 已补 `P-M02-CONFIRM-PERSONAL`；取消留在个人空间，确认后才切换 |
| App 共用容器帧 | 已确认（D-PC-05） | 保留一个 Polo 容器布局与中性 FDE 占位，不设计 App 内部页面 |
| 常用 Apps 上限、续费、Member 通知的展示文案 | 行为已确认，视觉文案待复看 | 当前文案仅用于高保真走查；若修改行为再同步主说明 |
| 圈子价格、周期、充值套餐与金额 | 缺真实商业输入 | 原型中的数字是演示数据；正式页面接入前由 POL-94/对应业务 owner 提供，不由客户端代选 |
| “分支：”虚线按钮 | 评审工具，不是产品功能 | Plan 时把每个分支映射到真实触发或测试入口；不要求用户批准为产品按钮 |
| 同一作品能否归属多个圈子 | 跨端冲突，交 POL-116 | 客户端只消费最终 entitlement；创作者归属、订单、撤权与退款口径由 POL-116 收口 |
"""
    if "## 6. 已解决项与后续输入" not in text:
        text, count = re.subn(r"## 6\. 待裁决项.*?\n## 7\. 已知限制", status_section + "\n## 7. 已知限制", text, count=1, flags=re.S)
        if count != 1:
            raise RuntimeError(f"review section6: expected one match, found {count}")
    path.write_text(text, encoding="utf-8")


def sync_visual_acceptance() -> None:
    path = BUNDLE / "visual-acceptance.md"
    text = path.read_text(encoding="utf-8")
    replacements = [
        ("修订 `poo70-dpc07-v2-2`（自 `poo71-hifi-v2-1` 按 D-PC-07 收口修订）", "修订 `poo70-master-r9-v2-3`（继承 D-PC-07，按 master-r9 / D-PC-08 同步）", "visual revision"),
        ("两文件 + manifest + 8 项 sources + 设计 Skill 绑定", "两文件 + manifest + 13 项 sources + 设计 Skill 绑定", "visual source count"),
        ("valid v2 high_fidelity prototype: 90 scenes", "valid v2 high_fidelity prototype: 91 scenes", "visual validator"),
        ("**1375 / 1375 条**", "**1364 / 1364 条**", "visual transitions"),
        ("（其中 440 条为 popover 菜单内的入口，评审时两次点击可达；工具 `tools/smoke_edges.py`）", "（工具 `tools/smoke_review.py`）", "visual transition note"),
        ("90 场景 × 2 视口 = 180 次加载", "91 场景 × 2 视口 = 182 次加载", "visual viewport count"),
        ("**通过**：90 项按 11 模块分组", "**通过**：91 项按 11 模块分组", "visual index count"),
        ("S1（11 步）/ S2（14 步）/ S3（7 步）", "S1（12 步）/ S2（14 步）/ S3（7 步）", "visual story count"),
        ("## 2. 截图索引 — 1440×900（26 张）", "## 2. 截图索引 — 1440×900（27 张）", "visual screenshot count"),
        ("| [P-M02-CONFIRM](screenshots/1440x900/P-M02-CONFIRM.png) | M02 | 切换确认 · 终止 3 项 |", "| [P-M02-CONFIRM](screenshots/1440x900/P-M02-CONFIRM.png) | M02 | 切换确认 · 终止 3 项 |\n| [P-M02-CONFIRM-PERSONAL](screenshots/1440x900/P-M02-CONFIRM-PERSONAL.png) | M02 | 我的空间有活动时切企业 · 先确认终止 |", "visual new screenshot"),
        ("企业首页（无管理卡，见待裁决 1）", "企业首页（无管理卡、无个人圈子通知，D-PC-07/08）", "visual enterprise caption"),
        ("90 场景逐场景", "91 场景逐场景", "visual requirement scene count"),
        ("manifest `sources` 10 项", "manifest `sources` 13 项", "visual evidence source count"),
        ("+ review.md §6 待裁决 9 项（含本轮重建引入 3 项）", "+ review.md §6 已解决项与后续输入", "visual review status"),
        ("详见 review.md §6 待裁决 9", "详见 review.md §6", "visual branch reference"),
    ]
    for old, new, label in replacements:
        text = replace_once(text, old, new, label)
    path.write_text(text, encoding="utf-8")


if __name__ == "__main__":
    sync_feature_map()
    sync_review()
    sync_visual_acceptance()
    print("synchronized master-r9 review documents")
