#!/usr/bin/env python3
from __future__ import annotations

import hashlib
import json
import subprocess
from pathlib import Path
from typing import Any, Iterable


SKILL_DIR = Path(__file__).resolve().parents[1]
REPO_ROOT = Path(__file__).resolve().parents[4]
SOURCE_PATH = SKILL_DIR / "references" / "source.json"


class ToolError(RuntimeError):
    pass


def run(command: list[str], cwd: Path, *, check: bool = True) -> str:
    result = subprocess.run(command, cwd=cwd, text=True, capture_output=True)
    if check and result.returncode != 0:
        detail = result.stderr.strip() or result.stdout.strip() or f"exit {result.returncode}"
        raise ToolError(f"{' '.join(command)}: {detail}")
    return result.stdout


def git(repo: Path, *args: str) -> str:
    return run(["git", *args], repo).strip()


def load_json(path: Path) -> dict[str, Any]:
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as exc:
        raise ToolError(f"cannot read {path}: {exc}") from exc


def dump_json(value: Any) -> str:
    return json.dumps(value, ensure_ascii=False, indent=2, sort_keys=True) + "\n"


def resolve_commit(repo: Path, ref: str) -> str:
    commit = git(repo, "rev-parse", "--verify", f"{ref}^{{commit}}")
    if len(commit) != 40:
        raise ToolError(f"{ref!r} did not resolve to a full commit")
    return commit


def show_bytes(repo: Path, ref: str, path: str) -> bytes:
    result = subprocess.run(["git", "show", f"{ref}:{path}"], cwd=repo, capture_output=True)
    if result.returncode != 0:
        detail = result.stderr.decode("utf-8", errors="replace").strip()
        raise ToolError(f"cannot read {path} at {ref}: {detail}")
    return result.stdout


def sha256_bytes(content: bytes) -> str:
    return hashlib.sha256(content).hexdigest()


def inventory(repo: Path, ref: str, paths: Iterable[str]) -> tuple[int, str]:
    output = run(["git", "ls-tree", "-r", "--full-tree", ref, "--", *paths], repo)
    entries: list[str] = []
    for line in output.splitlines():
        metadata, path = line.split("\t", 1)
        _mode, kind, object_id = metadata.split()
        if kind == "blob":
            entries.append(f"{path}\t{object_id}")
    entries.sort()
    payload = ("\n".join(entries) + ("\n" if entries else "")).encode()
    return len(entries), sha256_bytes(payload)
