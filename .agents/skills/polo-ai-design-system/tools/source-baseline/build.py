#!/usr/bin/env python3
"""Build the source-baseline artifacts INTO the Skill (single-direction generation).

Pipeline (no manual steps, no timestamps — same inputs rerun byte-identical):
  1. tsc --project tsconfig.json           (real typecheck over the entry sources)
  2. vite build (scene-ids SSR config)     (evaluates the REAL scene registry)
  3. node scene-ids-runner.cjs             (scene list from module evaluation, not regex)
  4. vite build --config vite.config.mjs   (browser bundle, inlined single file)
  5. copy dist/ → <out>; drop chunks the HTML no longer references
  6. write baseline-manifest.json          (input fingerprints, generation
                                            snapshot, scenes, file digests)
  7. write index.html                      (unified three-layer browsing entry)

Snapshot semantics (no commit self-reference trap): `snapshot.head` /
`snapshot.head_dirty` describe the input state AT THE TIME THE INPUTS LAST
CHANGED, not the current git state. Every rebuild computes an
`input_fingerprint` over everything the build consumed (repo sources from the
real vite module graph, generator sources, packages, lockfiles,
design_revision, scenes). When that fingerprint equals the one recorded in an
existing target manifest, the rebuild REUSES its snapshot verbatim, so
committing the sources + artifacts does not invalidate the check afterwards.
When the fingerprint changes, the snapshot is re-recorded from the current
HEAD/status. Currency is proven by the input hashes themselves plus the
byte-identical regeneration check — never by comparing snapshots to git.

The manifest deliberately does NOT hash references/design-system.json: that
model binds upstream guides/generator sources; this manifest is downstream.
Only the model `revision` string is fingerprinted, keeping generation one-way.

Usage:
  python3 build.py                # regenerate the Skill assets in place
  python3 build.py --check        # regenerate into a temp dir, byte-compare, exit 0/1
  python3 build.py --out DIR      # write somewhere else — ONLY into a directory
                                  # that is empty, absent, or a previous output of
                                  # this tool (guarded; never deletes foreign data)
"""
import argparse
import hashlib
import json
import os
import re
import shutil
import subprocess
import sys
import tempfile
from pathlib import Path

TOOL = Path(__file__).resolve().parent          # .../tools/source-baseline
ROOT = TOOL.parents[4]                          # repo root (dev/)
DESIGN = ROOT / '.agents' / 'skills' / 'polo-ai-design-system'
DEFAULT_OUT = DESIGN / 'assets' / 'source-baseline'
TOOL_REL = str(TOOL.relative_to(ROOT))          # e.g. .agents/skills/.../tools/source-baseline
GENERATOR_ID = TOOL_REL                          # manifest.generator.tool identity
VITE_FROM_TOOL = '../../../../../node_modules/.bin/vite'   # TOOL cwd → repo node_modules
VITE = ROOT / 'node_modules' / '.bin' / 'vite'
TSC = ROOT / 'node_modules' / '.bin' / 'tsc'
# Generated intermediates that must never count as generator sources or inputs.
TOOL_BUILD_DIRS = {'dist', 'dist-scene-ids', 'node_modules', '__pycache__'}


