#!/usr/bin/env python3
"""POO-43 R50 deterministic negative proof for guard-locale-audit.

Substitutes WRONG rendered copy (ja title) via the audit's documented
test-only mutation hook and requires the validator to exit non-zero with a
title-mismatch failure against the locale-catalog authority. Then proves the
control group: the same single-locale run WITHOUT the mutation passes (exit
0). Exits 0 only if both observations hold.
"""
import contextlib
import importlib.util
import io
import json
import sys
from pathlib import Path

AUDIT = Path(__file__).resolve().parent / "guard-locale-audit.py"

spec = importlib.util.spec_from_file_location("guard_locale_audit", AUDIT)
mod = importlib.util.module_from_spec(spec)
spec.loader.exec_module(mod)


def capture(locales, mutate):
    buf = io.StringIO()
    with contextlib.redirect_stdout(buf):
        result = mod.run_audit(locales=locales, mutate=mutate)
    return result, buf.getvalue()


def main() -> int:
    mutated, mutated_json = capture(["ja"], "ja:title")
    control, _ = capture(["ja"], None)

    mutated_failed = mutated["code"] != 0
    title_failure = any(
        "ja: title copy mismatch" in failure and "__mutated_wrong_title__" in failure
        for failure in mutated["failures"]
    )
    control_passed = control["code"] == 0 and not control["failures"]

    report = {
        "ok": mutated_failed and title_failure and control_passed,
        "mutatedRun": {
            "code": mutated["code"],
            "failures": mutated["failures"],
            "titleFailureObserved": title_failure,
        },
        "controlRun": {"code": control["code"], "failures": control["failures"]},
    }
    print(json.dumps(report, ensure_ascii=False, indent=1))
    return 0 if report["ok"] else 1


if __name__ == "__main__":
    sys.exit(main())
