# Creator Publishing

This context defines how creator communities publish versioned work and how members adopt that work into their Polo workspaces.

## Publishing

**Creator Space**:
A membership-governed community that owns and publishes creator work. It is distinct from the Polo workspace where a member uses that work.
_Avoid_: Creator workspace, Skill organization

**Creator Artifact**:
A publishable work owned by a Creator Space whose artifact type is fixed when it is created.
_Avoid_: App, upload, package

**Artifact Catalog**:
The unified member-facing view of Creator Artifacts across their type-specific storage and publication workflows.
_Avoid_: Skill table, Web App table

**Web App Artifact**:
A Creator Artifact whose published versions are applications that members can install or open.
_Avoid_: Skill, browser tab

**Skill Artifact**:
A Creator Artifact whose published versions are portable instruction packages that members can install into a Polo Workspace.
_Avoid_: Executable plugin, application

**Artifact Draft**:
A never-published Creator Artifact identified initially only by its immutable slug. It may be deleted by an Owner or Manager; after any version is published, the Artifact can only be archived.
_Avoid_: Archived Artifact, empty Published Artifact

Deleting an Artifact Draft releases its slug. Archiving an ever-published Artifact does not.

**Artifact Version**:
An immutable revision of a Creator Artifact identified by an ordered, stable semantic version.
_Avoid_: Upload, latest artifact

**Version Draft**:
An Artifact Version that has never been published. It may be deleted by an Owner or Manager, while Published and Revoked Versions are permanent records.
_Avoid_: Published Version, editable published content

**Validated Version**:
An Artifact Version whose current immutable upload has passed package validation. Uploading different content invalidates this state.
_Avoid_: Uploaded version, published version

**Expired Version Attempt**:
An unpublished Artifact Version attempt whose uploaded content and validation data were removed after prolonged inactivity. Its semantic version may be reused by a new attempt while minimal audit history remains.
_Avoid_: Revoked Version, deleted Published Version

**Published Version**:
An Artifact Version that has passed validation and is available for eligible Creator Space members to select and install while its artifact is active.
_Avoid_: Draft, uploaded version

**Revoked Version**:
A formerly Published Version permanently blocked from new downloads because it is unsafe or invalid. Revocation is terminal and does not delete or disable existing Skill Installations.
_Avoid_: Archived Artifact, deleted version

**Archived Artifact**:
A previously published Creator Artifact removed from member discovery and new downloads without deleting its publication history or existing Skill Installations. Archival is reversible by an authorized publisher.
_Avoid_: Deleted artifact, revoked installation

**Static Skill Package**:
The content of a Skill Artifact Version that Polo installs without automatically opening, rendering, or executing bundled references. It consists of required instructions plus optional inert references or artwork, and artwork is never required.
_Avoid_: Plugin bundle, installer, executable package

**Inert Reference**:
A supporting file bundled with a Skill for the AI to inspect as instructed, including source code or scripts. Its presence never authorizes or triggers execution by Polo.
_Avoid_: Dependency, installed program, executable payload

**Package Manifest**:
The immutable inventory of normalized file paths, sizes, and content hashes derived from a validated Static Skill Package.
_Avoid_: ZIP checksum, installation record

**Archive Policy**:
The Admin-managed platform policy that limits Creator Skill archives. Each validated Artifact Version retains the policy snapshot that governed its publication.
_Avoid_: Creator preference, package metadata

**Packaging Noise**:
A platform-recognized archive entry produced by common operating-system packaging tools that is removed before package validation and excluded from the Package Manifest.
_Avoid_: Invalid reference, hidden payload

**Version Metadata**:
The read-only snapshot of a Skill Artifact Version's normalized `SKILL.md` frontmatter. Before the first successful upload, an Artifact Draft is displayed by slug; afterward creator views may project the current Version Draft, while member views project only the latest Published Version.
_Avoid_: Editable artifact metadata, installation metadata

