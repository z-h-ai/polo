# ProductSpace 操作契约

状态：F01-B 已冻结（2026-08-10）

适用范围：Polo Admin、`@z-h-ai/shared`、Polo 客户端、Electron Main、本地 App Runtime 与 Polo 助手 Session

依据：[`product-space-contract.md`](./product-space-contract.md)、[`product-function-baseline.md`](./product-function-baseline.md)、[`user-flows-permissions-and-states.md`](./user-flows-permissions-and-states.md) 及四个入口已确认的 46 组用户流程。

本文冻结跨仓实现必须共同遵守的操作边界。企业成员管理、圈子经营、作品生产发布和平台治理的完整管理 API 仍由 E/C/A/W/O 等后续任务定义；它们不能改变本文的 ProductSpace 身份、Catalog、启动、缓存和运行隔离规则。

## 1. 本轮决策

1. ProductSpace 网络契约使用 `contractVersion: 1`，只包含 `personal / enterprise`。
2. Polo Admin 是空间访问、Catalog 授权、Skill 启用状态和启动解析的服务端权威。
3. 当前 ProductSpace 选择只保存在当前账号、当前设备，不提供服务端“切换空间”接口。
4. Catalog 同时返回 Polo 助手、Apps 和 Skills；Polo 助手是内置 App，不伪装成创作者作品。
5. 每次启动前必须在线解析当前授权和固定版本；离线缓存不能授权新的 App、Skill 或 Polo 助手执行。
6. Runtime Scope 同时包含 `productSpaceId` 与本地 `workspaceId`，二者不能互相推导。
7. 软件尚未公开发布，本轮直接替换旧 Organization 客户端契约，不做双读、双写或旧缓存自动迁移。

## 2. 契约所有权

跨 Polo Admin 与 Polo 客户端使用的类型、Zod Schema、错误码和路径常量唯一发布源为：

```text
@z-h-ai/shared/product-spaces
```

建议源文件：

```text
product-spaces/
  ids.ts
  types.ts
  schemas.ts
  errors.ts
  paths.ts
```

- Polo Admin 的 Route Handler 必须用这些 Schema 校验输入和输出。
- Polo 客户端的 AdminClient 必须再次解析所有服务端响应，不能直接断言类型。
- `@polo-ai/shared/admin` 可以封装 AdminClient、缓存和 Electron RPC，但不能复制或重新定义 ProductSpace 枚举与网络 DTO。
- 本地 Runtime 专属类型可以留在 Polo 仓库；凡同时出现在 HTTP 与本地 RPC 的字段必须复用共享 ID 和基础 Schema。

### 2.1 当前实现落点

2026-08-10 核对到的现状是：

- Polo Admin 已依赖发布包 `@z-h-ai/shared`，但当前安装版本只导出 Creator Skills 契约，尚无 `product-spaces` export。
- Polo 客户端的 AdminClient、Organization DTO 与 Catalog Schema 位于内部包 `polo/packages/shared/src/admin`，包名为 `@polo-ai/shared`。
- 当前客户端仍调用 `/api/me/organizations` 与 `/api/organizations/{organizationId}/apps`。
- 当前 Local App scope 是 `accountId + organizationId + catalogAppId`；Session 持久化只有 `workspaceRootPath`，没有 `productSpaceId`。

因此共享契约实现任务必须先扩展 `@z-h-ai/shared/product-spaces`，再让 Polo Admin 与 `@polo-ai/shared/admin` 同时依赖它。不要把新 DTO 只写进客户端内部包，否则 Polo Admin 仍会复制 Schema，F01-B 不能成立。

## 3. 公共标识与基础类型

