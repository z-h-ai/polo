#!/usr/bin/env python3
"""POO-71 v2 重建 · 第 6 步：双视口全场景审计 + 代表屏重摄。

对 90 场景 × 2 视口检查：
  - 横向溢出（scene scrollWidth > clientWidth，或 body 出现横向滚动）；
  - 交互元素超出视口右/下边界 > 4px（不可达风险）；
并按旧名单重摄 screenshots/（1440×900 26 张 + 1024×768 10 张）。
"""
import json
from pathlib import Path

from playwright.sync_api import sync_playwright

BUNDLE = Path(__file__).resolve().parents[1]
SHOTS = {
    '1440x900': ['P-M01-INVITE-BROWSER', 'P-M01-LOGIN-PASSWORD', 'P-M01-PERSONAL-PREP',
                 'P-M02-CONFIRM', 'P-M02-STOP-FAILED', 'P-M02-SWITCHER', 'P-M03-ALL-APPS',
                 'P-M03-HOME-ENT', 'P-M03-HOME-PERSONAL', 'P-M03-HOME-ZERO', 'P-M04-APP-VIEW',
                 'P-M04-CLOSE-ACTIVE', 'P-M04-PERM-DENIED', 'P-M05-CHAT',
                 'P-M05-QUESTION-REOPEN', 'P-M06-SKILLS', 'P-M07-DETAIL-PAID', 'P-M07-LIST',
                 'P-M08-FILES', 'P-M09-BROWSER', 'P-M09-PRE-BLOCK', 'P-M09-RESUMED',
                 'P-M10-MENU', 'P-M11-CONTRACT', 'P-M11-OFFLINE-HOME', 'P-M11-REOPEN-RECOVERY'],
    '1024x768': ['P-M02-SWITCHER', 'P-M03-ALL-APPS', 'P-M03-HOME-PERSONAL', 'P-M03-HOME-ZERO',
                 'P-M04-APP-VIEW', 'P-M05-CHAT', 'P-M07-LIST', 'P-M08-FILES',
                 'P-M09-PRE-BLOCK', 'P-M10-MENU'],
}

AUDIT_JS = """
() => {
  const scene = document.querySelector('.scene.active');
  const doc = document.documentElement;
  const problems = [];
  if (scene.scrollWidth > scene.clientWidth + 1) {
    problems.push('scene hscroll ' + scene.scrollWidth + '>' + scene.clientWidth);
  }
  if (doc.scrollWidth > doc.clientWidth + 1) {
    problems.push('doc hscroll ' + doc.scrollWidth + '>' + doc.clientWidth);
  }
  const W = window.innerWidth, H = window.innerHeight;
  const els = [...scene.querySelectorAll('button, a, input, select, textarea, [role="menuitem"]')]
    .filter(el => !(el.closest('[hidden]') || el.offsetParent === null ||
                    (el.getBoundingClientRect().width === 0 && el.getBoundingClientRect().height === 0)));
  for (const el of els) {
    el.scrollIntoView({block: 'nearest', inline: 'nearest'});
    const r = el.getBoundingClientRect();
    if (r.right > W + 4 || r.left < -4 || r.bottom > H + 4 || r.top < -4) {
      const label = (el.getAttribute('aria-label') || el.textContent || '').trim().slice(0, 24);
      problems.push('oob ' + el.tagName + '「' + label + '」 l=' + Math.round(r.left) +
                    ' r=' + Math.round(r.right) + ' t=' + Math.round(r.top) +
                    ' b=' + Math.round(r.bottom));
    }
  }
  els.forEach(el => el.scrollIntoView({block: 'start'}));
  return problems.slice(0, 6);
}
"""


def main():
    manifest = json.loads((BUNDLE / 'prototype-manifest.json').read_text(encoding='utf-8'))
    ids = [s['id'] for s in manifest['scenes']]
    report = {}
    with sync_playwright() as p:
        browser = p.chromium.launch()
        for tag, w, h in [('1440x900', 1440, 900), ('1024x768', 1024, 768)]:
            page = browser.new_page(viewport={'width': w, 'height': h})
            page.goto((BUNDLE / 'surface.html').as_uri() + f'?scene={ids[0]}')
            surface = page.main_frame
            out_dir = BUNDLE / 'screenshots' / tag
            out_dir.mkdir(parents=True, exist_ok=True)
            scene_problems = {}
            for sid in ids:
                # surface 直接加载时 window.parent === window，postMessage 自激活
                surface.evaluate(
                    """(sid) => window.postMessage(
                         {type: 'product-ui-prototype:show-scene', version: 1, scene: sid}, '*')""",
                    sid)
                page.wait_for_timeout(60)
                probs = surface.evaluate(AUDIT_JS)
                if probs:
                    scene_problems[sid] = probs
                if sid in SHOTS[tag]:
                    page.screenshot(path=str(out_dir / f'{sid}.png'))
            report[tag] = scene_problems
            page.close()
        browser.close()

    flat = {f'{tag}:{sid}': probs for tag, m in report.items() for sid, probs in m.items()}
    (BUNDLE / 'build' / 'viewport-audit.json').write_text(
        json.dumps(flat, ensure_ascii=False, indent=1), encoding='utf-8')
    if flat:
        print(f'PROBLEMS in {len(flat)} scenes:')
        for k, v in list(flat.items())[:40]:
            print(' -', k, '=>', '; '.join(v))
        return 1
    print(f'audit OK: {len(ids)} scenes x 2 viewports, no overflow/oob; '
          f'shots: {len(SHOTS["1440x900"])}+{len(SHOTS["1024x768"])}')
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
