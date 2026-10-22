#!/usr/bin/env python3
"""Verify the current client design source/export closure without external Skills.

This checks provenance and generation, not visual approval or product acceptance.
"""
import hashlib
import json
import re
import subprocess
import sys
import tempfile
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
    # The r1->r2 merge refreshed design-system.json but kept stale hashes inside
    # the SKILL.md body; the whole-file binding below cannot catch that drift.
    # Every generated Sources line must mirror the canonical model.
    skill_text = (DESIGN / 'SKILL.md').read_text()
    for source in model['sources']:
        prefix = '- `%s` — %s; ' % (source['path'], source['role'])
        line = next((l for l in skill_text.splitlines() if l.startswith(prefix)), None)
        match = re.search(r'SHA-256 `([0-9a-f]{64})`$', line) if line else None
        check('skill body binding ' + source['path'], bool(match) and match.group(1) == source['sha256'])
    # token-preview.html is a generated artifact of tools/build-token-preview.py;
    # regenerating to a temp file must be byte-identical to the maintained copy.
    preview = DESIGN / 'assets/tokens/token-preview.html'
    check('token-preview exists', preview.exists())
    if preview.exists():
        regenerated = Path(tempfile.mkstemp(suffix='.html')[1])
        try:
            subprocess.run([sys.executable, str(DESIGN / 'tools/build-token-preview.py'), str(regenerated)],
                           check=True, capture_output=True)
            check('token-preview regeneration', regenerated.read_bytes() == preview.read_bytes())
        finally:
            regenerated.unlink(missing_ok=True)
    # source-baseline (current-implementation baseline): the Skill assets must
    # be the byte-identical regeneration of tools/source-baseline for the same
    # real input fingerprint. Currency is judged by input hashes + output
    # regeneration (--check), NOT by snapshot HEAD equaling the current HEAD:
    # snapshot.head/head_dirty are the generation-time snapshot that stays
    # stable across re-commits of unchanged inputs (no commit self-reference).
    sb_manifest = DESIGN / 'assets/source-baseline/baseline-manifest.json'
    check('source-baseline manifest exists', sb_manifest.exists())
    if sb_manifest.exists():
        sb = json.loads(sb_manifest.read_text())
        check('source-baseline snapshot shape',
              isinstance(sb.get('snapshot'), dict)
              and isinstance(sb['snapshot'].get('head'), str) and bool(sb['snapshot']['head'])
              and isinstance(sb['snapshot'].get('head_dirty'), list))
        for rel, sha in sb['files'].items():
            f = DESIGN / 'assets/source-baseline' / rel
            check('source-baseline file ' + rel, f.exists() and digest(f) == sha)
        # Offline usability: the exported entries are single-file inlined — no
        # external script/stylesheet references, so file:// opens them fully.
        for rel in ('entries/baseline.html', 'index.html'):
            html = (DESIGN / 'assets/source-baseline' / rel).read_text()
            check('source-baseline self-contained ' + rel,
                  '<script type="module" src=' not in html
                  and not re.search(r'<link[^>]+rel="stylesheet"[^>]+href="(?!data:)', html))
        sb_build = subprocess.run([sys.executable, str(DESIGN / 'tools/source-baseline/build.py'), '--check'],
                                  cwd=str(ROOT), capture_output=True, text=True)
        check('source-baseline regeneration', sb_build.returncode == 0)
    # component-usage.md Settings registry ids must match the playground registry.
    usage = (DESIGN / 'references/component-usage.md').read_text()
    documented = {x for x in re.findall(r'^- `([a-z0-9-]+)` —', usage, re.M) if x.startswith('settings-')}
    registered = set()
    for entry in (ROOT / 'apps/electron/src/renderer/playground/registry').glob('*.tsx'):
        text = entry.read_text()
        if "category: 'Settings'" in text:
            registered |= set(re.findall(r"\bid: '([a-z0-9-]+)'", text))
    check('component-usage settings ids', documented == registered)
    # page-baselines scene references must exist in the consumer or unified manifest.
    baselines = (DESIGN / 'references/page-baselines.md').read_text()
    referenced = set(re.findall(r'`(P-[A-Z0-9-]+)`', baselines))
    known = {s['id'] for s in consumer['scenes']} | {s['id'] for s in manifest['scenes']}
    check('page-baselines scene ids', referenced <= known)
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
