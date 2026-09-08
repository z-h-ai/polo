#!/usr/bin/env python3
from __future__ import annotations

import argparse
import json
import re
import urllib.parse
from pathlib import Path
from typing import Any

from _common import REPO_ROOT, SOURCE_PATH, ToolError, dump_json, load_json, resolve_commit, run


def validate_release(payload: dict[str, Any], requested: str) -> dict[str, Any]:
    tag = payload.get("tag_name")
    if not isinstance(tag, str) or not tag:
        raise ToolError("release response has no tag_name")
    if requested != "latest" and tag != requested:
        raise ToolError(f"release response tag {tag!r} does not match {requested!r}")
    if payload.get("draft") is True:
        raise ToolError(f"release {tag} is a draft")
    if payload.get("prerelease") is True:
        raise ToolError(f"release {tag} is a prerelease")
    if not payload.get("published_at"):
        raise ToolError(f"release {tag} is not published")
    return payload


def query_release(root: Path, repository: str, target: str) -> dict[str, Any]:
    run(["direnv", "exec", str(root), "gh", "api", "user", "--jq", ".login"], root)
    endpoint = (
        f"repos/{repository}/releases/latest"
        if target == "latest"
        else f"repos/{repository}/releases/tags/{urllib.parse.quote(target, safe='')}"
    )
    raw = run(["direnv", "exec", str(root), "gh", "api", endpoint], root)
    try:
        return validate_release(json.loads(raw), target)
    except json.JSONDecodeError as exc:
        raise ToolError(f"invalid GitHub release response: {exc}") from exc


def parse_name_status(output: str) -> list[dict[str, str]]:
    changes: list[dict[str, str]] = []
    for line in output.splitlines():
        fields = line.split("\t")
        code = fields[0]
        kind = code[0]
        if kind in {"R", "C"} and len(fields) == 3:
            changes.append({"status": kind, "similarity": code[1:] or "", "old_path": fields[1], "path": fields[2]})
        elif len(fields) == 2:
            changes.append({"status": kind, "path": fields[1]})
        else:
            raise ToolError(f"unexpected git diff record: {line}")
    return changes


def sections_for(path: str) -> list[str]:
    sections: list[str] = []
    if path.endswith((".css", "/theme.ts")) or "/themes/" in path:
        sections.append("foundations")
    if any(part in path.lower() for part in ("layout", "app-shell", "panel", "sidebar", "topbar")):
        sections.append("layout")
    if "/components/" in path or path.endswith("/index.ts"):
        sections.append("components")
    if any(part in path.lower() for part in ("dialog", "dropdown", "popover", "tooltip", "button", "input", "select", "switch", "overlay", "motion")):
        sections.append("interaction-states")
    if "/assets/" in path or "/public/" in path or "/themes/" in path:
        sections.append("assets-themes")
    if path.startswith("apps/webui/"):
        sections.append("web-consumer")
    return sorted(set(sections)) or ["semantic-review"]


def compare(repo: Path, old_commit: str, new_commit: str, paths: list[str]) -> list[dict[str, object]]:
    output = run(["git", "diff", "--name-status", "--find-renames", old_commit, new_commit, "--", *paths], repo)
    changes: list[dict[str, object]] = []
    for change in parse_name_status(output):
        reviewed_paths = [change["path"]]
        if "old_path" in change:
            reviewed_paths.append(change["old_path"])
        change["sections"] = sorted({section for path in reviewed_paths for section in sections_for(path)})
        changes.append(change)
    return changes


def main() -> int:
    parser = argparse.ArgumentParser(description="Compare the saved Polo design source with a stable GitHub Release.")
    parser.add_argument("--repo", type=Path, default=REPO_ROOT, help="Git repository containing both source commits")
    parser.add_argument("--target", default="latest", help="latest or an exact stable release tag")
    parser.add_argument("--release-json", type=Path, help="test/offline release payload; skips GitHub lookup")
    args = parser.parse_args()

    manifest = load_json(SOURCE_PATH)
    release = (
        validate_release(load_json(args.release_json), args.target)
        if args.release_json
        else query_release(REPO_ROOT, manifest["repository"], args.target)
    )
    repo = args.repo.resolve()
    tag_commit = resolve_commit(repo, release["tag_name"])
    target_commitish = release.get("target_commitish")
    if isinstance(target_commitish, str) and re.fullmatch(r"[0-9a-fA-F]{40}", target_commitish):
        if tag_commit.lower() != target_commitish.lower():
            raise ToolError(f"release tag resolves to {tag_commit}, not target_commitish {target_commitish}")
    old_commit = resolve_commit(repo, manifest["release"]["commit"])
    changes = compare(repo, old_commit, tag_commit, manifest["coverage"]["paths"])
    result = {
        "from": {"tag": manifest["release"]["tag"], "commit": old_commit},
        "to": {
            "tag": release["tag_name"],
            "name": release.get("name") or release["tag_name"],
            "published_at": release["published_at"],
            "commit": tag_commit,
            "draft": False,
            "prerelease": False,
        },
        "covered_change_count": len(changes),
        "changes": changes,
        "write_performed": False,
    }
    print(dump_json(result), end="")
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except ToolError as exc:
        raise SystemExit(f"error: {exc}")
