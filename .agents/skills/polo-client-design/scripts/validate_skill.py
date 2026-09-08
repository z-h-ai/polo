#!/usr/bin/env python3
from __future__ import annotations

import json
import re
from pathlib import Path

from _common import REPO_ROOT, SKILL_DIR, SOURCE_PATH, ToolError, dump_json, inventory, load_json, resolve_commit, sha256_bytes, show_bytes
from extract_tokens import extract


DESIGN_CONTEXT = SKILL_DIR / "assets" / "design-context"
TRANSIENT_DIRS = {"dist", "dist-gallery"}


def local_inventory(root: Path) -> tuple[int, str]:
    entries: list[str] = []
    for path in sorted(root.rglob("*")):
        relative = path.relative_to(root)
        if not path.is_file() or any(part in TRANSIENT_DIRS for part in relative.parts):
            continue
        entries.append(f"{relative.as_posix()}\t{sha256_bytes(path.read_bytes())}")
    payload = ("\n".join(entries) + ("\n" if entries else "")).encode()
    return len(entries), sha256_bytes(payload)


def validate_self_contained_html(path: Path) -> list[str]:
    errors: list[str] = []
    html = path.read_text(encoding="utf-8")
    if re.search(r"<script[^>]+src=", html, re.IGNORECASE):
        errors.append(f"{path.relative_to(SKILL_DIR)} has an external script reference")
    if re.search(r"<link[^>]+stylesheet", html, re.IGNORECASE):
        errors.append(f"{path.relative_to(SKILL_DIR)} has an external stylesheet reference")
    if re.search(r"<(?:script|link)[^>]+https?://", html, re.IGNORECASE):
        errors.append(f"{path.relative_to(SKILL_DIR)} has a remote dependency")
    return errors


