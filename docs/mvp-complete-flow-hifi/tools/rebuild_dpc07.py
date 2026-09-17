#!/usr/bin/env python3
"""POO-70 D-PC-07 收口重建 · surface 与 manifest 增量修订（poo71-hifi-v2-1 → poo70-dpc07-v2-2）。

1. surface.html：移除首页「系统工具」区（文件/任务与结果入口，违反 D-PC-03 与 Spec §8 POO-56/57）；
   通知文案不再指向「任务与结果」；「查看历史结果」改「查看运行记录」；11 个 D-PC-07 场景注入 data-review-anchor。
2. manifest：同步删除/改名 transitions；新增 11 组锚定标注；绑定 D-PC-07 评审快照与原文；
   更新 design Skill 绑定；revision/change/summary。

prototype.html 与 surface 运行时由 rebuild_shell.py 按官方模板重建。
"""
import hashlib
import json
import re
import sys
from pathlib import Path

BUNDLE = Path(__file__).resolve().parents[1]
ROOT = BUNDLE.parents[1]  # git 仓库根（source 路径均相对此根）
REVISION = 'poo70-dpc07-v2-2'
PREVIOUS = 'poo71-hifi-v2-1'

# ---------- surface.html 修正 ----------

SYSTEM_TOOLS = re.compile(
    r'<section class="section"><div class="section-header"><div><h2>系统工具</h2>'
    r'<p>查看文件与执行结果</p></div></div><div class="utility-grid">.*?</div></section>',
    re.S,
)

NOTICE_OLD = '<small>结果在「任务与结果」查看</small>'
NOTICE_NEW = '<small>顶栏运行入口可查看</small>'
HISTORY_OLD = '>查看历史结果<'
HISTORY_NEW = '>查看运行记录<'

ANCHORS = {
    'P-M03-HOME-PERSONAL': [
        ('<button class="home-context-link" data-go="P-M07-LIST"',
         '<button data-review-anchor="circle-entry" class="home-context-link" data-go="P-M07-LIST"'),
        ('<button class="section-link home-section-action" data-go="P-M03-ALL-APPS"',
         '<button data-review-anchor="all-apps-entry" class="section-link home-section-action" data-go="P-M03-ALL-APPS"'),
        ('<article class="product-card assistant-card">',
         '<article data-review-anchor="assistant-card" class="product-card assistant-card">'),
    ],
    'P-M03-HOME-ZERO': [
        ('<div class="home-zero-guide" style="margin-top:16px;">',
         '<div data-review-anchor="zero-guide" class="home-zero-guide" style="margin-top:16px;">'),
    ],
    'P-M03-MANAGE-HOME': [
        ('<div class="subpage-heading">',
         '<div data-review-anchor="manage-limit" class="subpage-heading">'),
    ],
    'P-M04-CLOSE-ACTIVE': [
        ('<div class="dialog ">', '<div data-review-anchor="close-dialog" class="dialog ">'),
    ],
    'P-M04-TERM-FAILED': [
        ('<div class="dialog ">', '<div data-review-anchor="term-failed-dialog" class="dialog ">'),
        ('<div class="tab active">', '<div data-review-anchor="kept-tab" class="tab active">'),
    ],
    'P-M04-BACKGROUND': [
        ('<button class="bar-button" id="runtime-button"',
         '<button data-review-anchor="runtime-pill" class="bar-button" id="runtime-button"'),
    ],
    'P-M07-LIST': [
        ('</button><div><p class="eyebrow">我的空间</p><h1>我的圈子</h1>',
         '</button><div data-review-anchor="circle-nav-title"><p class="eyebrow">我的空间</p><h1>我的圈子</h1>'),
    ],
    'P-M09-APP-BANNER': [
        ('<div class="credits-banner info" style="margin:0 0 14px;">',
         '<div data-review-anchor="container-banner" class="credits-banner info" style="margin:0 0 14px;">'),
    ],
    'P-M09-CHECKING': [
        ('<div class="dialog ">', '<div data-review-anchor="single-check-dialog" class="dialog ">'),
    ],
    'P-M10-MENU': [
        ('<div class="menu-section-title">管理入口</div>',
         '<div data-review-anchor="admin-section-title" class="menu-section-title">管理入口</div>'),
    ],
    'P-M10-MENU-NOPRIV': [
        ('<div class="popover account-menu" id="account-menu" role="menu">',
         '<div data-review-anchor="account-menu-nopriv" class="popover account-menu" id="account-menu" role="menu">'),
    ],
}

# ---------- manifest 标注 ----------

