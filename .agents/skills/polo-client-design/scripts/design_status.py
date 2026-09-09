#!/usr/bin/env python3
"""Read-only design confirmation checks. Fingerprints never constitute approval."""
from __future__ import annotations

import argparse
import re
from pathlib import Path

from _common import SKILL_DIR, ToolError, dump_json, load_json, sha256_bytes

NORMATIVE = ('foundations.md', 'layout.md', 'components.md', 'interaction-states.md')
CONTRACT = ('id', 'goal', 'scope', 'changes', 'out_of_scope', 'states', 'baseline_commit', 'version')


def full_commit(value):
    return isinstance(value, str) and re.fullmatch(r'[0-9a-f]{40}', value) is not None


def version(value):
    if not isinstance(value, str) or not re.fullmatch(r'\d+\.\d+\.\d+', value):
        raise ToolError('design version must be major.minor.patch')
    return tuple(map(int, value.split('.')))


def target_digest(root: Path) -> str:
    paths = [root / 'references' / name for name in NORMATIVE]
    context = root / 'assets/design-context'
    paths += [context / 'prototype.html', context / 'scene-catalog.json', context / 'index.html']
    for folder in ('src', 'assets', 'components'):
        paths += [p for p in (context / folder).rglob('*') if p.is_file()]
    return sha256_bytes(''.join(f'{p.relative_to(root).as_posix()}\t{sha256_bytes(p.read_bytes())}\n'
                               for p in sorted(paths)).encode())


def fingerprint(change: dict, root: Path) -> str:
    return sha256_bytes(dump_json({'contract': {k: change.get(k) for k in CONTRACT},
                                   'target_sha256': target_digest(root)}).encode())


def evidence_valid(evidence, scope):
    return (isinstance(evidence, dict) and full_commit(evidence.get('commit'))
            and isinstance(evidence.get('reference'), str) and bool(evidence['reference'].strip())
            and isinstance(evidence.get('scope'), list) and evidence['scope'] == scope)


def validate_design(source: dict, root: Path, for_promotion=False) -> list[str]:
    errors = []
    try:
        if source.get('schema_version') != 2:
            raise ToolError('source.schema_version must be 2')
        migration = source['design_migration']
        changes = source['design_changes']
        if not isinstance(changes, list):
            raise ToolError('design_changes must be a list')
        if (not full_commit(migration.get('baseline_commit')) or migration.get('confirmation') is not None
                or not re.fullmatch(r'[0-9a-f]{64}', migration.get('target_sha256', ''))):
            raise ToolError('migration must retain a baseline digest and commit without invented confirmation')
        previous = version(migration['version'])
        ids = [c['id'] for c in changes]
        if len(ids) != len(set(ids)):
            errors.append('design change IDs must be unique')
        active = []
        for change in changes:
            label = change['id']
            if not isinstance(label, str) or not label.strip():
                raise ToolError('design change id must be non-empty')
            for key in ('goal', 'changes', 'out_of_scope'):
                if not isinstance(change.get(key), str) or not change[key].strip():
                    errors.append(f'{label}: {key} must be non-empty text')
            for key in ('scope', 'states'):
                values = change.get(key)
                if (not isinstance(values, list) or not values
                        or any(not isinstance(v, str) or not v.strip() for v in values)
                        or len(values) != len(set(values))):
                    raise ToolError(f'{label}: {key} must contain unique non-empty strings')
            if not full_commit(change.get('baseline_commit')):
                errors.append(f'{label}: baseline_commit must be a full commit')
            revision = version(change['version'])
            if revision <= previous:
                errors.append(f'{label}: revisions must increase from the migrated version')
            previous = revision
            state, delivery = change.get('design_status'), change.get('delivery_status')
            if state not in ('draft', 'approved', 'superseded'):
                errors.append(f'{label}: invalid design_status')
            if delivery not in ('pending', 'implemented', 'released'):
                errors.append(f'{label}: invalid delivery_status')
            confirmation = change.get('confirmation')
            if state in ('approved', 'superseded'):
                if (not isinstance(confirmation, dict)
                        or any(not isinstance(confirmation.get(k), str) or not confirmation[k].strip()
                               for k in ('by', 'at', 'reference'))
                        or not re.fullmatch(r'[0-9a-f]{64}', confirmation.get('fingerprint', ''))):
                    errors.append(f'{label}: approval needs user, time, reference and fingerprint')
            if state == 'draft':
                if confirmation is not None or delivery != 'pending':
                    errors.append(f'{label}: draft must have no confirmation and remain pending')
                if for_promotion:
                    errors.append(f'{label}: draft cannot be promoted')
            if state == 'superseded':
                replacement = change.get('superseded_by')
                if replacement not in ids[ids.index(label) + 1:] or not any(
                        c['id'] == replacement and c.get('design_status') in ('approved', 'superseded') for c in changes):
                    errors.append(f'{label}: superseded_by must identify a later confirmed replacement')
            else:
                active.append(change)
            if delivery in ('implemented', 'released'):
                if not evidence_valid(change.get('implementation'), change['scope']):
                    errors.append(f'{label}: implementation needs commit, reference and complete scope')
            if delivery == 'released':
                release = change.get('release_evidence', {})
                if (not evidence_valid(release, change['scope']) or not release.get('tag')
                        or not release.get('published_at') or release.get('draft') is not False
                        or release.get('prerelease') is not False):
                    errors.append(f'{label}: release needs stable published release evidence for complete scope')
        confirmed = [c for c in changes if c.get('design_status') in ('approved', 'superseded')]
        expected_version = confirmed[-1]['version'] if confirmed else migration['version']
        if source['design_context']['version'] != expected_version:
            errors.append('design_context.version must equal the latest confirmed revision (or migration)')
        # The latest active revision binds the entire target and its scope. Earlier
        # confirmations are historical; later confirmed designs may change them.
        if active:
            latest = active[-1]
            if latest.get('design_status') == 'approved' and (latest.get('confirmation') or {}).get('fingerprint') != fingerprint(latest, root):
                errors.append(f"{latest['id']}: design changed after confirmation; reconfirm the delta")
        elif target_digest(root) != migration['target_sha256']:
            errors.append('target changed without a design change record')
    except (KeyError, TypeError, ValueError, OSError, ToolError) as exc:
        errors.append(f'invalid design metadata: {exc}')
    return errors


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--skill-dir', type=Path, default=SKILL_DIR)
    parser.add_argument('--fingerprint', metavar='CHANGE_ID')
    args = parser.parse_args()
    source = load_json(args.skill_dir / 'references/source.json')
    if args.fingerprint:
        matches = [c for c in source['design_changes'] if c['id'] == args.fingerprint]
        if len(matches) != 1:
            raise ToolError('expected exactly one matching change')
        print(fingerprint(matches[0], args.skill_dir))
    else:
        print(dump_json({'migration': source['design_migration'], 'changes': source['design_changes']}), end='')


if __name__ == '__main__':
    try:
        main()
    except ToolError as exc:
        raise SystemExit(f'error: {exc}')
