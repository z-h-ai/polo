# ProductSpace 基础契约

状态：F01-A 基础契约

日期：2026-08-09

适用范围：Polo Admin、共享 Schema、Polo 客户端、本地 App Runtime

本文冻结 ProductSpace 的跨仓库基础语义，使服务端与客户端可以在不混淆本地 Workspace 的前提下继续设计。本文不冻结页面流程、最终 API 路径、命令粒度和错误提示；这些内容在 G1/G2/G3 产品对齐后进入 F01-B。

## 1. 目标

F01-A 解决五个基础问题：

1. 用一个稳定标识表达“我的空间”或“企业空间”的产品上下文。
2. 保留 Polo 客户端现有本地 `Workspace / workspaceId` 语义。
3. 让目录、App Runtime、Polo 助手、会话、文件和计量能够使用同一 ProductSpace 隔离键。
4. 防止 Creator Circle 再次被实现为成员可切换的空间。
5. 明确未公开发布阶段从旧 `organizationId` 模型直接切换到 ProductSpace，不建设双轨兼容层。

## 2. 非目标

F01-A 不包含：

- 最终页面路由、菜单、切换交互和确认文案。
- ProductSpace 列表与 Catalog 的最终 HTTP 路径。
- 企业创建、邀请、圈子加入、作品发布或导入的命令设计。
- 企业受限状态在界面中的最终表现。
- 数据库业务数据迁移、回填或旧表删除。
- 个人目录聚合时，同一作品来自多个圈子的展示与去重规则。
- App 沙箱的具体技术实现。

上述内容分别由 G1—G3、F01-B、F02 及后续领域任务确定。

## 3. 当前代码依据

F01-A 不是重新命名现有 Organization，而是为以下已经冲突的代码语义建立新边界：

| 当前代码 | 当前含义 | F01-A 处理 |
| --- | --- | --- |
| `polo-admin/src/lib/organizations/contracts.ts` | `Organization` 同时包含 `enterprise_workspace / creator_space` | 保留为 legacy；新 ProductSpace 不复用该枚举 |
| `polo/packages/core/src/types/workspace.ts` | `Workspace` 是带 `rootPath`、Sources 和配置的本地/远程工作目录 | 保留名称和 `workspaceId`，不承担产品空间职责 |
| `polo/packages/shared/src/admin/context-key.ts` | 缓存上下文为 `accountId + organizationId` | 直接替换为版本化 `accountId + productSpaceId` key；旧开发缓存不迁移 |
| `polo/packages/shared/src/protocol/local-apps.ts` | Catalog App scope 为 `accountId + organizationId + catalogAppId` | 迁移为包含 ProductSpace、Workspace 和运行主体的 Scope |
| `polo/packages/shared/src/sessions/types.ts` | Session 持久化只有 `workspaceRootPath`，没有产品空间身份 | 后续 P03 增加不可变 `productSpaceId`，继续保留 Workspace 归属 |

核对基线：`polo-admin@865856a`、`polo@67442804`。如果实施时这些路径或类型已经变化，必须重新核对差异，但不得改变本文的产品语义。

## 4. 规范术语

| 术语 | 代码名 | 定义 |
| --- | --- | --- |
| 产品空间 | `ProductSpace` | 成员消费 Apps、Skills、Polo 助手，并形成数据、授权、运行和费用边界的产品上下文 |
| 产品空间标识 | `productSpaceId` | ProductSpace 的稳定、不透明标识 |
| 我的空间 | `ProductSpace(kind=personal)` | 与一个业务账号一一对应的个人产品空间 |
| 企业空间 | `ProductSpace(kind=enterprise)` | 与一个 Enterprise 一一对应的企业产品空间 |
| 本地工作区 | `Workspace` | Polo 客户端本地或远程 AI 工作目录，包含目录、Sources、Sessions 和本机配置 |
| 本地工作区标识 | `workspaceId` | Workspace 的稳定标识，不表达租户、授权或付款主体 |
| 创作者圈子 | `CreatorCircle` | 用户加入、作品分发和创作者经营的关系边界，不是 ProductSpace |
| 企业 | `Enterprise` | 企业资料、成员、邀请、成员组、生命周期和管理设置的业务主体 |
| 目录实例标识 | `artifactInstanceId` | Catalog 为当前 ProductSpace 返回的、可用于安装和运行的稳定实例标识 |
| 目录条目标识 | `catalogEntryId` | Catalog 中一个内置 App 或作品实例在当前 ProductSpace 下的稳定条目标识；作品条目同时携带 `artifactInstanceId` |

代码、Schema、缓存和日志中不得使用裸 `spaceId`。必须写出 `productSpaceId`、`workspaceId`、`enterpriseId` 或 `circleId`，避免把不同身份边界压缩成同一字段。

## 5. 核心不变量

