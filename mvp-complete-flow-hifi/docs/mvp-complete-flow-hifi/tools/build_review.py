#!/usr/bin/env python3
"""POO-71 v2 重建 · 第 4 步：从 skill 模板生成 prototype.html 评审壳。

模板运行时原样保留；本轮仅做四处替换：
  1. data-prototype-mode -> high_fidelity；
  2. 评审 brief 增加静态「本轮待裁决」段；
  3. renderScene 注入 renderBrief()（按当前场景填充 现状/差异/依据/评审问题）；
  4. 注入 renderBrief 实现与 per-round 文案。
manifest 占位符由 sync_manifest.py 嵌入。
"""
from pathlib import Path

BUNDLE = Path(__file__).resolve().parents[1]
TEMPLATE = Path.home() / '.claude' / 'skills' / 'product-ui-prototype' / 'assets' / 'review-shell-template.html'
OUT = BUNDLE / 'prototype.html'

BRIEF_HTML = (
    '<section class="inspector-panel review-brief" data-review-brief hidden><h2>本轮评审</h2>'
    '<p><strong>现在怎样：</strong><span data-review-current></span></p>'
    '<p><strong>改成怎样：</strong><span data-review-target></span></p>'
    '<p><strong>为什么改：</strong><span data-review-reason></span></p>'
    '<p><strong>评审问题：</strong><span data-review-question></span></p>'
    '<p><strong>本轮待裁决：</strong>① 个人空间经切换器直切企业空间未走运行确认（C-R04 严格读法应有确认帧，v1 亦无）；'
    '② P-M04-APP-VIEW 为共用容器帧，不同 App/准备态共用布局，内部一律中性 FDE 占位；'
    '③ 「分支：」虚线按钮是评审分支入口（无自然产品入口的失败/取消路径），验收时不计入产品操作。'
    '详见 review.md 与 visual-acceptance.md。</p></section>'
)

BRIEF_JS = """
const ROUND_CURRENT='v1 单文件原型（revision poo71-hifi-v1-single-file）已确认 90 屏内容；运行时为 JS 构建器加演示控制区。';
const ROUND_TARGET='本阶段重建为 product-ui-prototype v2：surface.html 纯产品表面，场景交互全部静态声明为 transitions（G4 冻结稿视觉）';
const ROUND_REASON='POO-71 要求以 product-ui-prototype 重建；内容与 POO-70 已确认结论绑定，不新增产品语义。';
function renderBrief(){const scene=byScene.get(currentScene);
  document.querySelector('[data-review-current]').textContent=ROUND_CURRENT;
  document.querySelector('[data-review-target]').textContent=ROUND_TARGET+'。';
  document.querySelector('[data-review-reason]').textContent=ROUND_REASON;
  document.querySelector('[data-review-question]').textContent=scene.annotation;}
"""


def main():
    src = TEMPLATE.read_text(encoding='utf-8')

    def sub(old, new):
        nonlocal src
        assert src.count(old) == 1, f'expected 1 occurrence: {old[:60]!r}'
        src = src.replace(old, new)

    sub('data-prototype-mode="wireframe"', 'data-prototype-mode="high_fidelity"')
    old_brief = '<section class="inspector-panel review-brief" data-review-brief hidden><h2>本轮评审</h2><p><strong>现在怎样：</strong><span data-review-current>填写现状与限制</span></p><p><strong>改成怎样：</strong><span data-review-target>填写本轮差异</span></p><p><strong>为什么改：</strong><span data-review-reason>填写依据</span></p><p><strong>评审问题：</strong><span data-review-question>填写需要判断的问题</span></p></section>'
    sub(old_brief, BRIEF_HTML)
    sub("function renderScene(){document.body.dataset.currentScene=currentScene;document.querySelector('.review-badges [data-current-scene]').textContent=currentScene;renderIndex();renderAnnotation();renderStory();updateHash()}",
        "function renderScene(){document.body.dataset.currentScene=currentScene;document.querySelector('.review-badges [data-current-scene]').textContent=currentScene;renderIndex();renderAnnotation();renderStory();renderBrief();updateHash()}")
    sub("let currentScene=manifest.start_scene;", BRIEF_JS + "\nlet currentScene=manifest.start_scene;")
    OUT.write_text(src, encoding='utf-8')
    print(f'prototype.html <- {TEMPLATE.name} ({len(src)} chars)')


if __name__ == '__main__':
    main()
