#!/usr/bin/env python3
"""POO-71 v2 重建 · 第 3 步：生成 prototype-manifest.json（v2 契约）。

场景表来自 build/scenes.json（静态边表）与 build/v1-meta.json（v1 屏元数据）；
结论绑定为 POO-70 已确认条目（D-PC / PC-F / PC-N / C-R / J-PC / M01—M11）；
设计绑定为仓库 .agents/skills/polo-ai-design-system（G4 冻结稿为 authority）。
"""
import hashlib
import json
from pathlib import Path

BUNDLE = Path(__file__).resolve().parents[1]
ROOT = BUNDLE.parent.parent          # 仓库根（worktree 根）
OUT = BUNDLE / 'prototype-manifest.json'

REVISION = 'poo71-hifi-v2-1'
PREVIOUS_REVISION = 'poo71-hifi-v1-single-file'
POO70_REV = 'poo70 已确认结论快照（2026-09，sources/poo70-spec.md）'

JOURNEYS = {
    'M01': 'J1 登录与空间承接', 'M02': 'J2 空间切换', 'M03': 'J3 首页与目录',
    'M04': 'J4 App 执行与运行', 'M05': 'J5 助手会话', 'M06': 'J6 Skills 与数据源',
    'M07': 'J7 圈子加入与订阅', 'M08': 'J8 会话文件', 'M09': 'J9 积分与恢复',
    'M10': 'J10 账号与设置', 'M11': 'J11 异常与恢复',
}

# 复用/状态/跨端屏是 POO-70 已走查内容 → confirmed；新增/集成候选/调整 → suggested
STATUS_BY_CLS = {'reuse': 'confirmed', 'state': 'confirmed', 'cross': 'confirmed',
                 'adjust': 'suggested', 'new': 'suggested', 'integ': 'suggested'}
STATUS_OVERRIDE = {'P-M03-HOME-ENT': 'decision'}

SOURCES = [
    ('poo70-spec', 'POO-70 需求 Spec（已确认结论 D-PC/PC-F/PC-N/C-R/J-PC）', POO70_REV,
     'docs/mvp-complete-flow-hifi/sources/poo70-spec.md'),
    ('poo70-module-review', 'POO-70 模块评审（M01—M11 当前源码与差异）', POO70_REV,
     'docs/mvp-complete-flow-hifi/sources/poo70-module-review.md'),
    ('poo70-delta-review', 'POO-70 实现差异评审（集成候选 C-INT）', POO70_REV,
     'docs/mvp-complete-flow-hifi/sources/poo70-implementation-delta-review.md'),
    ('prototype-v1', 'v1 单文件原型快照（本轮重建的输入与基线）', PREVIOUS_REVISION,
     'docs/mvp-complete-flow-hifi/sources/prototype-v1.html'),
    ('prototype-v1-manifest', 'v1 原型 manifest 快照（自定义格式，无 revision）', PREVIOUS_REVISION,
     'docs/mvp-complete-flow-hifi/sources/prototype-v1-manifest.json'),
    ('g4-product-css', 'G4 冻结稿 product.css（POO-41 artifactCommit ef3528ef · 2026-08-11 产品确认）',
     'poo41-g4-freeze（2026-08-11）', 'docs/mvp-complete-flow-hifi/sources/g4-product.css'),
    ('g4-review-record', 'G4 冻结范围与验收记录（PC-F01—F11 整端 UI v1）', 'poo41-g4-freeze（2026-08-11）',
     'docs/mvp-complete-flow-hifi/sources/g4-review-record.md'),
    ('renderer-index-css', '当前发布客户端渲染层样式（「当前已有」视觉证据）', 'dev 01f4447c',
     'apps/electron/src/renderer/index.css'),
]

DESIGN_SOURCES = [
    ('docs/mvp-complete-flow-hifi/sources/g4-product.css', 'authority'),
    ('docs/mvp-complete-flow-hifi/sources/g4-review-record.md', 'authority'),
    ('docs/DESIGN.md', 'implementation'),
    ('apps/electron/src/renderer/index.css', 'implementation'),
]


