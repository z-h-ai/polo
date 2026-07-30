# POO-21：创作者圈子新增 Skill 类型方案

## 1. 结论与边界

在现有 `creator_space`（创作者圈子）内，把可发布内容抽象为 **创作者作品（Creator Artifact）**，而不是新增一种组织类型：

```text
Creator Space
└── Creator Artifact
    ├── type = web_app   （现有能力，保持不变）
    └── type = skill     （本次新增）
```

这样 Web App 与 Skill 共用圈子、成员、可见性、审核和版本发布能力；其上传、校验和“使用”动作按类型分流。`enterprise_workspace` 不受影响。

本期目标是实现从创作者发布 Skill 到成员一键安装并在桌面端 `@` 引用的闭环。Skill 是指令包，不是可执行程序：**不运行安装脚本、不申请宿主权限、不执行上传包中的命令**。

不在本期范围：付费/分成、评分评论、Skill 联动自动更新、第三方依赖自动下载、Web App 与 Skill 的组合包。

## 2. 关键产品规则

| 项目 | 规则 |
| --- | --- |
| 发布主体 | 仅创作者圈子的 Owner、Manager 可新建、上传版本、发布/下架；Member 只能浏览和安装。 |
| 类型不可变 | 作品创建后 `type` 不可修改；填错时新建另一作品，避免 Web App/Skill 的字段与版本语义混淆。 |
| 名称与标识 | `slug` 在同一圈子唯一，创建后不可改。Skill 只有这一个 slug，必须为小写 kebab-case，并同时作为发布包根目录名和 workspace 安装目录名。Skill 的展示名和简介来自当前发布版本的 `SKILL.md`，不能与包内元数据独立编辑。 |
| 可见性 | 沿用圈子可见性和成员资格；用户只能浏览并安装自己有有效成员资格的圈子作品。 |
| 版本 | 仅接受稳定 SemVer（`MAJOR.MINOR.PATCH`）；版本一经发布不可覆盖，且新发布版本必须高于当前最新版。作品维护 `latestPublishedVersion`，成员也可手动选择任意历史已发布版本。 |
| 安装范围 | 安装到当前 Polo workspace 的 `skills/<slug>/`，安装归 workspace 而非发起安装的账号。workspace 已有同 slug Skill 时只能明确替换或取消，不能改名并存或静默覆盖。 |
| 优先级冲突 | 项目级 `.agents/skills/` 同 slug 时阻止安装；全局 `~/.agents/skills/` 同 slug 时提示后允许安装，由 workspace Skill 覆盖全局 Skill。 |
| 卸载 | 未修改的 Creator Skill 可连同安装记录删除；本地已修改时默认仅移除安装记录并保留为普通 workspace Skill，也可由用户明确强制删除。项目级和全局 Skill 不受影响。 |
| 上线开关 | Admin 提供独立的 Creator Skill 全局功能开关；关闭时停止新建、上传、发布、下载、安装和更新，但不影响 Web App、既有 Skill 的本地使用、卸载或 Safety Status 查询。 |

## 3. Skill 发布包规范

### 3.1 归档格式

上传一个 ZIP，解压后只能有一个根目录：

```text
<skill-slug>/
├── SKILL.md                 # 必填
├── icon.png                 # 可选；Skill 无图标也合法
└── references/              # 可选；可包含说明、模板等静态文件
```

`references/` 不采用扩展名白名单，可包含作为惰性参考资料的源代码和脚本。Polo 不自动打开、渲染或执行这些文件，安装时移除可执行位；AI 后续若请求执行，仍受正常工具权限控制。不接受根目录外的业务文件、符号链接、绝对路径、`..` 路径、设备/特殊文件、ELF/PE/Mach-O 等可执行二进制或嵌套 ZIP/TAR。已知的打包噪音文件由平台按下述固定白名单帮助清理。

与本地 Skill 的兼容规则保持一致：`SKILL.md` 有合法 YAML frontmatter，至少包含 `name`、`description` 和非空正文；支持现有 `globs`、`alwaysAllow`、`icon`、`requiredSources` 字段。Creator Skill 的 `icon` 仅允许 emoji；不允许远程 URL。包内 `icon.png` 和 frontmatter `icon` 均可省略。

### 3.2 服务端强制校验

上传在服务端解压到隔离临时目录并校验，客户端校验只用于更早反馈：