### 5.1 ProductSpace 只有两种

```ts
type ProductSpaceKind = "personal" | "enterprise";
```

- 普通业务账号恰好拥有一个 personal ProductSpace。
- 一个 Enterprise 恰好对应一个 enterprise ProductSpace。
- Creator Circle、创作者工作台和平台运营端都不是 ProductSpace。
- 平台工作人员账号没有 personal ProductSpace，也不能成为 Enterprise Member。
- 新契约不得出现 `creator`、`creator_space` 或 `organization` 类型的 ProductSpace。

### 5.2 ProductSpace 与 Workspace 正交

同一次本地执行可以同时处于：

- 一个 ProductSpace，例如企业 A；
- 一个 Workspace，例如用户电脑上的“报价项目”目录。

二者可以独立变化。同一 Workspace 可以先后用于我的空间和企业空间；同一 ProductSpace 也可以在不同设备或 Workspace 中使用。

因此：

- `productSpaceId` 决定产品授权、数据权利、Catalog、费用和业务隔离。
- `workspaceId` 决定本地/远程工作目录、Sources、本机配置和 Workspace 级能力。
- 任何一方都不得由另一方推导、替代或作为默认值。
- 只持有 `workspaceId` 不构成访问任何 ProductSpace 的授权。

### 5.3 Enterprise 与 enterprise ProductSpace 是不同对象

Enterprise 保存企业本身及其管理关系；enterprise ProductSpace 保存成员消费和运行上下文。

迁移时可以为了减少缓存失效而保留相同的 UUID 值，但这只是迁移实现选择。所有调用方必须把 `enterpriseId` 与 `productSpaceId` 当作不同类型，不得依赖两者相等。

### 5.4 ProductSpace 是强隔离键

以下记录必须直接包含不可变的 `productSpaceId`，或通过不可变外键唯一归属于一个 ProductSpace：

- Catalog 快照和本地 Catalog 缓存。
- App/Skill 的 ProductSpace 启用状态，以及设备本地缓存、准备和运行状态。
- Polo 助手实例、Session 和附件元数据。
- App 最小运行记录和费用付款主体解析。
- ProductSpace 范围内的文件索引、权限快照和离线状态。

不能仅依赖当前 UI 选中的空间来解释已有记录。记录创建后切换空间，不得改变其 `productSpaceId`。

费用付款主体只用于服务端授权、计量和账务解析，不是 Polo 客户端常驻可见字段；客户端不得据此生成 payer badge、可信栏文案或“由谁承担算力”说明。

用户对 Skill 的启用偏好按 `accountId + productSpaceId + artifactInstanceId` 保存并跨该账号设备同步；企业内一名成员启用 Skill 不会替其他成员启用。设备本地缓存和运行准备状态仍按设备保存，不能反向作为授权或用户启用事实。

## 6. 标识契约

### 6.1 传输格式

所有跨进程和跨服务标识在 JSON 中使用非空字符串。`productSpaceId` 是不透明值：

- 客户端不得解析其中的前缀、长度或 UUID 结构。
- 客户端不得从账号、Enterprise、Circle 或 Workspace 计算 ProductSpace ID。
- 服务端当前可以使用 UUID 持久化，但不得把 UUID 结构作为公开客户端能力。
- 日志和错误中不得把另一个标识误标为 `productSpaceId`。

### 6.2 TypeScript 强类型

共享类型应使用品牌类型阻止不同 ID 在编译期误传：

```ts
declare const opaqueIdBrand: unique symbol;

export type OpaqueId<Name extends string> = string & {
  readonly [opaqueIdBrand]: Name;
};

export type AccountId = OpaqueId<"AccountId">;
export type ProductSpaceId = OpaqueId<"ProductSpaceId">;
export type WorkspaceId = OpaqueId<"WorkspaceId">;
export type EnterpriseId = OpaqueId<"EnterpriseId">;
export type CreatorCircleId = OpaqueId<"CreatorCircleId">;
export type ArtifactInstanceId = OpaqueId<"ArtifactInstanceId">;
```

运行时 Schema 负责把经过验证的字符串转换为对应品牌类型。调用方不得通过通用 `as string`/`as ProductSpaceId` 绕过边界；从持久化或网络进入的值必须重新验证。

## 7. 共享 Schema 基线

### 7.1 ProductSpace 引用

F01-A 只冻结跨仓库都需要的最小引用，不提前加入页面展示字段或完整生命周期：

```ts
export type EnterpriseProductSpaceRole = "owner" | "manager" | "member";

export type ProductSpaceRef =
  | {
      id: ProductSpaceId;
      kind: "personal";
    }
  | {
      id: ProductSpaceId;
      kind: "enterprise";
      enterpriseId: EnterpriseId;
      role: EnterpriseProductSpaceRole;
    };
```

