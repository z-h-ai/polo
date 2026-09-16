#!/usr/bin/env python3
"""POO-71 v2 重建 · 第 2 步：组装 surface.html 产品表面。

输入 build/scenes.json（90 个静态场景）与 v1 的 G4 产品 CSS，完成：
  1. 剥离演示 chrome 样式（demo-rail / note-panel / overlay / window-guard / preview-1024）；
  2. position: fixed -> absolute（scene 作为 relative 容器，满足 v2 禁 fixed 约束）；
  3. 追加 scene 容器与「分支」条目的适配样式；
  4. 按 product-surface-template.html 的运行时契约落成 surface.html。

manifest 由 sync_manifest.py 之后精确嵌入，这里只留占位符。
"""
import json
import re
from pathlib import Path

BUNDLE = Path(__file__).resolve().parents[1]
V1 = BUNDLE / 'sources' / 'prototype-v1.html'
SCENES = BUNDLE / 'build' / 'scenes.json'
OUT = BUNDLE / 'surface.html'

RUNTIME = """(()=>{'use strict';const manifest=JSON.parse(document.getElementById('prototype-manifest').textContent);const byScene=new Map(manifest.scenes.map(scene=>[scene.id,scene]));const elements=new Map([...document.querySelectorAll('[data-prototype-scene]')].map(element=>[element.dataset.prototypeScene,element]));let current=manifest.start_scene;function settings(source){document.body.dataset.theme=source.theme||manifest.target.themes[0];document.documentElement.lang=source.language||document.documentElement.lang;document.body.dataset.perspective=source.perspective||''}function announce(scene,reason,from=null,transition=null){window.parent.postMessage({type:'product-ui-prototype:scene-change',version:1,scene,reason,from,transition},'*')}function show(id,reason='command',from=null,transition=null){if(!byScene.has(id)||!elements.has(id))return;elements.forEach((element,key)=>element.classList.toggle('active',key===id));current=id;document.body.dataset.currentScene=id;announce(id,reason,from,transition)}document.addEventListener('click',event=>{const action=event.target.closest('[data-go]');if(!action)return;const scene=byScene.get(current);const edge=scene.transitions.find(item=>item.id===action.dataset.transition&&item.to===action.dataset.go);if(!edge)return;show(edge.to,'action',current,edge.id)});window.addEventListener('message',event=>{if(event.source!==window.parent)return;const data=event.data;if(!data||data.type!=='product-ui-prototype:show-scene'||data.version!==1||!byScene.has(data.scene))return;settings(data);show(data.scene)});const query=new URLSearchParams(location.search);const hash=new URLSearchParams(location.hash.slice(1));const requested=hash.get('scene')||query.get('scene');settings({theme:query.get('theme'),language:query.get('lang'),perspective:query.get('perspective')});show(byScene.has(requested)?requested:manifest.start_scene,'ready')})();"""

# v1 中仅服务演示壳的样式（含子选择器），产品表面不保留
STRIP = ('#demo-rail', '#note-panel', '#overlay-root', '.overlay-',
         '.prototype-boundary-note', '.window-guard', 'body.preview-1024', 'body.clean')

# fixed -> absolute：scene 是 relative 容器，inset/锚点声明不变
FIXED_TO_ABS = ('.modal-layer', '.toast', '.system-screen', '.auth-ambient')

ADAPT_CSS = """
/* ---- POO-71 v2 表面适配（scene 容器 / 分支条） ---- */
html, body { height: 100%; }
[data-product-surface] { display: block; width: 100%; height: 100vh; }
.scene { position: relative; display: none; width: 100%; height: 100vh; overflow: hidden; }
.scene.active { display: block; }
.scene > .system-screen { height: 100%; }
.scenario-strip { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; margin-top: 10px; }
/* v1 的 assist 布局 row1 是「界面示意」标注条（评审物，已剥离）；其移除后让三栏骨架跨满 grid */
.workspace-main.assistant-mode > .assistant-shell { grid-row: 1 / -1; }
.state-actions .scenario-strip { flex-basis: 100%; justify-content: center; }
.scenario-jump { border: 1px dashed color-mix(in srgb, var(--foreground) 28%, transparent); background: transparent; color: var(--fg-30, var(--foreground)); font-size: 12px; }
.scenario-jump:hover { border-color: var(--accent); color: var(--accent); }
.popover .scenario-strip { margin: 6px 4px 2px; }
"""


def iter_rules(css):
    """按深度切分顶层规则；@media 等块产出 (selector, 内部文本)。"""
    out, buf, body, depth = [], '', '', 0
    for ch in css:
        if depth == 0:
            if ch == '{':
                depth, body = 1, ''
            else:
                buf += ch
        elif depth == 1:
            if ch == '{':
                depth += 1
                body += ch
            elif ch == '}':
                out.append((buf.strip(), body))
                buf, depth = '', 0
            else:
                body += ch
        else:
            if ch == '{':
                depth += 1
            elif ch == '}':
                depth -= 1
            body += ch
    return out


def strip_rules(css):
    """剔除演示 chrome 规则；@media 块按同样谓词过滤内部规则。"""
    removed, kept = [], []
    for sel, body in iter_rules(css):
        if sel.startswith('@'):
            inner = strip_rules(body)[1]
            kept.append((sel, inner))
        elif any(token in sel for token in STRIP):
            removed.append(sel)
        else:
            kept.append((sel, body))
    rendered = []
    for sel, body in kept:
        if sel.startswith('@'):
            rendered.append(f'{sel} {{ {body} }}')
        else:
            rendered.append(f'{sel} {{ {body} }}')
    return removed, '\n'.join(rendered)


def build_css():
    src = (V1.read_text(encoding='utf-8'))
    css = '\n'.join(re.findall(r'<style>(.*?)</style>', src, re.S))
    css = re.sub(r'/\*.*?\*/', '', css, flags=re.S)
    removed, css = strip_rules(css)
    for sel in FIXED_TO_ABS:
        css, n = re.subn(r'(' + re.escape(sel) + r'\s*\{[^}]*?)position\s*:\s*fixed',
                         r'\1position: absolute', css)
        assert n == 1, f'{sel}: expected 1 fixed rule, got {n}'
    return css + ADAPT_CSS, removed


def main():
    data = json.loads(SCENES.read_text(encoding='utf-8'))
    ids = list(data['scenes'])
    css, removed = build_css()
    body = '\n'.join(data['scenes'][sid]['html'] for sid in ids)
    page = f"""<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data:; connect-src 'none'; base-uri 'none'; form-action 'none'">
<title>Polo AI</title>
<style>
{css}
</style>
</head>
<body data-prototype-mode="high_fidelity" data-theme="light">
<main data-product-surface>
{body}
</main>
<script id="prototype-manifest" type="application/json">__PROTOTYPE_MANIFEST__</script>
<script>
{RUNTIME}
</script>
</body>
</html>
"""
    OUT.write_text(page, encoding='utf-8')
    print(f'surface.html: {len(ids)} scenes, css {len(css)} chars '
          f'({len(removed)} demo rules stripped) -> {OUT}')


if __name__ == '__main__':
    main()
