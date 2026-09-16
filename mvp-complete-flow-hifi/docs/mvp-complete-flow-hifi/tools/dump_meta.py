#!/usr/bin/env python3
"""POO-71 v2 重建 · 第 0 步：从 v1 原型导出屏注册表元数据（SCREENS 等）。"""
import json
from pathlib import Path

from playwright.sync_api import sync_playwright

BUNDLE = Path(__file__).resolve().parents[1]
V1 = BUNDLE / 'sources' / 'prototype-v1.html'
OUT = BUNDLE / 'build' / 'v1-meta.json'

JS = """() => ({
  screens: SCREENS,
  moduleTitles: MODULE_TITLES,
  clsLabels: CLS_LABEL,
  stories: STORIES.map(s => ({ name: s.name, steps: s.steps.map(x => ({ s: x.s, n: x.n })) }))
})"""


def main():
    OUT.parent.mkdir(parents=True, exist_ok=True)
    with sync_playwright() as p:
        try:
            browser = p.chromium.launch(headless=True)
        except Exception:
            browser = p.chromium.launch(headless=True, channel='chrome')
        page = browser.new_page()
        page.goto(V1.as_uri())
        page.wait_for_function("() => typeof SCREENS !== 'undefined'")
        meta = page.evaluate(JS)
        browser.close()
    OUT.write_text(json.dumps(meta, ensure_ascii=False, indent=1), encoding='utf-8')
    print(f'{len(meta["screens"])} screens -> {OUT}')


if __name__ == '__main__':
    raise SystemExit(main())
