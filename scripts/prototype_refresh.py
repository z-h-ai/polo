#!/usr/bin/env python3
"""Plan or build a source-faithful preview artifact. Never changes tracked sources."""
import argparse
import hashlib
import html
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile

ROOT = Path(__file__).resolve().parents[1]
SKILL = '.agents/skills/polo-ai-design-system'
BASELINE = f'{SKILL}/assets/source-baseline'
MANIFEST = f'{BASELINE}/baseline-manifest.json'
GENERATED = (BASELINE + '/', f'{SKILL}/assets/tokens/token-preview.html')
# The graph catches dependencies outside these roots; these roots catch NEW inputs
# which cannot yet occur in the previous graph. Favor extra builds over missed UI.
WATCH = ('apps/electron/', 'packages/ui/', 'packages/core/', 'packages/shared/',
         f'{SKILL}/tools/', f'{SKILL}/assets/tokens/')
AUTOMATION = ('scripts/prototype_refresh.py', 'scripts/prototype_browser_check.py',
              'scripts/prototype-browser-requirements.txt',
              '.github/workflows/prototype-refresh.yml')


def git(repo, *args):
    return subprocess.check_output(['git', '-C', str(repo), *args])


def sha(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def resolve_commit(repo, ref):
    # Accept a commit expression as data, never a command or option.
    return git(repo, 'rev-parse', '--verify', '--end-of-options', ref + '^{commit}').decode().strip()


def watched(path, known):
    if path.startswith(GENERATED):
        return False
    return (path in known or path in AUTOMATION or path.startswith(WATCH)
            or path in ('package.json', 'bun.lock', 'bunfig.toml', '.npmrc', 'tsconfig.json',
                        f'{SKILL}/references/design-system.json'))


def make_plan(repo, before=None, force=False, last_success=None):
    head = resolve_commit(repo, 'HEAD')
    manifest_path = repo / MANIFEST
    baseline_origin = 'repository'
    previous_success = None
    baseline_head = None
    if last_success:
        try:
            cached = last_success / 'baseline-manifest.json'
            receipt = json.loads((last_success / 'result.json').read_text())
            if (receipt['status'] == 'passed' and
                    sha(cached) == receipt['artifact_sha256']['assets/source-baseline/baseline-manifest.json']):
                manifest_path = cached
                baseline_origin = 'last-successful-run'
                previous_success = receipt.get('run_url') or receipt['head']
                baseline_head = receipt['head']
        except (OSError, KeyError, TypeError, ValueError):
            pass  # Missing/corrupt cache falls back to committed material inputs.
    known = {}
    manifest_issue = None
    output_drift = []
    try:
        manifest = json.loads(manifest_path.read_text())
        baseline_head = baseline_head or manifest.get('snapshot', {}).get('head')
        for section in ('repo_files', 'lockfiles'):
            known.update(manifest['inputs'][section])
        # Producer source keys are relative to generator.tool, not repo root.
        generator = manifest['generator']
        known.update({str(Path(generator['tool']) / path): digest
                      for path, digest in generator['sources'].items()})
        if not known:
            raise ValueError('empty input graph')
        for path, expected in (manifest['files'].items() if baseline_origin == 'repository' else []):
            target = (repo / BASELINE / path).resolve()
            if not target.is_relative_to((repo / BASELINE).resolve()):
                raise ValueError('output path escapes baseline')
            if not target.is_file() or sha(target) != expected:
                output_drift.append(path)
        for path in (('index.html',) if baseline_origin == 'repository' else ()):
            if not (repo / BASELINE / path).is_file():
                output_drift.append(path)
    except (OSError, ValueError, KeyError, TypeError, AttributeError) as exc:
        manifest_issue = str(exc)
    drift = []
    ignored = subprocess.run(['git', '-C', str(repo), 'check-ignore', '--no-index', '-z', '--stdin'],
                             input=('\0'.join(known) + '\0').encode() if known else b'',
                             stdout=subprocess.PIPE, stderr=subprocess.PIPE, check=False)
    if ignored.returncode not in (0, 1):
        raise ValueError('cannot classify generated/ignored build inputs')
    ignored_inputs = set(ignored.stdout.decode().split('\0'))
    tracked = set(git(repo, 'ls-files', '-z').decode().split('\0'))
    for path, expected in known.items():
        target = (repo / path).resolve()
        if not target.is_relative_to(repo.resolve()):
            raise ValueError(f'input escapes repository: {path}')
        # Fresh CI has no shared/dist exports yet. Source/dependency changes are
        # watched separately; absent build products are not a docs-only UI change.
        if path in ignored_inputs and path not in tracked:
            continue
        if not target.is_file() or sha(target) != expected:
            drift.append(path)
    base = None
    history_issue = None
    if before and set(before) != {'0'}:
        try:
            base = resolve_commit(repo, before)
        except subprocess.CalledProcessError:
            history_issue = 'before commit unavailable; conservatively rebuild'
    else:
        history_issue = 'no event base; conservatively rebuild'
    event_base = base
    if baseline_head:
        try:
            # Include ALL pushes since the last successful preview, so a new
            # unregistered UI file from a cancelled run cannot vanish from diff.
            base = resolve_commit(repo, baseline_head)
        except subprocess.CalledProcessError:
            history_issue = 'baseline source commit unavailable; conservatively rebuild'
    # --no-renames includes both old and new paths for moves, including deletion.
    changed = (git(repo, 'diff', '--name-only', '--no-renames', '-z', base, head).decode().split('\0')
               if base else [])
    matched = sorted(p for p in changed if p and watched(p, known))
    reasons = []
    if force:
        reasons.append('manual-force')
    if manifest_issue:
        reasons.append('missing-or-invalid-manifest')
    if history_issue:
        reasons.append('unknown-change-range')
    if matched:
        reasons.append('ui-or-build-input-changed')
    if drift:
        reasons.append('committed-baseline-inputs-stale')
    if output_drift:
        reasons.append('committed-baseline-output-missing-or-stale')
    return {'schema_version': 1, 'head': head, 'before': base, 'event_before': event_base,
            'refresh': bool(reasons),
            'reasons': reasons, 'matched_paths': matched, 'stale_inputs': sorted(drift),
            'manifest_issue': manifest_issue, 'history_issue': history_issue,
            'output_drift': output_drift,
            'baseline_origin': baseline_origin, 'previous_success': previous_success,
            'proof_scope': 'Implementation preview only; no product approval or new scene coverage implied.'}


def boundary_plan(repo, boundary):
    """Read-only agent hook: repository materials, never an unadopted CI cache."""
    plan = make_plan(repo, before='HEAD')
    manifest = json.loads((repo / MANIFEST).read_text()) if not plan['manifest_issue'] else {}
    known = set(manifest.get('inputs', {}).get('repo_files', {}))
    known.update(manifest.get('inputs', {}).get('lockfiles', {}))
    generator = manifest.get('generator', {})
    known.update(str(Path(generator.get('tool', '')) / x) for x in generator.get('sources', {}))
    # A source+material commit can follow generation. Exact input bytes outrank
    # the historical snapshot SHA; otherwise every backfill would rebuild itself.
    hook_only = set(AUTOMATION) | {f'{SKILL}/references/design-system.json'}
    plan['matched_paths'] = [x for x in plan['matched_paths'] if x not in known and x not in hook_only]
    dirty = git(repo, 'ls-files', '--modified', '--others', '--exclude-standard', '-z').decode().split('\0')
    plan['unrecorded_ui_paths'] = sorted({x for x in dirty if x and watched(x, known) and x not in known and x not in hook_only})
    reasons = [r for r in plan['reasons'] if r != 'ui-or-build-input-changed']
    if plan['matched_paths'] or plan['unrecorded_ui_paths']:
        reasons.append('unreviewed-input-changes')
    source_issues = []
    try:
        model = json.loads((repo / SKILL / 'references/design-system.json').read_text())
        for row in model['sources']:
            path = (repo / row['path']).resolve()
            if not path.is_relative_to(repo.resolve()) or not path.is_file() or sha(path) != row['sha256']:
                source_issues.append(row['path'])
        if manifest.get('design_revision') != model['revision']:
            source_issues.append('design_revision')
    except (OSError, ValueError, KeyError, TypeError):
        source_issues.append('missing-or-invalid-design-model')
    # Token preview has a separate native producer from the page/component graph.
    # Reproduce only into temporary output, never rewrite the repository on check.
    try:
        with tempfile.TemporaryDirectory(prefix='polo-token-check-') as temp:
            expected = Path(temp) / 'tokens.html'
            subprocess.run([sys.executable, str(repo / SKILL / 'tools/build-token-preview.py'), str(expected)],
                           cwd=repo, capture_output=True, check=True, timeout=30)
            if expected.read_bytes() != (repo / SKILL / 'assets/tokens/token-preview.html').read_bytes():
                source_issues.append('token-preview-output-stale')
    except (OSError, subprocess.SubprocessError):
        source_issues.append('token-preview-missing-or-check-failed')
    if source_issues:
        reasons.append('design-sources-stale')
    plan.update(boundary=boundary, source_issues=source_issues, reasons=reasons,
                refresh=bool(reasons), status='needs-maintenance' if reasons else 'current',
                skill=f'{SKILL}/SKILL.md',
                instruction='Read references/usage-playbook.md#维护时机与-git-边界; reconcile scope, regenerate, verify, then recheck.' if reasons else 'Reuse repository materials; no maintenance needed.',
                git_actions='none: no commit, push, tag, release or deployment',
                proof_scope='Read-only source/output drift screening; full page reproduction, browser and product evidence remain separate.')
    return plan


def save(out, result):
    (out / 'result.json').write_text(json.dumps(result, ensure_ascii=False, indent=2) + '\n')
    status = html.escape(result['status'])
    links = ('<a href="assets/source-baseline/index.html">打开本次原型</a> · '
             '<a href="browser.json">浏览器检查与截图</a> · '
             '<a href="generated.patch">素材更新补丁</a>') if result['status'] == 'passed' else ''
    comparison = ''
    if (out / 'browser.json').exists():
        rendered = json.loads((out / 'browser.json').read_text())
        before = {r['scene']: r for r in rendered['before']}
        for row in rendered['after']:
            scene = row['scene']
            cells = []
            for label, item in [('Before · 仓库内旧素材', before.get(scene)), ('After · 本次源码再生成', row)]:
                if item and item.get('screenshot'):
                    path = html.escape(item['screenshot'], quote=True)
                    cells.append(f'<div><p>{label}</p><a href="{path}"><img loading="lazy" src="{path}" alt="{html.escape(scene)}"></a></div>')
                else:
                    cells.append(f'<div><p>{label}：无可比截图（新增场景或渲染失败，见 browser.json）</p></div>')
            comparison += f'<details><summary>{html.escape(scene)}</summary><div class="pair">{"".join(cells)}</div></details>'
    (out / 'index.html').write_text(f'''<!doctype html><html lang="zh-CN"><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1"><title>Polo 原型自动更新</title>
<style>body{{font:16px/1.65 system-ui;margin:40px auto;max-width:1200px;padding:20px;color:#172033;background:#f5f7fb}}pre{{white-space:pre-wrap;overflow-wrap:anywhere;background:white;padding:24px;border-radius:12px}}a{{color:#225ac7}}.pair{{display:grid;grid-template-columns:1fr 1fr;gap:12px}}img{{width:100%}}details{{margin:12px 0;padding:12px;background:white}}@media(max-width:700px){{.pair{{grid-template-columns:1fr}}}}</style>
<h1>Polo 原型自动更新</h1><p>状态：<strong>{status}</strong> · 源码：<code>{result['head'][:12]}</code></p>
<p>由当前实现生成；模拟数据只用于预览。浏览器检查证明可渲染，不代表产品设计或真实业务验收。</p>
<p>{links}</p><p><a href="result.json">完整运行记录</a></p>
<p>截图为同视口、固定时间的两侧实际渲染。素材源码/fixture 可以随提交变化；本对照用于审阅，不自动判定视觉通过。</p>{comparison}
<pre>{html.escape(json.dumps(result, ensure_ascii=False, indent=2))}</pre></html>''')


def command(repo, out, name, args):
    with (out / f'{name}.log').open('w') as log:
        subprocess.run(args, cwd=repo, stdout=log, stderr=subprocess.STDOUT,
                       check=True, timeout=1800)


def generated_patch(repo, pairs):
    """Use Git's EOF markers: difflib alone corrupts files without final newline."""
    patch = bytearray()
    for source, dest in pairs:
        exists = (repo / dest).is_file()
        proc = subprocess.run(['git', 'diff', '--no-index', '--no-ext-diff', '--binary', '--',
                               str(repo / dest) if exists else '/dev/null', str(source)],
                              stdout=subprocess.PIPE, stderr=subprocess.PIPE)
        if proc.returncode not in (0, 1):
            raise ValueError(proc.stderr.decode())
        headers = True
        for line in proc.stdout.splitlines(keepends=True):
            if line.startswith(b'@@') or line.startswith(b'GIT binary patch'):
                headers = False
            if headers and line.startswith(b'diff --git '):
                line = f'diff --git a/{dest} b/{dest}\n'.encode()
            elif headers and line.startswith(b'--- '):
                line = (f'--- a/{dest}\n' if exists else '--- /dev/null\n').encode()
            elif headers and line.startswith(b'+++ '):
                line = f'+++ b/{dest}\n'.encode()
            patch.extend(line)
    return bytes(patch)


def run(repo, out, plan):
    # A fresh, external directory cannot clobber user files or pollute source hashes.
    out = out.resolve()
    if out.is_relative_to(repo.resolve()):
        raise ValueError('--output must be outside the repository')
    out.mkdir(parents=True, exist_ok=False)
    result = dict(plan, status='building' if plan['refresh'] else 'skipped')
    if os.getenv('GITHUB_RUN_ID'):
        result['run_url'] = f"{os.environ.get('GITHUB_SERVER_URL', 'https://github.com')}/{os.environ['GITHUB_REPOSITORY']}/actions/runs/{os.environ['GITHUB_RUN_ID']}"
    save(out, result)
    if not plan['refresh']:
        return result
    try:
        if git(repo, 'status', '--porcelain', '--untracked-files=no').strip():
            raise ValueError('tracked worktree changes: build a clean source checkout')
        build = repo / SKILL / 'tools/source-baseline/build.py'
        target = out / 'assets/source-baseline'
        tokens = out / 'assets/tokens/token-preview.html'
        tokens.parent.mkdir(parents=True)
        # Normal standalone setup: shared browser exports are ignored build
        # products, not installed from the workspace's package.json alone.
        command(repo, out, 'shared-build', ['bun', 'run', '--cwd', 'packages/shared', 'build'])
        command(repo, out, 'build', [sys.executable, str(build), '--out', str(target)])
        command(repo, out, 'reproduce', [sys.executable, str(build), '--out', str(target), '--check'])
        token_builder = repo / SKILL / 'tools/build-token-preview.py'
        command(repo, out, 'tokens', [sys.executable, str(token_builder), str(tokens)])
        token_check = out / 'token-reproduce.html'
        command(repo, out, 'tokens-reproduce', [sys.executable, str(token_builder), str(token_check)])
        if sha(tokens) != sha(token_check):
            raise ValueError('token preview is not reproducible')
        token_check.unlink()
        # Read-only comparison files are freshly rendered; never reuse old screenshots.
        old = out / 'before'
        if (repo / BASELINE).is_dir():
            shutil.copytree(repo / BASELINE, old / 'source-baseline')
        if (repo / SKILL / 'assets/tokens').is_dir():
            shutil.copytree(repo / SKILL / 'assets/tokens', old / 'tokens')
        command(repo, out, 'browser', [sys.executable, str(repo / 'scripts/prototype_browser_check.py'),
                                      '--artifact', str(out)])
        new_manifest = json.loads((target / 'baseline-manifest.json').read_text())
        imported = new_manifest['inputs']['repo_files']
        for path, expected in imported.items():
            if sha(repo / path) != expected:
                raise ValueError(f'build input changed during verification: {path}')
        # This is an investigation hint, not an assertion that every imported file is visible.
        result['coverage_review_paths'] = [p for p in plan['matched_paths']
                                           if p.startswith('apps/electron/src/renderer/')
                                           and p not in imported]
        result['scene_count'] = len(new_manifest['scenes'])
        result['input_fingerprint'] = new_manifest['input_fingerprint']
        # Generate an applicable patch with only the four maintained generated files.
        pairs = [(target / 'index.html', f'{BASELINE}/index.html'),
                             (target / 'baseline-manifest.json', MANIFEST),
                             (target / 'entries/baseline.html', f'{BASELINE}/entries/baseline.html'),
                             (tokens, f'{SKILL}/assets/tokens/token-preview.html')]
        patch_path = out / 'generated.patch'
        patch_path.write_bytes(generated_patch(repo, pairs))
        if patch_path.stat().st_size:
            command(repo, out, 'patch-check', ['git', 'apply', '--check', str(patch_path)])
        result['artifact_sha256'] = {str(p.relative_to(out)): sha(p)
                                    for p in sorted((out / 'assets').rglob('*')) if p.is_file()}
        if resolve_commit(repo, 'HEAD') != plan['head'] or git(repo, 'status', '--porcelain', '--untracked-files=no').strip():
            raise ValueError('source checkout changed during generation')
        result['status'] = 'passed'
    except Exception as exc:
        result['status'] = 'failed'
        result['error'] = str(exc)
    save(out, result)
    return result


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--before', help='push event before SHA; missing/zero/unavailable => full rebuild')
    parser.add_argument('--force', action='store_true')
    parser.add_argument('--last-success', type=Path, help='optional verified successful-run manifest/receipt cache')
    parser.add_argument('--output', type=Path, help='fresh external directory; omitted => plan only')
    parser.add_argument('--boundary', choices=['main-integration', 'new-task'], help='read-only Agent lifecycle hook')
    parser.add_argument('--check', action='store_true', help='with --boundary: exit 3 when maintenance is required')
    args = parser.parse_args()
    if args.check and not args.boundary:
        parser.error('--check requires --boundary')
    if args.boundary and (args.before or args.force or args.last_success or args.output):
        parser.error('--boundary cannot use event ranges, artifact caches or generation options')
    try:
        if args.boundary:
            result = boundary_plan(ROOT, args.boundary)
            print(json.dumps(result, ensure_ascii=False, indent=2))
            return 3 if args.check and result['refresh'] else 0
        plan = make_plan(ROOT, args.before, args.force, args.last_success)
        result = run(ROOT, args.output, plan) if args.output else dict(plan, status='planned')
        print(json.dumps(result, ensure_ascii=False, indent=2))
        if os.getenv('GITHUB_OUTPUT'):
            with open(os.environ['GITHUB_OUTPUT'], 'a') as stream:
                stream.write(f"refresh={str(plan['refresh']).lower()}\n")
        return 1 if result['status'] == 'failed' else 0
    except (OSError, ValueError, subprocess.SubprocessError) as exc:
        print(str(exc), file=sys.stderr)
        return 2


if __name__ == '__main__':
    sys.exit(main())
