---
status: accepted
---

# Snapshot download access but recheck revocation before install

A short-lived Download Grant remains usable for its TTL even if the Artifact is subsequently archived, because v1 uses object-storage presigned URLs rather than an online download gateway. The installer nevertheless rechecks the exact Version's Safety Status before committing files and aborts if it has been revoked, separating ordinary membership changes from urgent security revocation.
