---
status: accepted
---

# Retain Safety Tombstones after package purge

Revoked Skill package objects and packages owned by a deleted Creator Space may be purged under Admin data-retention policy, but Polo permanently retains the minimal `artifactId`, version, archive checksum, terminal safety or availability status, and audit identity needed by the Safety Status API.

This separates storage and privacy cleanup from installed-version safety. An old workspace installation therefore remains identifiable as revoked or archived even after its original ZIP, manifest, catalog metadata, and Creator Space data are no longer retained.