1. ZIP 总大小、文件数、单文件大小和解压后总大小受限；默认值为 20 MiB / 200 文件 / 5 MiB / 50 MiB，由 Admin 管理后台作平台级全局配置。服务端与安装端不可突破的硬上限为 100 MiB / 1000 文件 / 25 MiB / 250 MiB。限制在流式读取和解压过程中执行，拒绝 zip bomb。
2. 每个条目为普通文件或目录，路径经过规范化后仍位于临时目录；拒绝软/硬链接、设备文件和路径穿越。所有平台统一拒绝大小写冲突、Unicode 规范化冲突、Windows 保留名、尾随空格/点，以及分隔符规范化后的重复路径。
3. 服务端与安装端使用同一噪音清理白名单：`__MACOSX/**`、`.DS_Store`、`Thumbs.db`、`desktop.ini`、`._*`。保留原始 ZIP，但在校验前忽略这些条目，返回 warning，并从 manifest 与 `contentDigest` 中排除。其他根目录外文件仍报错。
4. 根目录名、作品 slug 与包内根目录一致；恰好一个 `SKILL.md`。
5. 用共享的 `validateSkillContent()` 校验 `SKILL.md`，再叠加 Creator Skill 发布策略：拒绝远程 icon URL、非 PNG 包内图标和可执行二进制；references 不限制扩展名。
6. 校验通过后计算原始 ZIP SHA-256、逐文件 manifest 和 `contentDigest`，保存原始 ZIP 为不可变对象，并记录本次 `SkillArchivePolicy` 快照；不在服务端或客户端自动执行包内代码。

Admin 日后降低限制时不追溯作废已发布版本。安装端按版本保存的策略快照复核，同时始终执行自身绝对硬上限。

原始 ZIP 的 `archiveChecksum` 只验证下载对象，不能判断解压后的安装目录是否被修改。Package Manifest 以包根目录为基准，为清理噪音后的每个普通文件记录 `{ path, size, sha256 }`；`path` 使用统一 Unicode 与 `/` 分隔符规范化，条目按规范化 UTF-8 路径排序。共享实现以固定字段顺序的 canonical JSON 编码 manifest，再计算 SHA-256 作为 `contentDigest`。文件内容按原始字节计算，不自动转换换行符。安装后重新扫描时，缺失文件、额外文件、内容或大小变化，以及文件/目录类型冲突都视为本地修改；ZIP checksum 不参与该判断。

现有 `validateSkillContent()` 位于共享配置校验模块。实施时应将其及所依赖的 slug/frontmatter 规则进一步抽到无配置或 Node/Electron 依赖的共享模块，使 Admin 服务和桌面端使用同一套规则与错误信息。

## 4. 数据模型与 API

以下数据归属 Admin/创作者服务；Electron 仓库只维护传输 DTO、运行时校验和调用层。

### 4.1 数据模型

```ts
type CreatorArtifactType = 'web_app' | 'skill'
type CreatorArtifactStatus = 'draft' | 'published' | 'archived'
type CreatorArtifactVersionStatus =
  | 'upload_pending'
  | 'uploaded'
  | 'validating'
  | 'validation_failed'
  | 'validated'
  | 'published'
  | 'revoked'
  | 'expired'

interface SkillArchivePolicy {
  version: string
  maxArchiveBytes: number
  maxFileCount: number
  maxFileBytes: number
  maxExpandedBytes: number
}

interface CreatorArtifact {
  id: string
  organizationId: string
  type: CreatorArtifactType
  slug: string
  name?: string
  summary?: string
  displayIcon?:
    | { kind: 'emoji'; value: string }
    | { kind: 'image'; url: string }
  status: CreatorArtifactStatus
  latestPublishedVersion?: string
  createdByUserId: string
  createdAt: string
  updatedAt: string
  archivedAt?: string
  archivedByUserId?: string
}

interface CreatorArtifactVersion {
  id: string
  artifactId: string
  version: string
  changelog?: string
  status: CreatorArtifactVersionStatus
  archiveChecksum?: string
  contentDigest?: string
  sizeBytes?: number
  createdAt: string
  publishedAt?: string
  publishedByUserId?: string
  revokedAt?: string
  revokedByUserId?: string
  revocationReason?: string
  validationPolicy?: SkillArchivePolicy
  uploadGeneration: number
  validatorVersion?: string
  validatedArchiveChecksum?: string
  validatedAt?: string
}

interface SkillVersionMetadata {
  name: string
  description: string
  globs?: string[]
  alwaysAllow?: string[]
  icon?: string
  requiredSources?: string[]
}

interface SkillValidationIssue {
  code: string
  severity: 'error' | 'warning'
  path: string
  field?: string
  message: string
  suggestion?: string
}
```

