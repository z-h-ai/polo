#!/usr/bin/env python3
"""Synchronize master-r10 counts, revision labels and D-PC-09 review evidence."""

from pathlib import Path

BUNDLE = Path(__file__).resolve().parents[1]


def replace(text: str, old: str, new: str, label: str, minimum: int = 1) -> str:
    count = text.count(old)
    if count < minimum:
        raise RuntimeError(f"{label}: expected at least {minimum}, found {count}")
    return text.replace(old, new)


def sync_feature_map() -> None:
    path = BUNDLE / "feature-map.md"
    text = path.read_text(encoding="utf-8")
    text = replace(text, "poo70-master-r9-v2-3", "poo70-master-r10-v2-4", "feature revision")
    text = replace(text, "91 场景的交互全部静态声明为 1364 条 transitions（master-r9 / D-PC-08 修订后）", "92 场景的交互全部静态声明为 1383 条 transitions（master-r10 / D-PC-09 修订后）", "feature contract counts")
    text = replace(text, "### M07 我的圈子 — 覆盖：11 屏", "### M07 我的圈子 — 覆盖：12 屏", "feature M07 count")
    text = replace(text, "代表屏：`P-M07-LIST`（个人空间稳定入口，与「全部 Apps」并列）→ `P-M07-DETAIL-FOCUS` → `P-M07-RENEW`", "代表屏：`P-M07-LIST` → `P-M07-DETAIL-FOCUS` → `P-M07-SOURCE-FALLBACK`；最后来源失效见 `P-M11-BLOCKED-EXPIRED`", "feature M07 representative")
    text = replace(text, "场景追溯：PC-F03、D-PC-07（M07 入口收口）", "场景追溯：PC-F03、D-PC-07（M07 入口收口）、D-PC-09（作品去重与逐来源失效）", "feature M07 trace")
    text = replace(text, "到期（作品保留但不能启动）/退出（先停任务、作品按来源策略处理）", "到期/退出按来源撤权；其他有效来源继续使用；最后来源失效才阻断", "feature M07 behavior")
    text = replace(text, "| M07 我的圈子 | 11 | new 10 · cross 1 |", "| M07 我的圈子 | 12 | new 10 · adjust 1 · cross 1 |", "feature M07 stats")
    text = replace(text, "| **合计** | **91** | 91 场景 · 1364 条 transitions，全部自 `P-M01-INVITE-BROWSER` 可达（BFS 91/91） |", "| **合计** | **92** | 92 场景 · 1383 条 transitions；产品路径与 3 个明确 review entries 覆盖全部场景 |", "feature totals")
    anchor = "| 圈子只聚合到个人空间；企业无圈子；私域不等于仅邀请；有活动切企业先确认 | D-PC-08 | `P-M03-ALL-APPS`、`P-M03-HOME-ENT`、`P-M07-EMPTY`、`P-M02-CONFIRM-PERSONAL` |"
    addition = anchor + "\n| 同一作品可多圈分发；我的空间按作品去重；单一来源失效继续可用，最后来源失效才阻断 | D-PC-09 | `P-M03-ALL-APPS`、`P-M07-LEAVE`、`P-M07-SOURCE-FALLBACK`、`P-M07-EXPIRED`、`P-M11-BLOCKED-EXPIRED`、`P-M03-HOME-ENT` |"
    if "| 同一作品可多圈分发" not in text:
        text = replace(text, anchor, addition, "feature DPC09 row")
    text = replace(text, "`tools/rebuild_master_r9.py`（同步 D-PC-08 与新增确认页）→ `tools/smoke_review.py`（1364 边逐条点击核对）→ `tools/audit_viewports.py`（91×2 溢出/可达审计 + 37 张截图）", "`tools/rebuild_master_r9.py`（历史 D-PC-08 修订）→ `tools/rebuild_master_r10.py`（同步 D-PC-09）→ `tools/smoke_review.py`（1383 边逐条点击核对）→ `tools/smoke_dpc09.py`（多圈专项）→ `tools/audit_viewports.py`（92×2 溢出/可达审计 + 41 张截图）", "feature toolchain")
    path.write_text(text, encoding="utf-8")


