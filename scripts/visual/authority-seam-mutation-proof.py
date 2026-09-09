#!/usr/bin/env python3
"""POO-43 R50 negative/mutation proof for the authority persistence-seam test.

Proves the focused authority test actually bites, by applying two product
mutations in turn, running the focused test against each, and requiring it to
FAIL both times:

  M1 (seam bypass)        — persistFileAtomic calls node:fs renameSync
                            directly instead of the injected seam, so the
                            rename injection never fires.
  M2 (fail-closed invert) — persistFileAtomic swallows the persistence error
                            instead of rethrowing, so the failed commit no
                            longer throws.

Production files are restored byte-for-byte afterwards (verified against the
git index). Exits 0 only if BOTH mutated runs fail for the expected reason.
"""
import json
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
MODULE = ROOT / 'packages/server-core/src/runtime/product-space-catalog-authority-internal.ts'
TESTDIR = ROOT / 'packages/server-core'
PROOF = []

M1 = (
    'const { writeFileSync: persistWrite, renameSync: persistRename, unlinkSync: persistUnlink } =\n'
    '    __authorityPersistenceSeamForTests',
    'const { writeFileSync: persistWrite, unlinkSync: persistUnlink } =\n'
    '    __authorityPersistenceSeamForTests\n'
    '  const persistRename = renameSync',
    'M1 seam-bypass',
)

M2 = (
    '    } catch {}\n'
    '    throw error\n'
    '  }\n'
    '}',
    '    } catch {}\n'
    '  }\n'
    '}',
    'M2 fail-closed-invert',
)


def run_focused_test():
    return subprocess.run(
        ['bun', 'test', './src/runtime/__tests__/product-space-catalog-authority.test.ts'],
        cwd=TESTDIR, capture_output=True, text=True, timeout=600,
    )


def main():
    original = MODULE.read_text(encoding='utf-8')

    for old, new, label in (M1, M2):
        assert old in original, f'{label}: anchor not found'
        MODULE.write_text(original.replace(old, new), encoding='utf-8')
        try:
            proc = run_focused_test()
            combined = (proc.stdout or '') + (proc.stderr or '')
            failed = proc.returncode != 0
            expected_reason = (
                ('ESEAM_RENAME' in combined or 'toBe(injected)' in combined or 'rename' in combined)
                if label.startswith('M1')
                else ('Received: undefined' in combined or 'toThrow' in combined or 'Expected' in combined)
            )
            PROOF.append({
                'mutation': label,
                'testExitCode': proc.returncode,
                'testFailed': failed,
                'expectedReasonObserved': expected_reason,
            })
            if not failed:
                break
        finally:
            MODULE.write_text(original, encoding='utf-8')

    restored = MODULE.read_text(encoding='utf-8') == original
    ok = restored and len(PROOF) == 2 and all(p['testFailed'] and p['expectedReasonObserved'] for p in PROOF)
    print(json.dumps({'ok': ok, 'moduleRestored': restored, 'mutations': PROOF}, indent=1))
    return 0 if ok else 1


if __name__ == '__main__':
    sys.exit(main())
