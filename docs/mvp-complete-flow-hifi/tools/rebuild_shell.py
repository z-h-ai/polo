#!/usr/bin/env python3
"""POO-70 D-PC-07 重建 · 按官方模板重建 prototype.html 与 surface 运行时。

- prototype.html ← review-shell-template.html（data-prototype-mode 改 high_fidelity，manifest 占位符由 sync_manifest.py 填充）
- surface.html   ← 保留产品 CSS/DOM，仅将 manifest 之后的旧运行时替换为 product-surface-template 官方运行时
"""
import re
import sys
from pathlib import Path

BUNDLE = Path(__file__).resolve().parents[1]
SKILL_ASSETS = Path.home() / '.claude/skills/product-ui-prototype/assets'

SHELL = SKILL_ASSETS / 'review-shell-template.html'
SURFACE_TMPL = SKILL_ASSETS / 'product-surface-template.html'


def surface_runtime():
    """取官方 surface 模板里 manifest script 之后的运行时 <script> 块。"""
    template = SURFACE_TMPL.read_text(encoding='utf-8')
    match = re.search(
        r'<script id="prototype-manifest" type="application/json">.*?</script>\s*(<script>.*?</script>)',
        template, re.S,
    )
    if not match:
        raise SystemExit('official surface runtime block not found in template')
    return match.group(1)


def rebuild():
    # prototype.html：官方评审壳 + high_fidelity 模式
    shell = SHELL.read_text(encoding='utf-8')
    shell = shell.replace('<body data-prototype-mode="wireframe">',
                          '<body data-prototype-mode="high_fidelity">')
    if 'data-prototype-mode="high_fidelity"' not in shell:
        raise SystemExit('failed to switch review shell mode')
    (BUNDLE / 'prototype.html').write_text(shell, encoding='utf-8')

    # surface.html：仅换运行时（manifest script 与 </body> 之间的旧 <script>…</script>）
    surface_path = BUNDLE / 'surface.html'
    surface = surface_path.read_text(encoding='utf-8')
    pattern = re.compile(
        r'(<script id="prototype-manifest" type="application/json">.*?</script>)\s*<script>.*?</script>(\s*</body>)',
        re.S,
    )
    if not pattern.search(surface):
        raise SystemExit('old surface runtime block not found')
    surface = pattern.sub(lambda m: m.group(1) + '\n' + surface_runtime() + m.group(2), surface, count=1)
    surface_path.write_text(surface, encoding='utf-8')

    print('prototype.html rebuilt from official review shell (high_fidelity)')
    print('surface.html runtime replaced with official product-surface runtime')


if __name__ == '__main__':
    try:
        rebuild()
    except SystemExit as e:
        if e.code:
            print(f'ERROR: {e.code}', file=sys.stderr)
            sys.exit(1)
