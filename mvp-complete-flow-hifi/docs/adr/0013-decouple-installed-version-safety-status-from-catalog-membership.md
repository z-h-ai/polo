---
status: accepted
---

# Decouple installed-version safety status from catalog membership

An authenticated client may query the minimal Safety Status of an exact `artifactId + version + archiveChecksum` even without current membership in the publishing Creator Space. Revocation is permanent, checks reveal no catalog content, and network failure leaves the local Skill usable with a stale-status warning; this lets workspace-owned installations receive security notices without weakening member-only discovery.