**Upload Generation**:
The monotonic identity of the current immutable upload attempt for a Version Draft. Reissuing an expired upload or uploading new bytes advances the generation, making all earlier validation results stale.
_Avoid_: Retry count, semantic version

**Required Source**:
An advisory Source name declared in Skill metadata for the AI to interpret while following the Skill. It carries no platform-level installation, authorization, dependency-check, or activation semantics.
_Avoid_: Source permission, automatic dependency

**Requested Tool**:
An advisory tool name declared through the legacy `alwaysAllow` frontmatter field. It never grants or remembers platform permission.
_Avoid_: Allowed tool, preapproved tool

## Adoption

**Polo Workspace**:
The member-selected work area in which a Skill Artifact is installed and used. It is independent of the Creator Space that published the artifact.
_Avoid_: Creator Space, organization

**Active Workspace**:
The currently open Polo Workspace whose available server-core owns the filesystem and is therefore the only installation target for a member action.
_Avoid_: Workspace picker, Electron-local fallback

**Skill Installation**:
The workspace-owned, provenance-bearing association between one published Skill Artifact version and its materialized Skill in a Polo Workspace. Its local use does not depend on which account is signed in or on continued access to the publishing Creator Space.
_Avoid_: Download, copy

**Skill Update**:
An explicit replacement of a Skill Installation with another Published Version of the same Skill Artifact. Matching slugs from different Artifacts are source replacements, not updates.
_Avoid_: Automatic update, same-slug replacement

**Installation Ledger**:
The workspace metadata that records the provenance and verified content identity of Creator Skill Installations independently from both workspace settings and installed Skill content.
_Avoid_: Workspace settings, SKILL.md metadata

**Managed Creator Skill**:
A workspace Skill whose provenance was committed by a Creator Space Installation Operation. Matching local content alone never converts an ordinary workspace Skill into a Managed Creator Skill.
_Avoid_: Auto-detected installation, content-matched artifact

**Safety Status**:
The minimal current disposition of an exact installed Artifact Version, available without catalog access so its workspace can detect revocation while revealing no artifact content or Creator Space directory.
_Avoid_: Membership status, update metadata

**Safety Tombstone**:
The permanent minimal identity and unsafe or unavailable disposition of a purged Artifact Version. It survives package-object and Creator Space data cleanup so an old installation is never mistaken for a safe unknown version.
_Avoid_: Retained ZIP, catalog record

**Creator Skill Feature Gate**:
The Admin-controlled global capability that can stop new Creator Skill publication and distribution without affecting Web Apps, existing local use, uninstallation, or Safety Status.
_Avoid_: Artifact archive, version revocation

**Download Grant**:
A short-lived authorization to download one exact Published Version, based on access at issuance time. Later archival does not revoke the grant, while version revocation still prevents installation commit.
_Avoid_: Permanent URL, membership

**Dual Installation Authorization**:
The requirement that an installer simultaneously hold effective membership in the publishing Creator Space and existing Skill-write permission in the Active Workspace. Publisher roles do not confer workspace permission.
_Avoid_: Creator-only permission, workspace-only permission

**Installation Operation**:
A journaled, recoverable transition that changes a materialized Skill and its Installation Ledger entry as one logical commit.
_Avoid_: File copy, download

**Installation Commit Boundary**:
The point after download, validation, and staging when an Installation Operation starts changing the materialized Skill and Ledger. A user may cancel before this boundary; after it, the operation must finish committing or roll back.
_Avoid_: Upload completion, download completion

**Diverged Skill Installation**:
A Skill Installation whose materialized files no longer match its Package Manifest. Its local changes are treated as user-owned content and are never discarded without an explicit destructive choice.
_Avoid_: Corrupt Skill, automatic update

**Creator Skill Backup**:
A user-owned snapshot preserved before replacing a Diverged Skill Installation. Polo helps users inspect and explicitly delete these backups but never expires them automatically.
_Avoid_: Transaction backup, cache

**Skill Slug**:
The single stable slug of a Skill Artifact, its package root, and its installation in a Polo Workspace.
_Avoid_: Display name, artifact ID, installation slug
