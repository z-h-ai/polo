#!/usr/bin/env python3
"""POO-71 v2 重建 · 第 1 步：从 v1 单文件原型提取 90 屏静态场景 HTML。

用 Playwright 加载 v1 原型，逐屏驱动其构建器渲染，把「顶栏 chrome + 主内容 +
模态 + toast」落成静态 DOM，并完成三类改造：
  1. 评审 chrome 剥离（界面示意条、演示控制区不在产品表面）；
  2. 交互重接线（弹层触发钮、data-close-modal、自环按钮、分支入口）；
  3. 为每个 [data-go] 分配 bundle 唯一的 data-transition，产出边表。

输出 build/scenes.json：{scenes: {id: {html, edges}}, screens: v1 元数据}。
"""
import json
import sys
from pathlib import Path

from playwright.sync_api import sync_playwright

BUNDLE = Path(__file__).resolve().parents[1]
V1 = BUNDLE / 'sources' / 'prototype-v1.html'
OUT = BUNDLE / 'build' / 'scenes.json'

# ---------------------------------------------------------------- 配置表 ----
# base：该屏模态的「关闭/取消」落点（v1 用 data-close-modal，v2 必须是显式场景边）
BASE = {
    'P-M03-INSPECTOR': 'P-M03-HOME-PERSONAL',
    'P-M04-PERM-DENIED': 'P-M03-HOME-ENT',
    'P-M06-SKILL-DENIED': 'P-M06-SKILLS',
    'P-M07-JOIN-FREE': 'P-M07-LIST',
    'P-M07-JOIN-PENDING': 'P-M07-LIST',
    'P-M07-RENEW': 'P-M07-DETAIL-PAID',
    'P-M07-LEAVE': 'P-M07-DETAIL-FOCUS',
}

# 顶栏弹层触发钮的落点：space / account / runtime / notification
DEFAULT_POP = {'space': 'P-M02-SWITCHER', 'account': 'P-M10-MENU',
               'runtime': 'P-M04-RUNTIME', 'notification': 'P-M04-RUNTIME'}
POP_OVERRIDE = {
    'P-M02-SWITCHER': {'space': 'P-M03-HOME-ENT'},
    'P-M10-MENU': {'account': 'P-M03-HOME-PERSONAL'},
    'P-M10-MENU-NOPRIV': {'account': 'P-M03-HOME-PERSONAL'},
    'P-M04-RUNTIME': {'runtime': 'P-M03-HOME-ENT', 'notification': None},
}

