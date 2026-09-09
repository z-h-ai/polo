"""Behavior checks in isolated copies; all approvals/evidence below are synthetic."""
import copy
import json
import shutil
import subprocess
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from _common import SKILL_DIR, ToolError, dump_json, load_json
from design_status import fingerprint, target_digest, validate_design
from reconcile_release import reconcile
from sync_asset_metadata import sync
from validate_skill import local_inventory, validate_design_context


class IterationTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name) / 'skill'
        shutil.copytree(SKILL_DIR, self.root, ignore=shutil.ignore_patterns('__pycache__', 'dist', 'dist-gallery'))
        self.source = load_json(self.root / 'references/source.json')

    def draft(self):
        change = {'id': 'settings-single-column', 'goal': 'Readable settings',
                  'scope': ['settings.layout', 'settings.error-placement'],
                  'changes': 'Stack controls and place errors below', 'out_of_scope': 'Navigation and colors',
                  'states': ['normal', 'focus', 'disabled', 'error', 'narrow', 'dark'],
                  'baseline_commit': self.source['design_migration']['baseline_commit'], 'version': '1.0.1',
                  'design_status': 'draft', 'delivery_status': 'pending', 'confirmation': None}
        self.source['design_changes'].append(change)
        return change

    def approve(self, change):
        change['design_status'] = 'approved'
        change['confirmation'] = {'by': 'synthetic test user', 'at': '2026-09-09T00:00:00Z',
                                  'reference': 'test fixture only; not a real approval',
                                  'fingerprint': fingerprint(change, self.root)}
        self.source['design_context']['version'] = change['version']
        p = self.root / 'assets/design-context/prototype-manifest.json'
        manifest = load_json(p)
        manifest['baselineVersion'] = change['version']
        p.write_text(dump_json(manifest))

    def save(self):
        (self.root / 'references/source.json').write_text(dump_json(self.source))

    def review(self, change, outcomes=('matches', 'matches')):
        return {'release': copy.deepcopy(self.source['release']), 'changes': [{
            'id': change['id'], 'design_fingerprint': change['confirmation']['fingerprint'],
            'items': [{'scope': scope, 'outcome': outcome,
                       'observed': 'Synthetic release observation', 'evidence': 'Synthetic pinned source fixture',
                       'remaining': 'Error placement or column layout', 'recommendation': 'Implement approved stacking rule'}
                      for scope, outcome in zip(change['scope'], outcomes)]}]}

    def test_migration_and_ordinary_reuse_need_no_invented_approval(self):
        self.assertEqual(validate_design(self.source, self.root, True), [])
        self.assertEqual(self.source['design_changes'], [])
        self.assertIsNone(self.source['design_migration']['confirmation'])

    def test_unrecorded_target_edit_is_rejected(self):
        with (self.root / 'references/layout.md').open('a') as f:
            f.write('\nUnrecorded single-column target\n')
        self.assertTrue(validate_design(self.source, self.root, True))

    def test_draft_previews_but_cannot_promote(self):
        self.draft()
        self.assertEqual(validate_design(self.source, self.root), [])
        self.assertIn('draft cannot be promoted', '\n'.join(validate_design(self.source, self.root, True)))

    def test_approved_pending_can_promote_and_asset_sync_preserves_status(self):
        change = self.draft()
        self.approve(change)
        self.save()
        sync(self.root)
        self.source = load_json(self.root / 'references/source.json')
        self.assertEqual(validate_design(self.source, self.root, True), [])
        self.assertEqual(self.source['design_changes'][0], change)
        with patch('validate_skill.DESIGN_CONTEXT', self.root / 'assets/design-context'), patch('validate_skill.SKILL_DIR', self.root):
            self.assertEqual(validate_design_context(self.source), [])

    def test_target_or_contract_edits_invalidate_confirmation(self):
        change = self.draft()
        self.approve(change)
        for path in ['references/layout.md', 'assets/design-context/src/styles/tokens.css',
                     'assets/design-context/prototype.html', 'assets/design-context/scene-catalog.json']:
            p = self.root / path
            before = p.read_bytes()
            p.write_bytes(before + b'\n/* test change */\n')
            self.assertTrue(validate_design(self.source, self.root, True), path)
            p.write_bytes(before)
        change['scope'].append('settings.new-scope')
        self.assertTrue(validate_design(self.source, self.root, True))
        self.approve(change)
        self.assertEqual(validate_design(self.source, self.root, True), [])

    def test_target_color_keeps_release_token_snapshot(self):
        change = self.draft()
        token_path = self.root / 'references/tokens.json'
        before = token_path.read_bytes()
        with (self.root / 'references/foundations.md').open('a') as f:
            f.write('\nTarget (synthetic design): purple; observed release tokens retained.\n')
        with (self.root / 'assets/design-context/src/styles/tokens.css').open('a') as f:
            f.write('\n:root { --accent: purple; }\n')
        self.save()
        sync(self.root)
        self.assertEqual(token_path.read_bytes(), before)
        self.assertEqual(load_json(self.root / 'references/source.json')['release'], self.source['release'])
        self.assertEqual(validate_design(self.source, self.root), [])

    def test_delivery_requires_complete_evidence(self):
        change = self.draft()
        self.approve(change)
        change['delivery_status'] = 'implemented'
        self.assertTrue(validate_design(self.source, self.root, True))
        change['implementation'] = {'commit': 'a' * 40, 'reference': 'synthetic test implementation', 'scope': change['scope'][:1]}
        self.assertTrue(validate_design(self.source, self.root, True))
        change['implementation']['scope'] = change['scope'][:]
        self.assertEqual(validate_design(self.source, self.root, True), [])
        change['delivery_status'] = 'released'
        self.assertTrue(validate_design(self.source, self.root, True))
        change['release_evidence'] = {**self.source['release'], 'reference': 'synthetic release evidence', 'scope': change['scope'][:]}
        self.assertEqual(validate_design(self.source, self.root, True), [])
        change['release_evidence']['prerelease'] = True
        self.assertTrue(validate_design(self.source, self.root, True))

    def test_invalid_states_confirmation_and_versions_fail(self):
        change = self.draft()
        change['design_status'] = 'approved'
        self.assertTrue(validate_design(self.source, self.root, True))
        self.approve(change)
        for field, value in [('design_status', 'done'), ('delivery_status', 'done'), ('version', '1.0.0'), ('scope', []), ('states', []), ('baseline_commit', 'short')]:
            original = change[field]
            change[field] = value
            self.assertTrue(validate_design(self.source, self.root), field)
            change[field] = original

    def test_superseded_history_requires_confirmed_replacement(self):
        old = self.draft()
        self.approve(old)
        confirmation = copy.deepcopy(old['confirmation'])
        old['design_status'] = 'superseded'
        old['superseded_by'] = 'settings-v2'
        self.assertTrue(validate_design(self.source, self.root, True))
        new = copy.deepcopy(old)
        new.update(id='settings-v2', version='1.0.2', changes='Revised single column gap')
        new.pop('superseded_by')
        self.source['design_changes'].append(new)
        self.approve(new)
        self.assertEqual(validate_design(self.source, self.root, True), [])
        self.assertEqual(old['confirmation'], confirmation)

    def test_metadata_sync_is_byte_idempotent_and_only_mechanical(self):
        before = copy.deepcopy(self.source)
        verification = load_json(self.root / 'assets/design-context/prototype-manifest.json')['verification']
        sync(self.root)
        first = (self.root / 'references/source.json').read_bytes(), local_inventory(self.root / 'assets/design-context')
        sync(self.root)
        second = (self.root / 'references/source.json').read_bytes(), local_inventory(self.root / 'assets/design-context')
        self.assertEqual(first, second)
        after = load_json(self.root / 'references/source.json')
        for key in before.keys() - {'design_context'}:
            self.assertEqual(before[key], after[key], key)
        self.assertEqual(before['design_context']['version'], after['design_context']['version'])
        self.assertEqual(verification, load_json(self.root / 'assets/design-context/prototype-manifest.json')['verification'])

    def test_static_check_is_read_only_and_never_claims_acceptance(self):
        before = local_inventory(self.root / 'assets/design-context')
        result = subprocess.run(['node', str(self.root / 'assets/design-context/tools/validate-prototype.mjs')], capture_output=True, text=True, check=True)
        report = json.loads(result.stdout)
        self.assertTrue(report['ok'])
        for field in ('sourceFidelity', 'browser', 'productAcceptance'):
            self.assertEqual(report[field], 'not_assessed')
        self.assertFalse(report['writePerformed'])
        self.assertEqual(before, local_inventory(self.root / 'assets/design-context'))

    def test_missing_partial_and_conflicting_release_preserve_targets(self):
        change = self.draft()
        self.approve(change)
        self.save()
        before = copy.deepcopy(self.source), target_digest(self.root)
        for outcome in ('missing', 'partial', 'conflict'):
            report = reconcile(self.source, self.review(change, ('matches', outcome)))
            item = report['changes'][0]
            self.assertFalse(item['release_contains_complete_design'])
            self.assertEqual(item['target_action'], 'preserve')
            self.assertEqual(item['remaining'][0]['scope'], 'settings.error-placement')
            self.assertEqual(item['recorded_delivery_status'], 'pending')
            self.assertFalse(report['write_performed'])
        self.assertEqual(before, (self.source, target_digest(self.root)))

    def test_complete_release_reports_coverage_without_advancing_delivery(self):
        change = self.draft()
        self.approve(change)
        report = reconcile(self.source, self.review(change))
        self.assertTrue(report['changes'][0]['release_contains_complete_design'])
        self.assertEqual(change['delivery_status'], 'pending')

    def test_release_review_rejects_missing_duplicate_and_unsupported_evidence(self):
        change = self.draft()
        self.approve(change)
        for mutation in ('missing-change', 'missing-scope', 'duplicate', 'no-evidence', 'no-repair', 'prerelease', 'stale-design'):
            review = self.review(change, ('missing', 'partial'))
            if mutation == 'missing-change': review['changes'] = []
            elif mutation == 'missing-scope': review['changes'][0]['items'].pop()
            elif mutation == 'duplicate': review['changes'][0]['items'].append(review['changes'][0]['items'][0])
            elif mutation == 'no-evidence': review['changes'][0]['items'][0]['evidence'] = ''
            elif mutation == 'no-repair': review['changes'][0]['items'][0]['recommendation'] = ''
            elif mutation == 'prerelease': review['release']['prerelease'] = True
            else: review['changes'][0]['design_fingerprint'] = '0' * 64
            with self.assertRaises(ToolError, msg=mutation):
                reconcile(self.source, review)