def sync_visual_acceptance() -> None:
    path = BUNDLE / "visual-acceptance.md"
    text = path.read_text(encoding="utf-8")
    text = replace(text, "poo70-master-r9-v2-3", "poo70-master-r10-v2-4", "visual revision")
    text = replace(text, "（继承 D-PC-07，按 master-r9 / D-PC-08 同步）", "（继承 D-PC-07/08，按 D-PC-09 同步）", "visual revision note")
    text = replace(text, "13 项 sources", "16 项 sources", "visual source count")
    text = replace(text, "91 scenes", "92 scenes", "visual validator count")
    text = replace(text, "1364 / 1364", "1383 / 1383", "visual edge count")
    text = replace(text, "91 场景 × 2 视口 = 182 次加载", "92 场景 × 2 视口 = 184 次加载", "visual viewport count")
    text = replace(text, "91 项按 11 模块分组", "92 项按 11 模块分组", "visual index count")
    text = replace(text, "| 三条故事播放 |", "| 四条故事播放 |", "visual story label")
    text = replace(text, "S1（12 步）/ S2（14 步）/ S3（7 步）", "S1（12 步）/ S2（14 步）/ S3（7 步）/ S4（7 步）", "visual story steps")
    text = replace(text, "## 2. 截图索引 — 1440×900（27 张）", "## 2. 截图索引 — 1440×900（30 张）", "visual large shots")
    large_anchor = "| [P-M07-DETAIL-PAID](screenshots/1440x900/P-M07-DETAIL-PAID.png) | M07 | 付费订阅详情（虚构演示数据） |"
    large_rows = large_anchor + "\n| [P-M07-EXPIRED](screenshots/1440x900/P-M07-EXPIRED.png) | M07 | 单一圈子来源到期，另有来源的作品仍可打开 |\n| [P-M07-SOURCE-FALLBACK](screenshots/1440x900/P-M07-SOURCE-FALLBACK.png) | M07 | 退出一个圈子后，同一作品经其他来源继续可用 |"
    if "screenshots/1440x900/P-M07-SOURCE-FALLBACK.png" not in text:
        text = replace(text, large_anchor, large_rows, "visual DPC09 shots")
    m11_anchor = "| [P-M11-CONTRACT](screenshots/1440x900/P-M11-CONTRACT.png) | M11 | 需要升级 Polo（ContractGate 还原） |"
    m11_rows = "| [P-M11-BLOCKED-EXPIRED](screenshots/1440x900/P-M11-BLOCKED-EXPIRED.png) | M11 | 最后一个有效来源失效才阻断 |\n" + m11_anchor
    if "screenshots/1440x900/P-M11-BLOCKED-EXPIRED.png" not in text:
        text = replace(text, m11_anchor, m11_rows, "visual last-source shot")
    text = replace(text, "## 3. 截图索引 — 1024×768（10 张）", "## 3. 截图索引 — 1024×768（11 张）", "visual small shots")
    small_anchor = "| [P-M07-LIST](screenshots/1024x768/P-M07-LIST.png) | M07 |"
    small_rows = small_anchor + "\n| [P-M07-SOURCE-FALLBACK](screenshots/1024x768/P-M07-SOURCE-FALLBACK.png) | M07 |"
    if "screenshots/1024x768/P-M07-SOURCE-FALLBACK.png" not in text:
        text = replace(text, small_anchor, small_rows, "visual small DPC09 shot")
    text = replace(text, "；91 场景逐场景", "；92 场景逐场景", "visual criteria scenes")
    text = replace(text, "D-PC-01—08", "D-PC-01—09", "visual decision range")
    text = replace(text, "manifest `confirmations` 49 条", "manifest `confirmations` 50 条", "visual confirmations")
    text = replace(text, "| 三条故事连续点击走通", "| 四条故事连续走通", "visual stories criteria")
    text = replace(text, "manifest `stories` 3 条（S1 12 步 / S2 14 步 / S3 7 步）", "manifest `stories` 4 条（S1 12 步 / S2 14 步 / S3 7 步 / S4 7 步）", "visual stories count")
    text = replace(text, "1364 边全命中、182 次加载", "1383 边全命中、184 次加载", "visual evidence count")
    text = replace(text, "37 张截图", "41 张截图", "visual screenshot total")
    text = replace(text, "manifest `sources` 13 项", "manifest `sources` 16 项", "visual source criteria")
    text = replace(text, "D-PC-07/08 原话与本轮差异快照", "D-PC-07/08/09 原话与本轮差异快照", "visual source scope")
    path.write_text(text, encoding="utf-8")


def sync_review_residuals() -> None:
    path = BUNDLE / "review.md"
    text = path.read_text(encoding="utf-8")
    text = replace(text, "POO-71 仅以 G4 token", "本原型仅以 G4 token", "review legacy task wording")
    path.write_text(text, encoding="utf-8")


if __name__ == "__main__":
    sync_feature_map()
    sync_visual_acceptance()
    sync_review_residuals()
    print("synchronized master-r10 review documents")