ANNOTATIONS = {
    'P-M03-HOME-PERSONAL': [
        {'id': 'a-m03-fixed-assistant', 'anchor': 'assistant-card', 'title': '固定 Polo 助手',
         'body': 'Polo 助手卡固定在首页、不占常用名额，也不随常用配置消失（D-PC-07 M03 收口；D-PC-01：首页不自动挑选 App）。'},
        {'id': 'a-m03-circle-entry', 'anchor': 'circle-entry', 'title': '我的圈子 · 个人空间导航',
         'body': '「我的圈子」放在个人空间稳定导航，与「全部 Apps」并列，不放进账号设置（D-PC-07 M07 收口）。当前 dev 未找到此入口，本轮新增页面。'},
        {'id': 'a-m03-all-apps', 'anchor': 'all-apps-entry', 'title': '稳定「全部 Apps」入口',
         'body': '常用 Apps 最多 5 个、由用户在「管理常用 Apps」主动配置；此入口稳定可用，零常用时由此进目录（D-PC-01；D-PC-07 M03 收口）。现状差异：dev 为自动记录最近 6 个（HomePage MAX_RECENT_APPS=6）。'},
    ],
    'P-M03-HOME-ZERO': [
        {'id': 'a-m03-zero-guide', 'anchor': 'zero-guide', 'title': '零常用只引导、不代选',
         'body': '零常用时只引导去「全部 Apps」，不自动替用户挑选或固定 App（D-PC-01）；Polo 助手仍固定可用。'},
    ],
    'P-M03-MANAGE-HOME': [
        {'id': 'a-m03-manage-limit', 'anchor': 'manage-limit', 'title': '上限 5 个 · 助手不占名额',
         'body': '上限 5 个在这里生效；Polo 助手固定、不占名额（D-PC-07 M03 收口）。现状差异：dev 自动记录最近 6 个且打开 App 即写入，本稿改为用户主动配置。'},
    ],
    'P-M04-CLOSE-ACTIVE': [
        {'id': 'a-m04-close-three', 'anchor': 'close-dialog', 'title': '关闭三选项',
         'body': '有活动时关闭提供「取消 / 后台继续 / 终止并关闭」；后台继续为普通操作，终止并关闭为危险操作（D-PC-07 M04 收口）。现状差异：当前 TabBar 关闭按钮直接 closeTab，无活动判断。'},
    ],
    'P-M04-TERM-FAILED': [
        {'id': 'a-m04-keep-tab', 'anchor': 'kept-tab', 'title': '终止失败 · 标签保留',
         'body': '终止失败时 App 标签保留并展示真实状态，可重试；不出现「看似关了、后台还在跑」（D-PC-07 M04 收口；C-R03）。'},
        {'id': 'a-m04-term-dialog', 'anchor': 'term-failed-dialog', 'title': '只重试失败项',
         'body': '终止失败只重试失败项或取消；取消不复活已停止任务，操作结果未知不写成成功。'},
    ],
    'P-M04-BACKGROUND': [
        {'id': 'a-m04-bg-pill', 'anchor': 'runtime-pill', 'title': '顶栏运行入口',
         'body': '后台继续后任务留在同空间后台；顶栏运行 pill 是查看 / 聚焦 / 终止的运行入口，不扩张成业务任务或结果中心（Spec §8 POO-56 调整结论）。'},
    ],
    'P-M07-LIST': [
        {'id': 'a-m07-nav', 'anchor': 'circle-nav-title', 'title': '个人空间稳定入口',
         'body': '「我的圈子」在个人空间稳定导航，与「全部 Apps」并列，不放进账号设置（D-PC-07 M07 收口）。当前 dev 未找到该页面，本轮新增；列表、详情、审批、浏览器交接、到期与退出沿已确认流程制作。'},
    ],
    'P-M09-APP-BANNER': [
        {'id': 'a-m09-banner', 'anchor': 'container-banner', 'title': '容器级积分提示',
         'body': 'Polo 容器级横幅让不同 App 获得一致反馈，不接管 App 自身界面（D-PC-07 M09 收口）。本例为额度提醒变体；阻断态见「发送前积分不足」与「生成中不足」。'},
    ],
    'P-M09-CHECKING': [
        {'id': 'a-m09-single-check', 'anchor': 'single-check-dialog', 'title': '主动单次查询',
         'body': '浏览器返回后只提供用户主动「查询最新状态」的一次动作；不自动查询、发送、续写或重试（D-PC-07 M09 收口；PC-N03）。会话与草稿保留，由用户决定下一步。'},
    ],
    'P-M10-MENU': [
        {'id': 'a-m10-admin-section', 'anchor': 'admin-section-title', 'title': '管理入口统一收口',
         'body': '企业管理、创作者工作台等管理入口统一放在账号菜单，按资格显示（D-PC-07 M10 收口）；空间选择器不承担管理入口。后台在浏览器独立登录，返回后重验资格。'},
    ],
    'P-M10-MENU-NOPRIV': [
        {'id': 'a-m10-nopriv', 'anchor': 'account-menu-nopriv', 'title': '无资格不显示',
         'body': '普通账号菜单只有账号与偏好、充值账单、退出；无资格时不显示管理入口而不是灰置（D-PC-07 M10 收口；PC-F09）。'},
    ],
}