```ts
type ProductSpaceKind = "personal" | "enterprise";
type EnterpriseProductSpaceRole = "owner" | "manager" | "member";
type ProductSpaceAccessMode = "active" | "read_only";
type ProductSpaceRestrictionCode =
  | "billing_restricted"
  | "governance_suspended"
  | "enterprise_closing";

type CatalogEntryKind = "built_in_app" | "app" | "skill";
type CatalogEntryAvailability = "available" | "unavailable" | "blocked";
type CatalogEntryUnavailableReason =
  | "authorization_ended"
  | "space_restricted"
  | "version_unavailable"
  | "version_blocked";
```

所有 ID 使用 F01-A 的不透明品牌类型。网络 JSON 仍传非空字符串，进入业务层前由 Schema 转换。禁止裸 `spaceId` 和把 `enterpriseId`、`organizationId`、`workspaceId` 强转成 `ProductSpaceId`。

## 4. ProductSpace 列表

### 4.1 操作

```http
GET /api/me/product-spaces
Authorization: Bearer <accessToken>
```

该接口返回当前账号可以识别的全部消费空间，不返回 Creator Circle、创作者工作台或平台运营端。

### 4.2 响应

```ts
interface ListProductSpacesResponse {
  contractVersion: 1;
  personalProductSpaceId: ProductSpaceId;
  productSpaces: ProductSpaceSummary[];
}

type ProductSpaceSummary =
  | {
      id: ProductSpaceId;
      kind: "personal";
      name: "我的空间";
      accessMode: "active";
      payer: { kind: "account" };
    }
  | {
      id: ProductSpaceId;
      kind: "enterprise";
      enterpriseId: EnterpriseId;
      name: string;
      role: EnterpriseProductSpaceRole;
      accessMode: ProductSpaceAccessMode;
      restrictionCode?: ProductSpaceRestrictionCode;
      payer: { kind: "enterprise"; enterpriseId: EnterpriseId };
    };
```

约束：

- 普通业务账号必须恰好返回一个 personal ProductSpace，并通过 `personalProductSpaceId` 明确指出。
- 有效 EnterpriseMembership 返回企业空间；`removed` 成员关系不返回。
- 欠费、治理暂停或 closing 的企业仍可返回 `read_only`，用于展示受限原因和允许的历史入口，但不能启动执行。
- 平台工作人员账号调用该接口返回 `403 staff_account_not_allowed`，不能获得“我的空间”。
- 客户端没有有效本地选择或原选择已失效时，回到 `personalProductSpaceId`；服务端不保存“当前空间”。

这里的 `payer` 只供授权、计量和账务解析。Polo 客户端不把它渲染为 badge、可信栏字段或“由谁承担算力”说明。

## 5. 统一 Catalog

### 5.1 操作

```http
GET /api/product-spaces/{productSpaceId}/catalog?revision={knownRevision}
Authorization: Bearer <accessToken>
```

- 没有 `revision` 时返回完整 Catalog。
- `revision` 仍有效时返回 `304 Not Modified`，并通过 `X-Catalog-Revision` 返回当前值。
- `catalogRevision` 是服务端不透明字符串，代表“当前账号 + 当前 ProductSpace”的目录投影；客户端不得解析或自行递增。

### 5.2 响应

```ts
interface ProductSpaceCatalogResponse {
  contractVersion: 1;
  productSpaceId: ProductSpaceId;
  catalogRevision: string;
  entries: ProductSpaceCatalogEntry[];
}

interface CatalogEntryBase {
  catalogEntryId: CatalogEntryId;
  name: string;
  description: string;
  iconUrl?: string;
  availability: CatalogEntryAvailability;
  unavailableReason?: CatalogEntryUnavailableReason;
}

type ProductSpaceCatalogEntry =
  | CatalogEntryBase & {
      kind: "built_in_app";
      builtInAppId: "polo_assistant";
    }
  | CatalogEntryBase & {
      kind: "app";
      artifactInstanceId: ArtifactInstanceId;
      version: CatalogVersionSummary;
      sources: CatalogSource[];
      permissions: string[];
    }
  | CatalogEntryBase & {
      kind: "skill";
      artifactInstanceId: ArtifactInstanceId;
      version: CatalogVersionSummary;
      sources: CatalogSource[];
      enabled: boolean;
      permissions: string[];
    };

interface CatalogVersionSummary {
  versionId: ArtifactVersionId;
  version: string;
  checksum?: string;
}

type CatalogSource =
  | { kind: "polo"; name: "Polo" }
  | { kind: "creator_circle"; circleId: CreatorCircleId; name: string }
  | { kind: "enterprise_import"; name: string };
```

