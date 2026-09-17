#!/usr/bin/env python3
"""POO-70 master-r10：同步已确认的 D-PC-09 多圈分发与授权来源恢复。"""

from __future__ import annotations

import copy
import hashlib
import json
import re
import subprocess
import sys
from pathlib import Path

BUNDLE = Path(__file__).resolve().parents[1]
ROOT = BUNDLE.parents[1]
SURFACE = BUNDLE / "surface.html"
MANIFEST = BUNDLE / "prototype-manifest.json"
SPEC = ROOT / "docs/client-journey-review/spec.md"
PREVIOUS_MANIFEST = BUNDLE / "sources/prototype-manifest-before-master-r10.json"
PREVIOUS_SPEC = BUNDLE / "sources/poo70-spec-before-master-r10.md"
REVISION = "poo70-master-r10-v2-4"
PREVIOUS = "poo70-master-r9-v2-3"
FALLBACK_SCENE = "P-M07-SOURCE-FALLBACK"


def sha256(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def replace_once(text: str, old: str, new: str, label: str) -> str:
    count = text.count(old)
    if count != 1:
        raise RuntimeError(f"{label}: expected 1 occurrence, found {count}")
    return text.replace(old, new, 1)


def replace_first_of(text: str, old: str, new: str, expected: int, label: str) -> str:
    count = text.count(old)
    if count != expected:
        raise RuntimeError(f"{label}: expected {expected} occurrences, found {count}")
    return text.replace(old, new, 1)


def split_scenes(html: str):
    parts = re.split(r'(?=<section class="scene" data-prototype-scene=")', html)
    head, scenes = parts[0], []
    for part in parts[1:]:
        match = re.match(r'<section class="scene" data-prototype-scene="([A-Z0-9-]+)"', part)
        if not match:
            raise RuntimeError("scene boundary parse failed")
        scenes.append([match.group(1), part])
    return head, scenes


def same_creator_example(text: str) -> str:
    """Keep the D-PC-09 example inside one creator's two circles."""
    return text.replace("北极星设计圈", "晨星设计圈").replace("北极星设计工作室", "晨星增长工作室")


def same_creator_values(value):
    if isinstance(value, str):
        return same_creator_example(value)
    if isinstance(value, list):
        return [same_creator_values(item) for item in value]
    if isinstance(value, dict):
        return {key: same_creator_values(item) for key, item in value.items()}
    return value


def rewrite_all_apps(scene: str) -> str:
    # 首页快捷区中的同一作品成为唯一条目，并显示两个有效授权来源。
    scene = replace_first_of(
        scene,
        '<article class="product-card"><div class="card-heading"><span class="app-art "><svg class="icon " viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M6 3h8l4 4v14H6z"></path><path d="M14 3v5h5"></path><path d="M9 13h6M9 17h6"></path></svg></span><div class="card-title"><h3>会议纪要整理</h3><p class="source-line">来自 北极星设计圈</p>',
        '<article data-review-anchor="multi-circle-dedupe" class="product-card"><div class="card-heading"><span class="app-art "><svg class="icon " viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M6 3h8l4 4v14H6z"></path><path d="M14 3v5h5"></path><path d="M9 13h6M9 17h6"></path></svg></span><div class="card-title"><h3>会议纪要整理</h3><p class="source-line">2 个有效来源 · 晨星增长圈、北极星设计圈</p>',
        2,
        "all apps unique multi-source card",
    )
    scene = replace_once(
        scene,
        '按 2 个圈子查看 3 个 Apps · 同名 App 靠来源区分，不合并',
        '同一作品只显示一次；作品卡片保留全部有效授权来源',
        "all apps section description",
    )
    scene = replace_once(
        scene,
        '北极星设计工作室 · 2 个 Apps',
        '北极星设计工作室 · 1 个独有 App · 1 个共同授权作品',
        "north circle app count",
    )
    cards = list(re.finditer(r'<article class="product-card">.*?</article>', scene, flags=re.S))
    meetings = [m for m in cards if '<h3>会议纪要整理</h3>' in m.group(0)]
    if len(meetings) != 1:
        raise RuntimeError(f"expected one duplicate meeting card after unique card rewrite, found {len(meetings)}")
    duplicate = meetings[0]
    scene = scene[:duplicate.start()] + scene[duplicate.end():]
    return scene


def build_fallback_scene(all_apps: str) -> str:
    scene = all_apps.replace(
        'data-prototype-scene="P-M03-ALL-APPS"',
        f'data-prototype-scene="{FALLBACK_SCENE}"',
        1,
    ).replace('T-M03-ALL-APPS-', f'T-{FALLBACK_SCENE[2:]}-')
    scene = replace_once(scene, '<h1>全部 Apps</h1>', '<h1>授权来源已更新</h1>', "fallback title")
    scene = replace_once(
        scene,
        '<p>搜索、打开或加入首页</p>',
        '<p>已退出晨星增长圈；其他有效来源继续支持使用</p>',
        "fallback subtitle",
    )
    scene = replace_once(
        scene,
        '2 个有效来源 · 晨星增长圈、北极星设计圈',
        '仍可使用 · 北极星设计圈有效；晨星增长圈来源已撤销',
        "fallback source line",
    )
    scene = replace_once(
        scene,
        '同一作品只显示一次；作品卡片保留全部有效授权来源',
        '“会议纪要整理”仍只显示一次；已撤销来源不再计入授权',
        "fallback section description",
    )
    return scene


def rebuild_surface() -> None:
    html = SURFACE.read_text(encoding="utf-8")
    head, scenes = split_scenes(html)
    by_id = {sid: part for sid, part in scenes}
    if FALLBACK_SCENE in by_id:
        raise RuntimeError(f"{FALLBACK_SCENE} already exists")

    all_apps = rewrite_all_apps(by_id["P-M03-ALL-APPS"])
    fallback = same_creator_example(build_fallback_scene(all_apps))
    by_id["P-M03-ALL-APPS"] = same_creator_example(all_apps)

    leave = by_id["P-M07-LEAVE"]
    leave = replace_once(
        leave,
        '晨星增长工作室 · 1 个 Apps · 1 个 Skills',
        '晨星增长工作室 · 2 个 Apps · 1 个 Skills',
        "leave app count",
    )
    leave = replace_once(
        leave,
        '<small>已获得的作品将按来源策略处理；退出后不可再启动</small>',
        '<small>只撤销晨星增长圈这一来源；会议纪要整理仍由北极星设计圈授权并可继续使用。仅此圈提供的作品将不可用。</small>',
        "leave impact copy",
    )
    leave = replace_once(
        leave,
        'data-go="P-M07-EMPTY" data-transition="T-M07-LEAVE-021-M07-EMPTY">确认退出',
        f'data-go="{FALLBACK_SCENE}" data-transition="T-M07-LEAVE-021-M07-SOURCE-FALLBACK">确认退出',
        "leave confirm target",
    )
    by_id["P-M07-LEAVE"] = same_creator_example(leave)

    expired = by_id["P-M07-EXPIRED"]
    expired = replace_once(
        expired,
        '作品保留并标记到期 · 续费后立即恢复，不需要重新安装',
        '本圈来源已失效；其他圈子仍有效的同一作品继续可用',
        "expired section description",
    )
    old_meeting = re.search(
        r'<article class="circle-work-row">(?:(?!</article>).)*<h3>会议纪要整理</h3>.*?</article>',
        expired,
        flags=re.S,
    )
    if not old_meeting:
        raise RuntimeError("expired meeting row not found")
    meeting = old_meeting.group(0)
    meeting = meeting.replace(
        '<small>来自 北极星设计圈 · v0.6.1</small><em>来自 北极星设计圈</em>',
        '<small>本圈来源已到期 · v0.6.1</small><em>仍由晨星增长圈授权</em>',
    ).replace(
        '<button class="button" disabled="">已到期</button><button class="button primary" data-go="P-M07-RENEW" data-transition="T-M07-EXPIRED-017-M07-RENEW">续费恢复</button>',
        '<button class="button primary" data-go="P-M04-APP-VIEW" data-transition="T-M07-EXPIRED-017-M04-APP-VIEW">仍可打开</button>',
    )
    expired = expired[:old_meeting.start()] + meeting + expired[old_meeting.end():]
    by_id["P-M07-EXPIRED"] = same_creator_example(expired)

    blocked = by_id["P-M11-BLOCKED-EXPIRED"]
    blocked = blocked.replace('T-M11-BLOCKED-EXPIRED-001-M03-HOME-ENT', 'T-M11-BLOCKED-EXPIRED-001-M03-HOME-PERSONAL')
    blocked = blocked.replace('T-M11-BLOCKED-EXPIRED-003-M03-HOME-ENT', 'T-M11-BLOCKED-EXPIRED-003-M03-HOME-PERSONAL')
    blocked = blocked.replace('data-go="P-M03-HOME-ENT"', 'data-go="P-M03-HOME-PERSONAL"')
    blocked = blocked.replace('<span class="space-avatar" id="space-avatar" aria-hidden="true">晨</span>', '<span class="space-avatar" id="space-avatar" aria-hidden="true">我</span>')
    blocked = blocked.replace('<strong id="space-name">晨星科技</strong><small id="space-type">企业空间 · Member</small>', '<strong id="space-name">我的空间</strong><small id="space-type">个人空间 · 个人</small>')
    blocked = blocked.replace('数据报表生成器', '会议纪要整理')
    blocked = blocked.replace('来自 数据工坊圈 · v1.2.0', '此前来自 晨星增长圈、北极星设计圈 · v0.6.1')
    blocked = blocked.replace('从数据源生成周期报表', '把会议录音变成纪要')
    blocked = blocked.replace('晨星科技 · App 工作区', '我的空间 · App 工作区')
    blocked = blocked.replace('运行状态 · 晨星科技', '运行状态 · 我的空间')
    blocked = blocked.replace('圈子订阅已到期', '最后一个有效来源已失效')
    blocked = blocked.replace(
        '来源：北极星设计圈 · 续费后立即恢复，不需要重新安装；历史结果继续保留。',
        '晨星增长圈来源已撤销，北极星设计圈来源也已到期。恢复任一有效来源后即可重新打开，不需要重复安装。',
    )
    by_id["P-M11-BLOCKED-EXPIRED"] = same_creator_example(blocked)

    rebuilt = []
    for sid, _ in scenes:
        rebuilt.append(by_id[sid])
        if sid == "P-M03-ALL-APPS":
            rebuilt.append(fallback)
    SURFACE.write_text(head + "".join(rebuilt), encoding="utf-8")


def rebuild_manifest() -> None:
    data = json.loads(MANIFEST.read_text(encoding="utf-8"))
    scenes = data["scenes"]
    by_id = {scene["id"]: scene for scene in scenes}

    all_apps = by_id["P-M03-ALL-APPS"]
    all_apps["title"] = "全部 Apps · 作品去重与授权来源"
    all_apps["annotation"] = "我的空间按作品 ID 去重；同一作品只显示一次，并保留全部有效圈子授权来源（D-PC-09）。"
    annotations = [a for a in all_apps.get("annotations", []) if a.get("id") != "a-m03-multi-circle-dedupe"]
    annotations.append({
        "id": "a-m03-multi-circle-dedupe",
        "anchor": "multi-circle-dedupe",
        "title": "同一作品只显示一次",
        "body": "会议纪要整理同时来自晨星增长圈和北极星设计圈；我的空间按作品去重，并在唯一作品卡片上保留两个有效来源。",
    })
    all_apps["annotations"] = annotations
    all_apps["transitions"] = [
        edge for edge in all_apps["transitions"]
        if edge["id"] != "T-M03-ALL-APPS-020-M04-APP-VIEW"
    ]

    fallback = copy.deepcopy(all_apps)
    fallback.update({
        "id": FALLBACK_SCENE,
        "node": FALLBACK_SCENE,
        "journey": "J7 圈子加入与订阅",
        "module": "M07",
        "title": "授权来源更新 · 仍可使用",
        "status": "suggested",
        "category": "调整",
        "annotation": "退出晨星增长圈只撤销该来源；北极星设计圈仍有效，因此会议纪要整理继续可用（D-PC-09）。",
        "annotations": [{
            "id": "a-m07-source-fallback",
            "anchor": "multi-circle-dedupe",
            "title": "一个来源失效仍可使用",
            "body": "作品仍只显示一次；来源行更新为北极星设计圈有效，并明确晨星增长圈来源已撤销。",
        }],
    })
    fallback["transitions"] = []
    for edge in all_apps["transitions"]:
        item = copy.deepcopy(edge)
        item["id"] = item["id"].replace("T-M03-ALL-APPS-", "T-M07-SOURCE-FALLBACK-")
        fallback["transitions"].append(item)
    scenes.insert(scenes.index(all_apps) + 1, fallback)

    by_id = {scene["id"]: scene for scene in scenes}
    leave = by_id["P-M07-LEAVE"]
    leave["annotation"] = "退出只撤销当前圈子的授权来源；其他圈子仍有效的同一作品继续可用（D-PC-09）。"
    edge = next(e for e in leave["transitions"] if e["id"] == "T-M07-LEAVE-021-M07-EMPTY")
    edge.update({
        "id": "T-M07-LEAVE-021-M07-SOURCE-FALLBACK",
        "to": FALLBACK_SCENE,
        "feedback": "退出晨星增长圈；会议纪要整理仍由北极星设计圈授权",
    })

    expired = by_id["P-M07-EXPIRED"]
    expired["annotation"] = "北极星设计圈来源到期只撤销该来源；会议纪要整理仍由晨星增长圈授权并可打开，独有作品进入续费恢复（D-PC-09）。"
    edge = next(e for e in expired["transitions"] if e["id"] == "T-M07-EXPIRED-017-M07-RENEW")
    edge.update({
        "id": "T-M07-EXPIRED-017-M04-APP-VIEW",
        "label": "仍可打开",
        "to": "P-M04-APP-VIEW",
        "feedback": "另一个圈子来源仍有效，继续打开同一作品",
    })

    blocked = by_id["P-M11-BLOCKED-EXPIRED"]
    blocked["title"] = "作品 · 最后一个来源失效"
    blocked["annotation"] = "仅当最后一个有效圈子来源也失效时，作品才进入不可用与恢复路径（D-PC-09）。该状态属于我的空间，不进入企业空间。"
    for edge in blocked["transitions"]:
        if edge["id"] == "T-M11-BLOCKED-EXPIRED-001-M03-HOME-ENT":
            edge.update({"id": "T-M11-BLOCKED-EXPIRED-001-M03-HOME-PERSONAL", "to": "P-M03-HOME-PERSONAL", "feedback": "返回我的空间首页"})
        elif edge["id"] == "T-M11-BLOCKED-EXPIRED-003-M03-HOME-ENT":
            edge.update({"id": "T-M11-BLOCKED-EXPIRED-003-M03-HOME-PERSONAL", "to": "P-M03-HOME-PERSONAL", "feedback": "关闭并返回我的空间首页"})
        elif edge["id"] == "T-M11-BLOCKED-EXPIRED-002-M04-APP-VIEW":
            edge["label"] = "会议纪要整理"
        elif edge["id"] == "T-M11-BLOCKED-EXPIRED-004-M04-RUNTIME":
            edge["label"] = "1 项运行中"
        elif edge["id"] == "T-M11-BLOCKED-EXPIRED-005-M02-SWITCHER":
            edge["label"] = "我 我的空间个人空间 · 个人"
        elif edge["id"] == "T-M11-BLOCKED-EXPIRED-013-M04-RUNTIME":
            edge["label"] = "会议纪要整理已在后台完成 · 顶栏运行入口可查看"

    confirmations = [c for c in data["confirmations"] if c["id"] != "D-PC-09"]
    insert_at = next(i for i, c in enumerate(confirmations) if c["id"] == "D-PC-08") + 1
    confirmations.insert(insert_at, {
        "id": "D-PC-09",
        "status": "confirmed",
        "scope": "同一作品可分发到多个圈子；我的空间按作品去重并保留全部有效来源；单一来源失效不阻断，最后来源失效才不可用；企业不继承个人圈子来源",
        "source_revision": "user-decision-r10（2026-09-16）",
    })
    data["confirmations"] = confirmations

    stories = [s for s in data["stories"] if s["id"] != "S4"]
    stories.append({
        "id": "S4",
        "title": "故事四 · 多圈授权去重与逐来源失效",
        "description": "两个圈子授权同一作品 → 只显示一次 → 退出一个圈子仍可使用 → 最后来源失效才阻断 → 企业目录无圈子来源。",
        "steps": [
            {"id": "S4-01", "scene": "P-M03-ALL-APPS", "description": "同一作品只显示一次，来源行保留两个有效圈子"},
            {"id": "S4-02", "scene": "P-M07-DETAIL-FOCUS", "description": "进入晨星增长圈详情"},
            {"id": "S4-03", "scene": "P-M07-LEAVE", "description": "退出晨星增长圈前说明逐来源影响"},
            {"id": "S4-04", "scene": FALLBACK_SCENE, "description": "退出后仍由北极星设计圈授权并可打开"},
            {"id": "S4-05", "scene": "P-M07-EXPIRED", "arrival": "review", "description": "评审分支：单一圈子到期时，共同授权作品仍由另一来源支持"},
            {"id": "S4-06", "scene": "P-M11-BLOCKED-EXPIRED", "arrival": "review", "description": "评审分支：最后一个有效来源失效后才进入不可用与恢复"},
            {"id": "S4-07", "scene": "P-M03-HOME-ENT", "arrival": "review", "description": "评审分支：企业首页只显示企业导入与分发作品，无个人圈子来源"},
        ],
    })
    data["stories"] = stories
    data["review_entries"] = [
        {"scene": "P-M07-EXPIRED", "reason": "走查单一圈子来源到期但另一个来源仍有效"},
        {"scene": "P-M11-BLOCKED-EXPIRED", "reason": "走查最后一个有效来源失效后的阻断与恢复"},
        {"scene": "P-M03-HOME-ENT", "reason": "走查企业空间不出现个人圈子来源"},
    ]

    for scene_id in (
        "P-M03-ALL-APPS",
        "P-M07-LEAVE",
        FALLBACK_SCENE,
        "P-M07-EXPIRED",
        "P-M11-BLOCKED-EXPIRED",
    ):
        scene = next(item for item in data["scenes"] if item["id"] == scene_id)
        transformed = same_creator_values(scene)
        scene.clear()
        scene.update(transformed)
    data["stories"] = same_creator_values(data["stories"])

    source_defs = {
        "poo70-spec": ("POO-70 客户端产品与用户流程说明", "master-r10（2026-09-17）", "docs/mvp-complete-flow-hifi/sources/poo70-spec.md"),
        "dpc09-source": ("D-PC-09 多圈分发用户确认", "user-decision-r10（2026-09-16）", "docs/client-journey-review/sources/user-decision-r10.md"),
        "prototype-before-master-r10": ("master-r10 修订前 manifest", PREVIOUS, "docs/mvp-complete-flow-hifi/sources/prototype-manifest-before-master-r10.json"),
        "master-r10-review": ("master-r10 原型一致性评审快照", "master-r10（2026-09-17）", "docs/mvp-complete-flow-hifi/sources/master-r10-review-snapshot.json"),
    }
    sources = {source["id"]: source for source in data["sources"]}
    for sid, (label, revision, rel) in source_defs.items():
        sources[sid] = {"id": sid, "label": label, "revision": revision, "path": rel, "sha256": sha256(ROOT / rel)}
    data["sources"] = list(sources.values())

    data["review"] = json.loads((BUNDLE / "sources/master-r10-review-snapshot.json").read_text(encoding="utf-8"))
    data["revision"] = REVISION
    data["change"] = {
        "previous_revision": PREVIOUS,
        "changed_scenes": ["P-M03-ALL-APPS", "P-M07-EXPIRED", "P-M07-LEAVE", FALLBACK_SCENE, "P-M11-BLOCKED-EXPIRED"],
        "removed_scenes": [],
        "summary": "同步 D-PC-09：同一作品多圈授权按作品去重；单一来源失效继续可用；最后来源失效才阻断；修正到期阻断状态误落企业上下文。修改待复看。",
    }
    data["summary"] = [
        "本轮落实用户已确认的 D-PC-09，不再把同一作品跨多个圈子分发列为待 POL-116 裁决。",
        "我的空间按作品 ID 去重，并在唯一条目上显示全部有效圈子来源。",
        "退出或失去一个圈子只撤销该来源；另有有效来源时继续可用，最后来源失效才阻断。",
        "企业空间仍只展示企业导入、启用和分发的企业实例，不显示个人圈子来源。",
        "本修订为评审材料，状态为修改待复看；未启动产品编码、发布或真实产品验收。",
    ]
    MANIFEST.write_text(json.dumps(data, ensure_ascii=False, indent=1) + "\n", encoding="utf-8")


def refresh_sources() -> None:
    (BUNDLE / "sources/poo70-spec.md").write_text(SPEC.read_text(encoding="utf-8"), encoding="utf-8")
    data = json.loads(MANIFEST.read_text(encoding="utf-8"))
    for source in data["sources"]:
        source["sha256"] = sha256(ROOT / source["path"])
    MANIFEST.write_text(json.dumps(data, ensure_ascii=False, indent=1) + "\n", encoding="utf-8")


def rebase_previous_sources() -> None:
    """Keep the previous manifest independently source-valid after the live spec snapshot advances."""
    data = json.loads(PREVIOUS_MANIFEST.read_text(encoding="utf-8"))
    source = next(item for item in data["sources"] if item["id"] == "poo70-spec")
    source["path"] = "docs/mvp-complete-flow-hifi/sources/poo70-spec-before-master-r10.md"
    source["sha256"] = sha256(PREVIOUS_SPEC)
    PREVIOUS_MANIFEST.write_text(json.dumps(data, ensure_ascii=False, indent=1) + "\n", encoding="utf-8")


def restore_previous_spec_from_head() -> None:
    rel = "docs/client-journey-review/spec.md"
    content = subprocess.check_output(["git", "show", f"HEAD:{rel}"], cwd=ROOT)
    PREVIOUS_SPEC.write_bytes(content)
    rebase_previous_sources()


def main() -> None:
    if not PREVIOUS_MANIFEST.exists():
        PREVIOUS_MANIFEST.write_bytes(MANIFEST.read_bytes())
    if not PREVIOUS_SPEC.exists():
        PREVIOUS_SPEC.write_bytes(SPEC.read_bytes())
    rebuild_surface()
    rebuild_manifest()
    refresh_sources()
    print(f"rebuilt {REVISION}")


if __name__ == "__main__":
    if "--refresh-sources" in sys.argv:
        refresh_sources()
        print(f"refreshed sources for {REVISION}")
    elif "--rebase-previous" in sys.argv:
        rebase_previous_sources()
        print(f"rebased previous sources for {PREVIOUS}")
    elif "--restore-previous-spec" in sys.argv:
        restore_previous_spec_from_head()
        print(f"restored previous spec from HEAD for {PREVIOUS}")
    else:
        main()