# 既有按钮重接线：go=原目标 nth=第几处（0 起）to=新目标（None=移除动作）label=改文案
REWIRES = {
    'P-M01-LOGIN-PHONE': [{'go': 'P-M01-PERSONAL-PREP', 'to': 'P-M01-LOGIN-CODE'}],
    'P-M01-REOPEN': [{'go': 'P-M01-PERSONAL-PREP', 'to': 'P-M11-REOPEN-RECOVERY'}],
    'P-M02-SWITCHER': [{'go': 'P-M02-CONFIRM', 'nth': 1, 'to': None}],
    'P-M02-STOPPING': [{'go': 'P-M02-STOP-FAILED', 'to': 'P-M02-STOP-CANCEL'}],
    'P-M02-STOP-CANCEL': [{'go': 'P-M04-BACKGROUND', 'to': 'P-M03-HOME-ENT'}],
    'P-M03-CONTROLS': [{'go': 'P-M03-CONTROLS', 'to': 'P-M03-MANAGE-HOME'}],
    'P-M03-HOME-ENT': [{'go': 'P-M04-APP-VIEW', 'nth': 1, 'to': 'P-M04-PREPARE', 'label': '更新并打开'}],
    'P-M04-CLOSE-ACTIVE': [{'go': 'P-M04-TERM-FAILED', 'to': 'P-M03-HOME-ENT'}],
    'P-M04-TERM-FAILED': [{'go': 'P-M04-BACKGROUND', 'to': 'P-M03-HOME-ENT'}],
    'P-M04-RUNTIME': [
        {'go': 'P-M04-CLOSE-ACTIVE', 'nth': 1, 'to': 'P-M05-CHAT'},
        {'go': 'P-M04-CLOSE-ACTIVE', 'nth': 2, 'to': 'P-M09-APP-BANNER'},
    ],
    'P-M04-PREPARE': [{'go': 'P-M04-PREP-FAILED', 'label': '分支：下载失败'}],
    'P-M11-CONTRACT-DL': [{'go': 'P-M11-CONTRACT-FAIL', 'label': '分支：下载未完成'}],
    # v1 两个快捷键均自环 P-M05-QUESTION；v2 语义：回答/暂不都推进会话流（回答后由
    # composer 提交、暂不按默认口径继续），静态原型统一落到会话主屏
    'P-M05-QUESTION': [
        {'go': 'P-M05-QUESTION', 'nth': 0, 'to': 'P-M05-CHAT'},
        {'go': 'P-M05-QUESTION', 'nth': 1, 'to': 'P-M05-CHAT'},
    ],
    'P-M05-QUESTION-REOPEN': [
        {'go': 'P-M05-QUESTION', 'nth': 0, 'to': 'P-M05-CHAT'},
        {'go': 'P-M05-QUESTION', 'nth': 1, 'to': 'P-M05-CHAT'},
    ],
    'P-M08-FILE-MISSING': [{'go': 'P-M08-FILE-MISSING', 'to': 'P-M08-FILES'}],
    'P-M11-OFFLINE-RUNNING': [{'go': 'P-M11-OFFLINE-RUNNING', 'to': 'P-M04-APP-VIEW'}],
}

# 新增按钮：sel=容器选择器 mode=插入位 items=分支/续接按钮
def chip(to, label, plain=False):
    return {'to': to, 'label': label, 'plain': plain}

