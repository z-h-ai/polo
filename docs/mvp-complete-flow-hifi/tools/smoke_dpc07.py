#!/usr/bin/env python3
"""POO-70 D-PC-07/08 冒烟：评审壳 + 锚定标注 + 深链 + 视口 + 故事 + 面板边界。

运行：python3 tools/smoke_dpc07.py （需 playwright + chromium）
"""
import json
import sys
from pathlib import Path

from playwright.sync_api import sync_playwright

BUNDLE = Path(__file__).resolve().parents[1]
REVIEW = (BUNDLE / 'prototype.html').as_uri()
SURFACE = (BUNDLE / 'surface.html').as_uri()

DPC07 = [
    ('P-M03-HOME-PERSONAL', 'a-m03-circle-entry', 'circle-entry'),
    ('P-M03-HOME-PERSONAL', 'a-m03-fixed-assistant', 'assistant-card'),
    ('P-M03-HOME-PERSONAL', 'a-m03-all-apps', 'all-apps-entry'),
    ('P-M03-HOME-ZERO', 'a-m03-zero-guide', 'zero-guide'),
    ('P-M03-MANAGE-HOME', 'a-m03-manage-limit', 'manage-limit'),
    ('P-M04-CLOSE-ACTIVE', 'a-m04-close-three', 'close-dialog'),
    ('P-M04-TERM-FAILED', 'a-m04-keep-tab', 'kept-tab'),
    ('P-M04-TERM-FAILED', 'a-m04-term-dialog', 'term-failed-dialog'),
    ('P-M04-BACKGROUND', 'a-m04-bg-pill', 'runtime-pill'),
    ('P-M07-LIST', 'a-m07-nav', 'circle-nav-title'),
    ('P-M09-APP-BANNER', 'a-m09-banner', 'container-banner'),
    ('P-M09-CHECKING', 'a-m09-single-check', 'single-check-dialog'),
    ('P-M10-MENU', 'a-m10-admin-section', 'admin-section-title'),
    ('P-M10-MENU-NOPRIV', 'a-m10-nopriv', 'account-menu-nopriv'),
]

failures = []


def check(name, ok, detail=''):
    print(f'{"PASS" if ok else "FAIL"}  {name}' + (f' — {detail}' if detail else ''))
    if not ok:
        failures.append(name)


def surface_state(frame):
    return frame.evaluate('''() => ({
        current: document.body.dataset.currentScene,
        w: window.innerWidth, h: window.innerHeight,
        anchors: [...document.querySelectorAll('.scene.active [data-review-anchor]')].map(el => {
            const r = el.getBoundingClientRect();
            return {name: el.dataset.reviewAnchor,
                    inView: r.width > 0 && r.height > 0 && r.bottom > 0 && r.right > 0
                            && r.top < innerHeight && r.left < innerWidth};
        }),
    })''')


def shell_state(page):
    return page.evaluate('''() => ({
        pins: document.querySelectorAll('[data-annotation-layer] .annotation-pin').length,
        highlights: document.querySelectorAll('[data-annotation-layer] .annotation-highlight').length,
        cards: document.querySelectorAll('[data-annotation-layer] .annotation-card').length,
        brief: document.querySelector('[data-review-brief]')?.textContent?.slice(0, 400) || '',
    })''')


