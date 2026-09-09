#!/usr/bin/env python3
"""Synchronize only mechanical asset metadata; never approve or update releases."""
import argparse
from pathlib import Path

from _common import SKILL_DIR, dump_json, load_json, sha256_bytes
from validate_skill import local_inventory


def sync(root: Path):
    context = root / 'assets/design-context'
    manifest_path = context / 'prototype-manifest.json'
    source_path = root / 'references/source.json'
    manifest, source = load_json(manifest_path), load_json(source_path)
    data = (context / 'prototype.html').read_bytes()
    size, digest = len(data), sha256_bytes(data)
    count = len(list((context / 'components').rglob('*.html')))
    manifest['artifacts']['singleFileBytes'] = size
    manifest['artifacts']['singleFileSha256'] = digest
    manifest['artifacts']['componentGallery']['htmlCount'] = count
    manifest_path.write_text(dump_json(manifest), encoding='utf-8')
    info = source['design_context']
    info['prototype'].update(bytes=size, sha256=digest)
    info['component_gallery']['html_count'] = count
    info['file_count'], info['inventory_sha256'] = local_inventory(context)
    source_path.write_text(dump_json(source), encoding='utf-8')


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--skill-dir', type=Path, default=SKILL_DIR)
    sync(parser.parse_args().skill_dir)