新建的 `creator_artifacts` 存 Skill 作品共同字段。Skill 创建时只提交 slug；首次上传成功前 `name`、`summary` 和 `displayIcon` 为空，管理者的 draft 列表以 slug 作为临时标题和默认占位图。上传后，管理界面可投影当前版本 `SkillVersionMetadata`；面向成员的 Catalog 始终投影最新版已发布版本。`name`、`summary` 和 `displayIcon` 不是独立可编辑字段。frontmatter emoji 投影为 `displayIcon.kind = emoji`；包内 `icon.png` 由平台处理为受控图片资源并投影为 `kind = image`。两者都没有时继续使用默认占位图。`creator_artifact_versions` 存不可变版本及其 Skill 元数据快照；`creator_skill_version_files`（或对象存储 manifest）记录规范化相对路径、文件大小、逐文件 SHA-256、原始 ZIP checksum、整体 `contentDigest` 和存储对象 key。本期没有独立的作品级 Skill 字段，因此无需创建空的 `creator_skill_artifacts` 表。

现有 Web App 不迁移表或写流程。Admin API 在读模型层把现有 Web App 记录和新 Skill 记录聚合为统一 Artifact Catalog DTO。所有 artifact ID 是全局唯一的不透明字符串；新 Skill 使用 UUID，旧 Web App 若原 ID 不能满足全局唯一，由聚合层提供稳定映射。客户端不得解析 ID 或通过前缀推断类型。

增加唯一约束：`(organization_id, slug)`，以及排除 `expired` 尝试的 `(artifact_id, version)` 部分唯一约束。对 Skill 而言，前一个约束同时保证同圈子里的安装名没有歧义。从未发布的 Artifact draft 被删除后释放 slug；曾发布 Artifact 即使 archived 也继续占用 slug。过期尝试的最小历史进入审计记录，使相同 SemVer 可以用新的 version ID 重新创建。

### 4.2 API 契约

所有端点均验证 Bearer token。作品内容和管理端点再验证圈子成员资格及角色；能力、全局策略和精确安装版本的最小 Safety Status 不要求圈子成员资格，也不返回圈子内容。下载接口不返回永久公开 URL。所有写操作均支持 `Idempotency-Key`，按用户、操作和目标资源隔离并绑定请求 body hash：同 key 同 body 重放首次结果，同 key 不同 body 返回 `idempotency_conflict`，记录至少保留 24 小时。

每个管理 API 均按请求发生时的角色重新鉴权。Owner/Manager 在上传或异步校验期间被降级为 Member 时，已上传对象和安全校验任务可以保留并完成，但该用户不能再上传、删除、发布、撤销或下架；Artifact 始终属于 Creator Space，其他 Owner/Manager 可继续处理。

| 方法 | 路径 | 用途 |
| --- | --- | --- |
| `GET` | `/api/capabilities` | 返回 `creatorSkillArtifacts` 等服务端能力；客户端确认支持后才展示 Creator Skill 入口。 |
| `GET` | `/api/artifact-policies/skill` | 获取 Admin 管理的当前全局 Skill 归档限制，供创作者 UI 提前提示。 |
| `GET` | `/api/organizations/:organizationId/artifacts?type=skill&limit=50&cursor=...` | cursor 分页的圈子作品列表；成员只读 published，管理者可带 includeDrafts=true。默认按最近发布时间倒序。 |
| `POST` | `/api/organizations/:organizationId/artifacts` | 创建 draft；Skill body 只含 `type: "skill"` 和 `slug`，名称、简介由上传包生成。 |
| `GET/PATCH` | `/api/artifacts/:artifactId` | 读取或编辑允许的作品元数据；不可改变 type、slug，Skill 也不可独立编辑由当前发布版本投影的 name、summary。 |
| `DELETE` | `/api/artifacts/:artifactId` | Owner/Manager 删除从未发布过的 Artifact draft；曾发布作品只能 archive。 |
| `GET` | `/api/artifacts/:artifactId/versions?limit=50&cursor=...` | cursor 分页版本历史；普通成员只读取 published，管理者可读取 draft，按 SemVer 倒序。 |
| `POST` | `/api/artifacts/:artifactId/versions` | 创建版本并获得短时上传地址；使用 `Idempotency-Key`。 |
| `DELETE` | `/api/artifacts/:artifactId/versions/:version` | Owner/Manager 删除从未发布过的版本 draft；published/revoked 版本不可删除。 |
| `PUT` | 短时对象上传地址 | 上传 ZIP，不经 Electron 主进程转发大文件；过期前允许网络失败重试。 |
| `POST` | `/api/artifacts/:artifactId/versions/:version/validate` | 幂等触发异步服务端校验。 |
| `GET` | `/api/artifacts/:artifactId/versions/:version/validation` | 查询校验状态、validatorVersion 和 SkillValidationIssue 列表。 |
| `POST` | `/api/artifacts/:artifactId/versions/:version/publish` | 仅校验通过后发布，原子更新 `latestPublishedVersion`。 |
| `POST` | `/api/artifacts/:artifactId/versions/:version/download` | 成员获取短时下载地址及 archiveChecksum、contentDigest、文件 manifest、sizeBytes；v1 不承诺严格一次性。 |
| `POST` | `/api/artifacts/:artifactId/versions/:version/revoke` | Owner、Manager 或平台 Admin 撤销不安全版本，阻止新下载，并原子回退 latestPublishedVersion。 |
| `POST` | `/api/installed-artifacts/status` | 批量查询精确 artifactId + version + archiveChecksum 的最小安全状态；不要求目录成员资格，也不返回作品内容。 |
| `POST` | `/api/artifacts/:artifactId/archive` | 下架新安装入口；既有本地安装不自动删除。 |
| `POST` | `/api/artifacts/:artifactId/restore` | Owner/Manager 恢复下架作品及其原 latestPublishedVersion。 |