def sha256(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def build_sources():
    out = []
    for sid, label, revision, rel in SOURCES:
        out.append({'id': sid, 'label': label, 'revision': revision, 'path': rel,
                    'sha256': sha256(ROOT / rel)})
    return out


def build_design():
    skill = ROOT / '.agents' / 'skills' / 'polo-ai-design-system' / 'SKILL.md'
    return {
        'skill_path': '.agents/skills/polo-ai-design-system/SKILL.md',
        'sha256': sha256(skill),
        'revision': 'poo71-adopt-1（2026-09-16，随 POO-71 高保真重建建立）',
        'sources': [{'path': rel, 'sha256': sha256(ROOT / rel)} for rel, _ in DESIGN_SOURCES],
    }


def build_confirmations():
    c = []

    def add(cid, scope, status='confirmed', source_revision=POO70_REV):
        c.append({'id': cid, 'status': status, 'scope': scope, 'source_revision': source_revision})

    add('D-PC-01', '保留首页；零常用时引导「全部 Apps」，不自动挑选或固定 App')
    add('D-PC-02', 'App 自己负责业务内容、保存、历史与找回；Polo 提供容器、授权列表与打开能力')
    add('D-PC-03', '独立「文件」汇总页延后；助手附件与生成文件留在原对话内')
    add('D-PC-04', '集中审阅文档所呈现的全部模块、流程与变更范围及其对应 Spec 条款已由需求提出者确认')
    add('D-PC-05', 'App 容器边界与剩余视觉范围：App 打开后占满主内容工作区，容器外不加 App 内部 chrome')
    add('D-PC-06', '助手流程与现有三栏框架直接复用，不为概念线框重画')
    add('D-PC-07', '视觉与管理入口收口（顶栏品牌 / 标签 / 运行 / 空间 / 通知 / 账号）')
    add('PC-F01', '首次进入与有效会话恢复：登录 → 唯一个人空间；零常用引导全部 Apps；准备幂等不建第二个空间')
    add('PC-F02', '个人 App 找到、启动、使用：权限确认 → 透明准备 → App Tab；运行固定启动版本，更新下次启动生效')
    add('PC-F03', '加入、付费、续费、退出圈子：完全手动续费，无自动续费/宽限期；不建公开市场')
    add('PC-F04', '启用 Skill 与助手使用：授权 ≠ 本人启用 ≠ 设备准备，三态分别验证；启用在助手内')
    add('PC-F05', '邀请/创建企业后进入桌面：浏览器端完成创建且幂等；是否进入由用户在桌面端决定；刷新不强切')
    add('PC-F06', '安全切换与取消：全部终止后才提交切换；取消前无变化；部分已终止不自动复活')
    add('PC-F07', '企业 App/Skill/助手消费：企业目录与实例；个人圈子不能补企业授权；助手须通过企业授权')
    add('PC-F08', '被移除、作品阻断、企业受限：容器即时收回操作权与空间隔离；App 内保存/历史仍归 App')
    add('PC-F09', '账号偏好、管理与账单入口：无资格不显示可写管理；账单/复杂责任留 Browser 端')
    add('PC-F10', '离线、断网、重开恢复：离线阻止新启动；恢复先重验；不重发旧 Prompt、不猜测运行结果')
    add('PC-F11', '契约不一致升级：ContractGate 阻断业务；取消/升级失败仍阻断；不把旧缓存解释为新空间')
    add('PC-N01', '零常用 / 真空目录 / 加载失败三类态分别展示，不混淆')
    add('PC-N02', '从授权列表重开 App，内容归 App；Polo 不插入保存/结果判断步骤')
    add('PC-N03', '积分阻断：发送前不建消息、生成中保留部分输出；充值走浏览器，人工恢复，不自动续跑')
    add('PC-N04', '助手等待用户回答可跨重开恢复；回答一次只形成一条消息，暂不回答不续答')
    add('C-R01', '会话/账号失效：重新登录并重验原目标权限后才恢复；不自动执行原动作；退出不删业务数据')
    add('C-R02', '空/失败：加载中、真实零条、网络失败、权限受限分别展示；失败不用他处缓存填充')
    add('C-R03', '上下文：目录、会话、Skills、运行、计量使用同一已提交空间；缓存不成为授权依据')
    add('C-R04', '取消/中断：未提交可取消留原入口；已完成的终止不被回滚；操作结果未知不得写成成功')
    add('C-R05', '重新打开：先恢复身份、空间并重验权限/契约，再显示目录与会话数据')
    add('C-R06', '桌面权限：主动触发时请求；拒绝留原页面；撤销后下次实际调用重新校验')
    add('C-R07', '数据转移：切空间不搬数据；只转 allowlist 内容，不转凭证与隐藏上下文')
    add('C-R08', 'Browser 返回：只代表该端事实；桌面需同账号验证与自身刷新；未安装给下载指引')
    add('J-PC-01', '走查：首次登录 → 个人空间 → 目录 → 打开/重开 App（含零常用与真空目录）')
    add('J-PC-02', '走查：空间切换确认 → 逐项终止 → 失败/取消 → 目标空间进入')
    add('J-PC-03', '走查：积分阻断 → 浏览器充值 → 查询到账 → 恢复生成；每次点击一次查询且不重发')
    add('J-PC-04', '走查：助手列表 → Skill 启用三态 → 会话与追问 → 原对话文件')
    add('J-PC-05', '走查：圈子邀请/审批/付费/到期/退出的进入与恢复路径')
    add('J-PC-06', '走查：异常与恢复（离线、重开、ContractGate、账号受限）')
    add('J-PC-07', '走查：App 关闭三选项（取消/后台/终止）与终止失败恢复；后台活动不跨空间残留')
    add('M01', 'M01 登录与空间承接模块结论：邀请/无邀请/创建企业/常见失败的进入路径与恢复（POO-70 模块评审）')
    add('M02', 'M02 空间切换模块结论：无运行直切、有运行先终止、失败与取消恢复（POO-70 模块评审）')
    add('M03', 'M03 首页与全部 Apps 模块结论：常用区、来源行、三类空/错态（POO-70 模块评审）')
    add('M04', 'M04 App 容器模块结论：准备/更新/错误、权限拒绝、关闭三选项、运行状态中心（POO-70 模块评审）')
    add('M05', 'M05 助手会话模块结论：三栏骨架、停止/中断保留、追问与重开恢复（POO-70 模块评审）')
    add('M06', 'M06 技能与数据源模块结论：启用三态、同名来源区分、无授权路径（POO-70 模块评审）')
    add('M07', 'M07 我的圈子模块结论：列表/详情/加入/续费/到期/退出（POO-70 模块评审）')
    add('M08', 'M08 会话文件模块结论：附件与生成文件留在会话内，缺失给重选路径（POO-70 模块评审）')
    add('M09', 'M09 积分不足模块结论：发送前/生成中两态、浏览器充值与人工恢复（POO-70 模块评审）')
    add('M10', 'M10 账号菜单与设置模块结论：偏好、资格入口、外观设置（POO-70 模块评审）')
    add('M11', 'M11 异常与恢复模块结论：离线目录、会话过期、空间错误、ContractGate、版本阻断（POO-70 模块评审）')
    return c


STORIES = [
    {
        'id': 'S1', 'title': '故事一 · 登录准备与企业 App 执行',
        'description': '新用户登录进入个人空间（零常用引导）→ 切入企业空间 → 更新并打开 App → 追踪运行 → 助手会话 → 会话文件。',
        'steps': [
            ('S1-01', 'P-M01-LOGIN-PASSWORD', '账号密码登录：输入凭据，继续'),
            ('S1-02', 'P-M01-PERSONAL-PREP', '首次登录自动准备「我的空间」，幂等不建第二个'),
            ('S1-03', 'P-M03-HOME-ZERO', '零常用首页：引导去「全部 Apps」，不自动固定 App（PC-N01）'),
            ('S1-04', 'P-M03-ALL-APPS', '全部 Apps：目录、来源行与企业/个人分区'),
            ('S1-05', 'P-M03-HOME-PERSONAL', '使用后的个人首页：常用 Apps 与系统工具'),
            ('S1-06', 'P-M03-HOME-ENT', '切入企业空间首页（晨星科技）：企业目录与常用区'),
            ('S1-07', 'P-M04-PREPARE', '打开有更新的 App：透明准备（下载/校验），可取消'),
            ('S1-08', 'P-M04-APP-VIEW', 'App 容器占满工作区，内部界面为中性 FDE 占位（D-PC-05）'),
            ('S1-09', 'P-M04-RUNTIME', '顶栏运行状态中心：逐项查看运行中 App 与助手'),
            ('S1-10', 'P-M05-CHAT', '从运行项进入助手会话：生成中可停止'),
            ('S1-11', 'P-M08-FILES', '会话文件：附件与生成文件留在原对话内（D-PC-03）'),
        ],
    },
    {
        'id': 'S2', 'title': '故事二 · 空间切换、失败与重开恢复',
        'description': '企业空间发起切换 → 逐项终止运行 → 部分终止失败与取消 → 会话过期重开 → 恢复现场 → 关闭 App 三选项。',
        'steps': [
            ('S2-01', 'P-M03-HOME-ENT', '企业空间首页：发起空间切换'),
            ('S2-02', 'P-M04-RUNTIME', '先查看运行状态：3 项运行中'),
            ('S2-03', 'P-M02-SWITCHER', '空间切换器：选择「我的空间」（C-R03 同一已提交空间）'),
            ('S2-04', 'P-M02-CONFIRM', '切换确认：列出须终止的运行项，逐项可取消'),
            ('S2-05', 'P-M02-STOPPING', '逐项终止进行中：进度与幂等说明'),
            ('S2-06', 'P-M02-STOP-FAILED', '部分终止失败：已终止项不自动恢复，可重试'),
            ('S2-07', 'P-M02-STOP-CANCEL', '取消切换：留在企业空间，无半切状态（C-R04）'),
            ('S2-08', 'P-M03-HOME-ENT', '回到企业首页：分支 · 重开客户端且会话过期'),
            ('S2-09', 'P-M01-REOPEN', '会话过期：重新登录承接，不自动执行原动作（C-R01）'),
            ('S2-10', 'P-M11-REOPEN-RECOVERY', '重开恢复：先重验身份与空间，再恢复标签与运行状态（C-R05）'),
            ('S2-11', 'P-M03-HOME-ENT', '恢复后回到企业首页'),
            ('S2-12', 'P-M04-APP-VIEW', '重新打开 App 容器'),
            ('S2-13', 'P-M04-CLOSE-ACTIVE', '关闭运行中 App：取消 / 后台 / 终止三选项（J-PC-07）'),
            ('S2-14', 'P-M04-BACKGROUND', '转入后台：标签保留运行点，顶栏可随时回'),
        ],
    },
    {
        'id': 'S3', 'title': '故事三 · 积分不足、充值与恢复',
        'description': '生成中积分耗尽 → 保留部分输出 → 浏览器充值 → 查询未到账 → 到账后人工恢复，不自动续跑（PC-N03）。',
        'steps': [
            ('S3-01', 'P-M05-CHAT', '助手会话生成中：可随时停止'),
            ('S3-02', 'P-M09-STREAM-CUT', '积分耗尽：生成暂停，已生成部分如实保留并标注'),
            ('S3-03', 'P-M09-BROWSER', '浏览器端充值交接卡：桌面端不复制支付后台（C-R08）'),
            ('S3-04', 'P-M09-CHECKING', '回到桌面查询到账状态：每次点击一次查询'),
            ('S3-05', 'P-M09-NOT-YET', '尚未到账：如实提示，可稍后再查，不猜测成功'),
            ('S3-06', 'P-M09-RESUMED', '已到账：由用户决定是否继续，输入内容保留'),
            ('S3-07', 'P-M05-CHAT', '继续会话：基于保留的部分输出继续生成'),
        ],
    },
]


def build_stories():
    return [{'id': s['id'], 'title': s['title'], 'description': s['description'],
             'steps': [{'id': stid, 'scene': scene, 'description': text} for stid, scene, text in s['steps']]}
            for s in STORIES]


def main():
    meta = json.loads((BUNDLE / 'build' / 'v1-meta.json').read_text(encoding='utf-8'))
    data = json.loads((BUNDLE / 'build' / 'scenes.json').read_text(encoding='utf-8'))
    screens, scenes_html = meta['screens'], data['scenes']
    titles = {sid: s['t'] for sid, s in screens.items()}

    scene_ids = list(screens)
    scenes = []
    for sid in scene_ids:
        s = screens[sid]
        html = scenes_html[sid]['html']
        note = s['note']
        if 'scenario-jump' in html:
            note += '「分支：」虚线按钮是评审分支入口（无自然产品入口的失败/取消路径），非产品按钮。'
        transitions = []
        for e in scenes_html[sid]['edges']:
            label = e['label'] or '查看'
            if e['to'] == sid:
                feedback = f'「{label}」停留在本页（{titles[sid]}）'
            elif label.startswith('分支：'):
                feedback = f'进入分支场景「{titles.get(e["to"], e["to"])}」'
            else:
                feedback = f'切换到「{titles.get(e["to"], e["to"])}」'
            transitions.append({'id': e['id'], 'label': label, 'to': e['to'], 'feedback': feedback})
        scenes.append({
            'id': sid,
            'journey': JOURNEYS[s['m']],
            'node': sid,
            'state': 'default',
            'title': s['t'],
            'status': STATUS_OVERRIDE.get(sid, STATUS_BY_CLS[s['cls']]),
            'module': s['m'],
            'category': meta['clsLabels'][s['cls']],
            'annotation': note,
            'transitions': transitions,
        })

    manifest = {
        'schema_version': 2,
        'title': 'Polo 桌面客户端 · MVP 完整流程高保真原型',
        'revision': REVISION,
        'mode': 'high_fidelity',
        'files': {'review': 'prototype.html', 'surface': 'surface.html'},
        'sources': build_sources(),
        'flow': None,
        'design': build_design(),
        'target': {
            'themes': ['light'],
            'languages': ['zh-CN'],
            'viewports': [
                {'id': 'desktop-1440x900', 'width': 1440, 'height': 900},
                {'id': 'desktop-1024x768', 'width': 1024, 'height': 768},
            ],
        },
        'summary': [
            '把 POO-70 已确认的 90 屏 MVP 完整流程从 v1 单文件原型重建为 product-ui-prototype v2 契约：surface.html 纯产品表面 + prototype.html 评审壳。',
            '视觉令牌与组件绑定仓库设计 Skill polo-ai-design-system（authority = G4 冻结稿 product.css，POO-41 artifactCommit ef3528ef）。',
            '90 屏 / 1429 条 transitions 全部静态声明；三条代表故事可仅靠产品按钮走通，失败/取消/中断分支用「分支：」虚线入口补齐可达性。',
            '覆盖成功、失败、取消/中断、会话过期、客户端重开、跨端返回；App 内部为中性 FDE 占位，浏览器端只画交接卡。',
            '目标视口 1440×900 与 1024×768；本阶段只做 light 主题视觉验收（D-THEME-LIGHT）。',
        ],
        'modules': [{'id': mid, 'title': meta['moduleTitles'][mid]} for mid in sorted(meta['moduleTitles'])],
        'start_scene': 'P-M01-INVITE-BROWSER',
        'scenes': scenes,
        'stories': build_stories(),
        'confirmations': build_confirmations(),
        'change': {
            'previous_revision': PREVIOUS_REVISION,
            'changed_scenes': scene_ids,
            'removed_scenes': [],
            'summary': 'v1 单文件原型（JS 构建器 + 演示控制区）整体重建为 v2 双文件契约：90 屏全部静态化，交互重声明为 1429 条 transitions，并移除全部演示 chrome 与网络回传。',
        },
        'checks': {'offline': True, 'concept_label': True, 'review_separated': True},
    }
    OUT.write_text(json.dumps(manifest, ensure_ascii=False, indent=1) + '\n', encoding='utf-8')
    print(f'manifest: {len(scenes)} scenes, '
          f'{sum(len(s["transitions"]) for s in scenes)} transitions, '
          f'{len(manifest["confirmations"])} confirmations -> {OUT}')


if __name__ == '__main__':
    main()