ADDITIONS = {
    'P-M02-STOPPING': [{'sel': '.dialog-footer', 'items': [
        chip('P-M02-TARGET-LOADING', '全部终止，继续切换', plain=True),
        chip('P-M02-STOP-FAILED', '分支：部分终止失败')]}],
    'P-M02-TARGET-LOADING': [{'sel': '.dialog-footer', 'items': [
        chip('P-M03-HOME-PERSONAL', '加载完成，进入我的空间', plain=True),
        chip('P-M02-TARGET-FAILED', '分支：目标空间加载失败')]}],
    'P-M01-LOGIN-PASSWORD': [{'sel': '.login-panel', 'items': [
        chip('P-M01-LOGIN-CANCEL', '分支：取消登录')]}],
    'P-M01-LOGIN-CODE': [{'sel': '.login-panel', 'items': [
        chip('P-M01-COLD-START', '分支：非首次登录 · 冷启动重验')]}],
    'P-M01-PERSONAL-PREP': [{'sel': '.state-actions', 'items': [
        chip('P-M01-PERSONAL-PREP-FAIL', '分支：准备失败')]}],
    'P-M01-CREATE-ENT': [{'sel': '.state-actions', 'items': [
        chip('P-M01-INVITE-MISMATCH', '分支：受邀账号不匹配'),
        chip('P-M01-INVITE-PENDING', '分支：共享邀请待审批')]}],
    'P-M01-COLD-START': [{'sel': '.state-actions', 'items': [
        chip('P-M01-NOT-INSTALLED', '分支：本机未安装'),
        chip('P-M11-PERSONAL-RESTRICTED', '分支：账号受限'),
        chip('P-M01-CREATE-ENT', '分支：受邀账号尚无企业'),
        chip('P-M11-SPACE-ERROR', '分支：空间列表加载失败')]}],
    'P-M02-SWITCHER': [{'sel': '.popover.space-menu:not([hidden])', 'items': [
        chip('P-M02-ACCESS-LOST', '分支：目标空间已无权访问')]}],
    'P-M03-HOME-PERSONAL': [{'sel': '.workspace-main', 'items': [
        chip('P-M03-HOME-LOAD-FAIL', '分支：目录加载失败'),
        chip('P-M03-HOME-OFFLINE', '分支：离线缓存目录'),
        chip('P-M01-REOPEN', '分支：重开客户端 · 会话过期')]}],
    'P-M03-HOME-ZERO': [{'sel': '.workspace-main', 'items': [
        chip('P-M03-HOME-EMPTY-DIR', '分支：真空目录')]}],
    'P-M03-HOME-ENT': [{'sel': '.workspace-main', 'items': [
        chip('P-M11-CONTRACT', '分支：需要升级 Polo'),
        chip('P-M01-REOPEN', '分支：重开客户端 · 会话过期')]}],
    'P-M03-ALL-APPS': [{'sel': '.workspace-main', 'items': [
        chip('P-M03-ALL-APPS-ENT-EMPTY', '分支：企业目录为空')]}],
    'P-M04-APP-VIEW': [{'sel': '.app-actions', 'items': [
        chip('P-M04-PERM-DENIED', '分支：OS 权限被拒'),
        chip('P-M11-BLOCKED-WITHDRAWN', '分支：分发被撤下'),
        chip('P-M11-BLOCKED-VERSION', '分支：版本紧急阻断'),
        chip('P-M11-OFFLINE-RUNNING', '分支：运行中断网')]}],
    'P-M04-CLOSE-ACTIVE': [{'sel': '.dialog-footer', 'items': [
        chip('P-M04-TERM-FAILED', '分支：终止失败')]}],
    'P-M04-RUNTIME': [{'sel': '.popover.runtime-popover:not([hidden])', 'items': [
        chip('P-M11-REVOKE', '分支：运行中被移除')]}],
    'P-M05-CHAT': [{'sel': '.message-list', 'items': [
        chip('P-M05-QUESTION', '分支：助手追问'),
        chip('P-M09-USER-STOP', '分支：用户主动停止'),
        chip('P-M09-STREAM-CUT', '分支：生成中积分耗尽'),
        chip('P-M09-PRE-BLOCK', '分支：发送前积分不足')]}],
    'P-M08-FILES': [{'sel': '.workspace-main', 'items': [
        chip('P-M08-FILE-MISSING', '分支：文件缺失')]}],
    'P-M07-LIST': [{'sel': '.workspace-main', 'items': [
        chip('P-M07-EMPTY', '分支：零圈子空态')]}],
    'P-M07-JOIN-FREE': [{'sel': '.dialog-footer', 'items': [
        chip('P-M07-JOIN-PENDING', '分支：共享圈子需审批')]}],
    'P-M07-DETAIL-PAID': [{'sel': '.workspace-main', 'items': [
        chip('P-M07-EXPIRED', '分支：订阅已到期'),
        chip('P-M11-BLOCKED-EXPIRED', '分支：到期后 App 阻断')]}],
    'P-M09-CHECKING': [{'sel': '.dialog-footer', 'items': [
        chip('P-M09-RESUMED', '分支：查到已到账')]}],
    'P-M10-MENU': [{'sel': '.workspace-main', 'items': [
        chip('P-M10-MENU-NOPRIV', '分支：无管理资格')]}],
    'P-M10-MENU-NOPRIV': [{'sel': '.workspace-main', 'items': [
        chip('P-M10-MENU', '分支：有管理资格')]}],
    'P-M11-REOPEN-RECOVERY': [{'sel': '.workspace-main', 'items': [
        chip('P-M05-QUESTION-REOPEN', '分支：恢复的会话含待答问题')]}],
    'P-M11-CONTRACT-DL2': [{'sel': '.state-actions', 'items': [
        chip('P-M03-HOME-ENT', '下载完成，重启进入', plain=True)]}],
}