失败码至少包括：`creator_skill_feature_disabled`、`artifact_type_not_allowed`、`artifact_not_found`、`artifact_slug_conflict`、`artifact_not_deletable`、`version_not_deletable`、`invalid_skill_archive`、`skill_validation_failed`、`archive_policy_exceeded`、`version_conflict`、`artifact_not_published`、`artifact_version_revoked`、`artifact_access_denied`、`upload_expired`、`checksum_mismatch`、`content_digest_mismatch`、`idempotency_conflict`。

Admin 响应以 Zod 验证已知字段并剥离未知字段，使旧客户端可兼容服务端新增字段，同时保证未知字段不进入 renderer。renderer 到 server-core 的 RPC 输入使用 `.strict()`，未知字段直接拒绝。Artifact Catalog 缓存至少以 `userId + organizationId + filter + cursor` 为 key；退出登录、账号切换或成员资格变化时清除对应缓存，不能短暂展示前一账号可见的 draft 或成员内容。

新客户端仅在 capability 中确认 `creatorSkillArtifacts` 后请求或展示 Skill。旧客户端保持现有 Web App 查询路径，不接收未知 `type: skill`；聚合 Catalog 必须按请求类型和客户端能力过滤，不能让一个未知 Artifact 类型导致整个列表解析失败。

## 5. 创作者端体验

在创作者圈子详情页增加“作品”入口，沿用现有成员/邀请权限。

Admin 全局功能开关关闭时隐藏 Creator Skill 新建入口，并由服务端拒绝新建、上传、校验触发、发布、下载、安装和更新；Web App 流程不受影响。既有本地安装仍可使用和卸载，最小 Safety Status 查询保持可用。

1. 点击“新建作品”，先选择 **Web App** 或 **Skill**。首发默认不改变现有 Web App 流程。
2. 选择 Skill 后只填写唯一 slug；slug 同时是发布包根目录名和 workspace 安装目录名。首次上传成功前，draft 列表以 slug 作为临时标题。
3. 创建作品 draft 后先填写稳定 SemVer 版本号和更新说明，再创建版本记录并获得上传地址。首个版本默认使用 `Initial release`；后续版本 changelog 必填，最多 2,000 字符。
4. 选择 ZIP 后，客户端只做快速预检：ZIP 大小、单一根目录、根目录与 slug 一致、根目录下存在唯一 `SKILL.md`，以及明显的绝对路径、路径穿越或非法条目。客户端预检仅用于提前反馈，不能替代服务端校验。
5. 上传 ZIP，版本依次进入 `upload_pending → uploaded → validating → validated/validation_failed`。失败时按文件、字段和原因显示。只有 error 阻止发布；warning 正常展示但不要求额外确认。
   作品页面打开期间自动轮询校验状态；用户离开页面后停止轮询且不发送站内、邮件或系统通知。用户返回时通过手动刷新取得最新结果。
