---
status: accepted
---

# Project Skill Artifact metadata from published content

A Skill Artifact's displayed name and summary are projections of the current Published Version's normalized `SKILL.md` metadata, while all supported frontmatter fields are stored as an immutable Version Metadata snapshot. We rejected independently editable artifact and package metadata because it could make catalog identity, installed identity, dependency disclosures, and requested-tool disclosures disagree.
