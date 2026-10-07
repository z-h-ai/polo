#!/usr/bin/env python3
"""Verify the current client design source/export closure without external Skills.

This checks provenance and generation, not visual approval or product acceptance.
"""
import hashlib
import json
import re
from pathlib import Path

ROOT = Path(__file__).resolve().parents[3]
BUNDLE = ROOT / 'docs/mvp-complete-flow-hifi'
DESIGN = ROOT / '.agents/skills/polo-ai-design-system'


def digest(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def maintained_template(html):
    html = re.sub(r'(<style>)[\s\S]*?(</style>)',
                  lambda m: m[1] + '__WORKBENCH_BASE_CSS__' + m[2], html, count=1)
    html = re.sub(r'<style id="workbench-review-style">[\s\S]*?</style>', '', html)
    for key in ['workbench-header-scroll', 'space-switch-sequence',
                'space-switch-progress', 'circle-membership-feedback']:
        html = re.sub(r'<script data-product-script="' + key + r'">[\s\S]*?</script>', '', html)
    return re.sub(r'(<script[^>]+id="prototype-manifest"[^>]*>)[\s\S]*?(</script>)',
                  lambda m: m[1] + '__MANIFEST__' + m[2], html)


def main():
    model = json.loads((DESIGN / 'references/design-system.json').read_text())
    manifest = json.loads((BUNDLE / 'prototype-manifest.json').read_text())
    consumer = json.loads((DESIGN / 'assets/prototypes/client-entry/prototype-manifest.json').read_text())
    errors = []

    def check(name, passed):
        if not passed:
            errors.append(name)

    for source in model['sources']:
        check('source ' + source['path'], digest(ROOT / source['path']) == source['sha256'])
    check('model schema', model['schema_version'] == 2)
    check('compatibility adoption', json.loads((BUNDLE / 'design-system.adoption.json').read_text()) == model)
    check('skill binding', digest(DESIGN / 'SKILL.md') == manifest['design']['sha256'])
    check('design revision', model['revision'] == manifest['design']['revision'] == consumer['design_revision'])
    check('consumer source manifest', digest(BUNDLE / 'prototype-manifest.json') == consumer['source_manifest_sha256'])
    check('consumer product export', consumer['product_export'] == 'docs/mvp-complete-flow-hifi/prototype.html')
    product = (BUNDLE / 'prototype.html').read_text()
    check('base CSS materialization', re.search(r'<style>([\s\S]*?)</style>', product)[1] == (DESIGN / 'assets/tokens/workbench-base.css').read_text())
    check('increment CSS materialization', re.search(r'<style id="workbench-review-style">([\s\S]*?)</style>', product)[1] == (DESIGN / 'assets/tokens/workbench-review.css').read_text())
    check('maintained product template', maintained_template(product) == (DESIGN / 'references/client-workbench.template.html').read_text())
    by_scene = {scene['id']: scene for scene in manifest['scenes']}
    selected = {}
    for row in model['component_contracts']:
        for item in row['consumers']:
            check('owned consumer manifest', item['manifest'] == '.agents/skills/polo-ai-design-system/assets/prototypes/client-entry/prototype-manifest.json')
            selected.setdefault(item['scene'], []).append(row['name'])
    check('consumer scenes and components', consumer['scenes'] == [dict(scene, components=selected[scene['id']]) for scene in manifest['scenes'] if scene['id'] in selected])
    check('all selected scenes exist', set(selected) <= set(by_scene))
    print(json.dumps({'ok': not errors, 'design_revision': model['revision'],
                      'source_count': len(model['sources']), 'component_count': len(model['components']),
                      'consumer_scenes': len(selected), 'errors': errors,
                      'execution_ready': False, 'product_acceptance': 'not_run'}, ensure_ascii=False, indent=2))
    return 1 if errors else 0


if __name__ == '__main__':
    raise SystemExit(main())