# P-M11-CONTRACT-DL 追加「下载完成」续接（与重label并存）
ADDITIONS['P-M11-CONTRACT-DL'] = (
    [{'sel': '.state-actions', 'items': [chip('P-M03-HOME-ENT', '下载完成，重启进入', plain=True)]}])
ADDITIONS.pop('P-M11-CONTRACT-DL2')

# composer 发送键补接线（停止/到账后由用户再次发送）
SET_GO = {
    'P-M05-STOPPED': [{'sel': '.composer-send', 'to': 'P-M05-CHAT'}],
    'P-M09-USER-STOP': [{'sel': '.composer-send', 'to': 'P-M05-CHAT'}],
    'P-M09-RESUMED': [{'sel': '.composer-send', 'to': 'P-M05-CHAT'}],
}

# P-M09-STREAM-CUT 注入容器级积分横幅（非模态，符合 PC-N03）
WALLET_SVG = ('<svg class="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" '
              'stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">'
              '<path d="M3 7h18v12H3z"></path><path d="M16 13h3"></path><path d="M3 7l3-3h12l3 3"></path></svg>')
STREAM_BANNER = ('<div class="credits-banner">' + WALLET_SVG +
                 '<span><b>积分不足</b> · 本次生成已暂停，已生成部分已保留。充值到账后由你决定是否继续。</span>'
                 '<button class="button" data-go="P-M09-BROWSER">去充值</button></div>')
ADDITIONS['P-M09-STREAM-CUT'] = [{'sel': '.composer-wrap', 'mode': 'afterbegin', 'html': STREAM_BANNER}]

# 文案修订（评审过程性表述不出现在产品表面）
TEXT_REWRITES = [
    ('（演示数据未含搜索框交互）', ''),
    ('打开邀请链接（演示）', '打开邀请链接'),
    ('FDE 工作区（界面示意）', 'FDE 工作区'),
    ('内部界面归 App 开发者（FDE），原型用中性占位表达容器边界。', '内部界面归 App 开发者（FDE）。'),
]

