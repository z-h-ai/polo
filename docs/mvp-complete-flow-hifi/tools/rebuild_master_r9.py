#!/usr/bin/env python3
"""POO-70 master-r9：把已明确的 D-PC-08 与空间切换规则同步到高保真评审材料。"""

from __future__ import annotations

import copy
import hashlib
import json
import re
import sys
from pathlib import Path

BUNDLE = Path(__file__).resolve().parents[1]
ROOT = BUNDLE.parents[1]
SURFACE = BUNDLE / "surface.html"
MANIFEST = BUNDLE / "prototype-manifest.json"
REVISION = "poo70-master-r9-v2-3"
PREVIOUS = "poo70-dpc07-v2-2"
NEW_SCENE = "P-M02-CONFIRM-PERSONAL"
ENTERPRISE_CONTEXT_SCENES = {
    "P-M02-SWITCHER", "P-M02-CONFIRM", "P-M02-STOPPING", "P-M02-STOP-FAILED",
    "P-M02-STOP-CANCEL", "P-M02-TARGET-LOADING", "P-M02-TARGET-FAILED", "P-M02-ACCESS-LOST",
    "P-M03-HOME-ENT", "P-M04-APP-VIEW", "P-M04-PREPARE", "P-M04-PREP-FAILED",
    "P-M04-CLOSE-ACTIVE", "P-M04-TERM-FAILED", "P-M04-BACKGROUND", "P-M04-RUNTIME",
    "P-M04-PERM-DENIED", "P-M05-CHAT", "P-M05-STOPPED", "P-M05-QUESTION",
    "P-M05-QUESTION-REOPEN", "P-M06-SKILLS", "P-M06-SKILL-DENIED", "P-M06-TOOLS",
    "P-M08-FILES", "P-M08-FILE-MISSING", "P-M09-APP-BANNER", "P-M09-ENT-NOTIFY",
    "P-M11-REVOKE", "P-M11-BLOCKED-WITHDRAWN", "P-M11-BLOCKED-EXPIRED",
    "P-M11-BLOCKED-VERSION", "P-M11-OFFLINE-RUNNING",
}