约束：

- `catalogEntryId` 在一个 ProductSpace 内稳定且唯一；内置 Polo 助手没有 `artifactInstanceId`。
- 同一创作者作品通过多个圈子授权给同一用户时只返回一个作品条目，`sources` 可以列出多个圈子。
- personal Catalog 只聚合 Polo 内置能力和有效圈子授权；enterprise Catalog 只返回企业独立实例。
- 企业实例固定企业已采用版本，不跟随也不提醒创作者作品版本。
- Catalog 只提供显示、版本和权限摘要，不包含长期下载地址、Runtime URL 或可复用启动凭据。
- 授权已消失的条目可以从服务端 Catalog 消失；客户端把本地旧条目降级为不可运行 tombstone，不把缓存当作授权。
- 全局阻断的条目可保留为 `blocked` 以解释原因，但不能解析启动。

## 6. Skill 启用状态

### 6.1 操作

```http
PUT /api/product-spaces/{productSpaceId}/skills/{artifactInstanceId}/enablement
Authorization: Bearer <accessToken>
Content-Type: application/json

{ "enabled": true }
```

响应：

```ts
interface UpdateSkillEnablementResponse {
  contractVersion: 1;
  productSpaceId: ProductSpaceId;
  artifactInstanceId: ArtifactInstanceId;
  enabled: boolean;
  catalogRevision: string;
}
```

约束：

- 操作是幂等 PUT；重复提交相同值返回成功。
- 服务端从认证会话取得 `accountId`，实际唯一键为 `accountId + productSpaceId + artifactInstanceId`。
- 一名企业成员的启用状态不影响其他成员。
- 作品未授权、版本阻断或空间只读时，启用 `true` 失败；停用 `false` 允许幂等收敛。
- 客户端成功后更新当前 Catalog 缓存的 `enabled` 和 `catalogRevision`；其他设备在下次同步时获得相同状态。

## 7. 启动解析

### 7.1 操作

```http
POST /api/product-spaces/{productSpaceId}/catalog/{catalogEntryId}/resolve-launch
Authorization: Bearer <accessToken>
Content-Type: application/json
```

请求只包含客户端交付环境，不上传本地 Workspace 身份：

```ts
interface ResolveLaunchRequest {
  platform: "darwin" | "win32" | "linux";
  arch: "arm64" | "x64";
}
```

### 7.2 响应

```ts
interface ResolveLaunchResponse {
  contractVersion: 1;
  productSpaceId: ProductSpaceId;
  catalogEntryId: CatalogEntryId;
  resolvedAt: string;
  expiresAt: string;
  subject: ResolvedLaunchSubject;
  payer: { kind: "account" } | { kind: "enterprise"; enterpriseId: EnterpriseId };
  delivery: LaunchDelivery;
}

type ResolvedLaunchSubject =
  | { kind: "built_in_app"; builtInAppId: "polo_assistant" }
  | {
      kind: "artifact_instance";
      artifactType: "app" | "skill";
      artifactInstanceId: ArtifactInstanceId;
      versionId: ArtifactVersionId;
      version: string;
    };

type LaunchDelivery =
  | { kind: "built_in" }
  | { kind: "web_url"; url: string; launchToken: string }
  | {
      kind: "bundle";
      downloadUrl: string;
      checksum: string;
      sizeBytes: number;
      runtime: "static" | "python" | "js";
    };
```

