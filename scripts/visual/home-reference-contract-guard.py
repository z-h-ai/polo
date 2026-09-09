#!/usr/bin/env python3
"""POO-43 Home aligned-reference contract guard (R58).

Deterministic, checked-in regression guard for the Home authority pair:
- the HISTORICAL frozen POO-41 Home oracle must stay byte-for-byte unchanged
  (pinned SHA-256);
- the versioned aligned reference + companion contract must exist and stay
  semantically intact: required Home controls present, excluded Skills/
  runtime controls absent, threshold/viewport/locale/no-exclusion bindings
  intact, and the historical provenance hash intact.

Exit 0 = every invariant holds; non-zero with a JSON failure report.
"""
import hashlib
import json
import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
ORACLE = ROOT / ".pipeline/acceptance-repair-poo43/frozen-sources/poo41/space-home-light-zh-Hans-desktop.html"
# The pinned historical-oracle hash. Changing the frozen bytes is a contract
# violation — the oracle is provenance-only and must never be regenerated.
PINNED_ORACLE_SHA256 = "875404db3e03ffccb4aafa8a6d3dae3c9512022a7936365eab410495319ac887"
REFERENCE = ROOT / ".agents/skills/polo-client-design/assets/design-context/references/space-home-poo43-aligned-light-zh-Hans-desktop.html"
CONTRACT = ROOT / ".agents/skills/polo-client-design/assets/design-context/references/space-home-poo43-aligned.contract.md"

REQUIRED_REFERENCE_STRINGS = [
    "管理首页 Apps",
    "全部 Apps",
    "早上好",
    "我的圈子 · 3 个",
    "常用 Apps",
    "Polo 助手",
    "Polo 内置",
    "打开助手",
    "客户访谈整理",
    "认证创作者 · 北极星共创社",
    "素材清洗器",
    'data-scene="space-home"',
]

FORBIDDEN_REFERENCE_STRINGS = [
    "管理 Skills",
    "2 个 Skill 已启用",
    "运行中",
    "认证创作者 · 北极星工作室",
]

REQUIRED_CONTRACT_PATTERNS = [
    (r"1440×900", "desktop viewport binding"),
    (r"1024×768", "tablet viewport binding"),
    (r"`0\.02`", "region threshold binding"),
    (r"exclusions are not permitted", "no-exclusion binding"),
    (r"zh-Hans", "locale binding"),
    (r"875404db3e03ffccb4aafa8a6d3dae3c9512022a7936365eab410495319ac887", "historical provenance hash"),
    (r"管理首页 Apps", "required management control"),
    (r"shortcut-only", "shortcut-only dialog binding"),
]

FORBIDDEN_CONTRACT_PATTERNS = [
    (r"threshold[^\n]{0,40}(0\.0(?!2)[1-9]|0\.[1-9][0-9]?|[1-9]\.)", "weakened threshold"),
    (r"exclusion[s]?\s+(are\s+)?(permitted|allowed)", "permitted exclusions"),
]


def main() -> int:
    failures = []

    # 1. Historical oracle: byte-for-byte provenance.
    if not ORACLE.exists():
        failures.append(f"historical oracle missing: {ORACLE}")
    else:
        digest = hashlib.sha256(ORACLE.read_bytes()).hexdigest()
        if digest != PINNED_ORACLE_SHA256:
            failures.append(f"historical oracle bytes changed: {digest} != {PINNED_ORACLE_SHA256}")

    # 2. Aligned reference: present and semantically intact.
    if not REFERENCE.exists():
        failures.append(f"aligned reference missing: {REFERENCE}")
    else:
        html = REFERENCE.read_text(encoding="utf-8")
        for needle in REQUIRED_REFERENCE_STRINGS:
            if needle not in html:
                failures.append(f"reference missing required string: {needle!r}")
        for needle in FORBIDDEN_REFERENCE_STRINGS:
            if needle in html:
                failures.append(f"reference contains excluded control/copy: {needle!r}")
        # Binding markers inside the reference itself.
        for marker in ('data-scene="space-home"', "1440", "1024"):
            if marker not in html and marker != "1440" and marker != "1024":
                failures.append(f"reference missing marker: {marker!r}")

    # 3. Companion contract: present with intact bindings.
    if not CONTRACT.exists():
        failures.append(f"companion contract missing: {CONTRACT}")
    else:
        md = CONTRACT.read_text(encoding="utf-8")
        for pattern, label in REQUIRED_CONTRACT_PATTERNS:
            if not re.search(pattern, md):
                failures.append(f"contract missing {label}: /{pattern}/")
        for pattern, label in FORBIDDEN_CONTRACT_PATTERNS:
            if re.search(pattern, md, flags=re.IGNORECASE):
                failures.append(f"contract contains {label}: /{pattern}/")

    print(json.dumps({
        "ok": not failures,
        "oracleSha256": hashlib.sha256(ORACLE.read_bytes()).hexdigest() if ORACLE.exists() else None,
        "failures": failures,
    }, ensure_ascii=False, indent=1))
    return 1 if failures else 0


if __name__ == "__main__":
    sys.exit(main())