6. PUT 完成前用户可以取消；上传地址未过期时网络失败可重试。地址过期后客户端申请新上传地址、递增 `uploadGeneration`，并将旧校验任务视为陈旧结果。进入 validating 后只能等待当前任务或明确重新上传，任何旧任务成功都不能推进新 generation。
7. 每次重新上传生成新的不可变对象、递增 `uploadGeneration` 并使旧校验结果失效；旧任务结果只有在 generation 与 archiveChecksum 都匹配时才能写入。已发布版本不能重新上传。
8. 校验通过后点击“发布”。记录发布人和发布时间；作品列表以类型徽标区分 Web App 与 Skill。名称、简介和其他 Skill 内容均来自该版本包。
9. 任何内容变化，包括只修改 `name`、`description` 或其他 frontmatter，也必须创建并发布更高版本；已发布内容不可原地修订。
10. Owner/Manager 可删除从未发布过的 Artifact draft 或版本 draft；Artifact 一旦有过 published 版本便只能 archive，published/revoked 版本永久保留、不可删除。已发布 Skill 可新建更高版本；下架作品不再出现在普通成员列表中，但 Owner/Manager 可恢复。
11. Owner、Manager 或平台 Admin 可撤销单个不安全版本；作品自动选择最高的未撤销已发布版本作为最新版。

`revoked` 是终态，不能恢复为 published。误撤销或修复内容必须发布更高的新版本。恢复 Archived Artifact 时只恢复未撤销的发布版本，撤销版本不能重新下载或成为 latest。

发布必须严格递增：若较高版本已先发布，随后发布较低版本返回 `version_conflict`，即使较低版本更早完成校验。

Admin 审计至少记录 `artifact.created`、`artifact.draft_deleted`、`version.uploaded`、`version.validation_completed`、`version.draft_deleted`、`version.published`、`version.revoked`、`artifact.archived`、`artifact.restored`、`version.download_issued`。每条包含 actor、organization、artifact、version、结果、checksum 和时间，不记录 ZIP 内容或 `SKILL.md` 正文。

运行指标仅可记录操作类型、成功率、耗时、稳定错误码和包大小区间等诊断数据；不得上传文件名、文件内容、`SKILL.md` 正文、下载地址、访问 Token 或本地绝对路径。

校验成功保存 `validatorVersion`、`validatedArchiveChecksum`、`validatedAt`。安装端仍用自身当前安全规则复检。未发布版本 30 天无活动后进入 `expired`，删除 ZIP、校验临时数据和对象存储内容，仅保留最小审计；相同 SemVer 可用新的 version ID 重新创建。

有效 Creator Space 中所有未撤销 Published Version 的原始 ZIP、manifest 和内容身份持续保留，以支持安装历史版本。Revoked Version 以及已删除 Creator Space 的包对象按 Admin 数据保留策略最终清理；清理后永久保留最小 Safety Tombstone，包括 artifactId、version、archiveChecksum、revoked/archived 状态和必要审计，使旧安装不会因内容对象消失而被误报为安全。

Creator Space 删除后，其 Skill Artifact 立即停止发现、下载和更新，并在最小 Safety Status 中视为 archived；已安装 Skill 仍可本地使用和卸载。作品、对象和个人数据的后续清理遵循现有组织删除保留期，但不得删除上述最小 Safety Tombstone。

## 6. 成员安装与桌面端集成

### 6.1 浏览与安装流程

```text
选择 creator_space
  → 作品列表筛选 Skill
  → 详情页（说明、可选历史版本、更新说明；可原样展示包内元数据）
  → 安装到当前 workspace
  → 获取短时下载地址 + archiveChecksum + contentDigest + manifest
  → server-core 下载到临时目录并校验原始 ZIP
  → 安全解压 + validateSkillContent
  → 逐文件校验 manifest 并计算 contentDigest
  → 提交前重新查询 Creator Skill capability 与精确版本 Safety Status
  → 冲突确认/原子替换 skills/<slug>
  → invalidateSkillsCache + 广播 skills:changed
  → 可在聊天输入框 @<skill> 使用
```

正常安装不追加二次确认弹窗；用户查看详情后点击一次“安装”即可。只有 workspace 同名覆盖、全局同名覆盖、本地修改等风险场景需要额外确认。

安装目标固定为当前打开的 Polo workspace。详情页在安装按钮旁显示目标 workspace 名称和路径；没有打开 workspace，或其 server-core 离线、不可访问时，安装按钮禁用并提示用户先打开或重新连接 workspace。薄客户端不得把 ZIP 下载到 Electron 本机后代替目标 server-core 安装。

安装、更新和卸载复用现有 workspace Skill 写入权限，不新增 Creator Skill 专属 workspace 角色。开始安装时用户必须同时拥有来源 Creator Space 的有效成员资格和目标 workspace 的 Skill 写入权限；只读 workspace 用户可以浏览来源作品，但不能改变 workspace。来源空间的 Owner/Manager 在安装侧没有额外特权。

详情页展示完整但可折叠的 `SKILL.md`、文件树、文件数、总大小、版本、更新说明、Creator Space、实际发布人、发布时间、checksum，以及 `requiredSources`、`alwaysAllow` 原始值。references 不自动打开或渲染；用户主动选择后只以安全纯文本预览或下载方式访问。