def sha256(path):
    return hashlib.sha256(Path(path).read_bytes()).hexdigest()


def rebuild_surface():
    html = (BUNDLE / 'surface.html').read_text(encoding='utf-8')
    stats = {}
    stats['system_tools_removed'] = len(SYSTEM_TOOLS.findall(html))
    html = SYSTEM_TOOLS.sub('', html)

    # 按场景切分：删除/改写都限定在场景内进行，并记录实际变更的场景
    parts = re.split(r'(?=<section class="scene" data-prototype-scene=")', html)
    anchored = set()
    touched = set()
    for idx, part in enumerate(parts):
        match = re.match(r'<section class="scene" data-prototype-scene="([A-Z0-9-]+)"', part)
        if not match:
            # 头部（doctype/head）不含产品文案变更
            parts[idx] = part
            continue
        sid = match.group(1)
        scene_changed = False

        n_tools = len(SYSTEM_TOOLS.findall(part))
        if n_tools:
            part = SYSTEM_TOOLS.sub('', part)
            scene_changed = True
        stats.setdefault('system_tools_removed', 0)
        stats['system_tools_removed'] += n_tools

        n_notice = part.count(NOTICE_OLD)
        if n_notice:
            part = part.replace(NOTICE_OLD, NOTICE_NEW)
            scene_changed = True
        stats.setdefault('notice_rewritten', 0)
        stats['notice_rewritten'] += n_notice

        n_history = part.count(HISTORY_OLD)
        if n_history:
            part = part.replace(HISTORY_OLD, HISTORY_NEW)
            scene_changed = True
        stats.setdefault('history_relabeled', 0)
        stats['history_relabeled'] += n_history

        for old, new in ANCHORS.get(sid, []):
            if old in part:
                part = part.replace(old, new, 1)
                anchored.add(sid)
                scene_changed = True
            else:
                print(f'WARN anchor target not found: {sid}: {old[:60]}', file=sys.stderr)

        if scene_changed:
            touched.add(sid)
        parts[idx] = part

    html = ''.join(parts)
    stats['anchored_scenes'] = sorted(anchored)
    stats['touched_scenes'] = sorted(touched)
    missing = sorted(set(ANCHORS) - anchored)
    if missing:
        raise SystemExit(f'anchor injection failed for: {missing}')
    (BUNDLE / 'surface.html').write_text(html, encoding='utf-8')
    return stats


