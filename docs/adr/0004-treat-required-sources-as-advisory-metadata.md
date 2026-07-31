---
status: accepted
---

# Treat requiredSources as advisory metadata

Creator Skills may retain the optional, non-standard `requiredSources` frontmatter field, but Polo does not look up, install, authorize, dependency-check, or enable Sources because of it. The AI reads the field as part of `SKILL.md` and handles it as advisory instructions; this deliberately replaces the current behavior that silently enables usable Sources when a Skill is invoked.
