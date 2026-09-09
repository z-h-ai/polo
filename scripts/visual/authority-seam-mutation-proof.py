#!/usr/bin/env python3
"""POO-43 R52 negative/mutation proof for the authority persistence-seam test.

Proves the focused authority test actually bites, by applying two product
mutations in turn, running the focused test against each, and requiring it to
FAIL each time with the EXPECTED scenario-specific failure signature:

  M1 (seam bypass)        — persistFileAtomic calls node:fs renameSync
                            directly instead of the injected seam, so the
                            rename injection never fires. Expected: only the
                            RENAME scenario fails ('injected rename failure');
                            the write scenario still passes.
  M2 (fail-closed invert) — persistFileAtomic swallows the persistence error
                            instead of rethrowing. Expected: only the WRITE
                            scenario fails ('injected write failure'); the
                            rename scenario never runs.

The production module is then restored byte-for-byte and the focused test is
RERUN — it must PASS after restoration (exit 0). Exits 0 only if both mutated
runs fail with their expected signatures AND the restored rerun passes.
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
    'injected rename failure',
    'injected write failure',
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
    'injected write failure',
    'injected rename failure',
)


def run_focused_test():
    return subprocess.run(
        ['bun', 'test', './src/runtime/__tests__/product-space-catalog-authority.test.ts'],
        cwd=TESTDIR, capture_output=True, text=True, timeout=600,
    )


def main():
    original = MODULE.read_text(encoding='utf-8')

    for old, new, label, expect_present, expect_absent in (M1, M2):
        assert old in original, f'{label}: anchor not found'
        MODULE.write_text(original.replace(old, new), encoding='utf-8')
        try:
            proc = run_focused_test()
            combined = (proc.stdout or '') + (proc.stderr or '')
            failed = proc.returncode != 0
            reason_ok = expect_present in combined and expect_absent not in combined
            PROOF.append({
                'mutation': label,
                'testExitCode': proc.returncode,
                'testFailed': failed,
                'expectedFailureSignaturePresent': expect_present in combined,
                'wrongScenarioSignatureAbsent': expect_absent not in combined,
            })
            if not (failed and reason_ok):
                PROOF[-1]['observedExcerpt'] = combined[-1500:]
                break
        finally:
            MODULE.write_text(original, encoding='utf-8')
    else:
        restored_ok = MODULE.read_text(encoding='utf-8') == original
        rerun = run_focused_test()
        PROOF.append({
            'mutation': 'post-restore rerun',
            'moduleRestoredByteForByte': restored_ok,
            'rerunExitCode': rerun.returncode,
            'rerunPassed': rerun.returncode == 0,
        })
        ok = (
            restored_ok
            and rerun.returncode == 0
            and len(PROOF) == 3
            and all(p.get('testFailed') and p.get('wrongScenarioSignatureAbsent', True) for p in PROOF[:2])
        )
        print(json.dumps({'ok': ok, 'mutations': PROOF}, indent=1))
        return 0 if ok else 1

    restored_ok = MODULE.read_text(encoding='utf-8') == original
    print(json.dumps({'ok': False, 'moduleRestored': restored_ok, 'mutations': PROOF}, indent=1))
    return 1


if __name__ == '__main__':
    sys.exit(main())
