#!/usr/bin/env python3
"""Freeze actual native component renders for POO-170/179 smoke references.

Runtime remains the live React components. The reference removes product scripts
and only restores observed scroll offsets. The full ChatDisplay bundle contains
third-party dynamic imports that the strict native reader cannot resolve.
"""
from __future__ import annotations

import argparse
import hashlib
import json
from datetime import datetime, timezone
from pathlib import Path

from playwright.sync_api import sync_playwright

SKILL = Path(__file__).resolve().parents[1]
REPO = SKILL.parents[2]
PREFIX = SKILL.relative_to(REPO).as_posix()
BASELINE = SKILL / 'assets/source-baseline'
OUTPUT = SKILL / 'assets/prototypes/interview-conversation'
VIEWPORTS = [
    {'name': 'desktop-1280x800', 'width': 1280, 'height': 800},
    {'name': 'desktop-1440x900', 'width': 1440, 'height': 900},
    {'name': 'compact-800x600', 'width': 800, 'height': 600},
]
CASES = [
    {'id': 'scroll-latest', 'scene': 'interview-scroll', 'state': 'latest', 'lang': 'zh-Hans', 'task': 'POO-170'},
    {'id': 'scroll-history', 'scene': 'interview-scroll', 'state': 'history', 'lang': 'zh-Hans', 'task': 'POO-170'},
    *[{'id': f'status-{surface}-{language}', 'scene': f'interview-status-{surface}',
       'state': 'status', 'lang': language, 'task': 'POO-179'}
      for surface in ('picker', 'desktop', 'compact') for language in ('zh-Hans', 'en')],
]


# POO-179 retains all original routes. These are real component compositions,
# not a second product UI or an approval of the currently untranslated copy.
LOCALIZATION_CASES = [
    ('context', 'context-ready', 'zh-Hans'), ('context', 'context-ready', 'en'),
    ('permission', 'permission-known', 'zh-Hans'), ('permission', 'permission-unsupported', 'en'),
    ('credential', 'credential-filled', 'zh-Hans'), ('credential', 'credential-filled', 'en'),
    ('table', 'table-expanded', 'zh-Hans'), ('table', 'table-expanded', 'en'),
    ('overlay', 'tool-path-menu', 'zh-Hans'), ('turn', 'turn-executing', 'zh-Hans'),
    ('settings', 'settings-no-results', 'zh-Hans'), ('remote', 'remote-empty', 'zh-Hans'),
]
CASES += [{'id': f'localization-{name}-{lang}', 'scene': f'interview-localization-{name}-{lang}',
           'state': state, 'lang': lang, 'task': 'POO-179'} for name, state, lang in LOCALIZATION_CASES]


