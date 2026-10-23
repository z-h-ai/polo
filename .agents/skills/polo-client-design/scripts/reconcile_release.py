#!/usr/bin/env python3
"""Evaluate a human-reviewed release comparison without writing the design SOT."""
import argparse
from pathlib import Path

from _common import SKILL_DIR, ToolError, dump_json, load_json
from design_status import full_commit


def reconcile(source: dict, review: dict) -> dict:
    release = review.get('release', {})
    if (not full_commit(release.get('commit')) or not release.get('tag') or not release.get('published_at')
            or release.get('draft') is not False or release.get('prerelease') is not False):
        raise ToolError('review must identify a pinned stable published release')
    active = [c for c in source['design_changes'] if c['design_status'] == 'approved']
    rows = review.get('changes', [])
    if not isinstance(rows, list) or sorted(r['id'] for r in rows) != sorted(c['id'] for c in active):
        raise ToolError('review must cover every approved design exactly once')
    results = []
    for change in active:
        row = next(r for r in rows if r['id'] == change['id'])
        if row.get('design_fingerprint') != change['confirmation']['fingerprint']:
            raise ToolError(f"{change['id']}: review must reference the confirmed design fingerprint")
        items = row.get('items', [])
        if sorted(i['scope'] for i in items) != sorted(change['scope']):
            raise ToolError(f"{change['id']}: review must cover every scope item exactly once")
        remaining = []
        for item in items:
            outcome = item.get('outcome')
            if outcome not in ('matches', 'partial', 'missing', 'conflict'):
                raise ToolError('invalid release review outcome')
            if any(not isinstance(item.get(k), str) or not item[k].strip() for k in ('evidence', 'observed')):
                raise ToolError('every observation needs evidence and concrete observed behavior')
            if outcome != 'matches':
                if any(not isinstance(item.get(k), str) or not item[k].strip() for k in ('remaining', 'recommendation')):
                    raise ToolError('unmet design needs remaining scope and a repair recommendation')
                remaining.append(item)
        results.append({'id': change['id'], 'design_status': change['design_status'],
                        'recorded_delivery_status': change['delivery_status'],
                        'release_contains_complete_design': not remaining,
                        'remaining': remaining, 'observations': items,
                        'target_action': 'preserve'})
    return {'release': release, 'changes': results, 'write_performed': False,
            'note': 'Human-reviewed evidence only; no automatic approval, delivery transition or target replacement.'}


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--skill-dir', type=Path, default=SKILL_DIR)
    parser.add_argument('--review', type=Path, required=True)
    args = parser.parse_args()
    try:
        print(dump_json(reconcile(load_json(args.skill_dir / 'references/source.json'), load_json(args.review))), end='')
    except (ToolError, KeyError, TypeError) as exc:
        raise SystemExit(f'error: {exc}')
