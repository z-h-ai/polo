#!/usr/bin/env python3
"""Freeze actual native billing-banner renders for the POO-177 smoke reference.

Runtime remains the live React components (ChatDisplay → ChatInputZone status
banner with the ChatPage decision mapping). The reference removes product
scripts and keeps observed DOM/CSS only. Actions stay local no-ops: no GET,
no latch recovery, no payment handoff is simulated.
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
OUTPUT = SKILL / 'assets/prototypes/interview-quota-banner'
VIEWPORTS = [
    {'name': 'desktop-1280x800', 'width': 1280, 'height': 800},
    {'name': 'desktop-1440x900', 'width': 1440, 'height': 900},
    {'name': 'compact-800x600', 'width': 800, 'height': 600},
]
# The two current implementation states (member/owner insufficient-credit) in
# the locales the source-baseline router supports (baseline.tsx maps lang to
# en/zh-Hans only). The POO-177 plan's de/hu/pl narrow-viewport copy checks
# belong to acceptance fixtures, not to this baseline.
CASES = [
    {'id': f'quota-{role}-{language}', 'scene': f'interview-quota-{role}',
     'state': 'insufficient-credit', 'lang': language, 'viewports': VIEWPORTS}
    for role in ('member', 'owner') for language in ('zh-Hans', 'en')
]


def sha(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def encode(value) -> bytes:
    return (json.dumps(value, ensure_ascii=False, indent=2) + '\n').encode()


def freeze_native_reference(page):
    """Read a clone of an actual native page; retain CSS and observed scrolls."""
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
    styles = {}
    for index, style in enumerate(frozen['styles']):
        data = style.encode(); name = f'styles/{sha(data)}.css'
        styles[name] = data
        text = text.replace(f'__STYLE_{index}__', '../' + name)
    return text.encode(), styles


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
                for viewport in case['viewports']:
                    page = browser.new_page(viewport={k: viewport[k] for k in ('width', 'height')}, device_scale_factor=1)
                    errors = []
                    page.on('pageerror', lambda error: errors.append(str(error)))
                    try:
                        page.clock.set_fixed_time(datetime(2026, 10, 29, 12, tzinfo=timezone.utc))
                        page.emulate_media(reduced_motion='reduce')
                        page.goto(html.as_uri() + f'?scene={case["scene"]}&pure=1&lang={case["lang"]}', wait_until='load')
                        page.locator('section').first.wait_for(state='visible')
                        page.wait_for_timeout(500)
                        page.evaluate('document.fonts.ready')
                        if errors:
                            raise ValueError(f'{case["id"]}: actual component failed: {errors}')
                        banner = page.locator('[data-testid="chat-status-banner"]')
                        if banner.count() != 1:
                            raise ValueError(f'{case["id"]}: expected exactly one status banner, got {banner.count()}')
                        if banner.get_attribute('data-banner-variant') != 'destructive':
                            raise ValueError(f'{case["id"]}: insufficient-credit banner must stay destructive')
                        text, styles = freeze_native_reference(page)
                        files.update(styles)
                        name = f'views/{case["id"]}-{viewport["name"]}.html'
                        files[name] = text
                        record = {'case': case['id'], 'viewport': viewport['name'], 'page_errors': [],
                                  'banner_variant': banner.get_attribute('data-banner-variant'),
                                  'banner_text': banner.inner_text(),
                                  'horizontal_overflow': page.evaluate('document.documentElement.scrollWidth > innerWidth')}
                        if evidence:
                            evidence.mkdir(parents=True, exist_ok=True)
                            screenshot = evidence / f'{case["id"]}-{viewport["name"]}.png'
                            page.screenshot(path=str(screenshot), caret='hide')
                            record['screenshot'] = str(screenshot)
                        records.append(record)
                    finally:
                        page.close()
        finally:
            browser.close()

    mapping = {case['id']: {v['name']: f'views/{case["id"]}-{v["name"]}.html'
                            for v in case['viewports']} for case in CASES}
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
        'schema_version': 1, 'kind': 'frozen-native-quota-banner-reference', 'mode': 'high_fidelity',
        'revision': 'poo177-native-reuse-r1',
        'files': {'prototype': 'prototype.html', **{f'asset_{i}': name for i, name in enumerate(sorted(files)) if name != 'prototype.html'}},
        'target': {'languages': ['zh-Hans', 'en'], 'themes': ['light'],
                   'viewports': [{'id': v['name'], 'width': v['width'], 'height': v['height']} for v in VIEWPORTS]},
        'scenes': [{'id': case['id'], 'state': case['state'], 'title': case['id'], 'source_entry': 'prototype.html'} for case in CASES],
        'design': {'skill_path': f'{PREFIX}/SKILL.md', 'sha256': sha((SKILL / 'SKILL.md').read_bytes()), 'sources': sources},
        'confirmations': [{'id': 'D-ASSISTANT-REUSE', 'status': 'confirmed',
                           'source': f'{PREFIX}/references/policy-alignment.json#D-ASSISTANT-REUSE',
                           'scope': 'Preserve current renderer components/styles only; no new layout or fix outcome is visually approved.'}],
        'provenance': {'generator': f'{PREFIX}/tools/export-quota-banner-references.py',
                       'source_manifest': f'{PREFIX}/assets/source-baseline/baseline-manifest.json',
                       'source_input_fingerprint': baseline['input_fingerprint'], 'source_export_sha256': sha(html.read_bytes()),
                       'method': 'Actual Chromium render; cloned DOM with product scripts removed only from reference; single status banner asserted per case. Live React runtime remains unchanged.',
                       'fixed_reference_clock': '2026-10-29T12:00:00Z',
                       'scope': 'Component smoke references of the current billing-banner states; not Electron/backend acceptance, not the POO-177 refresh behaviour, and not bug before/after proof. de/hu/pl narrow-viewport copy checks are acceptance-fixture scope (source-baseline router maps lang to en/zh-Hans only).'},
    }
    files['prototype-manifest.json'] = encode(manifest)
    port = 43177
    routes = [{'name': case['id'], 'state': case['state'],
               'actual': f'/entries/baseline.html?scene={case["scene"]}&pure=1&lang={case["lang"]}',
               'whole_page': True, 'capture_full_page': True, 'actual_steps': [],
               'state_assertions': [{'type': 'visible', 'selector': '[data-testid="chat-status-banner"]'}]}
              for case in CASES]
    files['POO-177-visual-plan.json'] = encode({'e2e': {'visual': {'mode': 'smoke', 'viewports': VIEWPORTS, 'routes': routes}}})
    files['POO-177-runtime-manifest.json'] = encode({'services': {'frontend': {
        'url': f'http://127.0.0.1:{port}', 'cwd': f'{PREFIX}/tools/source-baseline',
        'start': f'../../../../../node_modules/.bin/vite --config vite.config.mjs --host 127.0.0.1 --port {port} --strictPort',
        'health_check': '/entries/baseline.html',
    }}})
    if evidence:
        (evidence / 'capture-receipt.json').write_bytes(encode({'cases': records, 'browser_closed': True,
            'limits': ['Current-state coverage only; the POO-177 refresh behaviour is implemented later and captured by its own acceptance evidence.', 'Local fixtures replace backend data; production components and handlers render every runtime state.']}))
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
            raise SystemExit('stale native quota banner references: ' + ', '.join(different))
    else:
        previous = OUTPUT / 'prototype-manifest.json'
        if previous.is_file():
            old = json.loads(previous.read_text())
            if old.get('provenance', {}).get('generator') != f'{PREFIX}/tools/export-quota-banner-references.py':
                raise ValueError('refuse to replace an unowned reference export')
            for name in old['files'].values():
                if name not in files:
                    candidate = (OUTPUT / name).resolve()
                    if not candidate.is_relative_to(OUTPUT.resolve()):
                        raise ValueError('escaping previous generated asset')
                    candidate.unlink(missing_ok=True)
        for name, data in files.items():
            path = OUTPUT / name; path.parent.mkdir(parents=True, exist_ok=True); path.write_bytes(data)
    print(f'{len(CASES)} native states; {len(files)} reference files current')


if __name__ == '__main__':
    main()
