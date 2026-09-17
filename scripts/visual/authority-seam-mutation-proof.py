#!/usr/bin/env python3
"""POO-43 R54 negative/mutation proof for the authority persistence-seam tests.

Proves the focused authority tests actually bite, by applying three product
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
  M3 (public leak)        — src/runtime/index.ts re-exports a host function
                            from the authority barrel and attaches the
                            internal seam as a NESTED PROPERTY on that
                            exported function, so the seam becomes reachable
                            by property descent (not by direct namespace
                            re-export) through the supported
                            @polo-ai/server-core/runtime subpath. Expected:
                            the all-public-subpath child guard fails (nonzero)
                            with the exact 'persistence seam must not be
                            reachable' reason.

The production files are then restored byte-for-byte and the focused test is
RERUN — it must PASS after restoration (exit 0). Exits 0 only if all mutated
runs fail with their expected signatures AND the restored rerun passes.
"""
import json
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
MODULE = ROOT / 'packages/server-core/src/runtime/product-space-catalog-authority-internal.ts'
RUNTIME_INDEX = ROOT / 'packages/server-core/src/runtime/index.ts'
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

M3_RUNTIME_ANCHOR = "export * from './null-browser-pane-manager.ts'\n"
M3_RUNTIME_LEAK = (
    M3_RUNTIME_ANCHOR,
    M3_RUNTIME_ANCHOR
    + "export { revokeProductSpaceCatalogAuthority } from './product-space-catalog-authority.ts'\n"
    + "import { __authorityPersistenceSeamForTests as __m3seam } from './product-space-catalog-authority-internal.ts'\n"
    + "import { revokeProductSpaceCatalogAuthority as __m3host } from './product-space-catalog-authority.ts'\n"
    + ";(__m3host as unknown as Record<string, unknown>).__leakedPersistenceSeam = __m3seam\n",
    'M3 public-leak-nested-property',
    'persistence seam must not be reachable',
    '',
)


def run_focused_test():
    return subprocess.run(
        ['bun', 'test', './src/runtime/__tests__/product-space-catalog-authority.test.ts'],
        cwd=TESTDIR, capture_output=True, text=True, timeout=600,
    )


def main():
    original = MODULE.read_text(encoding='utf-8')
    runtime_original = RUNTIME_INDEX.read_text(encoding='utf-8')

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
        # M3: leak the seam through the supported runtime subpath so the
        # R54 all-public-subpath identity guard must fail.
        assert M3_RUNTIME_LEAK[0] in runtime_original, 'M3: runtime index anchor not found'
        RUNTIME_INDEX.write_text(runtime_original.replace(*M3_RUNTIME_LEAK[:2]), encoding='utf-8')
        try:
            proc = run_focused_test()
            combined = (proc.stdout or '') + (proc.stderr or '')
            failed = proc.returncode != 0
            reason_ok = M3_RUNTIME_LEAK[3] in combined
            PROOF.append({
                'mutation': M3_RUNTIME_LEAK[2],
                'testExitCode': proc.returncode,
                'testFailed': failed,
                'expectedFailureSignaturePresent': reason_ok,
            })
            if not (failed and reason_ok):
                PROOF[-1]['observedExcerpt'] = combined[-1500:]
        finally:
            RUNTIME_INDEX.write_text(runtime_original, encoding='utf-8')

        module_restored = MODULE.read_text(encoding='utf-8') == original
        runtime_restored = RUNTIME_INDEX.read_text(encoding='utf-8') == runtime_original
        rerun = run_focused_test()
        PROOF.append({
            'mutation': 'post-restore rerun',
            'moduleRestoredByteForByte': module_restored,
            'runtimeIndexRestoredByteForByte': runtime_restored,
            'rerunExitCode': rerun.returncode,
            'rerunPassed': rerun.returncode == 0,
        })
        ok = (
            module_restored
            and runtime_restored
            and rerun.returncode == 0
            and len(PROOF) == 4
            and all(p.get('testFailed') and p.get('wrongScenarioSignatureAbsent', True) for p in PROOF[:2])
            and PROOF[2].get('testFailed') and PROOF[2].get('expectedFailureSignaturePresent')
        )
        print(json.dumps({'ok': ok, 'mutations': PROOF}, indent=1))
        return 0 if ok else 1

    module_restored = MODULE.read_text(encoding='utf-8') == original
    print(json.dumps({'ok': False, 'moduleRestored': module_restored, 'mutations': PROOF}, indent=1))
    return 1


if __name__ == '__main__':
    sys.exit(main())