# ------------------------------------------------------------ 页内捕获 ----
CAPTURE_JS = """
(args) => {
  const { id, base, rewire, additions, setGo, pop, layout } = args;
  const realCurrent = currentId;
  currentId = () => id;
  try { render(); } finally { currentId = realCurrent; }
  const app = document.getElementById('app-shell');
  const sys = document.getElementById('system-screen');
  const modal = document.getElementById('modal-layer');
  const toast = document.getElementById('toast');
  const isDesktop = !app.hidden;
  const sec = document.createElement('section');
  sec.className = 'scene';
  sec.setAttribute('data-prototype-scene', id);
  const src = isDesktop ? app : sys;
  const node = src.cloneNode(true);
  node.removeAttribute('hidden');
  sec.append(node);
  // v1 在运行时给 assist 布局加 assistant-mode（克隆不会带上）
  if (isDesktop && layout === 'assist') {
    const wm = node.querySelector('.workspace-main');
    if (wm) wm.classList.add('assistant-mode');
  }
  if (!modal.hidden && modal.textContent.trim()) {
    const m = modal.cloneNode(true); m.removeAttribute('hidden'); sec.append(m);
  }
  if (!toast.hidden && toast.textContent.trim()) {
    const t = toast.cloneNode(true); t.removeAttribute('hidden'); sec.append(t);
  }
  sec.querySelectorAll('.prototype-boundary-note').forEach(el => el.remove());
  const missed = [];
  const snaps = {};
  for (const rw of (rewire || [])) {
    if (!(rw.go in snaps)) snaps[rw.go] = [...sec.querySelectorAll('[data-go="' + rw.go + '"]')];
    const el = snaps[rw.go][rw.nth || 0];
    if (!el) { missed.push('rewire:' + rw.go); continue; }
    if (rw.to === null) {
      el.removeAttribute('data-go');
      el.setAttribute('aria-disabled', 'true');
    } else {
      if (rw.label) el.textContent = rw.label;
      if (rw.to) el.setAttribute('data-go', rw.to);
    }
  }
  sec.querySelectorAll('[data-close-modal]').forEach(el => {
    el.removeAttribute('data-close-modal');
    if (base) el.setAttribute('data-go', base);
  });
  sec.querySelectorAll('[data-pop]').forEach(el => {
    const kind = el.getAttribute('data-pop');
    el.removeAttribute('data-pop');
    const target = pop[kind];
    if (target) el.setAttribute('data-go', target);
  });
  for (const sg of (setGo || [])) {
    sec.querySelectorAll(sg.sel).forEach(el => el.setAttribute('data-go', sg.to));
  }
  for (const ad of (additions || [])) {
    const host = sec.querySelector(ad.sel);
    if (!host) { missed.push('add:' + ad.sel); continue; }
    if (ad.html) { host.insertAdjacentHTML(ad.mode || 'beforeend', ad.html); continue; }
    const strip = document.createElement('div');
    strip.className = 'scenario-strip';
    for (const it of ad.items) {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = it.plain ? 'button' : 'button scenario-jump';
      b.setAttribute('data-go', it.to);
      b.textContent = it.label;
      strip.append(b);
    }
    host.insertAdjacentElement(ad.mode || 'beforeend', strip);
  }
  const edges = [];
  let i = 0;
  sec.querySelectorAll('[data-go]').forEach(el => {
    const to = el.getAttribute('data-go');
    i += 1;
    const tid = 'T-' + id.slice(2) + '-' + String(i).padStart(3, '0') + '-' + to.slice(2);
    el.setAttribute('data-transition', tid);
    const label = (el.getAttribute('aria-label') || el.textContent || '').replace(/\\s+/g, ' ').trim();
    edges.push({ id: tid, to, label: label.slice(0, 60) });
  });
  return { html: sec.outerHTML, edges, missed };
}
"""


def main():
    meta = json.loads((BUNDLE / 'build' / 'v1-meta.json').read_text(encoding='utf-8'))
    ids = list(meta['screens'].keys())
    scenes, all_missed = {}, {}
    with sync_playwright() as p:
        try:
            browser = p.chromium.launch(headless=True)
        except Exception:
            browser = p.chromium.launch(headless=True, channel='chrome')
        page = browser.new_page(viewport={'width': 1440, 'height': 900})
        page.goto(V1.as_uri() + '?clean=1')
        page.wait_for_function("() => typeof render === 'function' && Object.keys(B).length > 80")
        for sid in ids:
            pop = dict(DEFAULT_POP)
            pop.update(POP_OVERRIDE.get(sid, {}))
            result = page.evaluate(CAPTURE_JS, {
                'id': sid,
                'base': BASE.get(sid),
                'rewire': REWIRES.get(sid, []),
                'additions': ADDITIONS.get(sid, []),
                'setGo': SET_GO.get(sid, []),
                'pop': pop,
                'layout': meta['screens'].get(sid, {}).get('layout'),
            })
            html = result['html']
            for old, new in TEXT_REWRITES:
                html = html.replace(old, new)
            scenes[sid] = {'html': html, 'edges': result['edges']}
            if result['missed']:
                all_missed[sid] = result['missed']
        browser.close()
    OUT.write_text(json.dumps({'scenes': scenes, 'screens': meta['screens']},
                              ensure_ascii=False), encoding='utf-8')
    edges = sum(len(s['edges']) for s in scenes.values())
    print(f'extracted {len(scenes)} scenes, {edges} edges -> {OUT}')
    if all_missed:
        print('MISSED HOOKS:', json.dumps(all_missed, ensure_ascii=False, indent=1))
        return 1
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