def validate_design_context(source: dict) -> list[str]:
    errors: list[str] = []
    context = source.get("design_context", {})
    required = [
        "README.md",
        "prototype-manifest.json",
        "prototype.html",
        "components/index.html",
        "scene-catalog.json",
        "src/main.jsx",
    ]
    for relative in required:
        if not (DESIGN_CONTEXT / relative).is_file():
            errors.append(f"design context is missing {relative}")
    if errors:
        return errors

    count, digest = local_inventory(DESIGN_CONTEXT)
    if context.get("root") != "assets/design-context":
        errors.append("design_context.root must be assets/design-context")
    if context.get("file_count") != count:
        errors.append(f"design_context file_count is {context.get('file_count')}, actual {count}")
    if context.get("inventory_sha256") != digest:
        errors.append(f"design_context inventory hash is {digest}, manifest has {context.get('inventory_sha256')}")

    try:
        manifest = json.loads((DESIGN_CONTEXT / "prototype-manifest.json").read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as exc:
        return [*errors, f"cannot read design-context manifest: {exc}"]
    sot = manifest.get("sot", {})
    if manifest.get("baselineVersion") != context.get("version"):
        errors.append("design-context version differs between source.json and prototype-manifest.json")
    if sot != {"owner": "polo-client-design", "root": "assets/design-context", "runtimeDependency": "none"}:
        errors.append("prototype manifest must declare the skill-owned, dependency-free SOT")
    source_info = manifest.get("source", {})
    if source_info.get("repositoryRoot") != "." or Path(source_info.get("root", "/")).is_absolute():
        errors.append("prototype source locations must be portable provenance paths")
    if source_info.get("gitRevision") != context.get("imported_from_commit"):
        errors.append("design-context import commit differs between manifests")

    prototype = DESIGN_CONTEXT / "prototype.html"
    prototype_info = context.get("prototype", {})
    prototype_bytes = prototype.read_bytes()
    prototype_digest = sha256_bytes(prototype_bytes)
    if prototype_info.get("path") != "assets/design-context/prototype.html":
        errors.append("design_context.prototype.path is not canonical")
    if prototype_info.get("bytes") != len(prototype_bytes):
        errors.append("design_context prototype byte count is stale")
    if prototype_info.get("sha256") != prototype_digest:
        errors.append("design_context prototype hash is stale")
    artifacts = manifest.get("artifacts", {})
    if artifacts.get("singleFileBytes") != len(prototype_bytes) or artifacts.get("singleFileSha256") != prototype_digest:
        errors.append("prototype artifact metadata does not match prototype.html")
    errors.extend(validate_self_contained_html(prototype))

    component_files = sorted((DESIGN_CONTEXT / "components").rglob("*.html"))
    gallery = context.get("component_gallery", {})
    if gallery.get("index") != "assets/design-context/components/index.html":
        errors.append("design_context component gallery index is not canonical")
    if gallery.get("html_count") != len(component_files):
        errors.append(f"component gallery count is {gallery.get('html_count')}, actual {len(component_files)}")
    for component in component_files:
        errors.extend(validate_self_contained_html(component))

    forbidden = ["/Users/" + "wow", "polo-client-" + "g4-ui", "design-demos/" + "polo-client-source-baseline"]
    text_suffixes = {".css", ".html", ".js", ".json", ".jsx", ".md", ".mjs", ".py", ".svg", ".ts", ".tsx"}
    for path in sorted(SKILL_DIR.rglob("*")):
        if not path.is_file() or path.suffix.lower() not in text_suffixes:
            continue
        text = path.read_text(encoding="utf-8", errors="replace")
        for needle in forbidden:
            if needle in text:
                errors.append(f"{path.relative_to(SKILL_DIR)} contains worktree-bound path {needle!r}")
    for path in sorted((DESIGN_CONTEXT / "src").rglob("*")):
        if not path.is_file() or path.suffix.lower() not in text_suffixes:
            continue
        text = path.read_text(encoding="utf-8", errors="replace")
        if "Math.random(" in text or "Date.now(" in text:
            errors.append(f"{path.relative_to(SKILL_DIR)} contains a nondeterministic fixture")
    return errors


def validate_links(path: Path) -> list[str]:
    errors: list[str] = []
    text = path.read_text(encoding="utf-8")
    for target in re.findall(r"\[[^\]]+\]\(([^)]+)\)", text):
        if "://" in target or target.startswith("#"):
            continue
        target_path = (path.parent / target.split("#", 1)[0]).resolve()
        if not target_path.exists():
            errors.append(f"{path.relative_to(REPO_ROOT)} links to missing {target}")
    return errors


def main() -> int:
    errors: list[str] = []
    source = load_json(SOURCE_PATH)
    release = source.get("release", {})
    commit = release.get("commit", "")
    if not re.fullmatch(r"[0-9a-f]{40}", commit):
        errors.append("release.commit must be a lowercase full commit")
    if release.get("draft") is not False or release.get("prerelease") is not False:
        errors.append("source release must be non-draft and non-prerelease")

    try:
        resolved = resolve_commit(REPO_ROOT, commit)
        if resolved != commit:
            errors.append(f"pinned commit resolves to {resolved}")
        tag_commit = resolve_commit(REPO_ROOT, release.get("tag", ""))
        if tag_commit != commit:
            errors.append(f"tag {release.get('tag')} resolves to {tag_commit}, not {commit}")
    except ToolError as exc:
        errors.append(str(exc))

    coverage = source.get("coverage", {})
    paths = coverage.get("paths", [])
    if not isinstance(paths, list) or not paths:
        errors.append("coverage.paths must be non-empty")
    else:
        try:
            count, digest = inventory(REPO_ROOT, commit, paths)
            if count != coverage.get("blob_count"):
                errors.append(f"coverage blob_count is {coverage.get('blob_count')}, actual {count}")
            if digest != coverage.get("inventory_sha256"):
                errors.append(f"coverage inventory hash is {digest}, manifest has {coverage.get('inventory_sha256')}")
        except ToolError as exc:
            errors.append(str(exc))

    for entry in source.get("focal_files", []):
        try:
            actual = sha256_bytes(show_bytes(REPO_ROOT, commit, entry["path"]))
            if actual != entry.get("sha256"):
                errors.append(f"hash mismatch for {entry['path']}: {actual}")
        except (KeyError, ToolError) as exc:
            errors.append(str(exc))

    token_path = SKILL_DIR / "references" / "tokens.json"
    try:
        saved = token_path.read_text(encoding="utf-8")
        generated = dump_json(extract(REPO_ROOT, commit))
        if saved != generated:
            errors.append("references/tokens.json is not the deterministic extraction for the pinned commit")
    except (OSError, ToolError) as exc:
        errors.append(str(exc))

    errors.extend(validate_design_context(source))

    markdown_files = [SKILL_DIR / "SKILL.md", *sorted((SKILL_DIR / "references").glob("*.md"))]
    for path in markdown_files:
        errors.extend(validate_links(path))

    design_entry = (REPO_ROOT / "docs" / "DESIGN.md").read_text(encoding="utf-8")
    if "../.agents/skills/polo-client-design/SKILL.md" not in design_entry:
        errors.append("docs/DESIGN.md does not point to the skill entrypoint")
    if "oklch(0.44 0.30 285)" in design_entry:
        errors.append("docs/DESIGN.md still contains the superseded duplicate specification")

    if errors:
        for error in errors:
            print(f"FAIL: {error}")
        return 1
    print(f"PASS: polo-client-design is consistent with {release['tag']} ({commit})")
    print(f"PASS: {coverage['blob_count']} covered blobs and {len(source['focal_files'])} focal hashes verified")
    print("PASS: references, deterministic tokens, bundled HTML SOT, and docs/DESIGN.md entrypoint verified")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