def sha(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def encode(value) -> bytes:
    return (json.dumps(value, ensure_ascii=False, indent=2) + '\n').encode()


def steps(case):
    state, lang = case['state'], case['lang']
    wrapper = f'[data-localization-case="{state}"]'
    if state == 'context-ready':
        return [{'action': 'hover', 'selector': wrapper + ' button:has-text("90%")'}]
    if state == 'credential-filled':
        return [{'action': 'fill', 'selector': '#credential-username:visible', 'value': 'fixture-user'},
                {'action': 'fill', 'selector': '#credential-password:visible', 'value': 'fixture-secret-not-real'}]
    if state == 'table-expanded':
        fullscreen = 'View Fullscreen' if lang == 'en' else '全屏查看'
        controls = 'Table Controls' if lang == 'en' else '表格控制'
        group = 'Group by' if lang == 'en' else '分组依据'
        return [{'action': 'hover', 'selector': wrapper + ' table'},
                {'action': 'click', 'selector': wrapper + f' button[title="{fullscreen}"]'},
                {'action': 'click', 'selector': f'.fixed.z-50 button[title="{controls}"], [role="dialog"] button[title="{controls}"]'},
                {'action': 'hover', 'selector': f'[role="menuitem"]:has-text("{group}")'}]
    if state == 'tool-path-menu':
        return [{'action': 'click', 'selector': wrapper + ' [data-search-exclude="true"] > button'},
                {'action': 'click', 'selector': wrapper + ' [data-search-exclude="true"] [class~="group/row"]'},
                {'action': 'click', 'selector': 'button[title="/fixture/work/原名 Report.md"]'}]
    if state == 'settings-no-results':
        return [{'action': 'click', 'selector': wrapper + ' button'},
                {'action': 'fill', 'selector': '[role="dialog"] input', 'value': 'no-match-179'}]
    if case['id'].startswith('localization-'):
        return []
    if case['task'] == 'POO-170':
        result = [{'action': 'press', 'selector': '[data-radix-scroll-area-viewport]', 'key': 'End'}]
        if case['state'] == 'history':
            result.append({'action': 'press', 'selector': '[data-radix-scroll-area-viewport]', 'key': 'PageUp'})
        return result
    if '-desktop-' in case['id']:
        return [{'action': 'click', 'selector': '[data-interview-status="desktop"] button'}]
    if '-compact-' in case['id']:
        label = 'Status' if case['lang'] == 'en' else '状态'
        return [
            {'action': 'click', 'selector': '[data-interview-status="compact"] button'},
            {'action': 'click', 'selector': f'button:has-text("{label}")'},
        ]
    return []


def assertions(case):
    state = case['state']
    wrapper = f'[data-localization-case="{state}"]'
    if state == 'context-ready':
        return [{'type': 'visible', 'selector': '[role="tooltip"]'},
                {'type': 'textContent', 'selector': '[role="tooltip"]', 'expected': '90%'}]
    if state.startswith('permission-'):
        return [{'type': 'visible', 'selector': '[data-tutorial="permission-banner"]:visible'},
                {'type': 'visible', 'selector': '[data-tutorial="permission-allow-button"]:visible'},
                {'type': 'countMin', 'selector': '[data-tutorial="permission-banner"]:visible button:visible', 'expected': '2'}]
    if state == 'credential-filled':
        return [{'type': 'inputValue', 'selector': '#credential-username:visible', 'expected': 'fixture-user'},
                {'type': 'attribute', 'selector': '#credential-password:visible', 'attribute': 'type', 'expected': 'password'}]
    if state == 'table-expanded':
        return [{'type': 'visible', 'selector': '[role="menu"]'},
                {'type': 'textContent', 'selector': 'body', 'expected': 'Fixture Orders'},
                {'type': 'countMin', 'selector': '[role="menuitem"]', 'expected': '2'}]
    if state == 'tool-path-menu':
        return [{'type': 'visible', 'selector': '[role="menu"]'},
                {'type': 'count', 'selector': '[role="menu"] [role="menuitem"]', 'expected': '2'}]
    if state == 'settings-no-results':
        return [{'type': 'visible', 'selector': '[role="dialog"]'},
                {'type': 'inputValue', 'selector': '[role="dialog"] input', 'expected': 'no-match-179'},
                {'type': 'count', 'selector': '[role="dialog"] button', 'expected': '0'}]
    if state == 'remote-empty':
        return [{'type': 'visible', 'selector': '[role="dialog"]'},
                {'type': 'inputValue', 'selector': '[role="dialog"] input', 'expected': '/fixture/work'}]
    if state == 'turn-executing':
        return [{'type': 'visible', 'selector': wrapper + ' [data-radix-scroll-area-viewport]'},
                {'type': 'visible', 'selector': wrapper + ' button.send-btn'}]
    if case['task'] == 'POO-170':
        return [{'type': 'visible', 'selector': '[data-radix-scroll-area-viewport]'}]
    if '-picker-' in case['id']:
        return [{'type': 'visible', 'selector': '[cmdk-root]'}]
    return [{'type': 'visible', 'selector': '[role="dialog"]' if '-compact-' in case['id'] else '[role="menu"]'}]


def assert_native_state(page, case):
    """Check the real arranged DOM; the fixture never inserts an expected result."""
    for assertion in assertions(case):
        target = page.locator(assertion['selector'])
        kind, expected = assertion['type'], assertion.get('expected')
        if kind == 'visible':
            target.first.wait_for(state='visible')
        elif kind == 'textContent':
            if str(expected) not in target.first.inner_text(): raise ValueError(f"{case['id']}: text state differs")
        elif kind in {'count', 'countMin'}:
            count = target.count()
            if (count != int(expected)) if kind == 'count' else (count < int(expected)):
                raise ValueError(f"{case['id']}: expected {kind} {expected}, observed {count}")
        elif kind == 'attribute':
            if target.first.get_attribute(assertion['attribute']) != expected: raise ValueError(f"{case['id']}: attribute state differs")
        elif kind == 'inputValue':
            if target.first.input_value() != expected: raise ValueError(f"{case['id']}: input state differs")
        else:
            raise ValueError('unsupported native state assertion: ' + kind)


def expected_outputs(evidence: Path | None):
    baseline = json.loads((BASELINE / 'baseline-manifest.json').read_text())
    html = BASELINE / 'entries/baseline.html'
    if sha(html.read_bytes()) != baseline['files']['entries/baseline.html']:
        raise ValueError('source baseline differs from its generator receipt')
    files: dict[str, bytes] = {}
    records = []
    with sync_playwright() as playwright:
        browser = playwright.chromium.launch(headless=True)
        try:
            for case in CASES:
                for viewport in VIEWPORTS:
                    page = browser.new_page(viewport={k: viewport[k] for k in ('width', 'height')}, device_scale_factor=1)
                    errors = []
                    page.on('pageerror', lambda error: errors.append(str(error)))
                    # Deterministic capture entropy. Product logic is untouched; only the
                    # environment's randomness (per-mount placeholder shuffle, processing
                    # verb pick) is pinned so an actual render is reproducible byte for byte.
                    page.add_init_script('let __referenceSeed = 0x9e3779b9;'
                                         ' Math.random = () => { __referenceSeed = (__referenceSeed * 1664525 + 1013904223) >>> 0;'
                                         ' return __referenceSeed / 4294967296; }')
                    try:
                        page.clock.set_fixed_time(datetime(2026, 10, 28, 12, tzinfo=timezone.utc))
                        page.emulate_media(reduced_motion='reduce')
                        page.goto(html.as_uri() + f'?scene={case["scene"]}&pure=1&lang={case["lang"]}', wait_until='load')
                        page.locator('[data-radix-scroll-area-viewport]' if case['task'] == 'POO-170' else 'section').first.wait_for(state='visible')
                        page.wait_for_timeout(500)
                        for step in steps(case):
                            target = page.locator(step['selector'])
                            if step['action'] == 'press': target.press(step['key'])
                            elif step['action'] == 'hover': target.hover()
                            elif step['action'] == 'fill': target.fill(step['value'])
                            elif step['action'] == 'click': target.click()
                            else: raise ValueError('unsupported native action: ' + step['action'])
                            page.wait_for_timeout(300)
                        page.evaluate('document.fonts.ready')
                        assert_native_state(page, case)
                        # Settle entry/fade animations before freezing. Entry animations
                        # emit a mid-flight inline opacity on every frame and never loop,
                        # so requiring a 200ms window with none of them (the product also
                        # keeps a few permanently hidden opacity:0 spans) means the clone
                        # captures a resting state, never a random frame.
                        page.wait_for_function('''() => {
                          const mid = [...document.querySelectorAll('*')].some(node => {
                            const value = node.style && node.style.opacity
                            if (!value) return false
                            const opacity = parseFloat(value)
                            return opacity > 0 && opacity < 1
                          })
                          if (mid) { window.__referenceCalm = 0; return false }
                          if (!window.__referenceCalm) window.__referenceCalm = performance.now()
                          return performance.now() - window.__referenceCalm > 200
                        }''', timeout=20000)
                        if errors:
                            raise ValueError(f'{case["id"]}: actual component failed: {errors}')
                        metrics = None
                        if case['task'] == 'POO-170':
                            metrics = page.locator('[data-radix-scroll-area-viewport]').evaluate('(e) => ({top:e.scrollTop,height:e.clientHeight,total:e.scrollHeight})')
                            distance = metrics['total'] - metrics['height'] - metrics['top']
                            if (case['state'] == 'latest' and distance > 20) or (case['state'] == 'history' and distance <= 20):
                                raise ValueError(f'{case["id"]}: native keyboard replay did not arrange state: {metrics}')
                        # Clone only. The actual runtime DOM and handlers remain untouched.
                        frozen = page.locator('html').evaluate('''element => {
                          const clone = element.cloneNode(true), styles = [], scrolls = [];
                          const original = element.querySelectorAll('*'), copies = clone.querySelectorAll('*');
                          original.forEach((node, index) => {
                            if (node.scrollTop || node.scrollLeft) {
                              const id = String(scrolls.length);
                              copies[index].setAttribute('data-reference-scroll', id);
                              scrolls.push({id, top:node.scrollTop, left:node.scrollLeft});
                            }
                          });
                          clone.querySelectorAll('script').forEach(node => node.remove());
                          clone.querySelectorAll('style').forEach(node => {
                            styles.push(node.textContent || '');
                            const link = document.createElement('link');
                            link.rel = 'stylesheet'; link.href = `__STYLE_${styles.length - 1}__`;
                            node.replaceWith(link);
                          });
                          return {html:'<!doctype html>' + clone.outerHTML,styles,scrolls,window:[scrollX,scrollY]};
                        }''')
                        text = frozen['html']
                        restore = '<script>const observed=' + json.dumps({'nodes': frozen['scrolls'], 'window': frozen['window']}) + ''';
const restore=()=>requestAnimationFrame(()=>{
  for(const item of observed.nodes){const node=document.querySelector('[data-reference-scroll="'+item.id+'"]');if(node){node.scrollTop=item.top;node.scrollLeft=item.left;}}
  window.scrollTo(...observed.window);
});window.addEventListener('load',()=>document.fonts.ready.then(restore));</script>'''
                        text = text.replace('</body>', restore + '</body>')
                        for index, style in enumerate(frozen['styles']):
                            data = style.encode(); name = f'styles/{sha(data)}.css'
                            files[name] = data
                            text = text.replace(f'__STYLE_{index}__', '../' + name)
                        name = f'views/{case["id"]}-{viewport["name"]}.html'
                        files[name] = text.encode()
                        record = {'case': case['id'], 'viewport': viewport['name'], 'page_errors': [], 'scroll': metrics,
                                  'horizontal_overflow': page.evaluate('document.documentElement.scrollWidth > innerWidth')}
                        if evidence:
                            evidence.mkdir(parents=True, exist_ok=True)
                            screenshot = evidence / f'{case["id"]}-{viewport["name"]}.png'
                            page.screenshot(path=str(screenshot), caret='hide')
                            assert_native_state(page, case)
                            record['screenshot'] = str(screenshot)
                        records.append(record)
                    finally:
                        page.close()
        finally:
            browser.close()

    mapping = {case['id']: {v['name']: f'views/{case["id"]}-{v["name"]}.html' for v in VIEWPORTS} for case in CASES}
    loader = '''<!doctype html><html><head><meta charset="utf-8"><title>Native component reference</title>
<style>html,body{margin:0;width:100%;height:100%;overflow:hidden}iframe{border:0;width:100%;height:100%;display:block}</style></head>
<body><iframe title="Frozen native component reference" id="reference"></iframe><script>
const scenes=__SCENES__, sizes=__SIZES__;
const selected=new URLSearchParams(location.search).get('scene');
const scene=Object.hasOwn(scenes,selected)?selected:Object.keys(scenes)[0];
const viewport=[...sizes].sort((a,b)=>Math.abs(a.width-innerWidth)-Math.abs(b.width-innerWidth))[0].name;
document.getElementById('reference').src=scenes[scene][viewport];
</script></body></html>'''.replace('__SCENES__', json.dumps(mapping)).replace('__SIZES__', json.dumps(VIEWPORTS))
    files['prototype.html'] = loader.encode()
    sources = [{'path': f'{PREFIX}/references/foundations.md', 'sha256': sha((SKILL / 'references/foundations.md').read_bytes())}]
    manifest = {
        'schema_version': 1, 'kind': 'frozen-native-conversation-reference', 'mode': 'high_fidelity',
        'revision': 'poo170-poo179-native-reuse-r1',
        'files': {'prototype': 'prototype.html', **{f'asset_{i}': name for i, name in enumerate(sorted(files)) if name != 'prototype.html'}},
        'target': {'languages': ['zh-Hans', 'en'], 'themes': ['light'],
                   'viewports': [{'id': v['name'], 'width': v['width'], 'height': v['height']} for v in VIEWPORTS]},
        'scenes': [{'id': case['id'], 'state': case['state'], 'title': case['id'], 'source_entry': 'prototype.html'} for case in CASES],
        'design': {'skill_path': f'{PREFIX}/SKILL.md', 'sha256': sha((SKILL / 'SKILL.md').read_bytes()), 'sources': sources},
        'confirmations': [{'id': 'D-ASSISTANT-REUSE', 'status': 'confirmed',
                           'source': f'{PREFIX}/references/policy-alignment.json#D-ASSISTANT-REUSE',
                           'scope': 'Preserve current renderer components/styles only; no new layout or fix outcome is visually approved.'},
                          {'id': 'D-CURRENT-STYLE', 'status': 'confirmed',
                           'source': f'{PREFIX}/references/policy-alignment.json#D-CURRENT-STYLE',
                           'scope': 'Existing settings, forms and dialogs keep their real renderer styles. Current untranslated copy is implementation evidence, not a new product design.'}],
        'provenance': {'generator': f'{PREFIX}/tools/export-conversation-references.py',
                       'source_manifest': f'{PREFIX}/assets/source-baseline/baseline-manifest.json',
                       'source_input_fingerprint': baseline['input_fingerprint'], 'source_export_sha256': sha(html.read_bytes()),
                       'method': 'Actual Chromium render and native click/key replay; cloned DOM with product scripts removed only from reference. Reference-only script restores observed scroll offsets. Live React runtime remains unchanged.',
                       'fixed_reference_clock': '2026-10-28T12:00:00Z',
                       'scope': 'Component smoke references; not Electron/backend acceptance and not bug before/after proof.'},
    }
    files['prototype-manifest.json'] = encode(manifest)
    for task, port in [('POO-170', 43170), ('POO-179', 43179)]:
        routes = [{'name': case['id'], 'state': case['state'],
                   'actual': f'/entries/baseline.html?scene={case["scene"]}&pure=1&lang={case["lang"]}',
                   'whole_page': True, 'capture_full_page': True, 'actual_steps': steps(case), 'state_assertions': assertions(case)}
                  for case in CASES if case['task'] == task]
        files[f'{task}-visual-plan.json'] = encode({'e2e': {'visual': {'mode': 'smoke', 'viewports': VIEWPORTS, 'routes': routes}}})
        files[f'{task}-runtime-manifest.json'] = encode({'services': {'frontend': {
            'url': f'http://127.0.0.1:{port}', 'cwd': f'{PREFIX}/tools/source-baseline',
            'start': f'../../../../../node_modules/.bin/vite --config vite.config.mjs --host 127.0.0.1 --port {port} --strictPort',
            'health_check': '/entries/baseline.html',
        }}})
    if evidence:
        (evidence / 'capture-receipt.json').write_bytes(encode({'cases': records, 'browser_closed': True,
            'limits': ['State coverage only, not bug before/after.', 'Local fixtures replace backend data; production components and handlers render every runtime state.']}))
    return files


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--check', action='store_true')
    parser.add_argument('--evidence', type=Path)
    args = parser.parse_args()
    files = expected_outputs(args.evidence)
    if args.check:
        different = [name for name, data in files.items() if not (OUTPUT / name).is_file() or (OUTPUT / name).read_bytes() != data]
        if different:
            raise SystemExit('stale native conversation references: ' + ', '.join(different))
    else:
        previous = OUTPUT / 'prototype-manifest.json'
        if previous.is_file():
            old = json.loads(previous.read_text())
            if old.get('provenance', {}).get('generator') != f'{PREFIX}/tools/export-conversation-references.py':
                raise ValueError('refuse to replace an unowned reference export')
            for name in old['files'].values():
                if name not in files:
                    candidate = (OUTPUT / name).resolve()
                    if not candidate.is_relative_to(OUTPUT.resolve()):
                        raise ValueError('escaping previous generated asset')
                    candidate.unlink(missing_ok=True)
        for name, data in files.items():
            path = OUTPUT / name; path.parent.mkdir(parents=True, exist_ok=True); path.write_bytes(data)
    print(f'{len(CASES)} native states x {len(VIEWPORTS)} viewports; {len(files)} reference files current')


if __name__ == '__main__':
    main()
