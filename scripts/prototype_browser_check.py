#!/usr/bin/env python3
"""Render all registered scenes offline; capture the old/new artifacts at equal viewport/time."""
import argparse
from datetime import datetime, timezone
import hashlib
import json
from pathlib import Path
import re
import sys
from playwright.sync_api import sync_playwright


def inspect(browser, root, screenshots):
    manifest = json.loads((root / 'baseline-manifest.json').read_text())
    ids = [row['id'] for row in manifest['scenes']]
    records = []
    screenshots.mkdir(parents=True)
    for scene in ids:
        if not re.fullmatch(r'[a-z0-9-]+', scene):
            raise ValueError(f'unsafe scene ID: {scene}')
        context = browser.new_context(viewport={'width': 1440, 'height': 900},
                                      locale='zh-CN', timezone_id='UTC', color_scheme='light')
        page = context.new_page()
        page.clock.set_fixed_time(datetime(2026, 10, 23, 12, tzinfo=timezone.utc))
        errors, external = [], []
        page.on('pageerror', lambda error: errors.append(str(error)))
        page.on('console', lambda msg: errors.append(msg.text) if msg.type == 'error' else None)
        def block(route):
            external.append(route.request.url)
            route.abort()
        page.route(re.compile(r'^https?://'), block)
        record = {'scene': scene, 'errors': errors, 'external_requests': external,
                  'viewport': [1440, 900], 'fixed_time': '2026-10-23T12:00:00Z'}
        try:
            url = (root / 'entries/baseline.html').resolve().as_uri() + '?scene=' + scene + '&pure=1'
            record['url'] = url
            page.goto(url, wait_until='networkidle')
            page.wait_for_function('document.querySelector("#root")?.innerText.trim().length > 10')
            page.evaluate('document.fonts.ready')
            page.evaluate('Promise.all([...document.images].map(i => i.decode().catch(() => null)))')
            page.wait_for_timeout(250)
            runtime = page.evaluate('window.__BASELINE_SCENE_IDS__')
            if sorted(runtime or []) != sorted(ids):
                errors.append('runtime scene IDs differ from generated manifest')
            text = page.locator('#root').inner_text()
            if re.search(r'展示失败|组件渲染失败|渲染需要额外上下文|Something went wrong|Minified React error', text):
                errors.append('component error fallback visible')
            if page.evaluate('[...document.images].some(i => i.getAttribute("src") && !i.naturalWidth)'):
                errors.append('broken image')
            destination = screenshots / (scene + '.png')
            page.screenshot(path=str(destination), animations='disabled')
            record['screenshot'] = str(destination.relative_to(screenshots.parents[1]))
            record['sha256'] = hashlib.sha256(destination.read_bytes()).hexdigest()
            record['visible_text'] = text[:250]
        except Exception as exc:
            errors.append(str(exc))
        record['passed'] = not errors and not external
        records.append(record)
        context.close()
    return records


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--artifact', type=Path, required=True)
    args = parser.parse_args()
    out = args.artifact.resolve()
    with sync_playwright() as p:
        browser = p.chromium.launch()
        result = {'proof_scope': 'Offline fixture rendering smoke, not interaction/visual approval or live backend acceptance.',
                  'after': inspect(browser, out / 'assets/source-baseline', out / 'screenshots/after')}
        try:
            result['before'] = inspect(browser, out / 'before/source-baseline', out / 'screenshots/before')
        except (OSError, ValueError, KeyError, TypeError) as exc:
            result['before'] = []
            result['before_unavailable'] = str(exc)
        # The three-layer index must remain navigable in the artifact bundle.
        page = browser.new_page()
        page.goto((out / 'assets/source-baseline/index.html').as_uri())
        links = page.locator('a').evaluate_all('(nodes) => nodes.map(n => n.getAttribute("href"))')
        result['missing_local_links'] = []
        for link in links:
            if not link or re.match(r'^(https?:|#)', link):
                continue
            path = link.split('?')[0].split('#')[0]
            if not (out / 'assets/source-baseline' / path).resolve().is_file():
                result['missing_local_links'].append(link)
        page.goto((out / 'assets/tokens/token-preview.html').as_uri())
        result['token_preview_rendered'] = page.locator('body').inner_text().strip() != ''
        browser.close()
    result['passed'] = (bool(result['after']) and all(r['passed'] for r in result['after'])
                        and not result['missing_local_links'] and result['token_preview_rendered'])
    (out / 'browser.json').write_text(json.dumps(result, ensure_ascii=False, indent=2) + '\n')
    print(json.dumps({'passed': result['passed'], 'after_scenes': len(result['after']),
                      'after_failed': sum(not r['passed'] for r in result['after']),
                      'before_failed': sum(not r['passed'] for r in result['before'])}))
    return 0 if result['passed'] else 1


if __name__ == '__main__':
    sys.exit(main())
