# POO-205 契约草案 v0（两仓联合评审稿）

状态：草案，待 polo-admin 侧联合评审冻结。冻结后生成进 `packages/shared`（zod 契约），
polo-admin 按同一契约实现 REST；本仓 Plan 的 P0 消费本文件。
评审重点标注为 **[联审]** 的条目为有意提出的方案，可改；未标注条目直接来自已确认 Spec。

## 1. Project 实体（admin 权威）

```ts
ProjectId = string            // 前缀 prj_
Project {
  id: ProjectId
  organizationEnterpriseId: string   // 所属组织(enterprise space 的 enterpriseId)
  productSpaceId: string             // 组织对应 ProductSpace id（冗余便于客户端边界校验）
  name: string
  purpose?: string
  instructions?: string              // 项目指令,注入该项目所有会话 system prompt(Q12)
  createdByAccountId: string
  createdAt / updatedAt: string      // ISO
}
ProjectMembership {
  projectId: ProjectId
  accountId: string
  role: 'owner' | 'manager' | 'member'
  createdAt: string
}
```

约束：
- ProjectMembership.accountId 必须 ∈ 组织 EnterpriseMembership（Q10：项目成员 ⊆ 组织成员，
  服务端拒绝越界）。
- 创建/改名/改指令要求发起人为该项目 owner/manager；成员管理同。
- 不做归档/软删除状态（本期 out of scope）。

## 2. 客户端 REST 面（AdminClient 新增）

```
GET    /api/client/organizations/{orgId}/projects                     列表(含我的角色/成员数)
POST   /api/client/organizations/{orgId}/projects                     创建 {name, purpose?, instructions?}
GET    /api/client/organizations/{orgId}/projects/{projectId}          详情
PATCH  /api/client/organizations/{orgId}/projects/{projectId}          改 name/purpose/instructions
GET    /api/client/organizations/{orgId}/projects/{projectId}/members  成员列表
POST   /api/client/organizations/{orgId}/projects/{projectId}/members  批量添加 {accountIds, role}
DELETE /api/client/organizations/{orgId}/projects/{projectId}/members/{accountId}
GET    /api/client/organizations/{orgId}/colleagues                    组织成员名单(勾选来源,替代现邀请流)
```

- 创建 Project 无付款责任、无幂等付款条款（对照现状 `POST /api/client/enterprises`）。
- 计费：项目会话计量归属组织 enterprise；`subject` 携带 projectId 仅供报表，
  不产生新计费主体。**[联审]** 计量迁移细节由 admin 侧确认。

## 3. 项目共享文件区（PC 契约升级）

现有 project-context 资产的作用域键从 `productSpaceId` 改为 `projectId`：

```
PC v2: 所有 pc_* RPC 的 {productSpaceId} 参数改为 {productSpaceId(组织空间), projectId}
```

- 资产归属、搜索、确认、置顶、回收站语义不变，仅换键。
- admin 侧存量资产按 §7 迁移映射重绑。

## 4. 会话绑定与运行时作用域

```ts
SessionRecord {
  productSpaceId?: string   // 保留:空间戳(fence 仍为空间级)
  projectId?: string        // 新增:企业空间内会话必填,个人空间会话无此字段
}
```

- 企业空间内创建会话必须携带有效 projectId 且发起人是项目成员；个人空间会话无 projectId。
- RPC 边界谓词（现 `trustedScopeMatchesSessionRecord`）扩展：空间匹配 + 若记录带
  projectId 则校验会话操作者仍为该项目成员。
- 运行时栅栏保持**空间级**不变（个人↔组织切换保留 PREPARE/STOP/COMMIT 事务）；
  "当前项目"是 renderer 导航状态,不进 fence——项目切换不 stop 其他项目执行（Spec §7-2）。
- 本地存储分存：个人会话留 `workspaces/{slug}/sessions/`；项目会话落
  `workspaces/{slug}/project-sessions/{projectId}/`（**[联审-客户端]** 最终路径实现时定,
  迁移工具同址改造）。

## 5. Catalog v2

```ts
CatalogEntry = AppEntry | SkillEntry        // built_in_app 类整体移除
AppEntry {
  ...现有字段(id/version/availability/deliveryMode/permissions/sources...)
  visibility: 'space' | 'member'            // 新增 [联审]
  ownerAccountId?: string                   // visibility=member 时必填
}
```

- 来源规则调整：member 可见条目使用新 source `'self'`；
  个人空间允许 `polo | creator_circle | self`，企业空间允许 `enterprise_import | self`
  （现状 schema `schemas.ts:394-422` 的校验随之改）。
- `polo_assistant` / `enterprise_knowledge` 条目及 Tab 契约退役；聊天为产品基础能力。
- 我的应用上传（画布生成应用落库、用户手动上传 HTML,两空间均可用）：
  ```
  POST /api/client/product-spaces/{spaceId}/my-apps          上传 bundle(static 单页),visibility=member
  GET  /api/client/product-spaces/{spaceId}/my-apps          我的列表(仅本人)
  ```
  复用现有 creator app 打包/校验管线（`PUBLISH_CREATOR_APP` 的 analyze/canonical 流）。
- 发布/撤回（仅企业空间内,发布到当前空间,Q7）：
  ```
  POST /api/client/product-spaces/{spaceId}/my-apps/{appId}/publish    member→space
  POST /api/client/product-spaces/{spaceId}/my-apps/{appId}/withdraw   space→member(成员侧留 withdrawn 墓碑)
  ```
  个人空间这两个端点返回明确错误码（客户端也不渲染入口）。
- resolve-launch 授权流不变,对 member 条目同样适用（本人使用也过授权,保持单一链路）。**[联审]**

## 6. 数据源与默认配置分级（Q13-2）

- MCP/数据源配置作用域：个人=现 workspace 级；企业=projectId 级。
  存储：**[联审-客户端]** sources 配置从 workspace 全局文件迁到
  个人(workspace)/项目(projectId)双键,契约仅约定"按 projectId 查询项目可用数据源"。
- 默认模型/权限模式：按 productSpaceId 一份（个人/各组织各一）,本项目不做项目级覆盖。

## 7. 迁移契约（一次性,内测硬切）

```
POST /api/admin/migrations/poo-205/upgrade-project-enterprises   {dryRun?: boolean}
GET  /api/client/migrations/poo-205/mapping                      客户端重绑用
```

- admin 侧升级（幂等）：对每个 `enterpriseKind='project'` 企业 E：
  E.kind → organization（同名/成员/计费保留）→ 建同名 Project P →
  EnterpriseMembership 角色映射为 P 的 ProjectMembership（owner→owner,
  manager→manager,member→member）→ E 名下 PC 资产重绑 projectId=P。
- KB 迁移：每个企业空间 OpenViking 租户的集合导出为
  `集合名/*.md` 文件,导入 P 的共享文件区,来源 `knowledge-base-migration` 记录日志；
  租户与凭据退役。
- mapping 响应：`[{oldProjectSpaceId, organizationSpaceId, projectId}]`（账号可见范围内）。
  客户端消费它做本地会话重绑（见 Plan §迁移）。

## 8. 评审待决清单

1. **[联审]** source `'self'` 的引入 vs 复用 creator_circle（推荐 self,语义干净）。
2. **[联审]** member 可见条目是否进统一 Catalog 响应（推荐进,带 visibility 过滤,
   避免双列表）。
3. **[联审]** 计量/计费迁移细节（admin 主导）。
4. **[联审]** my-apps 数量/体积配额（内测期可先不限,留校验位）。
5. **[联审]** instructions 长度上限（建议 8KB,与 PC 注入预算对齐）。
