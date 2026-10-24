"""Real Git histories exercise event ranges, drift recovery and output isolation."""
import importlib.util
import json
from pathlib import Path
import subprocess
import tempfile
import unittest
from unittest.mock import patch

MODULE = Path(__file__).resolve().parents[1] / 'prototype_refresh.py'
spec = importlib.util.spec_from_file_location('refresh', MODULE)
refresh = importlib.util.module_from_spec(spec)
spec.loader.exec_module(refresh)


class RefreshTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.repo = Path(self.tmp.name) / 'repo'
        self.repo.mkdir()
        self.git('init', '-q')
        self.git('config', 'user.email', 'fixture@example.invalid')
        self.git('config', 'user.name', 'Fixture')
        self.source = 'apps/electron/src/renderer/Card.tsx'
        self.write(self.source, 'export const Card = "before"\n')
        self.write('packages/odd-package/theme.css', ':root {color: red}')
        self.write(refresh.BASELINE + '/entries/baseline.html', '<h1>baseline</h1>')
        self.write(refresh.BASELINE + '/index.html', '<h1>index</h1>')
        self.write(refresh.MANIFEST, json.dumps({
            'inputs': {'repo_files': {p: refresh.sha(self.repo / p) for p in
                       [self.source, 'packages/odd-package/theme.css']}, 'lockfiles': {}},
            'generator': {'tool': f'{refresh.SKILL}/tools/source-baseline', 'sources': {}},
            'files': {'entries/baseline.html': refresh.sha(self.repo / refresh.BASELINE / 'entries/baseline.html')}}))
        self.base = self.commit()

    def git(self, *args):
        return subprocess.check_output(['git', '-C', str(self.repo), *args], stderr=subprocess.DEVNULL).decode().strip()

    def write(self, path, content):
        dest = self.repo / path
        dest.parent.mkdir(parents=True, exist_ok=True)
        dest.write_text(content)

    def commit(self):
        self.git('add', '.')
        self.git('commit', '-qm', 'fixture')
        return self.git('rev-parse', 'HEAD')

    def plan(self, before=None):
        return refresh.make_plan(self.repo, before or self.base)

    def prepare_boundary(self):
        self.write(f'{refresh.SKILL}/tools/build-token-preview.py', 'import sys; from pathlib import Path; Path(sys.argv[1]).write_text("tokens")')
        self.write(f'{refresh.SKILL}/assets/tokens/token-preview.html', 'tokens')
        self.write(f'{refresh.SKILL}/references/design-system.json', json.dumps({'revision': 'fixture', 'sources': []}))
        m = json.loads((self.repo / refresh.MANIFEST).read_text())
        m['inputs']['repo_files'][f'{refresh.SKILL}/tools/build-token-preview.py'] = refresh.sha(self.repo / refresh.SKILL / 'tools/build-token-preview.py')
        m['design_revision'] = 'fixture'
        m['snapshot'] = {'head': self.base}
        self.write(refresh.MANIFEST, json.dumps(m))
        self.commit()

    def test_boundary_rejects_corrupt_token_output(self):
        self.prepare_boundary()
        self.write(f'{refresh.SKILL}/assets/tokens/token-preview.html', 'corrupt')
        self.assertIn('token-preview-output-stale', refresh.boundary_plan(self.repo, 'new-task')['source_issues'])

    def test_boundary_current_checks_are_read_only(self):
        self.prepare_boundary()
        before = self.git('status', '--porcelain')
        for boundary in ['main-integration', 'new-task']:
            self.assertEqual(refresh.boundary_plan(self.repo, boundary)['status'], 'current')
        self.assertEqual(self.git('status', '--porcelain'), before)

    def test_source_and_material_same_commit_does_not_loop(self):
        self.prepare_boundary()
        self.write(self.source, 'blue button')
        m = json.loads((self.repo / refresh.MANIFEST).read_text())
        m['inputs']['repo_files'][self.source] = refresh.sha(self.repo / self.source)
        self.write(refresh.MANIFEST, json.dumps(m))
        self.commit()  # Snapshot intentionally remains the pre-commit HEAD.
        self.assertEqual(refresh.boundary_plan(self.repo, 'new-task')['status'], 'current')

    def test_boundary_catches_new_untracked_ui(self):
        self.prepare_boundary()
        self.write('apps/electron/src/renderer/New.tsx', 'new page')
        plan = refresh.boundary_plan(self.repo, 'new-task')
        self.assertEqual(plan['status'], 'needs-maintenance')
        self.assertIn('apps/electron/src/renderer/New.tsx', plan['unrecorded_ui_paths'])

    def test_boundary_catches_existing_uncommitted_ui(self):
        self.prepare_boundary()
        self.write(self.source, 'changed without commit')
        self.assertIn(self.source, refresh.boundary_plan(self.repo, 'main-integration')['stale_inputs'])

    def test_boundary_checks_model_source_bytes(self):
        self.prepare_boundary()
        self.write(f'{refresh.SKILL}/references/design-system.json', json.dumps({'revision': 'fixture', 'sources': [{'path': self.source, 'sha256': 'stale'}]}))
        self.assertIn(self.source, refresh.boundary_plan(self.repo, 'new-task')['source_issues'])

    def test_boundary_does_not_accept_unadopted_success_cache(self):
        self.prepare_boundary()
        self.write(self.source, 'new UI')
        self.commit()
        cache = self.success_cache()
        self.assertFalse(refresh.make_plan(self.repo, before='HEAD', last_success=cache)['refresh'])
        self.assertTrue(refresh.boundary_plan(self.repo, 'new-task')['refresh'])

    def test_docs_only_skips_current_baseline(self):
        self.write('README.md', 'docs')
        self.commit()
        self.assertFalse(self.plan()['refresh'])

    def test_generator_paths_are_tool_relative(self):
        path = f'{refresh.SKILL}/tools/source-baseline/build.py'
        self.write(path, '# generator')
        m = json.loads((self.repo / refresh.MANIFEST).read_text())
        m['generator']['sources'] = {'build.py': refresh.sha(self.repo / path)}
        self.write(refresh.MANIFEST, json.dumps(m))
        base = self.commit()
        self.write('README.md', 'docs')
        self.commit()
        self.assertFalse(self.plan(base)['refresh'])
        self.write(path, '# changed')
        self.commit()
        self.assertIn(path, self.plan(base)['stale_inputs'])

    def test_fresh_checkout_missing_ignored_exports_is_not_drift(self):
        self.write('.gitignore', 'packages/shared/dist/\n')
        m = json.loads((self.repo / refresh.MANIFEST).read_text())
        m['inputs']['repo_files']['packages/shared/dist/export.js'] = 'old-generated-hash'
        self.write(refresh.MANIFEST, json.dumps(m))
        base = self.commit()
        self.write('README.md', 'docs')
        self.commit()
        self.assertFalse(self.plan(base)['refresh'])

    def test_new_ui_outside_previous_graph_triggers(self):
        self.write('apps/electron/src/renderer/New.tsx', 'new')
        self.commit()
        self.assertTrue(self.plan()['refresh'])

    def test_external_graph_dependency_triggers(self):
        self.write('packages/odd-package/theme.css', ':root {color: blue}')
        self.commit()
        self.assertIn('packages/odd-package/theme.css', self.plan()['matched_paths'])

    def test_rename_outside_ui_still_detects_old_path(self):
        self.git('mv', self.source, 'removed.tsx')
        self.commit()
        self.assertIn(self.source, self.plan()['matched_paths'])

    def test_delete_detected(self):
        (self.repo / self.source).unlink()
        self.commit()
        self.assertIn(self.source, self.plan()['stale_inputs'])

    def test_cancelled_ui_push_then_docs_push_rebuilds(self):
        self.write(self.source, 'changed')
        intermediate = self.commit()
        self.write('README.md', 'later docs')
        self.commit()
        plan = self.plan(intermediate)
        self.assertEqual(plan['matched_paths'], [])
        self.assertTrue(plan['refresh'])
        self.assertIn(self.source, plan['stale_inputs'])

    def test_generated_only_valid_change_does_not_loop(self):
        self.write(refresh.BASELINE + '/index.html', '<h1>generated index refreshed</h1>')
        self.commit()
        self.assertFalse(self.plan()['refresh'])

    def success_cache(self, status='passed'):
        cache = Path(self.tmp.name) / 'last-success'
        cache.mkdir()
        m = json.loads((self.repo / refresh.MANIFEST).read_text())
        m['inputs']['repo_files'][self.source] = refresh.sha(self.repo / self.source)
        (cache / 'baseline-manifest.json').write_text(json.dumps(m))
        (cache / 'result.json').write_text(json.dumps({'status': status, 'head': self.git('rev-parse', 'HEAD'),
            'artifact_sha256': {'assets/source-baseline/baseline-manifest.json': refresh.sha(cache / 'baseline-manifest.json')}}))
        return cache

    def test_success_checkpoint_avoids_rebuilding_after_docs_only(self):
        self.write(self.source, 'new UI')
        ui_head = self.commit()
        cache = self.success_cache()
        self.write('README.md', 'docs after successful UI build')
        self.commit()
        plan = refresh.make_plan(self.repo, ui_head, last_success=cache)
        self.assertFalse(plan['refresh'])
        self.assertEqual(plan['baseline_origin'], 'last-successful-run')
        self.assertTrue(self.plan(ui_head)['refresh'])  # committed baseline is still old

    def test_failed_checkpoint_cannot_hide_stale_inputs(self):
        self.write(self.source, 'new UI')
        ui_head = self.commit()
        cache = self.success_cache(status='failed')
        self.assertTrue(refresh.make_plan(self.repo, ui_head, last_success=cache)['refresh'])

    def test_cancelled_new_unregistered_ui_survives_next_docs_push(self):
        cache = self.success_cache()
        path = 'apps/electron/src/renderer/NewUnregistered.tsx'
        self.write(path, 'new file not in baseline graph')
        cancelled_head = self.commit()
        self.write('README.md', 'next push')
        self.commit()
        plan = refresh.make_plan(self.repo, cancelled_head, last_success=cache)
        self.assertIn(path, plan['matched_paths'])
        self.assertTrue(plan['refresh'])

    def test_corrupt_checkpoint_falls_back_to_repository(self):
        cache = self.success_cache()
        (cache / 'baseline-manifest.json').write_text('{}')
        self.assertEqual(refresh.make_plan(self.repo, self.base, last_success=cache)['baseline_origin'], 'repository')

    def test_tampered_artifact_rebuilds(self):
        self.write(refresh.BASELINE + '/entries/baseline.html', 'broken')
        self.commit()
        self.assertTrue(self.plan()['output_drift'])

    def test_zero_and_unknown_before_rebuild(self):
        for before in ('0' * 40, 'not-a-commit'):
            self.assertTrue(self.plan(before)['refresh'])

    def test_missing_manifest_rebuilds(self):
        (self.repo / refresh.MANIFEST).unlink()
        self.assertTrue(self.plan()['manifest_issue'])

    def test_malformed_manifest_rebuilds(self):
        self.write(refresh.MANIFEST, '{"inputs": []}')
        self.assertTrue(self.plan()['manifest_issue'])

    def test_output_refuses_existing_or_repo_directory(self):
        for path in (self.repo / 'output', Path(self.tmp.name)):
            with self.assertRaises((ValueError, FileExistsError)):
                refresh.run(self.repo, path, self.plan())

    def test_failed_build_never_reports_success(self):
        plan = refresh.make_plan(self.repo, self.base, force=True)
        out = Path(self.tmp.name) / 'failed'
        with patch.object(refresh, 'command', side_effect=RuntimeError('build failed')):
            result = refresh.run(self.repo, out, plan)
        self.assertEqual(result['status'], 'failed')
        self.assertEqual(json.loads((out / 'result.json').read_text())['status'], 'failed')
        self.assertFalse((out / 'generated.patch').exists())

    def test_skipped_run_does_not_invoke_build(self):
        with patch.object(refresh, 'command') as command:
            result = refresh.run(self.repo, Path(self.tmp.name) / 'skip', self.plan())
            command.assert_not_called()
        self.assertEqual(result['status'], 'skipped')

    def test_dirty_checkout_is_not_published(self):
        self.write(self.source, 'uncommitted')
        result = refresh.run(self.repo, Path(self.tmp.name) / 'dirty', self.plan())
        self.assertEqual(result['status'], 'failed')
        self.assertIn('tracked worktree changes', result['error'])

    def test_patch_roundtrip_preserves_missing_final_newlines(self):
        self.write('end.html', '<p>old</p>')
        self.commit()
        changed = Path(self.tmp.name) / 'changed.html'
        changed.write_text('<p>new</p>')
        patchfile = Path(self.tmp.name) / 'update.patch'
        patchfile.write_bytes(refresh.generated_patch(self.repo, [(changed, 'end.html')]))
        self.git('apply', '--check', str(patchfile))
        self.git('apply', str(patchfile))
        self.assertEqual((self.repo / 'end.html').read_bytes(), changed.read_bytes())

    def test_patch_can_create_previously_missing_output(self):
        changed = Path(self.tmp.name) / 'new.html'
        changed.write_text('<p>new</p>')
        patchfile = Path(self.tmp.name) / 'create.patch'
        patchfile.write_bytes(refresh.generated_patch(self.repo, [(changed, 'new.html')]))
        self.git('apply', '--check', str(patchfile))
        self.git('apply', str(patchfile))
        self.assertEqual((self.repo / 'new.html').read_bytes(), changed.read_bytes())


if __name__ == '__main__':
    unittest.main()
