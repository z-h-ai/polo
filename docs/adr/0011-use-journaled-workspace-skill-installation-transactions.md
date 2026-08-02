---
status: accepted
---

# Use journaled workspace Skill installation transactions

Creator Skill installation uses a dedicated versioned Installation Ledger plus a persistent per-operation journal, rather than embedding provenance in workspace settings or `SKILL.md`. Operations are serialized per workspace and slug, stage and validate before swapping directories, commit the ledger atomically, and recover or roll back after failure or process restart so filesystem state and provenance cannot silently diverge.
