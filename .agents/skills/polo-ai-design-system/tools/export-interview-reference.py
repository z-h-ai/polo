#!/usr/bin/env python3
"""Export the native input baseline for task smoke binding; no design changes.

The source-baseline owns the native scene and CSS. This export builds that same
scene alone because the shared task gate requires a closed Skill-owned reference.
It does not claim that unchanged renderer evidence is an approved new target design.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import os
import subprocess
import tempfile
from pathlib import Path

SKILL = Path(__file__).resolve().parents[1]
REPO = SKILL.parents[2]
OUTPUT = SKILL / 'assets/prototypes/interview-input'
SKILL_PATH = SKILL.relative_to(REPO).as_posix()
BASELINE = SKILL / 'assets/source-baseline'


def digest(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def encoded(value: dict) -> bytes:
    return (json.dumps(value, ensure_ascii=False, indent=2) + '\n').encode()


def outputs() -> dict[str, bytes]:
    scene = 'interview-input'
    baseline = json.loads((BASELINE / 'baseline-manifest.json').read_text())
    if scene not in {row['id'] for row in baseline['scenes']}:
        raise ValueError('build the real source-baseline interview-input scene first')
    if digest(BASELINE / 'entries/baseline.html') != baseline['files']['entries/baseline.html']:
        raise ValueError('baseline HTML differs from its generator receipt')
    skill_file = SKILL / 'SKILL.md'
    authority = SKILL / 'references/foundations.md'
    # A global baseline bundle contains unrelated dynamic imports (for example
    # diagram engines). Export the exact same scene alone so the shared native
    # closure checker can verify every dependency without weakening its rules.
    with tempfile.TemporaryDirectory(prefix='polo-input-reference-') as temporary:
        env = {**os.environ, 'POLO_BASELINE_DIST': temporary}
        result = subprocess.run(
            [str(REPO / 'node_modules/.bin/vite'), 'build', '--config', 'vite.interview-input.config.mjs'],
            cwd=SKILL / 'tools/source-baseline', env=env, capture_output=True, text=True,
        )
        if result.returncode:
            raise ValueError('native input export failed: ' + result.stderr)
        prototype = (Path(temporary) / 'entries/interview-input.html').read_bytes()
    manifest = {
        'schema_version': 1,
        'kind': 'native-renderer-preservation-reference',
        'mode': 'high_fidelity',
        'revision': 'poo169-native-input-reuse-r1',
        'files': {'prototype': 'prototype.html'},
        'target': {'languages': ['zh-Hans'], 'themes': ['light'], 'viewports': [
            {'id': 'desktop-1280x800', 'width': 1280, 'height': 800},
            {'id': 'desktop-1440x900', 'width': 1440, 'height': 900},
            {'id': 'compact-800x600', 'width': 800, 'height': 600},
        ]},
        'scenes': [{'id': scene, 'title': 'Production RichTextInput', 'state': 'default',
                    'source_entry': 'prototype.html'}],
        'design': {'skill_path': f'{SKILL_PATH}/SKILL.md', 'sha256': digest(skill_file),
                   'sources': [{'path': authority.relative_to(REPO).as_posix(), 'sha256': digest(authority)}]},
        'confirmations': [{
            'id': 'D-ASSISTANT-REUSE', 'status': 'confirmed',
            'source': f'{SKILL_PATH}/references/policy-alignment.json#D-ASSISTANT-REUSE',
            'quote': '助手：既有聊天、输入、附件及会话导航以当前 `apps/electron/src/renderer/` 为准',
            'scope': 'Preserve current renderer components and styles only. No new layout or bug-fix outcome is visually approved by this record. POO-169 smoke verifies the authorized functional correction separately.',
        }],
        'provenance': {
            'source_manifest': f'{SKILL_PATH}/assets/source-baseline/baseline-manifest.json',
            'source_input_fingerprint': baseline['input_fingerprint'],
            'reference_html_sha256': hashlib.sha256(prototype).hexdigest(),
            'source_entry': f'{SKILL_PATH}/tools/source-baseline/entries/interview-input-entry.tsx',
            'generator': f'{SKILL_PATH}/tools/export-interview-reference.py',
            'role': 'Existing production component reference, not a newly accepted target design',
        },
    }
    visual = {'e2e': {'visual': {
        'mode': 'smoke',
        'viewports': [{'name': row['id'], 'width': row['width'], 'height': row['height']}
                      for row in manifest['target']['viewports']],
        'routes': [{
            'name': scene, 'state': 'default',
            'actual': '/entries/interview-input.html',
            'whole_page': True, 'capture_full_page': True,
            'state_assertions': [{'type': 'visible', 'selector': '[contenteditable="true"]'}],
        }],
    }}}
    runtime = {'services': {'frontend': {
        'url': 'http://127.0.0.1:43169',
        'cwd': f'{SKILL_PATH}/tools/source-baseline',
        'start': '../../../../../node_modules/.bin/vite --config vite.interview-input.config.mjs --host 127.0.0.1 --port 43169 --strictPort',
        'health_check': '/entries/interview-input.html',
    }}}
    return {
        'prototype.html': prototype,
        'prototype-manifest.json': encoded(manifest),
        'visual-plan.json': encoded(visual),
        'runtime-manifest.json': encoded(runtime),
    }


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--check', action='store_true')
    args = parser.parse_args()
    expected = outputs()
    if args.check:
        stale = [name for name, data in expected.items()
                 if not (OUTPUT / name).is_file() or (OUTPUT / name).read_bytes() != data]
        if stale:
            raise SystemExit('stale interview reference: ' + ', '.join(stale))
    else:
        OUTPUT.mkdir(parents=True, exist_ok=True)
        for name, data in expected.items():
            (OUTPUT / name).write_bytes(data)
    print(f'input preservation reference: {len(expected)} files current')


if __name__ == '__main__':
    main()