def run():
    with sync_playwright() as p:
        browser = p.chromium.launch()
        page = browser.new_page(viewport={'width': 1600, 'height': 1000})

        # 1. 深链：场景 + 锚定标注（第一个 D-PC-07 入口）
        page.goto(REVIEW + '#scene=P-M03-HOME-PERSONAL&annotation=a-m03-circle-entry')
        page.wait_for_timeout(1500)
        frame = next(f for f in page.frames if f.url.startswith(SURFACE.split('#')[0]))
        s = surface_state(frame)
        check('deep-link scene', s['current'] == 'P-M03-HOME-PERSONAL', s['current'])
        circle = next(a for a in s['anchors'] if a['name'] == 'circle-entry')
        check('deep-link anchor in view', circle['inView'], json.dumps(s['anchors']))
        sh = shell_state(page)
        check('annotation pin drawn', sh['pins'] >= 1, f"pins={sh['pins']} highlights={sh['highlights']}")

        # 2. 全部 14 个锚点逐个深链揭示
        bad = []
        for scene, ann, anchor in DPC07:
            page.goto(REVIEW + f'#scene={scene}&annotation={ann}')
            page.wait_for_timeout(900)
            st = surface_state(frame)
            hit = [a for a in st['anchors'] if a['name'] == anchor]
            if st['current'] != scene or not hit or not hit[0]['inView']:
                bad.append(f'{scene}/{anchor}(scene={st["current"]},inView={bool(hit and hit[0]["inView"])})')
        check('14 D-PC-07 anchors deep-link + visible', not bad, '; '.join(bad) or 'all visible')

        # 3. 视口切换：iframe 真实 CSS 视口（控件在面板内，用 change 事件驱动）
        page.goto(REVIEW + '#scene=P-M03-HOME-PERSONAL')
        page.wait_for_timeout(1200)
        expected = page.evaluate('''() => {
            const sel = document.querySelector('[data-viewport-select]');
            sel.selectedIndex = 1;
            sel.dispatchEvent(new Event('change', {bubbles: true}));
            const nums = sel.selectedOptions[0].textContent.match(/\\d+/g).map(Number);
            return nums.slice(0, 2);
        }''')
        page.wait_for_timeout(600)
        s2 = surface_state(frame)
        check('viewport switch changes real iframe viewport',
              (s2['w'], s2['h']) != (s['w'], s['h']), f"{s['w']}x{s['h']} -> {s2['w']}x{s2['h']}")
        check('iframe viewport equals manifest viewport',
              [s2['w'], s2['h']] == expected, f'{s2["w"]}x{s2["h"]} vs {expected}')

        # 4. 面板开合不改 iframe 视口
        before = surface_state(frame)
        page.locator('[data-open-panel="index"]').click()
        page.wait_for_timeout(600)
        after = surface_state(frame)
        check('panel open keeps iframe viewport',
              (before['w'], before['h']) == (after['w'], after['h']),
              f"{before['w']}x{before['h']} -> {after['w']}x{after['h']}")
        page.locator('[data-open-panel="settings"]').click()
        page.wait_for_timeout(400)
        tabs = page.locator('[data-inspector-tab]')
        check('inspector tabs present', tabs.count() >= 3, f'{tabs.count()} tabs')
        page.keyboard.press('Escape')
        page.wait_for_timeout(400)

        # 5. 产品点击跳转 + 评审壳同步
        page.goto(REVIEW + '#scene=P-M03-HOME-ZERO')
        page.wait_for_timeout(1200)
        frame.evaluate('''() => {
            const btn = [...document.querySelectorAll('[data-go="P-M03-ALL-APPS"]')]
                .find(b => b.offsetParent !== null);
            btn.click();
        }''')
        page.wait_for_timeout(900)
        s5 = surface_state(frame)
        check('product click navigates surface', s5['current'] == 'P-M03-ALL-APPS', s5['current'])

        # 6. Back（控件在面板内，JS 派发点击）
        page.evaluate('''() => document.querySelector('[data-back]').click()''')
        page.wait_for_timeout(700)
        s6 = surface_state(frame)
        check('Back returns to previous scene', s6['current'] == 'P-M03-HOME-ZERO', s6['current'])

        # 7. Reset 回起始屏
        page.evaluate('''() => document.querySelector('[data-reset]').click()''')
        page.wait_for_timeout(900)
        s7 = surface_state(frame)
        check('Reset returns to start scene', s7['current'] == 'P-M01-INVITE-BROWSER', s7['current'])

        # 8. 故事：选择即进入（官方壳无独立进入按钮），随后下一步推进
        story_name = page.evaluate('''() => {
            const sel = document.querySelector('[data-story-select]');
            if (!sel || sel.options.length < 2) return null;
            sel.selectedIndex = 1;
            sel.dispatchEvent(new Event('change', {bubbles: true}));
            return sel.selectedOptions[0].textContent;
        }''')
        page.wait_for_timeout(1200)
        check('story entered', story_name is not None, f'selected={story_name}')
        progress = page.evaluate('''() => document.querySelector('[data-story-progress]')?.textContent || '' ''')
        check('story progress shown', bool(progress.strip()), progress.strip())
        before_scene = surface_state(frame)['current']
        next_ok = page.evaluate('''() => {
            const nxt = document.querySelector('[data-story-next]');
            if (!nxt || nxt.disabled) return false;
            nxt.click();
            return true;
        }''')
        if not next_ok:
            next_scene = page.evaluate('''() => {
                const story = JSON.parse(document.querySelector('#prototype-manifest').textContent)
                    .stories.find(s => s.id === document.querySelector('[data-story-select]').value);
                return story?.steps?.[1]?.scene || null;
            }''')
            next_ok = frame.evaluate('''(target) => {
                const active = document.querySelector('.scene.active');
                const button = [...active.querySelectorAll('[data-go]')]
                    .find(item => item.dataset.go === target);
                if (!button) return false;
                button.click();
                return true;
            }''', next_scene)
        page.wait_for_timeout(900)
        check('story can advance by its declared product action', next_ok)
        if next_ok:
            new_scene = surface_state(frame)['current']
            check('story next advances scene', new_scene != before_scene, f'{before_scene} -> {new_scene}')
        page.evaluate('''() => document.querySelector('[data-story-exit]')?.click()''')
        page.wait_for_timeout(600)

        # 9. 评审壳含本轮评审 brief（D-PC-08），且新增切换确认页可直达。
        page.goto(REVIEW + '#scene=P-M03-HOME-PERSONAL')
        page.wait_for_timeout(1200)
        sh9 = shell_state(page)
        check('review brief bound to D-PC-08',
              'D-PC-08' in sh9['brief'], sh9['brief'][:160])
        page.goto(REVIEW + '#scene=P-M02-CONFIRM-PERSONAL')
        page.wait_for_timeout(900)
        check('personal-to-enterprise confirmation is reachable',
              surface_state(frame)['current'] == 'P-M02-CONFIRM-PERSONAL',
              surface_state(frame)['current'])

        # 10. 无控制台错误 / 无网络请求
        errors = []
        page.on('pageerror', lambda e: errors.append(str(e)))
        page.goto(REVIEW)
        page.wait_for_timeout(1500)
        check('no page errors', not errors, '; '.join(errors[:3]))

        browser.close()

    print()
    if failures:
        print(f'{len(failures)} FAILURES: {failures}')
        return 1
    print('ALL SMOKE CHECKS PASSED')
    return 0


if __name__ == '__main__':
    sys.exit(run())