`ResolveLaunchResponse.payer` 是内部执行契约，不是客户端展示字段。

约束：

- 每次新启动都必须调用，服务端重新验证账号、空间、作品授权、Skill 启用、稳定/企业版本、平台检查、全局治理和付款能力。
- 响应固定本次执行使用的 `versionId`；后续发布或回退不改变已经开始的执行。
- `expiresAt` 只限制启动凭据的使用时间，不要求已启动执行在该时刻自动结束。
- `web_url` 与 `bundle` 是技术交付差异，产品界面统一显示为 Web App。
- Web App 只能获得自身启动描述和已打包能力，不能通过该接口发现或调用用户电脑上的其他 Skills。
- Polo Admin 不接收、保存或根据 `workspaceId` 授权；`workspaceId` 只在客户端构造本地 Runtime Scope 时加入。

## 8. 本地 Runtime Scope 与执行操作

### 8.1 不可变执行身份

```ts
interface ProductSpaceExecutionScope {
  contractVersion: 1;
  executionId: ExecutionId;
  accountId: AccountId;
  productSpaceId: ProductSpaceId;
  workspaceId: WorkspaceId;
  subject: ResolvedLaunchSubject;
}
```

- `executionId` 每次启动唯一；相同作品可以有多个执行。
- `productSpaceId`、`workspaceId` 和作品 subject 的 `versionId` 在执行创建后不可修改。
- Session、附件元数据、必要本地日志和最小计量记录必须直接包含该 Scope 或不可变引用。
- Polo 助手会话也使用同一 Scope，不能只有 `workspaceRootPath` 或当前 UI 空间。

### 8.2 Electron Main / Runtime 必须提供的原子操作

```ts
listActiveExecutions(input: {
  accountId: AccountId;
  productSpaceId: ProductSpaceId;
}): Promise<ExecutionSummary[]>;

startExecution(input: {
  scope: ProductSpaceExecutionScope;
  delivery: LaunchDelivery;
}): Promise<ExecutionSummary>;

stopExecution(input: {
  executionId: ExecutionId;
}): Promise<ExecutionSummary>;

stopAllExecutions(input: {
  accountId: AccountId;
  productSpaceId: ProductSpaceId;
}): Promise<StopAllExecutionsResult>;

interface ExecutionSummary {
  executionId: ExecutionId;
  scope: ProductSpaceExecutionScope;
  name: string;
  status: ExecutionStatus;
  errorCode?: string;
}

interface StopAllExecutionsResult {
  allStopped: boolean;
  executions: ExecutionSummary[];
}
```

`ExecutionSummary.status` 统一使用：

```ts
type ExecutionStatus =
  | "preparing"
  | "running"
  | "waiting_for_network"
  | "stopping"
  | "stopped"
  | "failed";
```

`stopAllExecutions` 必须逐项返回结果，不能把“已发送停止信号”当作全部终止成功。存在 `preparing / running / waiting_for_network / stopping` 任一状态时都不能提交 ProductSpace 切换。

## 9. 空间切换事务

服务端没有 `switchProductSpace` API。客户端按以下两阶段流程提交本地选择：

1. 从当前完整上下文读取 `fromProductSpaceId`，重新获取目标空间列表并确认目标仍可访问。
2. 调用 `listActiveExecutions` 检查当前空间。
3. 没有活动执行时直接进入第 6 步。
4. 用户确认后调用 `stopAllExecutions`；用户取消时不改变任何上下文。
5. 只有全部执行进入 `stopped / failed` 终态后才继续；任一 `stopping` 或终止失败时保留原空间。
6. 原子写入当前设备的 `activeProductSpaceId`。
7. 丢弃当前页面内存中的旧 Catalog、Skills、助手 Session 列表、文件投影、权限与内部计量授权，再加载目标空间。
8. 目标加载成功后展示目标首页；失败时显示单一安全错误页，不能同时展示新旧空间内容。