约束：

- personal 分支不得携带 Enterprise role 或 `enterpriseId`。
- enterprise 分支必须携带 `enterpriseId` 和当前账号在该企业的有效角色。
- CreatorQualification、CircleMembership 和 Creator Owner 不进入 ProductSpaceRef。
- 名称、头像、未读数、状态提示等展示字段由 G1/G2 后的响应 DTO 扩展，不属于身份主键。

### 7.2 客户端当前上下文

```ts
export interface ProductSpaceContext {
  contractVersion: 1;
  accountId: AccountId;
  productSpace: ProductSpaceRef;
}
```

`accountId` 用于同一设备上的多账号隔离。服务端不得相信客户端提交的 `accountId` 来授权；服务端始终从已验证 Session/Token 中取得账号，并验证其是否可以访问 `productSpaceId`。

G1 已确认“当前空间选择”不跨设备同步。每台设备保存自己的最后选择；无论设备选择什么空间，其缓存和运行状态都必须包含上述账号与 ProductSpace 身份。

### 7.3 Catalog Scope

```ts
export interface ProductSpaceCatalogScope {
  contractVersion: 1;
  productSpaceId: ProductSpaceId;
}
```

最终 Catalog DTO 由 S01/F01-B 定义，但必须满足：

- 请求明确指定一个 `productSpaceId`。
- 响应中的每个条目拥有稳定的 `catalogEntryId`；App/Skill 作品条目还必须拥有 `artifactInstanceId`，内置 Polo 助手不伪装成作品实例。
- 个人 Catalog 不能返回企业实例；企业 Catalog 不能混入个人圈子授权。
- Circle 可以作为个人 Catalog 项的来源信息，但不能成为 Catalog scope。

### 7.4 执行 Scope

```ts
export type ProductSpaceRuntimeSubject =
  | {
      kind: "artifact_instance";
      artifactInstanceId: ArtifactInstanceId;
    }
  | {
      kind: "built_in_app";
      builtInAppId: "polo_assistant";
    };

export interface ProductSpaceExecutionScope {
  contractVersion: 1;
  accountId: AccountId;
  productSpaceId: ProductSpaceId;
  workspaceId: WorkspaceId;
  subject: ProductSpaceRuntimeSubject;
}
```

该 Scope 用于 Polo 客户端内部 IPC、本地安装和 Runtime 状态。发往 Polo Admin 的请求只需要认证身份与 `productSpaceId`，不应为了满足统一 DTO 而上传无关的本地 `workspaceId`。

Polo 助手是内置 App，因此使用同一执行 Scope，但以固定 `builtInAppId="polo_assistant"` 区分；它的 Session、文件、Skills 和费用仍按 `productSpaceId` 隔离。

## 8. 缓存与本地持久化契约

### 8.1 键格式

禁止通过字符串拼接生成跨账号、跨空间缓存键。统一使用带版本的 JSON tuple：

```ts
export function createProductSpaceContextKey(
  accountId: AccountId,
  productSpaceId: ProductSpaceId,
): string {
  return JSON.stringify(["product-space", 1, accountId, productSpaceId]);
}

export function createProductSpaceRuntimeKey(
  scope: ProductSpaceExecutionScope,
): string {
  return JSON.stringify([
    "product-space-runtime",
    scope.contractVersion,
    scope.accountId,
    scope.productSpaceId,
    scope.workspaceId,
    scope.subject.kind,
    scope.subject.kind === "artifact_instance"
      ? scope.subject.artifactInstanceId
      : scope.subject.builtInAppId,
  ]);
}
```

缓存命名空间至少包含：

- contract version；
- accountId；
- productSpaceId；
- 对运行状态而言，还包含 workspaceId 和运行主体。

### 8.2 缓存内容

- ProductSpace 列表缓存不能与旧 Organization 列表合并后作为新模型写回。
- Catalog、权限和离线快照必须逐账号、逐 ProductSpace 保存版本和抓取时间。
- 缓存失效只影响目标 ProductSpace，不得清空同账号的其他空间或其他账号。
- 被撤权或服务端不再返回的空间可以保留最小本地 tombstone 用于解释状态，但不能继续作为授权来源或启动 App。
- 日志目录可以按 Runtime key 派生，但不能只按 App 名称、slug 或 artifactId 共用。
- 离线缓存只允许查看已保存在本机的历史结果、文件和目录说明，不能授权新的 App、Polo 助手或 AI 执行。

## 9. 旧 organizationId 直接切换原则

Polo 尚未公开发布，本轮不为旧客户端、旧 Catalog 或旧本地 Runtime 建设长期兼容能力。跨仓实现按同一交付批次直接切换到 ProductSpace 契约：