def sha256(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def split_scenes(html: str):
    parts = re.split(r'(?=<section class="scene" data-prototype-scene=")', html)
    head, scenes = parts[0], []
    for part in parts[1:]:
        match = re.match(r'<section class="scene" data-prototype-scene="([A-Z0-9-]+)"', part)
        if not match:
            raise RuntimeError("scene boundary parse failed")
        scenes.append([match.group(1), part])
    return head, scenes


def personal_background(personal: str) -> str:
    """Reuse the personal home content behind the switch-confirmation modal."""
    match = re.search(r'<main class="workspace-main".*?</main>', personal, flags=re.S)
    if not match:
        raise RuntimeError("personal home main content not found")
    return match.group(0).replace(
        "T-M03-HOME-PERSONAL-", "T-M02-CONFIRM-PERSONAL-BG-"
    )


def replace_confirm_background(scene: str, personal: str) -> str:
    background = personal_background(personal)
    scene, count = re.subn(
        r'<main class="workspace-main".*?</main>',
        lambda _: background,
        scene,
        count=1,
        flags=re.S,
    )
    if count != 1:
        raise RuntimeError("personal confirmation main content not found")
    return scene


def add_personal_background_edges(data: dict, scene_html: str) -> None:
    by_id = {scene["id"]: scene for scene in data["scenes"]}
    target = by_id[NEW_SCENE]
    target["transitions"] = [
        edge for edge in target["transitions"] if edge["id"] in scene_html
    ]
    existing = {edge["id"] for edge in target["transitions"]}
    for edge in by_id["P-M03-HOME-PERSONAL"]["transitions"]:
        copied = copy.deepcopy(edge)
        copied["id"] = copied["id"].replace(
            "T-M03-HOME-PERSONAL-", "T-M02-CONFIRM-PERSONAL-BG-"
        )
        if copied["id"] in scene_html and copied["id"] not in existing:
            target["transitions"].append(copied)
            existing.add(copied["id"])


def rebuild_surface():
    html = SURFACE.read_text(encoding="utf-8")
    head, scenes = split_scenes(html)
    by_id = {sid: part for sid, part in scenes}
    if NEW_SCENE in by_id:
        raise RuntimeError(f"{NEW_SCENE} already exists")

    # 个人首页有运行项时，选择企业必须先确认。
    personal = by_id["P-M03-HOME-PERSONAL"]
    personal = personal.replace(
        'data-go="P-M03-HOME-ENT" data-transition="T-M03-HOME-PERSONAL-004-M03-HOME-ENT"',
        f'data-go="{NEW_SCENE}" data-transition="T-M03-HOME-PERSONAL-004-M02-CONFIRM-PERSONAL"',
        1,
    )
    by_id["P-M03-HOME-PERSONAL"] = personal

    # 从企业→个人确认页派生同构的个人→企业确认页；只保留一个个人空间运行项。
    clone = by_id["P-M02-CONFIRM"]
    clone = clone.replace('data-prototype-scene="P-M02-CONFIRM"', f'data-prototype-scene="{NEW_SCENE}"', 1)
    clone = clone.replace("T-M02-CONFIRM-", "T-M02-CONFIRM-PERSONAL-")
    clone = clone.replace('data-go="P-M03-HOME-ENT"', 'data-go="P-M03-HOME-PERSONAL"', 1)
    clone = clone.replace(
        'data-transition="T-M02-CONFIRM-PERSONAL-001-M03-HOME-ENT"',
        'data-transition="T-M02-CONFIRM-PERSONAL-001-M03-HOME-PERSONAL"',
        1,
    )
    clone = clone.replace('<span class="space-avatar" id="space-avatar" aria-hidden="true">晨</span>', '<span class="space-avatar" id="space-avatar" aria-hidden="true">我</span>', 1)
    clone = clone.replace('<strong id="space-name">晨星科技</strong><small id="space-type">企业空间 · Member</small>', '<strong id="space-name">我的空间</strong><small id="space-type">个人空间 · 个人</small>', 1)
    clone = clone.replace('<span id="runtime-label">3 项运行中</span>', '<span id="runtime-label">1 项运行中</span>', 1)
    clone = clone.replace('<div class="menu-label">运行状态 · 晨星科技</div>', '<div class="menu-label">运行状态 · 我的空间</div>', 1)
    clone = clone.replace('<h2>切换到 我的空间</h2><p>终止 3 项任务后切换</p>', '<h2>切换到 晨星科技</h2><p>终止 1 项任务后切换</p>', 1)
    clone = clone.replace('当前仍在 晨星科技。切换只影响这台设备；已终止的项不会自动恢复。', '当前仍在 我的空间。切换只影响这台设备；已终止的项不会自动恢复。', 1)
    clone = re.sub(
        r'<div class="dialog-list">.*?</div><p class="dialog-note">',
        '<div class="dialog-list"><div class="dialog-row"><span class="row-state ">运行中</span><span class="row-copy"><strong>数据报表生成器</strong><small>我的空间 · 后台运行</small></span></div></div><p class="dialog-note">',
        clone,
        count=1,
        flags=re.S,
    )
    clone = clone.replace(
        f'data-go="P-M02-SWITCHER" data-transition="T-M02-CONFIRM-PERSONAL-020-M02-SWITCHER"',
        'data-go="P-M03-HOME-PERSONAL" data-transition="T-M02-CONFIRM-PERSONAL-020-M03-HOME-PERSONAL"',
        1,
    )
    clone = clone.replace(
        f'data-go="P-M02-STOPPING" data-transition="T-M02-CONFIRM-PERSONAL-021-M02-STOPPING"',
        'data-go="P-M03-HOME-ENT" data-transition="T-M02-CONFIRM-PERSONAL-021-M03-HOME-ENT"',
        1,
    )
    clone = replace_confirm_background(clone, by_id["P-M03-HOME-PERSONAL"])

    # 圈子空态不再把私域分发误写成仅邀请，也不能跳到企业邀请页。
    empty = by_id["P-M07-EMPTY"]
    empty = empty.replace("圈子作品来自认证创作者的邀请或订阅", "圈子作品来自创作者的私域分发")
    empty = empty.replace(
        "使用创作者分享的邀请链接加入圈子；加入后，圈子的 Apps 与 Skills 会出现在你的空间里。",
        "使用创作者分享链接、二维码、定向邀请或付费/审批入口加入；获得的 Apps 与 Skills 会聚合到我的空间。",
    )
    empty = empty.replace(
        'data-go="P-M01-INVITE-BROWSER" data-transition="T-M07-EMPTY-014-M01-INVITE-BROWSER">打开邀请链接',
        'data-go="P-M07-JOIN-FREE" data-transition="T-M07-EMPTY-014-M07-JOIN-FREE">使用已有链接或二维码',
    )
    by_id["P-M07-EMPTY"] = empty

    # 个人真空目录不提企业；普通消费页只在需要理解权益时展示圈子来源。
    by_id["P-M03-HOME-EMPTY-DIR"] = by_id["P-M03-HOME-EMPTY-DIR"].replace(
        "企业还没有向你分发 App，加入的圈子也没有作品。出现内容后，这里会按来源分组展示。",
        "尚未加入提供 App 的圈子，或已加入圈子还没有分发 App。取得权益后会聚合到我的空间。",
    )
    source_rewrites = {
        "认证创作者 · 林可 · 数据工坊": "来自 数据工坊圈",
        "认证创作者 · 陈默 · 设计蓝图": "来自 北极星设计圈",
        "认证创作者 · 晨星增长工作室": "来自 晨星增长圈",
        "认证创作者 · 北极星设计工作室": "来自 北极星设计圈",
    }
    for sid, part in list(by_id.items()):
        for old, new in source_rewrites.items():
            part = part.replace(old, new)
        # 企业空间不展示个人圈子通知；企业目录仍只保留企业作品。
        if '<strong id="space-name">晨星科技</strong>' in part:
            part = re.sub(
                r'<button class="menu-row" data-go="P-M07-DETAIL-PAID"[^>]*>.*?</button>',
                "",
                part,
                flags=re.S,
            )
        by_id[sid] = part

    # 新确认页紧跟原确认页，保持模块索引连续。
    rebuilt = []
    for sid, _ in scenes:
        rebuilt.append(by_id[sid])
        if sid == "P-M02-CONFIRM":
            rebuilt.append(clone)
    SURFACE.write_text(head + "".join(rebuilt), encoding="utf-8")


def rebuild_manifest():
    data = json.loads(MANIFEST.read_text(encoding="utf-8"))
    scenes = data["scenes"]
    by_id = {s["id"]: s for s in scenes}

    # 个人首页的企业选择进入新确认页。
    home = by_id["P-M03-HOME-PERSONAL"]
    edge = next(e for e in home["transitions"] if e["id"] == "T-M03-HOME-PERSONAL-004-M03-HOME-ENT")
    edge.update({
        "id": "T-M03-HOME-PERSONAL-004-M02-CONFIRM-PERSONAL",
        "to": NEW_SCENE,
        "feedback": "切换到「切换确认 · 从我的空间到企业」",
    })

    # 新页面沿用原确认页的视觉结构，更新真实操作与反馈。
    source = by_id["P-M02-CONFIRM"]
    new_scene = copy.deepcopy(source)
    new_scene.update({
        "id": NEW_SCENE,
        "node": NEW_SCENE,
        "title": "切换确认 · 从我的空间到企业",
        "category": "调整",
        "annotation": "我的空间有活动时也必须先说明将终止的运行项；取消留在我的空间，确认后才进入企业（PC-F06/C-R04）。",
    })
    new_edges = []
    for old in source["transitions"]:
        item = copy.deepcopy(old)
        item["id"] = item["id"].replace("T-M02-CONFIRM-", "T-M02-CONFIRM-PERSONAL-")
        if item["id"] == "T-M02-CONFIRM-PERSONAL-001-M03-HOME-ENT":
            item.update({"id": "T-M02-CONFIRM-PERSONAL-001-M03-HOME-PERSONAL", "to": "P-M03-HOME-PERSONAL", "feedback": "返回我的空间首页"})
        elif item["id"] == "T-M02-CONFIRM-PERSONAL-020-M02-SWITCHER":
            item.update({"id": "T-M02-CONFIRM-PERSONAL-020-M03-HOME-PERSONAL", "to": "P-M03-HOME-PERSONAL", "feedback": "取消切换，留在我的空间；运行项不变"})
        elif item["id"] == "T-M02-CONFIRM-PERSONAL-021-M02-STOPPING":
            item.update({"id": "T-M02-CONFIRM-PERSONAL-021-M03-HOME-ENT", "to": "P-M03-HOME-ENT", "feedback": "确认终止当前活动后进入晨星科技"})
        new_edges.append(item)
    new_scene["transitions"] = new_edges
    insert_at = scenes.index(source) + 1
    scenes.insert(insert_at, new_scene)
    surface_scenes = dict(split_scenes(SURFACE.read_text(encoding="utf-8"))[1])
    add_personal_background_edges(data, surface_scenes[NEW_SCENE])

    # 文字与跨空间信息修正。
    by_id = {s["id"]: s for s in scenes}
    by_id["P-M07-EMPTY"]["annotation"] = "没有圈子时说明私域来源可为分享链接、二维码、定向邀请、付费或审批入口；不虚构公开市场。"
    edge = next(e for e in by_id["P-M07-EMPTY"]["transitions"] if e["id"] == "T-M07-EMPTY-014-M01-INVITE-BROWSER")
    edge.update({"id": "T-M07-EMPTY-014-M07-JOIN-FREE", "label": "使用已有链接或二维码", "to": "P-M07-JOIN-FREE", "feedback": "进入圈子加入确认"})
    by_id["P-M03-HOME-EMPTY-DIR"]["annotation"] = "个人目录为空时说明尚未加入提供 App 的圈子，或已加入圈子尚未分发；不混入企业目录。"
    by_id["P-M03-ALL-APPS"]["annotation"] = "我的空间聚合多个圈子的有效 App 权益；圈子不是空间，同名作品按稳定条目和实际权益来源区分。"
    by_id["P-M03-HOME-ENT"]["annotation"] = "企业首页只展示企业导入、启用并向本人分发的能力；不含个人圈子、圈子订阅或管理卡（D-PC-07/08）。"

    # 删除所有企业上下文里指向个人圈子的通知 transition，与 surface 同步。
    for scene in scenes:
        if scene["id"] in ENTERPRISE_CONTEXT_SCENES:
            scene["transitions"] = [e for e in scene["transitions"] if e["to"] != "P-M07-DETAIL-PAID"]

    # 用当前主说明替换旧产品结论快照，并新增本轮用户原话与修订前清单。
    spec_source = BUNDLE / "sources" / "poo70-spec.md"
    spec_source.write_text((ROOT / "docs/client-journey-review/spec.md").read_text(encoding="utf-8"), encoding="utf-8")
    source_defs = {
        "poo70-spec": ("POO-70 客户端产品与用户流程说明", "master-r9（2026-09-17）", "docs/mvp-complete-flow-hifi/sources/poo70-spec.md"),
        "dpc08-source": ("D-PC-08 主说明与共享边界整理依据", "user-decision-r9（2026-09-17）", "docs/client-journey-review/sources/user-decision-r9.md"),
        "prototype-before-master-r9": ("master-r9 修订前 manifest", PREVIOUS, "docs/mvp-complete-flow-hifi/sources/prototype-manifest-before-master-r9.json"),
        "master-r9-review": ("master-r9 原型一致性评审快照", "master-r9（2026-09-17）", "docs/mvp-complete-flow-hifi/sources/master-r9-review-snapshot.json"),
    }
    sources = {s["id"]: s for s in data["sources"]}
    for sid, (label, revision, rel) in source_defs.items():
        sources[sid] = {"id": sid, "label": label, "revision": revision, "path": rel, "sha256": sha256(ROOT / rel)}
    data["sources"] = list(sources.values())

    confirmations = [c for c in data["confirmations"] if c["id"] != "D-PC-08"]
    confirmations.insert(7, {
        "id": "D-PC-08",
        "status": "confirmed",
        "scope": "圈子权益只聚合到我的空间；圈子不是空间；企业不继承个人圈子且不订阅圈子；无公开市场，私域不等于仅邀请",
        "source_revision": "user-decision-r9（2026-09-17）",
    })
    data["confirmations"] = confirmations
    story = next(s for s in data["stories"] if s["id"] == "S1")
    if not any(step["scene"] == NEW_SCENE for step in story["steps"]):
        insert_at = next(i for i, step in enumerate(story["steps"]) if step["scene"] == "P-M03-HOME-ENT")
        story["steps"].insert(insert_at, {
            "id": "S1-05A",
            "scene": NEW_SCENE,
            "description": "我的空间有运行项：先确认终止，再进入企业空间",
        })
    data["review"] = json.loads((BUNDLE / "sources/master-r9-review-snapshot.json").read_text(encoding="utf-8"))
    data["revision"] = REVISION
    changed = set(data.get("change", {}).get("changed_scenes", []))
    changed.update({NEW_SCENE, "P-M03-HOME-PERSONAL", "P-M03-HOME-ENT", "P-M03-ALL-APPS", "P-M03-HOME-EMPTY-DIR", "P-M07-EMPTY"})
    data["change"] = {
        "previous_revision": PREVIOUS,
        "changed_scenes": sorted(changed),
        "removed_scenes": [],
        "summary": "同步 master-r9/D-PC-08：修正圈子私域入口、个人与企业目录边界和企业空间通知；新增个人空间有活动时切企业确认页；产品说明成为唯一来源。修改待下一次视觉复看。",
    }
    data["summary"] = [
        "本轮按 POO-70 master-r9 与 D-PC-08 修正已明确规则的遗漏，不增加新产品能力。",
        "我的空间聚合多个圈子的有效权益，圈子不进入空间选择器；企业只展示自己的导入/启用/分发能力，不继承个人圈子，也不出现圈子订阅通知。",
        "私域加入可以来自分享链接、二维码、定向邀请、付费或审批入口；当前不建设公开市场。",
        "个人空间有活动时选择企业，先展示终止确认；取消留在个人空间，确认后才切换。",
        "本修订为评审材料，状态为修改待复看；未启动产品编码、发布或真实产品验收。",
    ]
    MANIFEST.write_text(json.dumps(data, ensure_ascii=False, indent=1) + "\n", encoding="utf-8")


if __name__ == "__main__":
    if "--repair-generated" in sys.argv:
        (BUNDLE / "sources/poo70-spec.md").write_text(
            (ROOT / "docs/client-journey-review/spec.md").read_text(encoding="utf-8"),
            encoding="utf-8",
        )
        html = SURFACE.read_text(encoding="utf-8")
        before = 'data-transition="T-M02-CONFIRM-PERSONAL-001-M03-HOME-ENT"'
        after = 'data-transition="T-M02-CONFIRM-PERSONAL-001-M03-HOME-PERSONAL"'
        if html.count(before) != 1:
            if html.count(before) != 0 or html.count(after) != 1:
                raise RuntimeError(f"expected one generated transition to repair, found {html.count(before)}")
        else:
            html = html.replace(before, after, 1)
        head, scenes = split_scenes(html)
        by_scene = {scene_id: scene for scene_id, scene in scenes}
        by_scene[NEW_SCENE] = replace_confirm_background(
            by_scene[NEW_SCENE], by_scene["P-M03-HOME-PERSONAL"]
        )
        SURFACE.write_text(head + "".join(by_scene[scene_id] for scene_id, _ in scenes), encoding="utf-8")
        data = json.loads(MANIFEST.read_text(encoding="utf-8"))
        add_personal_background_edges(data, by_scene[NEW_SCENE])
        for scene in data["scenes"]:
            if scene["id"] in ENTERPRISE_CONTEXT_SCENES:
                scene["transitions"] = [edge for edge in scene["transitions"] if edge["to"] != "P-M07-DETAIL-PAID"]
        for source in data["sources"]:
            source["sha256"] = sha256(ROOT / source["path"])
        previous = json.loads((BUNDLE / "sources/prototype-manifest-before-master-r9.json").read_text(encoding="utf-8"))
        previous_scenes = {scene["id"]: scene for scene in previous["scenes"]}
        data["change"]["changed_scenes"] = sorted(
            scene["id"] for scene in data["scenes"]
            if scene["id"] not in previous_scenes or scene != previous_scenes[scene["id"]]
        )
        MANIFEST.write_text(json.dumps(data, ensure_ascii=False, indent=1) + "\n", encoding="utf-8")
        print(f"repaired generated surface for {REVISION}")
    else:
        rebuild_surface()
        rebuild_manifest()
        print(f"rebuilt {REVISION}")