企业访问权在使用中失效时使用同一终止机制，但不需要用户确认；终止后回到“我的空间”。

## 10. 缓存与本地持久化

### 10.1 键

```ts
const productSpaceListKey = JSON.stringify([
  "product-space-list", 1, accountId,
]);

const catalogKey = JSON.stringify([
  "product-space-catalog", 1, accountId, productSpaceId,
]);

const runtimeKey = JSON.stringify([
  "product-space-runtime", 1, accountId, productSpaceId,
  workspaceId, executionId,
]);

const activeSelectionKey = JSON.stringify([
  "active-product-space", 1, accountId, deviceId,
]);
```

禁止用分隔符拼接，禁止省略 `accountId`，禁止把 `workspaceId` 放进 Catalog key。

### 10.2 规则

- ProductSpace 列表和 Catalog 各自保存 `syncedAt`；Catalog 额外保存 `catalogRevision`。
- 网络成功返回 401/403/404 时不得回退到“可运行缓存”；可以保留清除交付信息后的 tombstone 供解释和本地数据管理。
- 离线时允许查看已明确保存在本机的历史结果、文件和目录说明；不能 resolve-launch、启动 App、调用 Skill 或创建 Polo 助手执行。
- 网络中断中的执行进入 `waiting_for_network`，停止新的 AI/网络调用；恢复后由用户继续或终止，不自动标记成功。
- Skill 的跨设备启用状态以服务端为准；下载、解压和 Runtime 准备状态只存在于本机。

## 11. 错误语义

所有 HTTP 错误使用：

```ts
interface ProductSpaceErrorResponse {
  error: ProductSpaceErrorCode;
  message: string;
  requestId: string;
  retryable: boolean;
  details?: Record<string, string | number | boolean>;
}
```

| HTTP | `error` | 语义与客户端动作 |
| --- | --- | --- |
| 400 | `validation_error` | 请求结构错误；不重试同一请求 |
| 401 | `unauthorized` / `token_revoked` | 进入登录或会话恢复 |
| 403 | `account_disabled` | 退出业务界面并显示账号恢复渠道 |
| 403 | `staff_account_not_allowed` | 工作人员账号不能进入成员工作台 |
| 403 | `product_space_restricted` | 空间只读；停止新执行并刷新空间状态 |
| 503 | `personal_space_preparing` | 首次创建“我的空间”尚未完成；停留准备页并按退避重试 |
| 404 | `product_space_not_found` | 空间不存在或账号无权访问；两种情况不做差异泄露 |
| 404 | `catalog_entry_not_found` | 条目不存在或不属于该空间；刷新 Catalog |
| 409 | `catalog_entry_unavailable` | 授权、分发或版本状态变化；刷新 Catalog，不使用缓存启动 |
| 409 | `skill_not_enabled` | Skill 未启用；返回 Skill 入口，不自动替用户启用 |
| 409 | `version_blocked` | 目标版本被全局阻断；终止相关活动执行并标记历史来源 |
| 429 | `usage_limit_reached` | 显示个人余额或企业限额处理入口 |
| 503 | `service_unavailable` | 保留原空间并允许重试；不能切到缓存授权模式 |

客户端本地错误独立使用 `runtime_*` 前缀，例如 `runtime_stop_failed`、`runtime_prepare_failed`、`runtime_network_required`。本地错误不能伪装成服务端授权成功。

## 12. 未公开发布阶段的直接切换

本轮不实现：

- `/api/me/organizations` 与 `/api/me/product-spaces` 双读或合并。
- Organization Catalog 与 ProductSpace Catalog 双写。
- `organizationId` 到 `productSpaceId` 的客户端运行时 fallback。
- Creator Space 本地 App/Skill 自动搬入“我的空间”。
- 旧 Catalog、旧 Session 或旧 Runtime Scope 的通用自动迁移。