def rebuild_manifest(surface_stats):
    manifest_path = BUNDLE / 'prototype-manifest.json'
    manifest = json.loads(manifest_path.read_text(encoding='utf-8'))
    changed = set(surface_stats['touched_scenes'])

    drop_prefixes = ('文件查看最近文件', '任务与结果查看执行与结果')
    removed_edges = 0
    for scene in manifest['scenes']:
        kept = []
        for edge in scene['transitions']:
            if edge['label'].startswith(drop_prefixes):
                removed_edges += 1
                changed.add(scene['id'])
                continue
            if edge['label'] == '数据报表生成器已在后台完成结果在「任务与结果」查看':
                edge['label'] = '数据报表生成器已在后台完成 · 顶栏运行入口可查看'
                changed.add(scene['id'])
            elif edge['label'] == '查看历史结果':
                edge['label'] = '查看运行记录'
                changed.add(scene['id'])
            if '结果在「任务与结果」查看' in edge['feedback']:
                edge['feedback'] = edge['feedback'].replace('结果在「任务与结果」查看', '顶栏运行入口可查看')
                changed.add(scene['id'])
            kept.append(edge)
        scene['transitions'] = kept
        if scene['id'] in ANNOTATIONS:
            scene['annotations'] = ANNOTATIONS[scene['id']]

    for story in manifest['stories']:
        for step in story['steps']:
            if step['description'] == '使用后的个人首页：常用 Apps 与系统工具':
                step['description'] = '使用后的个人首页：Polo 助手固定 + 用户配置的常用 Apps'

    # sources：新增 D-PC-07 快照与原文
    snapshot_rel = 'docs/mvp-complete-flow-hifi/sources/dpc07-review-snapshot.json'
    decision_rel = 'docs/mvp-complete-flow-hifi/sources/user-decision-r8.md'
    sources = [s for s in manifest['sources'] if s['id'] not in {'dpc07-decision', 'dpc07-source'}]
    sources.append({'id': 'dpc07-decision', 'label': 'D-PC-07 视觉与管理入口收口（评审快照）',
                    'revision': 'user-decision-r8（2026-09-16）', 'path': snapshot_rel,
                    'sha256': sha256(ROOT / snapshot_rel)})
    sources.append({'id': 'dpc07-source', 'label': 'D-PC-07 确认原话与边界（user-decision-r8）',
                    'revision': 'user-decision-r8（2026-09-16）', 'path': decision_rel,
                    'sha256': sha256(ROOT / decision_rel)})
    manifest['sources'] = sources

    # review brief（内容必须与快照 JSON 完全一致）
    review = json.loads((BUNDLE / 'sources' / 'dpc07-review-snapshot.json').read_text(encoding='utf-8'))
    review['source'] = 'dpc07-decision'
    manifest['review'] = review

    # design Skill 绑定：当前仓库落地的提取式 Skill
    skill_rel = '.agents/skills/polo-ai-design-system/SKILL.md'
    design = manifest['design']
    design['skill_path'] = skill_rel
    design['sha256'] = sha256(ROOT / skill_rel)
    design['revision'] = 'poo70-dpc07-adopt-1（2026-09-17，POO-70 worktree 落地 G4 提取式 Skill，权威仍为 POO-41 冻结稿）'

    # revision / change / summary
    manifest['revision'] = REVISION
    manifest['change'] = {
        'previous_revision': PREVIOUS,
        'changed_scenes': sorted(changed),
        'removed_scenes': [],
        'summary': (
            '按 D-PC-07 收口重建评审材料：修复设计 Skill 断链（收敛提交移除了 .agents/skills，验证 fail closed）；'
            '绑定 D-PC-07 评审快照并为 11 个收口场景添加锚定标注；移除首页「系统工具」区（文件/任务与结果入口违反 '
            'D-PC-03 与 Spec §8 POO-56/57 调整结论，共 27 处）；后台完成通知不再指向「任务与结果」（D-PC-02）；'
            '「查看历史结果」更名「查看运行记录」（App 业务历史归 App，Polo 只提供运行记录）；'
            'prototype.html 与 surface 运行时按 product-ui-prototype 官方模板契约重建。'
        ),
    }
    manifest['summary'] = [
        '把 POO-70 已确认的 90 屏 MVP 完整流程按 product-ui-prototype v2 官方模板契约重建：surface.html 纯产品表面（官方运行时协议）+ prototype.html 官方评审壳（面板四标签、锚定标注、深链、故事自动同步）。',
        '视觉令牌与组件绑定仓库设计 Skill polo-ai-design-system（authority = G4 冻结稿 product.css，POO-41 artifactCommit ef3528ef；Skill 已在 POO-70 worktree 落地）。',
        'D-PC-07 五项收口（首页组合、关闭三选项、圈子入口、容器级积分提示、账号菜单管理入口）以锚定标注呈现待核对；评审 brief 绑定 user-decision-r8 快照。',
        '移除违反已确认结论的旧残留：首页「系统工具」文件/任务与结果入口、通知的「结果在任务与结果查看」、「查看历史结果」更名；App 内部为中性 FDE 占位，浏览器端只画交接卡。',
        '目标视口 1440×900 与 1024×768；本阶段只做 light 主题视觉验收（D-THEME-LIGHT）。',
    ]
    manifest['checks'] = {'offline': True, 'concept_label': True, 'review_separated': True}

    manifest_path.write_text(json.dumps(manifest, ensure_ascii=False, indent=1) + '\n', encoding='utf-8')
    return {
        'removed_edges': removed_edges,
        'changed_scene_count': len(changed),
        'total_transitions': sum(len(s['transitions']) for s in manifest['scenes']),
    }


def main():
    surface_stats = rebuild_surface()
    manifest_stats = rebuild_manifest(surface_stats)
    print('surface:', json.dumps({k: v for k, v in surface_stats.items()
                                  if k not in ('anchored_scenes', 'touched_scenes')}, ensure_ascii=False))
    print('anchored:', len(surface_stats['anchored_scenes']), 'scenes')
    print('touched:', len(surface_stats['touched_scenes']), 'scenes')
    print('manifest:', json.dumps(manifest_stats, ensure_ascii=False))


if __name__ == '__main__':
    main()
