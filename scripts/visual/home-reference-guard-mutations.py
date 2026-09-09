#!/usr/bin/env python3
"""POO-43 adversarial mutation suite for the Home reference contract guard.

Every mutation runs against ISOLATED TEMPORARY COPIES of the authority trio
(oracle / aligned reference / companion contract) — never the tracked files.
Each case asserts the guard fails for its INTENDED reason:

  R59 false-negative regressions (must stay fixed):
    A1  manage button replaced by <span hidden> retaining the text
    A2  全部 Apps button replaced by a non-interactive span
    A3  contract link retargeted to a nonexistent reference filename

  Preserved direct mutations:
    B1  required string removed (管理首页 Apps entirely)
    B2  forbidden string added (运行中 badge)
    B3  contract threshold weakened (0.02 → 0.01)
    B4  contract exclusion permitted ("exclusions are permitted")
    B5  aligned reference file missing
    B6  contract tablet binding removed (1024×768)
    B7  frozen oracle byte drift

Finally the tracked authority files are verified byte-for-byte unchanged and
the guard is re-run on the REAL paths — it must pass.

Exit 0 only when every case behaves as intended and the final state is clean.
"""
import hashlib
import importlib.util
import json
import sys
import tempfile
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
GUARD = ROOT / "scripts/visual/home-reference-contract-guard.py"
ORACLE = ROOT / ".pipeline/acceptance-repair-poo43/frozen-sources/poo41/space-home-light-zh-Hans-desktop.html"
REFERENCE = ROOT / ".agents/skills/polo-client-design/assets/design-context/references/space-home-poo43-aligned-light-zh-Hans-desktop.html"
CONTRACT = ROOT / ".agents/skills/polo-client-design/assets/design-context/references/space-home-poo43-aligned.contract.md"

spec = importlib.util.spec_from_file_location("home_reference_contract_guard", GUARD)
guard = importlib.util.module_from_spec(spec)
spec.loader.exec_module(guard)

CASES: list[dict] = []


def run_case(label: str, mutate, expect_fragment: str, oracle: Path, reference: Path, contract: Path):
    before = {p: p.read_bytes() for p in (oracle, reference, contract) if p.exists()}
    oracle_m, reference_m, contract_m = oracle, reference, contract
    with tempfile.TemporaryDirectory() as tmp:
        tmpdir = Path(tmp)
        if not mutate.get("skip_temp"):
            oracle_m = tmpdir / oracle.name
            reference_m = tmpdir / reference.name
            contract_m = tmpdir / contract.name
            oracle_m.write_bytes(oracle.read_bytes())
            reference_m.write_bytes(reference.read_bytes())
            contract_m.write_bytes(contract.read_bytes())
        target = {"oracle": oracle_m, "reference": reference_m, "contract": contract_m}[mutate["target"]]
        current = target.read_text(encoding="utf-8") if target.exists() else None
        if mutate["kind"] == "replace":
            assert current is not None and mutate["old"] in current, f"{label}: anchor missing"
            target.write_text(current.replace(mutate["old"], mutate["new"]), encoding="utf-8")
        elif mutate["kind"] == "delete":
            target.unlink()
        failures = guard.check(oracle_m, reference_m, contract_m)
        intended = any(expect_fragment in failure for failure in failures)
        CASES.append({
            "case": label,
            "guardFailed": bool(failures),
            "intendedReasonObserved": intended,
            "failures": failures[:3],
        })
        if not (failures and intended):
            return False
    # isolation proof: tracked sources untouched by this case
    for p, data in before.items():
        if p.read_bytes() != data:
            CASES.append({"case": label, "error": f"tracked file mutated: {p}"})
            return False
    return True


def main() -> int:
    tracked_before = {
        p: hashlib.sha256(p.read_bytes()).hexdigest()
        for p in (ORACLE, REFERENCE, CONTRACT)
    }

    ok = True
    # ── R59 false negatives ──
    ok &= run_case(
        "A1 manage button -> span hidden",
        {"target": "reference", "kind": "replace",
         "old": '<button class="quiet-link">管理首页 Apps</button>',
         "new": '<span hidden>管理首页 Apps</span>'},
        "expected exactly one visible interactive <button>管理首页 Apps",
        ORACLE, REFERENCE, CONTRACT,
    )
    ok &= run_case(
        "A2 all-apps button -> non-interactive span",
        {"target": "reference", "kind": "replace",
         "old": '<button class="quiet-link">全部 Apps</button>',
         "new": '<span>全部 Apps</span>'},
        "expected exactly one visible interactive <button>全部 Apps",
        ORACLE, REFERENCE, CONTRACT,
    )
    ok &= run_case(
        "A3 contract link -> nonexistent reference",
        {"target": "contract", "kind": "replace",
         "old": "(./space-home-poo43-aligned-light-zh-Hans-desktop.html)",
         "new": "(./space-home-poo43-aligned-nonexistent.html)"},
        "no contract Markdown link resolves to the checked aligned reference",
        ORACLE, REFERENCE, CONTRACT,
    )
    # ── preserved direct mutations ──
    ok &= run_case(
        "B1 required string removed",
        {"target": "reference", "kind": "replace",
         "old": '<button class="quiet-link">管理首页 Apps</button>', "new": ""},
        "管理首页 Apps",
        ORACLE, REFERENCE, CONTRACT,
    )
    ok &= run_case(
        "B2 forbidden string added",
        {"target": "reference", "kind": "replace",
         "old": "<h3>客户访谈整理</h3>",
         "new": "<h3>客户访谈整理</h3><span class=\"badge\">运行中</span>"},
        "reference contains excluded control/copy",
        ORACLE, REFERENCE, CONTRACT,
    )
    ok &= run_case(
        "B3 contract threshold weakened",
        {"target": "contract", "kind": "replace", "old": "`0.02`", "new": "`0.01`"},
        "weakened threshold",
        ORACLE, REFERENCE, CONTRACT,
    )
    ok &= run_case(
        "B4 contract exclusion permitted",
        {"target": "contract", "kind": "replace",
         "old": "exclusions are not permitted", "new": "exclusions are permitted for icon tiles"},
        "permitted exclusions",
        ORACLE, REFERENCE, CONTRACT,
    )
    ok &= run_case(
        "B5 aligned reference missing",
        {"target": "reference", "kind": "delete"},
        "aligned reference missing",
        ORACLE, REFERENCE, CONTRACT,
    )
    ok &= run_case(
        "B6 contract tablet binding removed",
        {"target": "contract", "kind": "replace", "old": "1024×768", "new": "1023×767"},
        "tablet viewport binding",
        ORACLE, REFERENCE, CONTRACT,
    )
    ok &= run_case(
        "B7 frozen oracle byte drift",
        {"target": "oracle", "kind": "replace", "old": "<title>Polo 客户端核心任务主路径</title>",
         "new": "<title>Polo 客户端核心任务主路径 </title>"},
        "historical oracle bytes changed",
        ORACLE, REFERENCE, CONTRACT,
    )

    tracked_after = {
        p: hashlib.sha256(p.read_bytes()).hexdigest()
        for p in (ORACLE, REFERENCE, CONTRACT)
    }
    clean = tracked_before == tracked_after

    baseline = guard.check(ORACLE, REFERENCE, CONTRACT)
    rerun_green = not baseline

    passed = ok and clean and rerun_green
    print(json.dumps({
        "ok": passed,
        "trackedFilesByteForByteClean": clean,
        "baselineGuardGreenAfterSuite": rerun_green,
        "cases": CASES,
    }, ensure_ascii=False, indent=1))
    return 0 if passed else 1


if __name__ == "__main__":
    sys.exit(main())