下载、校验和写入 workspace 必须由拥有该 workspace 文件系统的 server-core 完成；薄客户端只发请求，不能在 Electron 本机安装远程 workspace 的 Skill。renderer 不接触文件系统，也不信任下载地址以外的内容。安装器使用“临时目录 → 验证 → 备份旧目录 → rename → 写安装记录”的可回滚替换；失败时恢复旧 Skill，不留下半成品目录。

下载授权以短时 URL 签发时的成员资格为准：之后下架作品会阻止新 URL，但不保证立即终止已经签发的 URL。版本撤销和 Creator Skill 全局开关关闭属于提交例外；安装器在提交前复查 capability 与 Safety Status，若功能已关闭或版本已撤销，则删除 staging 并拒绝安装。

用户在下载授权签发后被暂停或移出 Creator Space，不中止该授权对应的在途安装；版本未撤销时仍可提交。此后新的浏览、下载、安装和更新请求均拒绝。workspace 中已经安装的 Skill 继续可用，且仍可通过最小 Safety Status 接口检查撤销状态。

安装进度按“下载 → 校验 → 解压准备 → 提交替换 → 刷新完成”展示。用户可在提交替换开始前取消；进入提交阶段后暂时禁用取消，直到事务提交或自动回滚。失败反馈包含失败阶段、稳定错误码、可读原因、相关文件路径和可复制诊断信息，并在安全时提供重试。首次安装失败不留下正式目录或 Ledger 记录，更新失败则旧版本保持完整。

### 6.2 本地安装记录

在 workspace 根目录使用独立的 `creator-skills.json` Installation Ledger，而不是修改 workspace `config.json` 或往 `SKILL.md` 写平台专用字段：

```ts
interface CreatorSkillsLedger {
  schemaVersion: 1
  installed: InstalledCreatorSkill[]
}

interface InstalledCreatorSkill {
  artifactId: string
  organizationId: string
  slug: string
  version: string
  archiveChecksum: string
  contentDigest: string
  installedAt: string
  lastKnownStatus?: 'active' | 'revoked' | 'archived'
  lastCheckedAt?: string
  ignoredVersion?: string
}
```

Ledger 使用临时文件 + rename 原子写入，用途是显示来源、检测更新、判断是否可安全卸载。记录不包含用户 ID：安装属于 workspace，其他账号可继续使用本地 Skill，但没有圈子成员资格时不能浏览、重新下载或更新来源作品。加载 Skill 时仍只依赖标准目录和 `SKILL.md`，因此用户复制或导出后保持可用。

服务端保存逐文件 manifest；客户端安装时用它验证解压结果，并保存整体 `contentDigest`。若重新扫描安装目录所得的文件集合、逐文件 hash 或 `contentDigest` 不匹配，该安装成为“本地已修改”状态：

- 更新只能选择“备份本地修改并替换”或取消。
- 卸载默认仅移除 Creator 安装记录，将目录保留为普通 workspace Skill；用户可明确强制删除。
- 平台不得静默丢弃本地修改。
- 更新产生的备份保存在 workspace 根目录的 `skill-backups/<slug>/<timestamp>/`，不参与 Skill 加载，且仅由用户明确删除。
- 设置中提供“Creator Skill 备份”管理入口，展示 slug、创建时间、大小和产生备份的操作；支持确认后逐个删除或全部删除。平台不按时间自动清理这些用户内容。

同名冲突按现有加载优先级处理：项目级 > workspace > 全局。项目级同名会令新安装不可见，因此阻止安装；全局同名可在明确提示后由 workspace Skill 覆盖。

现有普通 workspace Skill 不自动加入 Installation Ledger。即使其目录内容与某个发布版本完全相同，平台也不据此认领来源；只有通过 Creator Space 安装事务提交的 Skill 才是受管理的 Creator Skill。

已安装版本若后来被撤销，平台不自动删除或禁用本地 Skill。客户端在登录并打开 workspace 时、打开作品或 Skill 详情时检查状态；持续在线时最多每 24 小时检查一次，只查询状态而不自动下载或安装。

检测到撤销后，在 workspace Skill 列表、Skill 详情和聊天输入框的 `@` 候选中持续显示红色“版本已撤销”标记，并提供“更新到安全版本”和“卸载”入口；本期不发送站内、邮件或系统通知。

安全查询以精确的 `artifactId + version + archiveChecksum` 为条件。即使当前账号没有来源圈子资格，也只可获得 `active/revoked/archived` 和可用安全版本号，不返回作品内容或圈子目录。查询结果写入 Ledger 的 `lastKnownStatus`、`lastCheckedAt`。离线或请求失败时继续允许使用，但显示“安全状态未能更新”，不得把未知状态展示为安全。

