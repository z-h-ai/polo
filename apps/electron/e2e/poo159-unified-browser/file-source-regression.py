#!/usr/bin/env python3
"""Real Chromium regression for FilePreviewPane HTML render/source round trips.

From repo root (requires bun, python Playwright and its Chromium, as provided by
scripts/prototype-browser-requirements.txt; existing renderer CSS must be built):
  python3 apps/electron/e2e/poo159-unified-browser/file-source-regression.py \
    --evidence-dir .pipeline/sdlc/POO-159/file-source-check

Bundles the CURRENT production component into an isolated temporary fixture;
never builds app dist, attaches to an existing browser, or reads a user profile.
Header/CodeBlock peers and translations are stubs. The iframe, source toggle,
layout classes and visibility come from production; CSS comes from the current
renderer index.html. All temporary build/profile resources close in finally.
"""
import argparse
import hashlib
import importlib.metadata
import json
import os
from pathlib import Path
import re
import subprocess
import tempfile
import time

from playwright.sync_api import sync_playwright

REPO = Path(__file__).resolve().parents[4]
COMPONENT = REPO / 'apps/electron/src/renderer/components/app-shell/FilePreviewPane.tsx'
FIXTURE = '''<!doctype html><html><head><title>HTML state fixture</title></head>
<body><input id="draft" aria-label="Draft"><button id="increment">Increment</button>
<span id="count">0</span><main>__ROWS__</main>
<script>window.instanceToken=Math.random().toString(36);window.keyEvents=0;
let count=0;document.getElementById('increment').onclick=()=>document.getElementById('count').textContent=String(++count);
addEventListener('keydown',()=>window.keyEvents++);</script></body></html>'''
FIXTURE = FIXTURE.replace('__ROWS__', ''.join(f'<p style="height:40px;margin:0">Row {i}</p>' for i in range(1, 71)))
BUILD = r'''
import { build } from 'esbuild';
import { join } from 'node:path';
const out = process.env.POO159_COMPONENT_WORK;
await build({ entryPoints:[join(out,'entry.tsx')], outfile:join(out,'bundle.js'), bundle:true, format:'iife', platform:'browser', jsx:'automatic', plugins:[{
 name:'fixture-peers', setup(b) {
  b.onResolve({filter:/^@polo-ai\/ui$/},()=>({path:'ui',namespace:'fixture'}));
  b.onResolve({filter:/^react-i18next$/},()=>({path:'i18n',namespace:'fixture'}));
  b.onLoad({filter:/.*/,namespace:'fixture'},a=>({loader:'tsx',resolveDir:process.cwd(),contents:a.path==='i18n' ?
   `export const useTranslation=()=>({t:(key)=>key});` :
   `import React from 'react';
    export const FullscreenOverlayBaseHeader=({filePath,headerActions,onClose})=><header style={{height:48,flexShrink:0,display:'flex',alignItems:'center'}}><span>{filePath}</span>{headerActions}<button onClick={onClose}>Close</button></header>;
    export const CodeBlock=({code})=><pre data-testid="source-code">{code}</pre>;
    export const CodePreviewOverlay=()=>null;export const ImagePreviewOverlay=()=>null;export const JSONPreviewOverlay=()=>null;export const PDFPreviewOverlay=()=>null;
    export const Markdown=({children})=><div>{children}</div>;`
  }));
 }
}]});
'''
STATE = '''() => ({input:document.querySelector('#draft').value,
 count:document.querySelector('#count').textContent,scrollY,scrollMax:document.documentElement.scrollHeight-innerHeight,
 width:innerWidth,height:innerHeight,instance:window.instanceToken,keys:window.keyEvents,
 parentBlocked:(()=>{try{void parent.document.body;return false}catch{return true}})(),
 bridgeAbsent:typeof window.electronAPI==='undefined'})'''


def digest(path):
    return hashlib.sha256(Path(path).read_bytes()).hexdigest()


def save(path, value):
    path.write_text(json.dumps(value, indent=2, ensure_ascii=False) + '\n')


def capture(page, evidence, name, state):
    # Capture identity/state together with the image, never add provenance later.
    assert page.locator('header').inner_text().startswith('fixture/guide.html')
    path = evidence / f'{name}.png'
    page.locator('#root').screenshot(path=str(path))
    save(evidence / f'{name}.capture.json', {
        'kind': 'isolated real Chromium component regression',
        'resource': 'fixture/guide.html', 'state': state,
        'viewport': page.viewport_size, 'dpr': page.evaluate('devicePixelRatio'),
        'visible_identity': page.locator('header').inner_text(), 'sha256': digest(path),
    })


