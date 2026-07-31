---
status: accepted
---

# Unify Artifact reads without migrating Web App writes

The Artifact Catalog aggregates existing Web App records and new Skill Artifact records behind one `CreatorArtifact` DTO while each type retains its established write model. We rejected a v1 Web App data migration because it would couple Skill delivery to an unrelated regression risk; globally unique opaque IDs and explicit artifact types keep the aggregated read model unambiguous.
