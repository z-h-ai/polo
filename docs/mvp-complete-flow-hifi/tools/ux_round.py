#!/usr/bin/env python3
"""ux-r1 · 用户走查迭代同步工具。

将 surface.html 的 DOM 边（data-go/data-transition）作为唯一事实来源：
  1. 按 DOM 顺序对每个场景 canonical 重编号（T-<场景>-NNN-<目标>）；
  2. 同步 prototype-manifest.json 的 scenes[].transitions；
  3. 将同一份 manifest 写回 surface.html 与 prototype.html 的内嵌 <script id="prototype-manifest">。

用法：python3 tools/ux_round.py            # 三方同步（DOM → manifest → 两个 HTML）
本工具不修改场景文案与故事；故事/修订说明由迭代补丁单独维护。
"""
import json
import re
from collections import OrderedDict
from pathlib import Path

BUNDLE = Path(__file__).resolve().parents[1]
TAG_RE = re.compile(r'<(button|a)\b[^>]*?data-go="([^"]+)"[^>]*?data-transition="([^"]*)"[^>]*>(.*?)</\1>', re.S)
ATTR_RE = re.compile(r'(data-go="[^"]+"[^>]*?data-transition=")([^"]*)(")')


def extract_edges(blk):
    out = []
    for m in TAG_RE.finditer(blk):
        label = re.sub(r'<[^>]+>', '', m.group(4))
        label = re.sub(r'\s+', ' ', label).strip()[:40]
        out.append({'go': m.group(2), 'span': m.span(), 'label': label})
    return out


def renumber(blk, sid, titles):
    edges = extract_edges(blk)
    result = [{'id': f'T-{sid}-{i+1:03d}-{e["go"]}', 'label': e['label'], 'to': e['go'],
               'feedback': f'切换到「{titles[e["go"]]}」'} for i, e in enumerate(edges)]
    for idx in range(len(edges) - 1, -1, -1):
        e = edges[idx]
        m = ATTR_RE.search(blk, e['span'][0], e['span'][1])
        if not m:
            raise AssertionError(f'{sid}: attr not found at {e["span"]}')
        blk = blk[:m.start()] + m.group(1) + result[idx]['id'] + m.group(3) + blk[m.end():]
    return blk, result


def main():
    manifest = json.loads((BUNDLE / 'prototype-manifest.json').read_text(encoding='utf-8'))
    titles = {s['id']: s['title'] for s in manifest['scenes']}
    surface = (BUNDLE / 'surface.html').read_text(encoding='utf-8')

    head_end = surface.find('<main data-product-surface>\n') + len('<main data-product-surface>\n')
    tail_start = surface.find('\n</main>\n<script id="prototype-manifest"')
    body = surface[head_end:tail_start]
    blocks, order = {}, []
    for m in re.finditer(r'<section class="scene" data-prototype-scene="', surface):
        sid_m = re.match(r'<section class="scene" data-prototype-scene="([^"]+)"', surface[m.start():m.start()+200])
        order.append(sid_m.group(1))
    starts = [mm.start() for mm in re.finditer(r'<section class="scene" data-prototype-scene="', surface)]
    for i, st in enumerate(starts):
        en = starts[i + 1] if i + 1 < len(starts) else tail_start
        seg = surface[st:en].rstrip('\n')
        sid = re.match(r'<section class="scene" data-prototype-scene="([^"]+)"', seg).group(1)
        blocks[sid] = seg

    by_id = {s['id']: s for s in manifest['scenes']}
    new_body_parts = []
    seen = set()
    for sid in order:
        blk, edges = renumber(blocks[sid], sid, titles)
        new_body_parts.append(blk)
        seen.add(sid)
        sc = by_id.setdefault(sid, {'id': sid})
        if 'transitions' not in sc:
            sc['transitions'] = edges
        else:
            old, new = {t['id'] for t in sc['transitions']}, {t['id'] for t in edges}
            if old == new:
                sc['transitions'] = edges  # 顺序/label 以 DOM 为准
            else:
                sc['transitions'] = edges
    missing = [sid for sid in by_id if sid not in seen]
    if missing:
        raise SystemExit(f'manifest 场景缺少 DOM: {missing}')
    manifest['scenes'] = [by_id[sid] for sid in order]

    new_json = json.dumps(manifest, ensure_ascii=False, separators=(',', ':'))
    out = surface[:head_end] + '\n'.join(new_body_parts) + surface[tail_start:]
    m = re.search(r'(<script id="prototype-manifest" type="application/json">).*?(</script>)', out, re.S)
    out = out[:m.start()] + m.group(1) + new_json + m.group(2) + out[m.end():]
    (BUNDLE / 'surface.html').write_text(out, encoding='utf-8')

    proto = (BUNDLE / 'prototype.html').read_text(encoding='utf-8')
    m = re.search(r'(<script id="prototype-manifest" type="application/json">).*?(</script>)', proto, re.S)
    proto = proto[:m.start()] + m.group(1) + new_json + m.group(2) + proto[m.end():]
    (BUNDLE / 'prototype.html').write_text(proto, encoding='utf-8')

    (BUNDLE / 'prototype-manifest.json').write_text(json.dumps(manifest, ensure_ascii=False, indent=1) + '\n', encoding='utf-8')
    total = sum(len(s['transitions']) for s in manifest['scenes'])
    print(f'ux_round sync OK: {len(manifest["scenes"])} scenes, {total} transitions (three-way consistent)')


if __name__ == '__main__':
    main()