def sha256_bytes(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def sha256(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def run(cmd, **kw):
    proc = subprocess.run(cmd, cwd=str(TOOL), capture_output=True, text=True, **kw)
    if proc.returncode != 0:
        sys.stderr.write(proc.stdout + proc.stderr)
        raise SystemExit(f'build.py: step failed ({cmd[0]}), exit {proc.returncode}')
    return proc


def ensure_safe_output_dir(out: Path) -> None:
    """Refuse to rmtree anything this tool does not own.

    A non-empty directory is accepted only when its manifest identifies THIS
    generator (exact generator.tool match) AND every file on disk is listed in
    that manifest — any foreign file means the directory holds something this
    tool did not generate, and it is refused instead of wiped.
    """
    try:
        resolved = out.resolve()
    except OSError:
        resolved = out
    protected = [ROOT, ROOT / 'apps', ROOT / 'packages', ROOT / 'docs',
                 DESIGN, DESIGN / 'assets', DESIGN / 'tools', TOOL]
    for p in protected:
        if resolved == p.resolve():
            raise SystemExit(f'build.py: refusing --out {out}: protected repository path')
    if not out.exists():
        return                      # absent — nothing can be deleted
    if out.is_file():
        raise SystemExit(f'build.py: refusing --out {out}: not a directory')
    entries = list(out.iterdir())
    if not entries:
        return                      # empty directory — safe to build into
    manifest = out / 'baseline-manifest.json'
    if manifest.is_file():
        try:
            data = json.loads(manifest.read_text())
        except (OSError, ValueError):
            data = None
        generator_ok = (isinstance(data, dict)
                        and isinstance(data.get('generator'), dict)
                        and data['generator'].get('tool') == GENERATOR_ID
                        and isinstance(data.get('files'), dict))
        if generator_ok:
            listed = set(data['files'])
            actual = {str(p.relative_to(out)) for p in out.rglob('*') if p.is_file()}
            # manifest + index are written after `files` is computed; they are
            # always this tool's own output, never foreign.
            foreign = sorted(actual - listed - {'baseline-manifest.json', 'index.html'})
            if not foreign:
                return              # a previous output of THIS tool, nothing foreign
            raise SystemExit(
                f'build.py: refusing --out {out}: directory was generated by this tool '
                f'but contains files outside its manifest: {foreign[:5]}. '
                'Remove them (they are not this tool\'s output) or pass an empty directory.')
    raise SystemExit(
        f'build.py: refusing --out {out}: not empty and no baseline-manifest.json '
        f'generated by {GENERATOR_ID} was found. Pass an empty directory, a directory '
        'this tool generated earlier, or drop --out to use the Skill assets.')


def collect_inputs(module_graph: list) -> dict:
    """Fingerprint what THIS build really consumed, from the vite module graph."""
    status = subprocess.run(
        ['git', 'status', '--porcelain', '--untracked-files=all'],
        cwd=str(ROOT), capture_output=True, text=True, check=True).stdout
    dirty = set()
    for line in status.splitlines():
        if len(line) > 3:
            dirty.add(line[3:].split(' -> ')[-1].strip('"'))

    repo_files: dict = {}
    packages: dict = {}
    outside: set = set()
    for raw in module_graph:
        path = raw.split('?')[0] if raw.endswith('?raw') else raw
        if '\x00' in path:
            continue                # vite virtual module, not a file
        p = Path(path)
        try:
            rel = p.relative_to(ROOT)
        except ValueError:
            outside.add(str(p))
            continue
        parts = rel.parts
        if 'node_modules' in parts:
            i = parts.index('node_modules')
            seg = parts[i + 1]
            name = '/'.join(parts[i + 1:i + 3]) if seg.startswith('@') else seg
            if name not in packages:
                pkg_json = Path(*parts[:i + 1], *name.split('/')) / 'package.json'
                version = 'unknown'
                try:
                    version = json.loads((ROOT / pkg_json).read_text()).get('version', 'unknown')
                except (OSError, ValueError):
                    pass
                packages[name] = version
            continue
        if not p.is_file():
            continue
        rel_str = str(rel)
        # Build intermediates under the tool dir (dist*/ etc.) are not sources.
        if rel_str.startswith(TOOL_REL + '/') and rel.parts[5] in TOOL_BUILD_DIRS:
            continue
        repo_files[rel_str] = sha256(p)

    lockfiles = {}
    for name in ('package.json', 'bun.lock', 'bun.lockb'):
        f = ROOT / name
        if f.is_file():
            lockfiles[name] = sha256(f)

    return {
        'repo_files': dict(sorted(repo_files.items())),
        'packages': dict(sorted(packages.items())),
        'lockfiles': lockfiles,
        'paths_outside_repo': sorted(outside),
        'note': (
            'repo_files hold the WORKING TREE contents actually consumed by the '
            'build (hashes prove currency — a changed file cannot match). '
            'packages/lockfiles record the dependency set vite resolved. '
            'references/design-system.json is intentionally NOT an input: it binds '
            'upstream sources; material outputs are downstream. Only the revision '
            'string is fingerprinted, avoiding model/output cycles.'
        ),
    }


def extract_scenes(dist: str) -> list:
    """Scene list from evaluating the real modules (vite SSR + happy-dom node)."""
    env = {**os.environ, 'POLO_BASELINE_SCENE_DIST': dist}
    vite = subprocess.run(
        [str(VITE), 'build', '--config', 'vite.scene-ids.config.mjs'],
        cwd=str(TOOL), capture_output=True, text=True, env=env)
    if vite.returncode != 0:
        sys.stderr.write(vite.stdout + vite.stderr)
        raise SystemExit('build.py: scene-ids vite build failed')
    node = shutil.which('node')
    if not node:
        raise SystemExit('build.py: node not found on PATH (required for scene extraction)')
    proc = subprocess.run([node, 'scene-ids-runner.cjs'],
                          cwd=str(TOOL), capture_output=True, text=True, env=env)
    if proc.returncode != 0:
        sys.stderr.write(proc.stdout + proc.stderr)
        raise SystemExit('build.py: scene-ids runner failed')
    for line in reversed(proc.stdout.splitlines()):
        line = line.strip()
        if line.startswith('[') and line.endswith(']'):
            return json.loads(line)
    raise SystemExit('build.py: scene-ids runner produced no JSON array')


def generator_sources() -> dict:
    """Fingerprints of the generator itself (everything except build output)."""
    out = {}
    for path in sorted(TOOL.rglob('*')):
        if not path.is_file():
            continue
        rel = path.relative_to(TOOL)
        if set(rel.parts) & TOOL_BUILD_DIRS:
            continue
        out[str(rel)] = sha256(path)
    return out


def current_git_state() -> dict:
    head = subprocess.run(['git', 'rev-parse', 'HEAD'], cwd=str(ROOT),
                          capture_output=True, text=True, check=True).stdout.strip()
    status = subprocess.run(['git', 'status', '--porcelain', '--untracked-files=all'],
                            cwd=str(ROOT), capture_output=True, text=True, check=True).stdout
    dirty = set()
    for line in status.splitlines():
        if len(line) > 3:
            dirty.add(line[3:].split(' -> ')[-1].strip('"'))
    return {'head': head, 'dirty': dirty}


def input_fingerprint(body: dict) -> str:
    """Hash everything the build consumed EXCEPT the snapshot and output files."""
    return sha256_bytes(json.dumps(body, ensure_ascii=False, sort_keys=True).encode())


def build(out: Path, provenance_base: dict | None) -> dict:
    typecheck = subprocess.run(
        [str(TSC), '--project', str(TOOL / 'tsconfig.json'), '--pretty', 'false'],
        cwd=str(ROOT), capture_output=True, text=True)
    if typecheck.returncode != 0:
        sys.stderr.write(typecheck.stdout + typecheck.stderr)
        raise SystemExit('build.py: typecheck failed')

    with tempfile.TemporaryDirectory(prefix='polo-baseline-scene-') as scene_dist:
        scenes = extract_scenes(scene_dist)

    with tempfile.TemporaryDirectory(prefix='polo-baseline-dist-') as dist_dir:
        env = {**os.environ, 'POLO_BASELINE_DIST': dist_dir}
        with tempfile.NamedTemporaryFile(suffix='-modules.json', delete=False) as tf:
            modules_out = tf.name
        env['POLO_BASELINE_MODULES_OUT'] = modules_out
        vite = subprocess.run(
            [str(VITE), 'build', '--config', 'vite.config.mjs'],
            cwd=str(TOOL), capture_output=True, text=True, env=env)
        if vite.returncode != 0:
            sys.stderr.write(vite.stdout + vite.stderr)
            raise SystemExit('build.py: vite build failed')
        module_graph = json.loads(Path(modules_out).read_text())
        Path(modules_out).unlink(missing_ok=True)

        if out.exists():
            shutil.rmtree(out)
        out.mkdir(parents=True)
        shutil.copytree(dist_dir, out, dirs_exist_ok=True)

    # The inlined HTML no longer references standalone chunks; only keep what
    # the page actually loads, so the bundle is not stored twice.
    html = (out / 'entries' / 'baseline.html').read_text()
    referenced = set(re.findall(r'assets/[A-Za-z0-9._-]+\.(?:js|css)', html))
    assets_dir = out / 'assets'
    if assets_dir.is_dir():
        for path in sorted(assets_dir.rglob('*')):
            if path.is_file() and path.relative_to(out).as_posix() not in referenced:
                path.unlink()
        if not any(assets_dir.iterdir()):
            assets_dir.rmdir()

    model = json.loads((DESIGN / 'references' / 'design-system.json').read_text())
    files = {}
    for path in sorted(out.rglob('*')):
        if path.is_file():
            files[str(path.relative_to(out))] = sha256(path)

    git = current_git_state()
    manifest: dict = {
        'schema_version': 2,
        'design_revision': model['revision'],
        'generator': {
            'tool': GENERATOR_ID,
            'sources': generator_sources(),
            'commands': [
                'node_modules/.bin/tsc --project .agents/skills/polo-ai-design-system/tools/source-baseline/tsconfig.json --pretty false',
                {'cwd': TOOL_REL, 'run': f'{VITE_FROM_TOOL} build --config vite.scene-ids.config.mjs'},
                {'cwd': TOOL_REL, 'run': 'node scene-ids-runner.cjs'},
                {'cwd': TOOL_REL, 'run': f'{VITE_FROM_TOOL} build --config vite.config.mjs'},
                'python3 .agents/skills/polo-ai-design-system/tools/source-baseline/build.py',
            ],
            'typecheck_exit': typecheck.returncode,
            'scene_extraction_exit': 0,
            'vite_exit': vite.returncode,
        },
        'entry': 'entries/baseline.html',
        'entry_self_contained': (
            'entries/baseline.html inlines its JS and CSS (vite inlineDynamicImports '
            '+ single-file transform), so it opens and runs directly from file:// '
            'with no server and no external request.'
        ),
        'scenes': scenes,
        'fixture_scope': (
            'Fixtures replace BACKEND DATA only (playground mock + baseline fixtures); '
            'every rendered element comes from the renderer sources consumed by this '
            'build. They do not represent real backend behavior.'
        ),
        'inputs': collect_inputs(module_graph),
        'files': files,
    }
    manifest['input_fingerprint'] = input_fingerprint(
        {k: v for k, v in manifest.items() if k not in ('files', 'input_fingerprint')})

    # Snapshot reuse: identical inputs keep the recorded generation snapshot so
    # committing sources+artifacts cannot invalidate the check afterwards.
    # Whether THIS run reused the snapshot is runtime state — it goes to the
    # log only, never into the manifest, or a reuse/no-reuse pair could never
    # be byte-identical.
    base = provenance_base if isinstance(provenance_base, dict) else None
    base_ok = (isinstance(base, dict)
               and isinstance(base.get('generator'), dict)
               and base['generator'].get('tool') == GENERATOR_ID
               and base.get('input_fingerprint') == manifest['input_fingerprint']
               and isinstance(base.get('snapshot'), dict))
    if base_ok:
        manifest['snapshot'] = base['snapshot']
    else:
        # generator.sources keys are TOOL-relative; git status is repo-relative.
        dirty_keys = (set(manifest['inputs']['repo_files'])
                      | {TOOL_REL + '/' + k for k in manifest['generator']['sources']})
        manifest['snapshot'] = {
            'head': git['head'],
            'head_dirty': sorted(p for p in dirty_keys if p in git['dirty']),
            'note': ('Input state at the time the inputs LAST changed (git head plus '
                     'uncommitted/untracked input paths of THIS build). Currency is '
                     'proven by inputs hashes + regeneration, not by comparing this '
                     'snapshot to the current git state.'),
        }
    reused = base_ok  # log-only: runtime state must NOT enter the manifest

    manifest.pop('snapshot_reused', None)
    (out / 'baseline-manifest.json').write_text(
        json.dumps(manifest, ensure_ascii=False, indent=2, sort_keys=True) + '\n')
    (out / 'index.html').write_text(render_entry(manifest), encoding='utf-8')
    return manifest, reused



def render_entry(m: dict) -> str:
    """The unified three-layer entry. Static HTML, no external requests."""
    by_region: dict = {}
    for s in m['scenes']:
        by_region.setdefault(s['region'], []).append(s)
    groups = ''.join(
        '<h3>{region} · {n}</h3><ul>{items}</ul>'.format(
            region=region,
            n=len(scenes),
            items=''.join(
                f'<li><a href="entries/baseline.html?scene={s["id"]}"><code>{s["id"]}</code></a></li>'
                for s in scenes)
        )
        for region, scenes in by_region.items())
    g = m['generator']
    snap = m['snapshot']
    inputs = m['inputs']
    settings_n = sum(1 for s in m['scenes'] if s['region'] == '设置')
    dirty = snap['head_dirty']
    dirty_summary = (
        f'{len(dirty)} 个输入与该快照 HEAD 不同（未提交/未跟踪，见 manifest.snapshot.head_dirty）：'
        + '<br>'.join(f'<code>{p}</code>' for p in dirty)
        if dirty else '无 — 生成时全部输入与快照 HEAD 一致'
    )
    files = ''.join(
        f'<tr><td><code>{name}</code></td><td><code>{sha[:12]}</code></td></tr>'
        for name, sha in m['files'].items())
    return f"""<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Polo AI Design System · 三层素材入口</title>
<style>
  body {{ font-family: system-ui, sans-serif; margin: 0; background: #f7f7f8; color: #1c1c1e; }}
  main {{ max-width: 960px; margin: 0 auto; padding: 40px 24px 80px; }}
  h1 {{ font-size: 22px; }} h2 {{ font-size: 16px; margin-top: 40px; border-bottom: 1px solid #e2e2e4; padding-bottom: 6px; }}
  h3 {{ font-size: 13px; margin: 18px 0 4px; color: #55555a; }}
  .card {{ background: #fff; border: 1px solid #e2e2e4; border-radius: 12px; padding: 16px 20px; margin: 12px 0; }}
  .card a {{ color: #5b4fc4; font-weight: 600; }}
  .card p {{ margin: 6px 0 0; font-size: 13px; color: #6b6b70; }}
  table {{ border-collapse: collapse; font-size: 12px; width: 100%; }}
  td {{ border-top: 1px solid #eee; padding: 4px 8px; vertical-align: top; }}
  code {{ font-size: 12px; background: #f1f1f3; border-radius: 4px; padding: 1px 5px; word-break: break-all; }}
  ul {{ columns: 2; font-size: 13px; }}
  .meta {{ font-size: 12px; color: #6b6b70; }}
</style>
</head>
<body>
<main>
<h1>Polo AI Design System · 三层素材入口</h1>
<p class="meta">统一入口由 <code>tools/source-baseline/build.py</code> 生成；基线素材 import 当前分支真实 renderer 源码，fixture 只替换后端数据。本页与 <code>entries/baseline.html</code> 的 JS/CSS 均已内联，可直接以 <code>file://</code> 打开。</p>

<h2>第一层 · 页面/区域基线（可直接作新需求起点）</h2>
<div class="card">
  <a href="entries/baseline.html">当前实现基线 · 场景目录（{len(m['scenes'])} 个场景，按层分组）</a>
  <p>登录壳、工作台整页、首页、圈子、助手、设置 {settings_n} 个场景（注册表子页 + 未登录独立态；清单由源码求值）——
  全部由 <code>apps/electron/src/renderer</code> 真实组件渲染；地址支持 <code>?scene=ID</code> 与 <code>#scene=ID</code>，<code>&amp;pure=1</code> 为纯页面模式。</p>
</div>
<div class="card">
  <a href="entries/baseline.html?scene=workspace-home&amp;pure=1">工作台整页 · 首页路由（纯页面）</a>
  <p>真实 TabShell（TopBar+TabContent）+ ClientPageProvider + ClientHomeRouter；首页→我的圈子→详情为产品自身 navigate/back，同一 fixture 数据上下文。</p>
</div>
<div class="card">
  <a href="entries/baseline.html?scene=workspace-circle-detail&amp;pure=1">工作台整页 · 圈子详情深路由（纯页面）</a>
  <p>同一壳组合 mount 后经 useClientPage().navigate 定位到圈子详情。</p>
</div>
<div class="card">
  <span><b>目标设计模板（旧目标稿，非当前实现）</b>：<code>docs/mvp-complete-flow-hifi/prototype.html</code>（仓库根服务后打开，场景地址 <code>#scene=P-*</code>）。</span>
  <p>该层是已评审的目标模板基线，按已确认设计范围另列使用；与上面「当前实现基线」分层明确，勿混用。</p>
</div>

<h2>第二层 · 组件画廊（生产组件与变体）</h2>
<div class="card">
  <a href="entries/baseline.html?scene=components-gallery&amp;pure=1">组件画廊（生产组件逐条浏览，真实变体切换）</a>
  <p>settings 组件 12 项（<code>@/components/settings</code>，其中 <code>settings-page-preview</code> 为 registry PageDemo 组合展示示例）、
  聊天/TurnCard/输入区、onboarding 步骤件；渲染协议与 playground 注册同源，变体切换为真实受控交互；
  每张卡标注生产落点（准确索引，不复制实现）。</p>
</div>

<h2>第三层 · 设计基础（tokens 与原则）</h2>
<div class="card">
  <a href="../tokens/token-preview.html">Token 预览（workbench-base / POO-105 材质令牌）</a>
  <p>色彩、字体、间距、材质 cascade 与状态合同；来源见 references/foundations.md。</p>
</div>

<p>可编辑原生入口与任务候选/预览/导出方法：<code>references/native-reuse.md</code>；场景源码 <code>tools/source-baseline/entries/scenes.tsx</code>。不要编辑本 HTML 导出。</p>
<h2>场景清单（由真实模块求值提取）</h2>
{groups}

<h2>生成记录（仅本次构建实际执行的步骤）</h2>
<table>
  <tr><td>输入快照（输入最近变化时）</td><td>HEAD <code>{snap['head']}</code>{'<br>' + dirty_summary if dirty else ''}<br><span class="meta">快照语义：记录输入最近一次变化时的生成环境；当前性由输入哈希与再生核对证明，不与当前 git 状态机械比对。</span></td></tr>
  <tr><td>design revision</td><td><code>{m['design_revision']}</code></td></tr>
  <tr><td>输入指纹</td><td>仓库源文件 {len(inputs['repo_files'])} 个（含 <code>apps/electron/src/renderer</code> 页面/组件/样式与所维护源，来自真实 vite 模块图）；依赖包 {len(inputs['packages'])} 个；lockfile {len(inputs['lockfiles'])} 个；生成器文件 {len(g['sources'])} 个。指纹：<code>{m['input_fingerprint'][:12]}</code></td></tr>
  <tr><td>typecheck</td><td>cwd <code>仓库根</code>：<code>node_modules/.bin/tsc --project {TOOL_REL}/tsconfig.json --pretty false</code> → exit {g['typecheck_exit']}（本次构建执行）</td></tr>
  <tr><td>场景清单提取</td><td>cwd <code>{TOOL_REL}</code>：<code>{VITE_FROM_TOOL} build --config vite.scene-ids.config.mjs</code> + <code>node scene-ids-runner.cjs</code> → exit {g['scene_extraction_exit']}（本次构建执行；对真实场景模块求值，非源码正则）</td></tr>
  <tr><td>浏览器打包</td><td>cwd <code>{TOOL_REL}</code>：<code>{VITE_FROM_TOOL} build --config vite.config.mjs</code> → exit {g['vite_exit']}（本次构建执行；JS/CSS 内联进 <code>entries/baseline.html</code>，file:// 可直接打开，未引用 chunk 不落位）</td></tr>
  <tr><td>再生核对（未随本次构建执行）</td><td>验证方法：cwd <code>仓库根</code> 执行 <code>python3 {TOOL_REL}/build.py --check</code>——重新生成到临时目录并逐字节比对（输入未变时复用已记录快照）；由 <code>docs/mvp-complete-flow-hifi/tools/check_design_system.py</code> 强制执行，结果以检查器输出为准，本页不代其声明结果。</td></tr>
  <tr><td>运行时验证（生成器不执行）</td><td>浏览器内全场景 sweep、交互旅程与 file:// 打开验证由维护流程用真实浏览器执行，记录登记于 <code>references/page-baselines.md</code>；本页不代其声明结果。</td></tr>
</table>

<h2>产物文件（SHA-256 前 12 位）</h2>
<table>
{files}
</table>

<p class="meta">fixture 范围：{m['fixture_scope']}</p>
</main>
</body>
</html>
"""


def load_existing_manifest(out: Path) -> dict | None:
    manifest = out / 'baseline-manifest.json'
    if not manifest.is_file():
        return None
    try:
        data = json.loads(manifest.read_text())
    except (OSError, ValueError):
        return None
    return data if isinstance(data, dict) and data.get('generator', {}).get('tool') == GENERATOR_ID else None


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--out', type=Path, default=DEFAULT_OUT)
    ap.add_argument('--check', action='store_true',
                    help='regenerate into a temp dir and byte-compare with the target')
    args = ap.parse_args()

    # Provenance base: an existing manifest of THIS generator at the target, so
    # unchanged inputs keep their recorded snapshot (see module docstring).
    provenance = load_existing_manifest(args.out)

    if args.check:
        target = args.out
        with tempfile.TemporaryDirectory() as tmp:
            build(Path(tmp), provenance)
            expected = {p.relative_to(target): p for p in target.rglob('*') if p.is_file()}
            actual = {p.relative_to(tmp): Path(tmp) / p.relative_to(tmp)
                      for p in Path(tmp).rglob('*') if p.is_file()}
            problems = []
            for rel in sorted(set(expected) | set(actual)):
                if rel not in expected:
                    problems.append(f'unexpected generated file: {rel}')
                elif rel not in actual:
                    problems.append(f'missing generated file: {rel}')
                elif expected[rel].read_bytes() != actual[rel].read_bytes():
                    problems.append(f'drift: {rel}')
            for p in problems:
                print(p, file=sys.stderr)
            raise SystemExit(1 if problems else 0)

    ensure_safe_output_dir(args.out)
    manifest, reused = build(args.out, provenance)
    print(json.dumps({'ok': True, 'out': str(args.out),
                      'scenes': len(manifest['scenes']),
                      'files': len(manifest['files']),
                      'snapshot_head': manifest['snapshot']['head'][:12],
                      'snapshot_dirty': len(manifest['snapshot']['head_dirty']),
                      'snapshot_reused': reused},
                     ensure_ascii=False))


if __name__ == '__main__':
    main()