同一集成批次按以下顺序落地：

1. 发布 `@z-h-ai/shared/product-spaces` v1 契约。
2. Polo Admin 建立 ProductSpace 数据与新接口。
3. Polo 客户端升级 AdminClient、缓存、Session 与 Runtime Scope。
4. 新客户端首次启动时停止旧本地 Runtime，删除旧 Organization 授权/目录/安装状态缓存，再从新 Catalog 重建。
5. 删除 Polo 客户端对旧空间列表与 Catalog 的调用；测试夹具同步切换。

本地 Workspace、用户主动导出的文件和不依赖旧授权的普通本地资料不清理。若开发或试点环境存在必须保留的数据，另写对象明确的一次性脚本，不扩展为产品兼容机制。

## 13. F01-B 验收契约

### 13.1 共享 Schema

- personal/enterprise 的 discriminated union 能拒绝错误字段组合。
- `ProductSpaceId`、`WorkspaceId`、`EnterpriseId` 和 `CatalogEntryId` 不能直接互传。
- Polo Admin 与 Polo 客户端消费同一份 `@z-h-ai/shared/product-spaces` Schema，没有复制枚举。
- 未知 `kind`、未知错误码、跨空间条目和响应中的多余敏感交付字段均 fail closed。

### 13.2 空间与 Catalog

- 新账号获得且只获得一个 personal ProductSpace；Creator Circle 不出现在空间列表。
- 同一账号的 personal Catalog 不包含企业实例，enterprise Catalog 不包含个人圈子授权。
- 同一作品通过两个圈子授权时只有一个条目且保留两个来源；失去一个来源时仍可用，失去最后来源后不能启动。
- 企业受限空间为只读且 resolve-launch 失败；解除限制不自动重启旧执行。
- 企业版本只在重新上传并采用后变化，不读取创作者最新版本。

### 13.3 Skill 与 Polo 助手

- Skill 启用状态以 `accountId + productSpaceId + artifactInstanceId` 隔离并跨该账号设备同步。
- 企业成员 A 启用 Skill 不会替成员 B 启用。
- 两个 ProductSpace 的 Polo 助手拥有不同 Session、附件、文件、Skills 与内部计量授权；客户端不展示付款主体。
- Skill 在 resolve-launch 后固定作品版本；Polo 助手执行固定其 ProductSpace Scope，目录更新不切换已开始执行。

### 13.4 Runtime 与切换

- 同一执行同时携带互不相等的 `productSpaceId` 和 `workspaceId`，并按两者生成独立本地身份。
- 同一作品在个人空间和企业空间产生不同 Runtime、缓存、日志和 Session key。
- 有活动执行时不能写入新的 `activeProductSpaceId`；全部终止后才切换。
- 任一终止失败时仍处于原空间，目标空间数据不会进入当前页面。
- 当前企业访问权被撤销后终止该账号在企业中的执行并回到“我的空间”，不复制企业数据。

### 13.5 直接切换

- 新客户端不再调用旧 Organization 空间列表和 Catalog。
- 首次升级不会把旧 Creator Space、Catalog 或 Session 猜测为 personal ProductSpace。
- 清理旧授权缓存不删除 Workspace 或用户主动导出的普通文件。
- Polo Admin、共享包和 Polo 客户端的集成测试使用同一 `contractVersion=1`，不存在新旧双轨运行。

## 14. F01-B 之后

F01-B 完成后可以并行启动：

- F02：ProductSpace 持久化、我的空间自动创建和现有企业转换。
- F03：业务账号、平台工作人员账号和 CreatorQualification 拆分。
- 共享契约实现任务：发布 `@z-h-ai/shared/product-spaces` 并建立两端 contract tests。

F02/F03 与共享契约稳定后，再按依赖推进 E01、C01、A01 和 Polo 客户端 S01/P01/P02/P03；不得继续扩展旧 Organization 多态模型。
