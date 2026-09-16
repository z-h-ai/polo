# Polo Domain Context

## Creator Publishing

This context defines how creator communities publish versioned work and how members adopt that work into their Polo workspaces.

### Publishing

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

### Adoption

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
## Polo CLI Execution

This context defines the language used for non-interactive Polo commands that execute alongside the desktop application without becoming part of its session experience.

### Language

**CLI 执行运行时**:
由一次 `polo run` 或 `polo exec` 调用独占、并且独立于 Electron 运行的执行上下文；其生命周期不超过该次命令所需的执行周期。
_Avoid_: One-shot Runtime、Electron RPC 会话

**配置工作区**:
一次 CLI 执行读取 Polo 能力配置的 workspace；它决定可用的 sources、skills、权限和模型配置，但不决定 agent 操作文件的位置。
_Avoid_: 当前目录、代码仓库

**执行目录**:
Agent 在一次 CLI 执行中操作文件和运行命令的目录；它不因被使用而成为配置工作区。
_Avoid_: 自动注册的 workspace、配置目录

**执行覆盖**:
只在当前 CLI 执行期间生效的 provider、model、endpoint 或凭据选择；它不会改变配置工作区或 Electron 后续使用的共享设置。
_Avoid_: 保存连接、修改默认模型

**CLI 会话**:
由 `polo run` 或 `polo exec` 创建、只属于 CLI 体验的会话记录；它只能由 CLI 发现或恢复，永远不是 Electron 会话。
_Avoid_: 隐藏的 Electron 会话、桌面会话

**CLI 执行所有者**:
发起一次 CLI 执行并负责接收其结果的命令进程；所有为该次执行创建的运行活动都受其生命周期约束。
_Avoid_: 后台 server、Electron

**CLI Thread**:
一次 CLI 调用创建的主会话及其所有派生会话构成的、可由全局唯一 `thread_id` 定位的整体；保留、恢复和清理策略作用于整个 Thread。
_Avoid_: CLI 执行组、单个主 session、内部 session slug

**CLI Thread 状态**:
Thread 最近一次执行的终态，取值为 `completed`、`failed` 或 `interrupted`；终态不决定持久化 Thread 是否可以恢复。
_Avoid_: 进程存活状态、删除状态

**Exec JSONL 协议**:
`polo exec --json` 面向自动化消费者提供的稳定事件协议；它兼容 Codex 的核心事件形态，但不是 Polo 内部事件或全部 Codex 事件的镜像。
_Avoid_: RPC 事件透传、完整 Codex JSONL 等价

**恢复 CLI 会话**:
继续使用既有 CLI Thread 中的原会话和历史，而不是复制或分叉出新的持久化记录。
_Avoid_: 复制会话、隐式 fork

**临时恢复**:
基于既有 CLI 会话历史进行一次不留存结果的执行；原会话及其使用时间保持不变。
_Avoid_: 删除原会话、原位追加

**最终回答**:
一次成功 CLI 执行产生的完整 assistant message；普通输出模式只把该结果交付到 stdout。
_Avoid_: 流式片段、进度文本、失败前的部分回答

**Polo 会话产物**:
由 Polo 创建并负责生命周期的会话记录及其附件、计划、数据和恢复元数据；provider 自主管理的缓存不属于该概念。
_Avoid_: provider 缓存、Electron workspace 文件

**执行配置快照**:
一次 CLI 调用开始时解析出的配置工作区能力与执行覆盖集合；该调用期间 Electron 的后续配置变化不会改变它。
_Avoid_: 实时配置、共享 watcher 状态
