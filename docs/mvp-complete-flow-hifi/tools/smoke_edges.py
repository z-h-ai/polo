#!/usr/bin/env python3
"""POO-70 D-PC-07 · 全部 transitions 逐边点击审计（官方运行时版）。

对每条 transition：单独加载 surface.html?scene=<SID>，点击对应 [data-transition] 按钮，
核对运行时落点 body.dataset.currentScene == edge.to。
"""
import json
import sys
from pathlib import Path

from playwright.sync_api import sync_playwright

BUNDLE = Path(__file__).resolve().parents[1]
SURFACE = (BUNDLE / 'surface.html').as_uri()

MANIFEST = json.loads((BUNDLE / 'prototype-manifest.json').read_text(encoding='utf-8'))
EDGES = [(s['id'], e['id'], e['to']) for s in MANIFEST['scenes'] for e in s['transitions']]

CLICK_JS = """
(tid) => {
  const all = [...document.querySelectorAll('[data-go]')].filter(b => b.dataset.transition === tid);
  const visible = all.find(b => b.offsetParent !== null);
  const btn = visible || all[0];
  if (!btn) return 'missing';
  btn.click();
  return visible ? 'clicked' : 'clicked-hidden';
}
"""


def main():
    bad = []
    hidden_clicks = []
    checked = 0
    with sync_playwright() as p:
        browser = p.chromium.launch()
        page = browser.new_page(viewport={'width': 1440, 'height': 900})
        errors = []
        page.on('pageerror', lambda e: errors.append(str(e)))
        for sid, tid, to in EDGES:
            page.goto(f'{SURFACE}?scene={sid}')
            page.wait_for_function(
                "() => document.body.dataset.currentScene && document.body.dataset.currentScene !== ''",
                timeout=5000,
            )
            state = page.evaluate(CLICK_JS, tid)
            if state == 'missing':
                bad.append(f'{tid}: button not found in {sid}')
                continue
            if state == 'clicked-hidden':
                hidden_clicks.append(tid)
            page.wait_for_timeout(30)
            landed = page.evaluate('() => document.body.dataset.currentScene')
            checked += 1
            if landed != to:
                bad.append(f'{tid}: expected {to}, landed {landed}')
        browser.close()

    total = len(EDGES)
    print(f'checked {checked}/{total} edges, pageerrors={len(errors)}, '
          f'via-hidden-popover={len(hidden_clicks)}: {hidden_clicks}')
    if bad:
        print(f'{len(bad)} FAILURES:')
        for item in bad[:20]:
            print(' ', item)
        return 1
    print('ALL EDGES OK')
    return 0


if __name__ == '__main__':
    sys.exit(main())
