#!/usr/bin/env python3
"""POO-196 批2 A 档证据采集驱动。

附着 run.mjs（POO196_CDP_PORT）暴露的 Electron 巡游窗口，按 tour-spec.json 逐
状态出带凭据截图：复用 diff-summary skill 的 capture_page（identity/state 在
真实 DOM 上核验 + sha256 回执）。main.ts 的 evidenceTour() 布置好一个状态后把
状态名写进 window.__poo196.tourState 并等待 $POO196_TOUR_DIR/advance 出现同名
内容；驱动等到状态名 → 截图 → 写放行文件。

某状态在当前树不存在（如 before 树没有能力通知/加载更多/预览覆盖层）时，
capture_page 的状态检查会失败：驱动记 absent 并照常放行，让巡游继续。

用法:
  python3 capture_tour.py --cdp http://127.0.0.1:9222 \
    --spec tour-spec.json --side after --source-ref <sha> \
    --tour-dir /tmp/poo196-tour --out /tmp/diff-summary-<id>/
"""
import argparse
import json
import sys
import time
import urllib.request
from datetime import datetime, timezone
from pathlib import Path

SKILL_SCRIPTS = Path.home() / '.claude' / 'skills' / 'diff-summary' / 'scripts'
sys.dont_write_bytecode = True
sys.path.insert(0, str(SKILL_SCRIPTS))

from capture import capture_page  # noqa: E402
from playwright.sync_api import sync_playwright  # noqa: E402


class ElectronPage:
    """capture_page 要求 page.viewport_size 与凭据一致；CDP 附着的真实窗口没有
    Playwright 视口覆盖，用窗口真实内尺寸回答，其余全部透传。"""

    def __init__(self, page, viewport):
        self._page = page
        self._viewport = {'width': viewport[0], 'height': viewport[1]}

    def __getattr__(self, name):
        return getattr(self._page, name)

    @property
    def viewport_size(self):
        return dict(self._viewport)


def find_host_page(browser):
    for context in browser.contexts:
        for page in context.pages:
            try:
                if page.evaluate('Boolean(window.__poo196 && window.__poo196.ready)'):
                    return page
            except Exception:
                continue
    raise RuntimeError('host page with window.__poo196 not found over CDP')


def wait_tour_state(page, name, timeout_s=300):
    end = time.time() + timeout_s
    while time.time() < end:
        try:
            current = page.evaluate('String(window.__poo196 && window.__poo196.tourState || "")')
            if current == name:
                return
        except Exception:
            pass
        time.sleep(0.2)
    raise RuntimeError(f'tour state {name} never appeared')


def resolve_ws_endpoint(cdp: str) -> str:
    """Electron 的 DevTools HTTP 端点对 Playwright 追加的尾部斜杠（/json/version/）
    返回 404，所以先自取 webSocketDebuggerUrl 再以 ws:// 直连。"""
    base = cdp.rstrip('/')
    with urllib.request.urlopen(f'{base}/json/version', timeout=10) as response:
        payload = json.loads(response.read().decode('utf-8'))
    return payload['webSocketDebuggerUrl']


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--cdp', required=True)
    parser.add_argument('--spec', required=True)
    parser.add_argument('--side', required=True, choices=('before', 'after'))
    parser.add_argument('--source-ref', required=True)
    parser.add_argument('--tour-dir', default='/tmp/poo196-tour')
    parser.add_argument('--out', required=True)
    args = parser.parse_args()

    spec = json.loads(Path(args.spec).read_text(encoding='utf-8'))
    out = Path(args.out).absolute()
    out.mkdir(parents=True, exist_ok=True)
    ack = Path(args.tour_dir) / 'advance'
    results = []

    with sync_playwright() as pw:
        browser = pw.chromium.connect_over_cdp(resolve_ws_endpoint(args.cdp))
        page = find_host_page(browser)
        size = page.evaluate('[window.innerWidth, window.innerHeight]')
        shim = ElectronPage(page, size)
        for state in spec['states']:
            name = state['name']
            wait_tour_state(page, name)
            ui = {
                'kind': 'screenshot',
                'source_ref': args.source_ref,
                'object': state['object'],
                'state': state['state'],
                'role': state['role'],
                'data': state['data'],
                'viewport': size,
                'identity': state['identity'],
                'note': f'真实 Electron 渲染（{args.side} 树构建产物，CDP 附着采集）',
            }
            try:
                recorded = capture_page(
                    shim, ui, state['selectors'], state['state_checks'],
                    str(out / f'{args.side}-{name}.png'),
                )
                results.append({'name': name, 'ok': True, 'ui': recorded})
                print(f'[{args.side}] {name}: captured')
            except Exception as error:
                results.append({'name': name, 'ok': False, 'absent': True,
                                'reason': str(error)[:300]})
                print(f'[{args.side}] {name}: ABSENT ({str(error)[:200]})')
            ack.write_text(name, encoding='utf-8')

    (out / f'{args.side}-tour-results.json').write_text(
        json.dumps({'side': args.side, 'source_ref': args.source_ref,
                    'viewport': size, 'captured_at': datetime.now(timezone.utc).isoformat(),
                    'results': results}, ensure_ascii=False, indent=2) + '\n',
        encoding='utf-8')
    print(f"[{args.side}] done: {sum(1 for r in results if r['ok'])}/{len(results)} captured")


if __name__ == '__main__':
    main()