更新只在相同 `artifactId` 的版本之间成立；其他作品即使 slug 相同也属于来源替换，必须走冲突确认。后台只检查版本和安全状态，不下载 ZIP；用户明确点击后才更新。Ledger 可记录 `ignoredVersion`：忽略该版本后不再提示，更高版本出现时重新提示。手动安装未撤销历史版本视为回滚，并自动忽略回滚前的较高版本，直到出现更高的新版本。

### 6.3 安装事务与恢复

每个安装、更新或卸载操作以 workspace+slug 为粒度进入进程内队列，并获取独占 lock file。持久化工作目录为：

```text
.creator-skill-ops/<operationId>/
├── journal.json
├── stage/
└── backup/
```

提交顺序固定为：

```text
获取锁
  → 下载并验证 stage
  → 写 journal
  → 旧目录 rename 为 backup
  → stage rename 为正式目录
  → 原子更新 creator-skills.json
  → 标记 committed
  → 清理临时 backup 和 journal
```

失败时恢复旧目录和旧 Ledger。server-core 启动时扫描 journal：未提交操作回滚，已提交操作清理残留。只有正式目录与 Ledger 都提交成功后，才调用 `invalidateSkillsCache` 并触发 `skills:changed`。为保留项目级 Skill，renderer 收到事件后按当前会话 `workingDirectory` 重新请求完整列表，而不是直接用仅含 workspace Skills 的事件结果。

### 6.4 Sources 与权限说明

- `requiredSources` 是可选、非官方的建议性 frontmatter。平台仅允许并保留该字段，可在详情中原样展示；不会据此查找、安装、授权、检查或启用 Source。AI 读取 `SKILL.md` 后自行解释。现有引用 Skill 时自动启用 Source 的行为需要移除。
- `alwaysAllow` 与 `requiredSources` 一样属于版本级建议性元数据。平台允许、保留并展示为“Skill 请求使用的工具”，但不据此授予或记住任何权限；真正权限仍由当前权限模式和用户审批决定。
- 安装成功后立即刷新当前 workspace 的 Skills 列表和当前会话的 Skill cache；下一条用户消息即可通过 `@` 引用。已经生成中的 AI 回复不动态注入新 Skill，新会话必定可见。

## 7. 仓库改动拆分

| 阶段 | 主要位置 | 交付 |
| --- | --- | --- |
| 0. 契约 | Admin 服务 + `packages/shared/src/admin/{types,schemas,client}.ts` | Skill 数据库迁移、Web App/Skill 聚合读模型、cursor API、响应 strip/RPC strict DTO、错误码与缓存隔离。 |
| 1. Skill 包校验 | 共享 Skill validator、Admin 上传 worker | ZIP 安全检查、内容校验、对象存储、发布状态机。 |
| 2. 创作者界面 | 创作者圈子 Web/Admin UI | 创建、上传、校验、发布、版本管理与下架。 |
| 3. Electron 浏览 | `apps/electron` + admin RPC | Skill 目录、详情、下载元数据与角色/成员权限反馈。 |
| 4. 安装器 | `packages/shared`、`packages/server-core`、Electron preload/renderer | server-core 下载、安全解压、锁、journal、可回滚目录交换、独立 Ledger、崩溃恢复与卸载；本地与远程 workspace 使用同一路径。 |
| 5. 更新体验 | Electron renderer | 基于 artifactId 的已安装版本、可更新提示、忽略指定版本、手动更新与历史版本回滚；不做后台自动下载或安装。 |

现有组织类型只保留 `enterprise_workspace | creator_space`；不得把 `skill` 加入 `OrganizationType`。现有 tab-browser 的 `AppDefinitionType = 'builtin' | 'webapp'` 也不是作品类型，不应直接扩成 `skill`，因为 Skill 没有浏览器 tab 或 URL。

## 8. 验收标准