- Polo 客户端不再读取 `/api/me/organizations` 或旧 Organization Catalog。
- Polo Admin 不为新客户端提供 `organizationId` 到 `productSpaceId` 的运行时兜底，也不做新旧双写。
- `Organization(type=enterprise_workspace)` 的开发数据可由 F02 一次性转换为 Enterprise 与 enterprise ProductSpace；允许保留 UUID 值，但新代码仍把两类 ID 视为不同类型。
- `Organization(type=creator_space)` 只能由 C01 拆为 CreatorCircle、CircleMembership 和作品关系，永远不能转换为 ProductSpace。
- 旧 Catalog、安装状态、Skill 启用状态和 Runtime 缓存直接失效并重建，不尝试猜测归属。
- 旧 Session 缺少不可变 `productSpaceId` 时不导入新会话列表；本地 Workspace、用户主动导出的文件和不依赖旧授权的普通本地资料不受影响。

实施时只需提供一次性开发环境清理或数据转换脚本，并在同一集成版本中更新 Polo Admin、共享契约和 Polo 客户端。若公开发布前出现必须保留的真实试点数据，再为已确认的数据单独编写显式迁移，不提前建设通用兼容框架。

## 10. 安全边界

- 服务端对每个 ProductSpace 请求重新验证认证账号与 ProductSpace 的访问关系。
- 不存在、不可访问和跨租户的 ProductSpace 不能通过返回差异泄露租户信息；最终 HTTP 状态与错误码由 F01-B 冻结。
- Enterprise role 只来自服务端 EnterpriseMembership，不接受客户端自行声明。
- CircleMembership 只影响 personal Catalog 授权，不授予 ProductSpace、企业或创作者后台权限。
- `artifactInstanceId` 只在其 ProductSpace 内有效；把企业 A 的实例 ID 与企业 B 的 ProductSpace 组合必须失败。
- Workspace 的本地文件权限不能提升 ProductSpace 权限；ProductSpace 权限也不能自动开放任意本地 Workspace 文件。
- 切换 ProductSpace 前必须终止旧空间运行项。切换交互由 G2/G3 确认，但 Runtime 必须提供“列出活动执行”和“按 ProductSpace 终止”的能力。

## 11. Schema 所有权与发布规则

- ProductSpace 类型与运行 Scope 必须在一个共享契约模块中维护，Polo Admin 与 Polo 客户端不得分别复制枚举和 Zod Schema。
- 服务端在网络边界验证输入和输出；Polo 客户端在 AdminClient 边界再次解析不可信响应。
- 共享 Schema 必须拒绝未知 ProductSpace kind，并通过 discriminated union 拒绝 personal 携带企业角色或 enterprise 缺少企业信息。
- 当前未公开发布阶段允许协调后的破坏性契约变更，但 Polo Admin、共享包和 Polo 客户端必须在同一集成批次升级；公开发布后再启用兼容版本与最低客户端策略。
- 具体共享包名称、仓库发布顺序和版本号属于实施任务，但只能有一个发布源。

推荐逻辑模块：

```text
product-spaces/
  ids.ts
  types.ts
  schemas.ts
  context-key.ts
  runtime-scope.ts
```

## 12. F01-A 验收标准

### 12.1 类型与 Schema

- `ProductSpaceKind` 只接受 `personal / enterprise`。
- personal ProductSpace 不能携带 `enterpriseId` 或 Enterprise role。
- enterprise ProductSpace 缺少 `enterpriseId` 或 role 时验证失败。
- `ProductSpaceId` 与 `WorkspaceId` 在 TypeScript 中不能直接互传。
- 从网络或持久化读取的 ID 未经过 Schema 验证时不能进入强类型业务接口。

### 12.2 隔离

- 同一执行 Scope 可以同时携带互不相等的 `workspaceId` 和 `productSpaceId`。
- 相同 App/内置助手在两个 ProductSpace 中生成不同 Runtime key、Session scope 和缓存 key。
- 相同 ProductSpace 在两个 Workspace 中生成不同本地 Runtime key，但仍归属于同一产品授权与付款上下文。
- Staff Account 不产生 personal ProductSpace；Creator Circle 不出现在 ProductSpace 枚举或列表模型中。

### 12.3 直接切换

- 新客户端不调用旧 Organization 空间列表或 Catalog。
- creator_space Organization 永远不能映射为 ProductSpace。
- 缺少 `productSpaceId` 的旧 App、Session 或缓存不能启动，也不能自动归入我的空间。
- 升级时清理旧授权与 Runtime 缓存，新写入只进入版本化 ProductSpace 命名空间。
- 文档和共享类型中没有使用 `spaceId` 表达多种不同概念。

## 13. F01-B 衔接

G1—G3 已确认。最终操作 API、错误语义、Catalog 条目、客户端缓存和 Runtime Scope 由 [`product-space-operation-contract.md`](./product-space-operation-contract.md) 冻结。
