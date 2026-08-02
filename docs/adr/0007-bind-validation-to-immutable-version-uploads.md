---
status: accepted
---

# Bind validation to immutable version uploads

Each Skill Artifact Version upload creates a new immutable storage object, and validation is bound to that object's checksum and Package Manifest. Re-uploading an unpublished version invalidates prior validation, while a published version can never accept another upload; this prevents content from changing between validation and publication.