def run(evidence):
    evidence.mkdir(parents=True, exist_ok=True)
    renderer = REPO / 'apps/electron/dist/renderer'
    index = (renderer / 'index.html').read_text()
    stylesheets = [renderer / href.lstrip('./') for href in re.findall(r'<link[^>]+href="([^"]+\.css)"', index)]
    if not stylesheets:
        raise RuntimeError('No current production CSS in dist/renderer/index.html')
    result = {
        'component': str(COMPONENT.relative_to(REPO)), 'component_sha256': digest(COMPONENT),
        'css': {str(p.relative_to(REPO)): digest(p) for p in stylesheets},
        'playwright_version': importlib.metadata.version('playwright'),
        'fixture_boundary': 'Production FilePreviewPane/iframe/layout/toggle; sibling header/code and translations stubbed; current production CSS; independent headless profile.',
        'checks': {},
    }
    ledger = {'owner': 'POO-159 isolated file-source regression', 'pid': os.getpid(),
              'purpose': 'real opaque iframe source/render state regression',
              'release': 'finally context.close + temporary directory cleanup', 'browser_pids': []}
    # Build entry stays under the repo so the existing workspace node_modules
    # resolves naturally, and its entire directory is removed on every exit.
    work_root = REPO / '.pipeline/sdlc/POO-159'
    work_root.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory(prefix='file-source-work-', dir=work_root) as directory:
        work = Path(directory)
        ledger['work_directory'] = str(work)
        save(evidence / 'resources.json', ledger)
        entry = "import React from 'react';import {createRoot} from 'react-dom/client';\n"
        entry += f'import {{FilePreviewPane}} from {json.dumps(str(COMPONENT))};\n'
        entry += f'const state={{type:"html",filePath:"fixture/guide.html",content:{json.dumps(FIXTURE)}}};\n'
        entry += 'createRoot(document.getElementById("root")).render(<FilePreviewPane state={state} onClose={()=>{}} onRetry={()=>{}} loadDataUrl={async()=>""} loadPdfData={async()=>new Uint8Array()} isDark={false}/>);'
        (work / 'entry.tsx').write_text(entry)
        built = subprocess.run(['bun', '-e', BUILD], cwd=REPO,
                               env={**os.environ, 'POO159_COMPONENT_WORK': str(work)}, capture_output=True, text=True)
        (evidence / 'fixture-build.log').write_text(built.stdout + built.stderr)
        if built.returncode:
            raise RuntimeError(f'Isolated fixture bundle failed: {built.returncode}')
        css = '\n'.join(p.read_text() for p in stylesheets)
        html = '<!doctype html><html><head><style>' + css + '</style></head><body style="margin:0"><div id="root" style="width:347px;height:723px"></div><script>' + (work / 'bundle.js').read_text() + '</script></body></html>'
        with sync_playwright() as playwright:
            context = None
            session = None
            try:
                context = playwright.chromium.launch_persistent_context(str(work / 'profile'), headless=True,
                           viewport={'width': 500, 'height': 800}, device_scale_factor=1, args=['--site-per-process'])
                page = context.pages[0]
                result['browser_version'] = context.browser.version
                session = context.browser.new_browser_cdp_session()
                processes = session.send('SystemInfo.getProcessInfo')['processInfo']
                ledger['browser_pids'] = [p['id'] for p in processes]
                save(evidence / 'resources.json', ledger)
                page.set_content(html)
                iframe = page.locator('iframe')
                iframe.wait_for(state='visible')
                frame = page.frames[1]
                frame.wait_for_selector('#increment')
                native_frame = context.new_cdp_session(frame)
                target = native_frame.send('Target.getTargetInfo')['targetInfo']['targetId']
                element = iframe.element_handle()
                frame.fill('#draft', 'POO-159 保留')
                for _ in range(3):
                    frame.click('#increment')
                frame.evaluate('scrollTo(0,900)')
                page.wait_for_timeout(100)
                before = frame.evaluate(STATE)
                result['before'] = {**before, 'target': target}
                capture(page, evidence, 'before', result['before'])
                toggle = page.get_by_title('browserPane.sidebar.viewSource')
                toggle.click()
                page.locator('[data-testid="source-code"]').wait_for(state='visible')
                page.wait_for_timeout(100)
                source_box = iframe.evaluate('(el)=>{const r=el.getBoundingClientRect();return {width:r.width,height:r.height,visibility:getComputedStyle(el).visibility,display:getComputedStyle(el).display}}')
                # Real mouse/keyboard input at the former iframe control position
                # must not reach the hidden frame while the source overlay is up.
                page.mouse.click(32, 64)
                page.keyboard.type('blocked')
                source = frame.evaluate(STATE)
                result['source'] = {**source, 'box': source_box,
                                    'parent_focus_is_iframe': page.evaluate('document.activeElement===document.querySelector("iframe")')}
                capture(page, evidence, 'source', result['source'])
                toggle.click()
                page.wait_for_timeout(600)
                after = frame.evaluate(STATE)
                result['after'] = {**after, 'target': native_frame.send('Target.getTargetInfo')['targetInfo']['targetId']}
                capture(page, evidence, 'after', result['after'])
                result['checks'] = {
                    'prepared_real_midpage_state': before['scrollY'] == 900 and before['scrollMax'] > 1500 and before['count'] == '3',
                    'same_iframe_target_and_heap': result['after']['target'] == target and after['instance'] == before['instance'] and element.evaluate('(el)=>el===document.querySelector("iframe")'),
                    'source_retains_layout': source_box['width'] == before['width'] and source_box['height'] == before['height'],
                    'source_scroll_preserved': source['scrollY'] == before['scrollY'],
                    'source_blocks_input': not result['source']['parent_focus_is_iframe'] and source['input'] == before['input'] and source['keys'] == before['keys'],
                    'roundtrip_input_and_counter': after['input'] == before['input'] and after['count'] == before['count'],
                    'roundtrip_scroll': after['scrollY'] == before['scrollY'],
                    'roundtrip_viewport': (after['width'], after['height']) == (before['width'], before['height']),
                    'sandbox_and_bridge_unchanged': iframe.get_attribute('sandbox') == 'allow-scripts' and before['parentBlocked'] and after['parentBlocked'] and after['bridgeAbsent'],
                }
            finally:
                if session:
                    try:
                        latest = session.send('SystemInfo.getProcessInfo')['processInfo']
                        ledger['browser_pids'] = sorted(set(ledger['browser_pids']) | {p['id'] for p in latest})
                        save(evidence / 'resources.json', ledger)
                    except Exception as error:
                        ledger['process_snapshot_error'] = str(error)
                if context:
                    context.close()
        # Browser.close waits for the own browser; verify the captured native
        # PIDs are gone rather than treating a disconnect as cleanup.
        deadline = time.monotonic() + 3
        alive = []
        while True:
            alive = [pid for pid in ledger['browser_pids'] if subprocess.run(['kill', '-0', str(pid)], capture_output=True).returncode == 0]
            if not alive or time.monotonic() >= deadline:
                break
            time.sleep(.1)
        ledger['alive_after_close'] = alive
    ledger['work_directory_removed'] = not Path(ledger['work_directory']).exists()
    ledger['status'] = 'reclaimed' if not ledger.get('alive_after_close') and ledger['work_directory_removed'] else 'cleanup_failed'
    save(evidence / 'resources.json', ledger)
    result['pass'] = sum(result['checks'].values())
    result['fail'] = len(result['checks']) - result['pass']
    result['resources_reclaimed'] = ledger['status'] == 'reclaimed'
    save(evidence / 'result.json', result)
    print(json.dumps(result, ensure_ascii=False))
    return 0 if result['fail'] == 0 and result['resources_reclaimed'] else 1


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--evidence-dir', type=Path, required=True)
    args = parser.parse_args()
    evidence = args.evidence_dir.resolve()
    try:
        status = run(evidence)
    except BaseException as error:
        # Context/profile finally blocks have already run. Preserve a failed
        # invocation and its cleanup state rather than losing the resource ledger.
        evidence.mkdir(parents=True, exist_ok=True)
        path = evidence / 'resources.json'
        ledger = json.loads(path.read_text()) if path.exists() else {}
        alive = [pid for pid in ledger.get('browser_pids', []) if subprocess.run(['kill', '-0', str(pid)], capture_output=True).returncode == 0]
        ledger.update({'error': str(error), 'alive_after_error': alive,
                       'work_directory_removed': not Path(ledger.get('work_directory', '/nonexistent')).exists()})
        ledger['status'] = 'reclaimed_after_error' if not alive and ledger['work_directory_removed'] else 'cleanup_failed'
        save(path, ledger)
        raise
    raise SystemExit(status)