- Owner/Manager 能在创作者圈子创建 `skill` draft，上传符合规范的 ZIP，校验后发布；Member 无法创建或发布。
- 正常成员只能看到所在圈子的已发布 Skill，并能安装至所选 workspace；无成员资格、被暂停、已下架或未发布均不能下载。
- Creator Skill 全局开关关闭后所有新增和分发动作被服务端拒绝，Web App 与既有本地 Skill 的使用/卸载不受影响，Safety Status 仍可查询。
- 安装同时要求有效 Creator Space 成员资格和目标 workspace 的现有 Skill 写入权限；只读用户不能安装、更新或卸载。
- 恶意归档（路径穿越、链接、多个根目录、缺 `SKILL.md`、非法 frontmatter、超限/zip bomb、篡改 checksum）在服务端和安装端均被拒绝，不写入 workspace。
- 安装同名 Skill 时明确展示来源与版本；取消或安装失败后原版本完整可用；成功替换后 `skills:changed` 触发并可 `@` 引用。
- 安装目标只允许当前打开且 server-core 可用的 workspace；安装进度可见，提交阶段前可取消，进入提交后必须完成提交或回滚。
- 安装失败展示阶段、稳定错误码、可读原因和可复制诊断；首次安装不留残余，更新失败保留旧版本。
- 项目级同名时阻止安装；全局同名时经确认后由 workspace Skill 覆盖。不同账号可使用 workspace 中已安装的 Skill，但无来源圈子资格时不能重新下载或更新。
- 下载授权签发后发生的成员暂停或移除不打断在途安装，但会阻止后续浏览、下载和更新；版本撤销仍会在提交前阻止安装。
- 管理者被降级后，已上传内容和异步校验结果保留，但每个后续管理操作按当前角色拒绝；其他 Owner/Manager 可接手。
- 本地修改过的 Creator Skill 在更新前被备份，在卸载时默认保留为普通本地 Skill；任何路径都不静默丢弃修改。
- Creator Skill 备份可在设置中查看大小并由用户逐个或全部清理，但不得按时间自动删除；现有普通 workspace Skill 不被自动认领为 Creator 安装。
- 并发安装/更新/卸载按 workspace+slug 串行执行；在目录交换、Ledger 写入或进程重启等故障点均能恢复一致状态，且只在完整提交后广播 `skills:changed`。
- 单个不安全版本可被撤销并停止新下载，最新版自动回退；已安装撤销版本不会被远程删除或禁用，但联网时必须显示安全警告和明确处置入口。
- 撤销警告同时出现在 Skill 列表、详情和 `@` 候选中；校验页面只在打开时轮询，离开后不发送完成通知，返回后由用户手动刷新。
- 诊断指标不得包含文件名、内容、下载地址、Token 或本地绝对路径。
- 从未发布且已删除的 Artifact slug 可重新使用；曾发布 Artifact 的 slug 在下架后仍保留。Creator Space 删除后停止分发，但既有安装继续使用。
- 活跃圈子的未撤销已发布历史包持续可下载；被撤销或随圈子删除而清理的包仍永久保留最小 Safety Tombstone。
- 撤销不可逆；恢复下架作品不会恢复撤销版本。无目录成员资格的 workspace 用户仍可查询精确安装版本的最小安全状态，离线或查询失败时显示陈旧状态而不阻止本地使用。
- 并发发布只允许严格递增版本成为 published；所有写操作可安全幂等重放。下架不保证撤销已签发短时 URL，但版本在安装提交前被撤销时必须中止且不写入 workspace。
- 校验问题具有稳定 code/severity/path 结构且不泄露服务端路径；warning 不阻止发布。陈旧 generation 的结果不能覆盖新上传，30 天无活动的未发布内容会过期清理并允许重新使用其 SemVer。
- 更新只来自同一 artifactId，且只在用户明确操作后下载；可忽略指定版本并在更高版本出现时重新提示，回滚到历史版本后不会立即提示升级回原版本。
- `requiredSources` 和 `alwaysAllow` 不会自动获得 Source 授权或工具权限。
- Web App 创建、发布、安装/打开流程回归通过；企业 workspace 的组织、邀请与成员流程不受影响。

## 9. 产品决策

1. 初版仅允许有效圈子成员发现和安装，不增加公开可见性；未来公开市场另行设计审核、举报和信任体系。
2. Skill 不增加独立审核角色；Owner/Manager 在技术校验通过后直接发布，并记录发布人和发布时间。
3. Skill 仅使用一个不可变 slug，同一圈子内不可重复。
4. 初版只接受稳定 SemVer，不接受 prerelease；历史已发布版本可由成员手动安装。
5. Creator Skill 使用独立 Admin 全局功能开关；关闭不影响 Web App、既有本地使用、卸载和 Safety Status。
6. 新客户端通过 `creatorSkillArtifacts` capability 判断服务端支持；旧客户端只接收 Web App。
7. 删除从未发布的 Artifact draft 会释放 slug，曾发布作品即使 archived 也永久保留 slug。
8. 删除 Creator Space 会立即停止 Skill 分发，但不远程删除或禁用本地安装。
9. 活跃圈子的未撤销 Published Version 持续保留可安装对象；被清理对象仍保留永久 Safety Tombstone。
